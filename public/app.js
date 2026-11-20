// Job App Central UI. Plain JS, no build step.
// All scraped/AI text goes through textContent (never innerHTML) so a malicious posting can't inject script.

const state = {
  tab: 'jobs',
  data: null,
  open: new Set(),
  jobFilter: { status: 'active', verdict: 'hideRejected', q: '', sort: 'fit' },
  pendingApply: null,
  tasks: new Map(),
  models: null,
};

// ---------- tiny DOM helper ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM, allowed by the strict CSP
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const safeUrl = (u) => {
  try {
    const url = new URL(u);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
};
function starIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.7l5.9-.9z');
  svg.append(path);
  return svg;
}
const extLink = (href, text) => (safeUrl(href) ? h('a', { href: safeUrl(href), target: '_blank', rel: 'noopener noreferrer' }, text) : null);
const host = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function toast(msg, ms = 2800) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

async function refresh({ background = false } = {}) {
  state.data = await api('/api/state');
  for (const t of state.data.tasks) if (!state.tasks.has(t.id)) trackTask(t);
  // Don't wipe a half-edited profile when a background task finishes.
  if (background && state.tab === 'profile') return;
  render();
}

function trackTask(task, onDone) {
  state.tasks.set(task.id, task);
  renderTaskbar();
  const poll = async () => {
    try {
      const { task: t } = await api(`/api/tasks/${task.id}`);
      state.tasks.set(t.id, t);
      renderTaskbar();
      if (t.status === 'running') return setTimeout(poll, 2000);
      state.tasks.delete(t.id);
      renderTaskbar();
      if (t.status === 'error') toast(t.error, 6000);
      else onDone?.(t.result);
      await refresh({ background: true });
    } catch (e) {
      state.tasks.delete(task.id);
      renderTaskbar();
      toast(e.message);
    }
  };
  setTimeout(poll, 1500);
}

function renderTaskbar() {
  const bar = document.getElementById('taskbar');
  bar.replaceChildren();
  for (const t of state.tasks.values()) {
    bar.append(h('span', { class: 'row' }, h('span', { class: 'spinner' }), `${t.label.slice(0, 40)}: ${t.progress}`));
  }
}

// ---------- shared bits ----------
const VERDICT_TEXT = { verified: 'Verified', caution: 'Caution', rejected: 'Failed checks' };
const STATUS_TEXT = { new: 'New', saved: 'Saved', applied: 'Applied', interviewing: 'Interviewing', offer: 'Offer', rejected: 'Rejected', archived: 'Archived' };

function verdictBadge(job) {
  const v = job.verification;
  if (!v) return h('span', { class: 'badge' }, h('span', { class: 'spinner' }), 'Checking');
  return h('span', { class: 'badge', title: `Real: ${v.trust} · Co-op fit: ${v.scope}` }, h('span', { class: `dot ${v.overall}` }), VERDICT_TEXT[v.overall]);
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T23:59:59`);
  return Math.ceil((d - Date.now()) / 86_400_000);
}

function banner() {
  const el = document.getElementById('banner');
  el.replaceChildren();
  const d = state.data;
  if (!d.hasKey) {
    el.append(h('div', { class: 'notice' }, 'Add your Anthropic API key to ', h('code', {}, '.env'), ' (see ', h('code', {}, '.env.example'), ') and restart the server to enable AI search.'));
  } else if (!d.profile.program || !d.profile.coopTerm) {
    el.append(h('div', { class: 'notice' }, 'Fill in your ', h('a', { href: '#', onclick: (e) => (e.preventDefault(), go('profile')) }, 'profile'), ' (program, term, skills, resume) so results match you.'));
  }
}

// ---------- Jobs ----------
function jobsView() {
  const d = state.data;
  const f = state.jobFilter;
  const jobs = d.jobs;

  const counts = (s) => jobs.filter((j) => j.status === s).length;
  const dueSoon = jobs.filter((j) => ['new', 'saved'].includes(j.status) && (daysUntil(j.deadline) ?? 99) <= 7 && daysUntil(j.deadline) >= 0).length;

  const focus = h('input', { class: 'grow', placeholder: 'Optional focus, e.g. "fintech in Toronto" or "embedded / hardware"', value: state.jobFocus || '', oninput: (e) => (state.jobFocus = e.target.value) });
  const count = h('select', {}, [8, 12, 20].map((n) => h('option', { value: n, selected: n === 12 }, `${n} jobs`)));
  const findBtn = h('button', {
    class: 'btn primary',
    disabled: !d.hasKey,
    onclick: async () => {
      findBtn.disabled = true;
      try {
        const { task } = await api('/api/discover/jobs', { method: 'POST', body: { focus: focus.value, count: count.value } });
        trackTask(task, (r) => toast(`Added ${r.added} new postings`));
        toast('Searching. This usually takes 1 to 3 minutes.');
      } catch (e) {
        toast(e.message);
      } finally {
        findBtn.disabled = false;
      }
    },
  }, 'Find jobs');

  const addUrl = h('input', { class: 'grow', type: 'url', placeholder: 'Paste a posting link to add and verify it' });
  const addBtn = h('button', {
    class: 'btn',
    onclick: async () => {
      if (!addUrl.value.trim()) return;
      try {
        const { task } = await api('/api/jobs', { method: 'POST', body: { url: addUrl.value.trim() } });
        addUrl.value = '';
        trackTask(task, () => toast('Added and verified'));
      } catch (e) {
        toast(e.message);
      }
    },
  }, 'Add');

  const statusChips = [
    ['active', 'Active'], ['new', 'New'], ['saved', 'Saved'], ['applied', 'Applied'], ['interviewing', 'Interviewing'], ['offer', 'Offer'], ['rejected', 'Rejected'], ['archived', 'Archived'], ['all', 'All'],
  ].map(([k, label]) => h('button', { class: `chip ${f.status === k ? 'on' : ''}`, onclick: () => ((f.status = k), render()) }, label));

  const verdictSel = h('select', { onchange: (e) => ((f.verdict = e.target.value), render()) },
    [['hideRejected', 'Hide failed'], ['verified', 'Verified only'], ['all', 'Show all']].map(([v, t]) => h('option', { value: v, selected: f.verdict === v }, t)));
  const sortSel = h('select', { onchange: (e) => ((f.sort = e.target.value), render()) },
    [['fit', 'Best fit'], ['deadline', 'Deadline'], ['newest', 'Newest']].map(([v, t]) => h('option', { value: v, selected: f.sort === v }, t)));
  const q = h('input', { placeholder: 'Filter', class: 'filter', value: f.q, oninput: (e) => { f.q = e.target.value; renderJobList(); } });

  const listEl = h('div', { class: 'list', id: 'joblist' });

  const wrap = h('div', {},
    h('div', { class: 'row' }, focus, count, findBtn),
    h('div', { class: 'row', style: 'margin-top:8px' }, addUrl, addBtn),
    h('div', { class: 'stats' },
      [['New', counts('new')], ['Applied', counts('applied')], ['Interviewing', counts('interviewing')], ['Offers', counts('offer')], ['Due in 7 days', dueSoon]]
        .map(([k, v]) => h('div', { class: 'stat' }, h('b', {}, v), h('span', {}, k))),
      h('span', { class: 'spacer' }),
      h('a', { class: 'btn ghost sm', href: '/api/export/jobs.csv', download: 'jobs.csv' }, 'Export CSV')),
    h('div', { class: 'row', style: 'margin-top:16px' }, h('div', { class: 'chips' }, statusChips), h('span', { class: 'spacer' }), q, verdictSel, sortSel),
    listEl,
  );
  queueMicrotask(renderJobList);
  return wrap;
}

function filteredJobs() {
  const f = state.jobFilter;
  const q = f.q.toLowerCase();
  let list = state.data.jobs.filter((j) => {
    if (f.status === 'active' && ['archived', 'rejected'].includes(j.status)) return false;
    if (!['active', 'all'].includes(f.status) && j.status !== f.status) return false;
    const v = j.verification?.overall;
    if (f.verdict === 'hideRejected' && v === 'rejected') return false;
    if (f.verdict === 'verified' && v !== 'verified') return false;
    if (q && !`${j.title} ${j.company} ${j.location} ${j.term}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const by = {
    fit: (a, b) => (b.starred - a.starred) || ((b.fitScore ?? -1) - (a.fitScore ?? -1)),
    deadline: (a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999'),
    newest: (a, b) => b.addedAt.localeCompare(a.addedAt),
  }[f.sort];
  return list.sort(by);
}

function renderJobList() {
  const el = document.getElementById('joblist');
  if (!el) return;
  const jobs = filteredJobs();
  const hidden = state.data.jobs.filter((j) => j.verification?.overall === 'rejected').length;
  el.replaceChildren(...(jobs.length ? jobs.map(jobItem) : [h('div', { class: 'empty' }, state.data.jobs.length ? 'Nothing matches these filters.' : 'No jobs yet. Fill in your profile, then press Find jobs.')]));
  if (hidden && state.jobFilter.verdict === 'hideRejected') {
    el.append(h('div', { class: 'small muted', style: 'padding:10px 4px' }, `${hidden} posting${hidden > 1 ? 's' : ''} hidden because they failed verification.`));
  }
}

async function patchJob(job, body) {
  const { job: updated } = await api(`/api/jobs/${job.id}`, { method: 'PATCH', body });
  Object.assign(job, updated);
}

function applyTo(job) {
  const v = job.verification;
  if (v?.overall === 'rejected') {
    const why = v.checks.filter((c) => c.result === 'fail').map((c) => `• ${c.label}: ${c.detail}`).join('\n');
    if (!confirm(`This posting failed verification:\n\n${why}\n\nOpen it anyway?`)) return;
  }
  window.open(safeUrl(job.url), '_blank', 'noopener,noreferrer');
  state.pendingApply = job.id;
  state.open.add(job.id);
  renderJobList();
}

function jobItem(job) {
  const isOpen = state.open.has(job.id);
  const due = daysUntil(job.deadline);
  const statusSel = h('select', {
    onclick: (e) => e.stopPropagation(),
    onchange: async (e) => {
      await patchJob(job, { status: e.target.value });
      render();
    },
  }, Object.entries(STATUS_TEXT).map(([k, t]) => h('option', { value: k, selected: job.status === k }, t)));

  const head = h('div', { class: 'item-head', onclick: () => { isOpen ? state.open.delete(job.id) : state.open.add(job.id); renderJobList(); } },
    h('button', { class: `star ${job.starred ? 'on' : ''}`, title: job.starred ? 'Unstar' : 'Star', 'aria-pressed': String(job.starred), onclick: async (e) => { e.stopPropagation(); await patchJob(job, { starred: !job.starred }); renderJobList(); } }, starIcon()),
    h('div', {},
      h('div', { class: 'title' }, job.title || 'Untitled role'),
      h('div', { class: 'sub' }, [job.company, job.location, job.term && job.term !== 'unspecified' ? job.term : null, job.pay].filter(Boolean).join(' · '))),
    verdictBadge(job),
    h('span', { class: 'fit', title: 'Fit with your profile' }, job.fitScore != null ? `${job.fitScore}%` : ''),
    h('span', { class: `due ${due != null && due <= 7 && due >= 0 ? 'soon' : ''}` }, due == null ? '' : due < 0 ? 'Closed' : due === 0 ? 'Due today' : `${due}d left`),
    h('div', { class: 'row', style: 'flex-wrap:nowrap' }, statusSel,
      h('button', { class: 'btn primary sm', title: 'Opens the posting in a new tab', disabled: !safeUrl(job.url), onclick: (e) => { e.stopPropagation(); applyTo(job); } }, 'Apply')),
  );

  if (!isOpen) return h('div', { class: 'item' }, head);
  return h('div', { class: 'item' }, head, jobBody(job));
}

function jobBody(job) {
  const v = job.verification;
  const notes = h('textarea', { rows: 3, placeholder: 'Notes (referral, contact, interview dates...)', value: job.notes || '' });
  notes.addEventListener('change', () => patchJob(job, { notes: notes.value }).then(() => toast('Saved')));
  const deadline = h('input', { type: 'date', value: job.deadline || '', onchange: (e) => patchJob(job, { deadline: e.target.value }).then(renderJobList) });

  const left = h('div', {},
    state.pendingApply === job.id && job.status !== 'applied'
      ? h('div', { class: 'notice applybar', style: 'margin-bottom:12px' }, 'Did you submit the application?',
        h('button', { class: 'btn sm primary', onclick: async () => { state.pendingApply = null; await patchJob(job, { status: 'applied' }); render(); toast('Marked as applied'); } }, 'Yes, mark applied'),
        h('button', { class: 'btn sm ghost', onclick: () => { state.pendingApply = null; renderJobList(); } }, 'Not yet'))
      : null,
    job.summary && [h('div', { class: 'label' }, 'Summary'), h('p', {}, job.summary)],
    (job.fitNotes || job.whyFit) && [h('div', { class: 'label' }, 'Fit'), h('p', {}, job.fitNotes || job.whyFit)],
    job.missingSkills?.length ? h('p', { class: 'small muted' }, `Gaps to address: ${job.missingSkills.join(', ')}`) : null,
    job.requirements?.length ? [h('div', { class: 'label' }, 'Requirements'), h('ul', {}, job.requirements.map((r) => h('li', {}, r)))] : null,
    h('div', { class: 'label' }, 'Notes'), notes,
    h('div', { class: 'row small muted', style: 'margin-top:8px' }, 'Deadline', deadline,
      job.appliedAt ? `· Applied ${job.appliedAt.slice(0, 10)}` : null,
      `· Added ${job.addedAt.slice(0, 10)}`),
  );

  const checks = v
    ? h('ul', { class: 'checks' }, v.checks.map((c) => h('li', {}, h('span', { class: `dot ${c.result}` }), h('span', { class: 'muted' }, c.label), h('span', {}, c.detail))))
    : h('p', { class: 'muted small' }, 'Verification in progress.');

  const right = h('div', {},
    h('div', { class: 'label' }, 'Verification'),
    v ? h('p', { class: 'small' },
      h('span', { class: 'badge' }, h('span', { class: `dot ${v.trust}` }), 'Real posting'), '   ',
      h('span', { class: 'badge' }, h('span', { class: `dot ${v.scope}` }), 'Co-op scope')) : null,
    checks,
    v?.aiError ? h('p', { class: 'small', style: 'color:var(--warn)' }, `Claude review failed: ${v.aiError}`) : null,
    v ? h('p', { class: 'small muted' }, `Checked ${new Date(v.checkedAt).toLocaleString()}`) : null,
    h('div', { class: 'links', style: 'margin:10px 0' }, extLink(job.url, host(job.url) || 'Open posting'), job.companyDomain ? extLink(`https://${job.companyDomain}`, job.companyDomain) : null),
    h('div', { class: 'row' },
      h('button', { class: 'btn sm', onclick: async () => { const { task } = await api(`/api/jobs/${job.id}/verify`, { method: 'POST', body: {} }); trackTask(task, () => toast('Re-verified')); } }, 'Re-verify'),
      h('button', { class: 'btn sm', disabled: !state.data.hasKey, onclick: () => { state.peopleCompany = job.company; go('people'); } }, 'Find people here'),
      h('button', { class: 'btn sm ghost danger', onclick: async () => { if (!confirm('Delete this posting?')) return; await api(`/api/jobs/${job.id}`, { method: 'DELETE', body: {} }); refresh(); } }, 'Delete')),
  );
  return h('div', { class: 'item-body' }, left, right);
}

// ---------- People ----------
function peopleView() {
  const d = state.data;
  const focus = h('input', { class: 'grow', placeholder: 'Optional focus, e.g. "Waterloo alumni at Toronto startups"' });
  const companies = h('input', { class: 'grow', placeholder: 'Companies (comma-separated)', value: state.peopleCompany || '' });
  state.peopleCompany = '';
  const btn = h('button', {
    class: 'btn primary',
    disabled: !d.hasKey,
    onclick: async () => {
      try {
        const { task } = await api('/api/discover/contacts', {
          method: 'POST',
          body: { focus: focus.value, companies: companies.value.split(',').map((s) => s.trim()).filter(Boolean) },
        });
        trackTask(task, (r) => toast(`Added ${r.added} people`));
        toast('Searching. This usually takes 1 to 2 minutes.');
      } catch (e) {
        toast(e.message);
      }
    },
  }, 'Find people');

  const cards = d.contacts.filter((c) => c.status !== 'archived').map(contactCard);
  return h('div', {},
    h('div', { class: 'row' }, companies, focus, btn),
    h('p', { class: 'small muted' }, 'Only people with a public page are listed. Emails are shown only when they were published on that page; Claude never guesses addresses.'),
    h('div', { style: 'margin-top:16px' }, cards.length ? cards : h('div', { class: 'empty' }, 'No contacts yet.')),
  );
}

function contactCard(c) {
  const statusSel = h('select', { onchange: async (e) => { await api(`/api/contacts/${c.id}`, { method: 'PATCH', body: { status: e.target.value } }); refresh(); } },
    ['new', 'drafted', 'emailed', 'replied', 'archived'].map((s) => h('option', { value: s, selected: c.status === s }, s[0].toUpperCase() + s.slice(1))));

  const subject = h('input', { style: 'width:100%;margin-bottom:6px', value: c.draft?.subject || '' });
  const body = h('textarea', { rows: 8, value: c.draft?.body || '' });
  const saveDraft = () => api(`/api/contacts/${c.id}`, { method: 'PATCH', body: { draft: { subject: subject.value, body: body.value } } });
  subject.addEventListener('change', saveDraft);
  body.addEventListener('change', saveDraft);

  const emailInput = h('input', { type: 'email', placeholder: 'Add email if you find one', value: c.email || '', style: 'width:220px' });
  emailInput.addEventListener('change', () => api(`/api/contacts/${c.id}`, { method: 'PATCH', body: { email: emailInput.value } }).then(() => toast('Saved')));

  const mailto = () => `mailto:${encodeURIComponent(emailInput.value.trim())}?subject=${encodeURIComponent(subject.value)}&body=${encodeURIComponent(body.value)}`;

  return h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('span', { class: 'title' }, c.name),
      h('span', { class: 'sub' }, [c.title, c.company].filter(Boolean).join(' · ')),
      h('span', { class: 'spacer' }),
      c.sourceUrl && !c.sourceSeen ? h('span', { class: 'badge', title: "Source page wasn't in Claude's search results. Double-check this person." }, h('span', { class: 'dot warn' }), 'Unconfirmed source') : null,
      statusSel),
    c.reason ? h('p', { style: 'margin:6px 0' }, c.reason) : null,
    h('div', { class: 'links' }, extLink(c.profileUrl, 'Profile'), extLink(c.sourceUrl, `Source (${host(c.sourceUrl)})`)),
    h('div', { class: 'row', style: 'margin-top:10px' }, emailInput,
      h('button', {
        class: 'btn sm',
        disabled: !state.data.hasKey,
        onclick: async (e) => {
          e.target.disabled = true;
          e.target.textContent = 'Writing';
          try {
            await api(`/api/contacts/${c.id}/draft`, { method: 'POST', body: {} });
            state.openDraft = c.id;
            await refresh();
          } catch (err) {
            toast(err.message);
            e.target.disabled = false;
          }
        },
      }, c.draft ? 'Rewrite email' : 'Draft email'),
      c.draft ? h('button', { class: 'btn sm ghost', onclick: () => { state.openDraft = state.openDraft === c.id ? null : c.id; render(); } }, state.openDraft === c.id ? 'Hide draft' : 'Show draft') : null,
      h('button', { class: 'btn sm ghost danger', onclick: async () => { if (!confirm('Remove this contact?')) return; await api(`/api/contacts/${c.id}`, { method: 'DELETE', body: {} }); refresh(); } }, 'Remove')),
    c.draft && state.openDraft === c.id
      ? h('div', { style: 'margin-top:10px' }, subject, body,
        h('div', { class: 'row', style: 'margin-top:6px' },
          h('button', { class: 'btn sm primary', onclick: async () => { await saveDraft(); location.href = mailto(); if (c.status !== 'emailed') api(`/api/contacts/${c.id}`, { method: 'PATCH', body: { status: 'emailed' } }).then(refresh); } }, 'Open in mail app'),
          h('button', { class: 'btn sm', onclick: () => navigator.clipboard.writeText(`Subject: ${subject.value}\n\n${body.value}`).then(() => toast('Copied')) }, 'Copy')))
      : null,
  );
}

// ---------- Profile ----------
function profileView() {
  const p = state.data.profile;
  const field = (key, label, attrs = {}) => h('label', { class: attrs.full ? 'full' : '' }, label,
    attrs.rows ? h('textarea', { name: key, rows: attrs.rows, placeholder: attrs.placeholder || '', value: p[key] || '' }) : h('input', { name: key, placeholder: attrs.placeholder || '', value: p[key] || '' }));

  const modelSel = h('select', { name: 'model' }, h('option', { value: '' }, 'Auto (newest Sonnet)'),
    p.model ? h('option', { value: p.model, selected: true }, p.model) : null);
  if (state.data.hasKey) {
    (state.models ? Promise.resolve(state.models) : api('/api/models').then((r) => (state.models = r.models))).then((models) => {
      for (const m of models) if (m.id !== p.model) modelSel.append(h('option', { value: m.id }, m.name));
    }).catch(() => {});
  }

  const form = h('form', {
    class: 'profile',
    onsubmit: async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const body = Object.fromEntries(fd.entries());
      body.openToUS = fd.has('openToUS');
      await api('/api/profile', { method: 'PUT', body });
      await refresh();
      toast('Profile saved');
    },
  },
    field('name', 'Name'),
    field('email', 'Email'),
    field('program', 'Program', { placeholder: 'e.g. Computer Engineering' }),
    field('year', 'Year / term', { placeholder: 'e.g. 2A' }),
    field('coopTerm', 'Target co-op term', { placeholder: 'e.g. Summer 2027' }),
    field('termLength', 'Term length', { placeholder: '4 months / 8 months' }),
    field('sequence', 'Co-op number', { placeholder: 'e.g. First co-op' }),
    field('workAuth', 'Work authorization'),
    field('roles', 'Target roles', { full: true }),
    field('locations', 'Preferred locations', { full: true }),
    field('skills', 'Skills', { full: true, placeholder: 'Python, React, C++, SQL, ...' }),
    field('links', 'Links', { full: true, placeholder: 'GitHub, LinkedIn, portfolio' }),
    h('label', { class: 'check full' }, h('input', { type: 'checkbox', name: 'openToUS', checked: p.openToUS }), 'Include US roles (needs a J-1 visa)'),
    field('resume', 'Resume (paste as plain text)', { full: true, rows: 14 }),
    h('label', {}, 'Claude model', modelSel),
    h('div', { class: 'full' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save profile')),
  );
  return h('div', {}, h('p', { class: 'muted' }, 'Claude uses this to search and to judge fit. It stays on your computer except when sent to the Claude API.'), form);
}

// ---------- Activity ----------
function activityView() {
  const s = state.data.searches;
  if (!s.length) return h('div', { class: 'empty' }, 'No searches yet.');
  return h('table', { class: 'log' },
    h('thead', {}, h('tr', {}, ['When', 'Type', 'Focus', 'Found', 'Added', 'Web searches', 'Tokens in / out', 'Model'].map((t) => h('th', {}, t)))),
    h('tbody', {}, s.map((r) => h('tr', {},
      h('td', {}, new Date(r.at).toLocaleString()),
      h('td', {}, r.kind === 'jobs' ? 'Jobs' : 'People'),
      h('td', {}, r.focus || '—'),
      h('td', {}, r.found), h('td', {}, r.added),
      h('td', {}, r.usage?.web_searches ?? ''),
      h('td', {}, r.usage ? `${r.usage.input_tokens.toLocaleString()} / ${r.usage.output_tokens.toLocaleString()}` : ''),
      h('td', { class: 'small muted' }, r.model || '')))));
}

// ---------- shell ----------
function go(tab) {
  state.tab = tab;
  render();
}

function render() {
  if (!state.data) return;
  banner();
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.tab === state.tab);
  const view = { jobs: jobsView, people: peopleView, profile: profileView, activity: activityView }[state.tab]();
  document.getElementById('view').replaceChildren(view);
}

document.getElementById('tabs').addEventListener('click', (e) => {
  const tab = e.target.dataset?.tab;
  if (tab) go(tab);
});

refresh().catch((e) => toast(e.message));
