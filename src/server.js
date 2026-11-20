import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.js';

loadEnv();

const { getDb, update, id, urlKey } = await import('./store.js');
const { ask, extractJson, listModels, hasKey } = await import('./claude.js');
const { verifyJob } = await import('./verify.js');
const { fetchPage, htmlToText } = await import('./fetchPage.js');
const P = await import('./prompts.js');

const PORT = Number(process.env.PORT || 4317);
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

const JOB_STATUSES = ['new', 'saved', 'applied', 'interviewing', 'offer', 'rejected', 'archived'];
const CONTACT_STATUSES = ['new', 'drafted', 'emailed', 'replied', 'archived'];

// ---------- background tasks (long Claude calls) ----------
const tasks = new Map();
function startTask(kind, label, fn) {
  const task = { id: id(), kind, label, status: 'running', progress: 'Starting', startedAt: Date.now() };
  tasks.set(task.id, task);
  const setProgress = (msg) => (task.progress = msg);
  fn(setProgress)
    .then((result) => Object.assign(task, { status: 'done', result, progress: 'Done' }))
    .catch((err) => {
      console.error(`[${kind}]`, err);
      Object.assign(task, { status: 'error', error: err.message });
    })
    .finally(() => (task.endedAt = Date.now()));
  // Forget finished tasks after an hour.
  setTimeout(() => tasks.delete(task.id), 3_600_000).unref();
  return task;
}

async function pool(items, size, worker) {
  let i = 0;
  const run = async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
}

// ---------- helpers ----------
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isHttpUrl = (u) => {
  try {
    return ['http:', 'https:'].includes(new URL(u).protocol);
  } catch {
    return false;
  }
};
const clampInt = (v, lo, hi, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

function normalizeJob(raw, origin, searchedKeys) {
  const url = str(raw.url, 2000);
  return {
    id: id(),
    origin,
    title: str(raw.title, 200),
    company: str(raw.company, 120),
    companyDomain: str(raw.companyDomain, 120).toLowerCase(),
    url,
    location: str(raw.location, 160),
    remote: str(raw.remote, 20),
    term: str(raw.term, 80),
    duration: str(raw.duration, 80),
    deadline: /^\d{4}-\d{2}-\d{2}$/.test(raw.deadline || '') ? raw.deadline : '',
    postedDate: /^\d{4}-\d{2}-\d{2}$/.test(raw.postedDate || '') ? raw.postedDate : '',
    pay: str(raw.pay, 80),
    summary: str(raw.summary, 1200),
    requirements: Array.isArray(raw.requirements) ? raw.requirements.map((r) => str(r, 200)).filter(Boolean).slice(0, 12) : [],
    whyFit: str(raw.whyFit, 400),
    fitScore: Number.isFinite(raw.fitScore) ? Math.max(0, Math.min(100, raw.fitScore)) : null,
    seenInSearch: searchedKeys ? searchedKeys.has(urlKey(url)) : null,
    status: 'new',
    notes: '',
    starred: false,
    addedAt: new Date().toISOString(),
    appliedAt: null,
    verification: null,
  };
}

async function runVerification(jobId) {
  const db = getDb();
  const job = db.jobs.find((j) => j.id === jobId);
  if (!job) return;
  const out = await verifyJob(job, db.profile);
  await update((d) => {
    const j = d.jobs.find((x) => x.id === jobId);
    if (!j) return;
    j.verification = out.verification;
    j.fitScore = out.fitScore;
    j.fitNotes = out.fitNotes;
    j.missingSkills = out.missingSkills;
    // Fill blanks from what Claude read on the actual page; never overwrite user-visible data with blanks.
    for (const [k, v] of Object.entries(out.fields || {})) {
      if (k === 'deadline' && !/^\d{4}-\d{2}-\d{2}$/.test(v || '')) continue;
      if (typeof v === 'string' && v.trim() && !j[k]) j[k] = v.trim().slice(0, 200);
    }
  });
  return out.usage;
}

function recordSearch(kind, info) {
  return update((d) => {
    d.searches.unshift({ id: id(), kind, at: new Date().toISOString(), ...info });
    d.searches = d.searches.slice(0, 100);
  });
}

// ---------- route handlers ----------
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', /^\/api\/state$/, () => {
  const db = getDb();
  return {
    hasKey: hasKey(),
    profile: db.profile,
    jobs: db.jobs,
    contacts: db.contacts,
    searches: db.searches.slice(0, 30),
    tasks: [...tasks.values()].filter((t) => t.status === 'running'),
  };
});

route('GET', /^\/api\/models$/, async () => ({ models: await listModels() }));

route('PUT', /^\/api\/profile$/, async (_m, body) => {
  const allowed = Object.keys(getDb().profile);
  await update((d) => {
    for (const k of allowed) {
      if (!(k in body)) continue;
      d.profile[k] = typeof d.profile[k] === 'boolean' ? Boolean(body[k]) : str(String(body[k] ?? ''), k === 'resume' ? 20000 : 1000);
    }
  });
  return { profile: getDb().profile };
});

route('POST', /^\/api\/discover\/jobs$/, (_m, body) => {
  const focus = str(body.focus, 300);
  const count = clampInt(body.count, 3, 25, 12);
  const task = startTask('jobs', focus || 'Job search', async (progress) => {
    const db = getDb();
    const existing = db.jobs.map((j) => `${j.company} ${j.title}`);
    progress('Claude is searching the web');
    const res = await ask({
      system: 'You are a meticulous co-op job researcher for a University of Waterloo student. You only report postings you actually found.',
      prompt: P.discoverJobsPrompt(db.profile, { focus, count, exclude: existing }),
      model: db.profile.model,
      webSearch: true,
      maxSearches: 12,
      maxTokens: 12000,
    });
    const list = extractJson(res.text);
    if (!Array.isArray(list)) throw new Error('Expected a list of jobs from Claude.');
    const searchedKeys = new Set(res.searchedUrls.map(urlKey));
    const have = new Set(db.jobs.map((j) => urlKey(j.url)));
    const fresh = [];
    for (const raw of list) {
      if (!raw || !isHttpUrl(raw.url)) continue;
      const key = urlKey(raw.url);
      if (have.has(key)) continue;
      have.add(key);
      fresh.push(normalizeJob(raw, 'ai', searchedKeys));
    }
    await update((d) => d.jobs.unshift(...fresh));

    let done = 0;
    progress(`Verifying 0/${fresh.length}`);
    await pool(fresh, 3, async (j) => {
      try {
        const u = await runVerification(j.id);
        if (u) {
          res.usage.input_tokens += u.input_tokens;
          res.usage.output_tokens += u.output_tokens;
          res.usage.web_searches += u.web_searches;
        }
      } catch (e) {
        console.error('verify failed', j.url, e.message);
      }
      progress(`Verifying ${++done}/${fresh.length}`);
    });
    await recordSearch('jobs', { focus, found: list.length, added: fresh.length, model: res.model, usage: res.usage });
    return { added: fresh.length, found: list.length };
  });
  return { task };
});

route('POST', /^\/api\/discover\/contacts$/, (_m, body) => {
  const focus = str(body.focus, 300);
  const count = clampInt(body.count, 3, 20, 8);
  const companies = Array.isArray(body.companies) ? body.companies.map((c) => str(c, 80)).filter(Boolean).slice(0, 15) : [];
  const task = startTask('contacts', focus || 'People search', async (progress) => {
    const db = getDb();
    progress('Claude is searching the web');
    const res = await ask({
      system: 'You find publicly listed professional contacts. You never guess email addresses or invent people.',
      prompt: P.discoverContactsPrompt(db.profile, { focus, companies, count }),
      model: db.profile.model,
      webSearch: true,
      maxSearches: 10,
      maxTokens: 8000,
    });
    const list = extractJson(res.text);
    if (!Array.isArray(list)) throw new Error('Expected a list of people from Claude.');
    const searchedKeys = new Set(res.searchedUrls.map(urlKey));
    const have = new Set(db.contacts.map((c) => `${c.name}|${c.company}`.toLowerCase()));
    const fresh = [];
    for (const raw of list) {
      const name = str(raw?.name, 120);
      const company = str(raw?.company, 120);
      if (!name || have.has(`${name}|${company}`.toLowerCase())) continue;
      have.add(`${name}|${company}`.toLowerCase());
      const sourceUrl = isHttpUrl(raw.sourceUrl) ? str(raw.sourceUrl, 2000) : '';
      let email = str(raw.email, 200);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) email = '';
      fresh.push({
        id: id(),
        name,
        title: str(raw.title, 160),
        company,
        companyDomain: str(raw.companyDomain, 120),
        profileUrl: isHttpUrl(raw.profileUrl) ? str(raw.profileUrl, 2000) : '',
        email,
        sourceUrl,
        sourceSeen: sourceUrl ? searchedKeys.has(urlKey(sourceUrl)) : false,
        reason: str(raw.reason, 400),
        hook: str(raw.hook, 400),
        status: 'new',
        notes: '',
        draft: null,
        addedAt: new Date().toISOString(),
      });
    }
    await update((d) => d.contacts.unshift(...fresh));
    await recordSearch('contacts', { focus, found: list.length, added: fresh.length, model: res.model, usage: res.usage });
    return { added: fresh.length, found: list.length };
  });
  return { task };
});

route('GET', /^\/api\/tasks\/([\w-]+)$/, ([, tid]) => {
  const t = tasks.get(tid);
  if (!t) throw httpError(404, 'Task not found');
  return { task: t };
});

route('POST', /^\/api\/jobs$/, (_m, body) => {
  const url = str(body.url, 2000);
  if (!isHttpUrl(url)) throw httpError(400, 'Enter a full http(s) link to the posting.');
  if (getDb().jobs.some((j) => urlKey(j.url) === urlKey(url))) throw httpError(409, 'That posting is already on your board.');
  const task = startTask('add', url, async (progress) => {
    progress('Reading the posting');
    let text = '';
    try {
      text = htmlToText((await fetchPage(url)).html);
    } catch {
      /* verification will report reachability */
    }
    let raw = { url };
    if (hasKey()) {
      const res = await ask({ system: 'You extract structured data from job postings.', prompt: P.extractJobPrompt(url, text), model: getDb().profile.model, maxTokens: 1500 });
      raw = { ...extractJson(res.text), url };
    }
    const job = normalizeJob({ ...raw, title: raw.title || str(body.title, 200), company: raw.company || str(body.company, 120) }, 'manual', null);
    job.status = 'saved';
    await update((d) => d.jobs.unshift(job));
    progress('Verifying');
    await runVerification(job.id);
    return { jobId: job.id };
  });
  return { task };
});

route('PATCH', /^\/api\/jobs\/([\w-]+)$/, async ([, jid], body) => {
  const job = await update((d) => {
    const j = d.jobs.find((x) => x.id === jid);
    if (!j) return null;
    if (JOB_STATUSES.includes(body.status)) {
      if (body.status === 'applied' && !j.appliedAt) j.appliedAt = new Date().toISOString();
      j.status = body.status;
    }
    if ('notes' in body) j.notes = str(body.notes, 5000);
    if ('starred' in body) j.starred = Boolean(body.starred);
    if ('deadline' in body && (body.deadline === '' || /^\d{4}-\d{2}-\d{2}$/.test(body.deadline))) j.deadline = body.deadline;
    return j;
  });
  if (!job) throw httpError(404, 'Job not found');
  return { job };
});

route('DELETE', /^\/api\/jobs\/([\w-]+)$/, async ([, jid]) => {
  await update((d) => (d.jobs = d.jobs.filter((j) => j.id !== jid)));
  return { ok: true };
});

route('POST', /^\/api\/jobs\/([\w-]+)\/verify$/, ([, jid]) => {
  if (!getDb().jobs.some((j) => j.id === jid)) throw httpError(404, 'Job not found');
  return { task: startTask('verify', jid, async () => (await runVerification(jid), { jobId: jid })) };
});

route('PATCH', /^\/api\/contacts\/([\w-]+)$/, async ([, cid], body) => {
  const c = await update((d) => {
    const x = d.contacts.find((y) => y.id === cid);
    if (!x) return null;
    if (CONTACT_STATUSES.includes(body.status)) x.status = body.status;
    if ('notes' in body) x.notes = str(body.notes, 5000);
    if ('email' in body) x.email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) ? str(body.email, 200) : '';
    if (body.draft && typeof body.draft === 'object') x.draft = { subject: str(body.draft.subject, 300), body: str(body.draft.body, 5000) };
    return x;
  });
  if (!c) throw httpError(404, 'Contact not found');
  return { contact: c };
});

route('DELETE', /^\/api\/contacts\/([\w-]+)$/, async ([, cid]) => {
  await update((d) => (d.contacts = d.contacts.filter((c) => c.id !== cid)));
  return { ok: true };
});

route('POST', /^\/api\/contacts\/([\w-]+)\/draft$/, async ([, cid], body) => {
  const db = getDb();
  const contact = db.contacts.find((c) => c.id === cid);
  if (!contact) throw httpError(404, 'Contact not found');
  const job = body.jobId ? db.jobs.find((j) => j.id === body.jobId) : null;
  const res = await ask({ system: 'You write short, honest outreach emails for students.', prompt: P.coldEmailPrompt(db.profile, contact, job), model: db.profile.model, maxTokens: 1200 });
  const draft = extractJson(res.text);
  const saved = await update((d) => {
    const c = d.contacts.find((x) => x.id === cid);
    c.draft = { subject: str(draft.subject, 300), body: str(draft.body, 5000) };
    if (c.status === 'new') c.status = 'drafted';
    return c;
  });
  return { contact: saved };
});

route('GET', /^\/api\/export\/jobs\.csv$/, () => {
  const cols = ['status', 'title', 'company', 'location', 'term', 'deadline', 'pay', 'fitScore', 'verdict', 'url', 'appliedAt', 'notes'];
  const esc = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = getDb().jobs.map((j) => cols.map((c) => esc(c === 'verdict' ? j.verification?.overall : j[c])).join(','));
  return { __raw: [cols.join(','), ...rows].join('\n'), type: 'text/csv; charset=utf-8', filename: 'jobs.csv' };
});

// ---------- HTTP plumbing ----------
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'content-type': type, ...SECURITY_HEADERS, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(httpError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(httpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, 'Not found', 'text/plain');
  }
  send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream', { 'cache-control': 'no-cache' });
}

const server = http.createServer(async (req, res) => {
  try {
    // Only answer to localhost names (blocks DNS-rebinding attacks from websites).
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return send(res, 403, { error: 'Forbidden host' });

    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
      return serveStatic(req, res, pathname);
    }

    // Writes must come from this app's own page (blocks cross-site requests).
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Cross-origin request blocked' });
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'Use application/json' });
    }

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.pattern);
      if (!m) continue;
      const body = req.method === 'GET' ? {} : await readBody(req);
      const out = await r.handler(m, body);
      if (out?.__raw !== undefined) {
        return send(res, 200, out.__raw, out.type, { 'content-disposition': `attachment; filename="${out.filename}"` });
      }
      return send(res, 200, out);
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status === 500) console.error(err);
    send(res, status, { error: err.message || 'Server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Job App Central running at http://localhost:${PORT}`);
  if (!hasKey()) console.log('Note: ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.');
});
