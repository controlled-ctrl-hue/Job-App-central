// Posting verification: deterministic checks first, then a Claude review.
// Two separate questions: "is this posting real?" (trust) and
// "is it a co-op/intern role that fits me?" (scope).
import { fetchPage, htmlToText, extractJobPostingLd, pageTitle } from './fetchPage.js';
import { ask, extractJson } from './claude.js';
import { profileSummary } from './prompts.js';

const ATS_HOSTS = [
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com', 'workday.com', 'smartrecruiters.com',
  'jobvite.com', 'icims.com', 'bamboohr.com', 'workable.com', 'recruitee.com', 'breezy.hr', 'jazzhr.com',
  'applytojob.com', 'taleo.net', 'successfactors.com', 'oraclecloud.com', 'eightfold.ai', 'dayforcehcm.com',
  'ultipro.com', 'rippling.com', 'teamtailor.com', 'personio.com', 'pinpointhq.com', 'gem.com',
  'wellfound.com', 'ycombinator.com', 'workatastartup.com', 'uwaterloo.ca',
];
const AGGREGATORS = ['linkedin.com', 'indeed.com', 'glassdoor.com', 'glassdoor.ca', 'ziprecruiter.com', 'simplyhired.com', 'talent.com', 'jobbank.gc.ca', 'monster.com', 'builtin.com', 'handshake.com', 'joinhandshake.com', 'simplify.jobs', 'github.com'];
const RISKY_HOSTS = ['forms.gle', 'docs.google.com', 'sites.google.com', 'wixsite.com', 'weebly.com', 'blogspot.com', 'bit.ly', 'tinyurl.com', 't.me', 'wa.me', 'linktr.ee', 'jotform.com', 'typeform.com', 'carrd.co'];

const SCAM_PATTERNS = [
  [/gift ?cards?/i, 'mentions gift cards'],
  [/wire (the )?(money|funds|transfer)/i, 'asks for wire transfers'],
  [/cashier'?s? che(ck|que)|deposit (the|a) che(ck|que)|send you a che(ck|que)/i, 'cheque-deposit pattern (classic overpayment scam)'],
  [/purchase (your own |the )?(equipment|laptop|software)/i, 'asks you to buy equipment'],
  [/(training|registration|application|onboarding) fee/i, 'charges a fee'],
  [/(interview|chat|contact)[^.]{0,40}\b(telegram|whatsapp|signal app|google hangouts)\b/i, 'interview over a chat app'],
  [/\b(bitcoin|crypto ?wallet|usdt)\b/i, 'payment in crypto'],
  [/no (interview|experience) (required|needed)[^.]{0,60}\$\s?\d{3,}/i, 'high pay with no interview/experience'],
  [/(social insurance number|SIN number|bank (account )?details)[^.]{0,60}(before|to apply|application)/i, 'asks for SIN/bank details up front'],
];
const CLOSED_PATTERNS = /no longer (accepting applications|available|open)|position (has been|is) (filled|closed)|job (is )?(closed|not found|has expired)|this (job|posting|position) (has )?(expired|closed)|page (you are looking for|not found)/i;
const FREE_MAIL = /[a-z0-9._%+-]+@(gmail|yahoo|hotmail|outlook|aol|proton(mail)?|icloud|gmx|yandex|mail)\.(com|ca|me|ru)\b/i;

const INTERN_TITLE = /\b(intern(ship)?|co-?op|co op|student|placement|apprentice|work term|pey)\b/i;
const SENIOR_TITLE = /\b(senior|sr\.?|staff|principal|lead|manager|director|head of|vp|vice president|architect)\b/i;
const FULLTIME_TITLE = /\b(new grad(uate)?|university grad(uate)?|full[- ]time|entry[- ]level)\b/i;
const US_LOC = /\b(USA|United States|U\.S\.|San Francisco|New York|NYC|Seattle|Boston|Austin|Chicago|Los Angeles|Bay Area|Palo Alto|Mountain View|Menlo Park|Sunnyvale|Redmond|CA|NY|WA|MA|TX|IL|NJ|CO|GA|VA|PA|FL|NC)\b/;

const hostOf = (u) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};
const hostIs = (host, list) => list.some((d) => host === d || host.endsWith(`.${d}`));
const check = (group, label, result, detail = '') => ({ group, label, result, detail });

function heuristicChecks(job, page, profile) {
  const checks = [];
  const host = hostOf(page?.finalUrl || job.url);
  const companyDomain = String(job.companyDomain || '').toLowerCase().replace(/^www\./, '');

  // --- Trust ---
  if (!/^https?:\/\//i.test(job.url)) checks.push(check('trust', 'Valid link', 'fail', 'Not an http(s) URL'));
  else if (job.url.startsWith('https://')) checks.push(check('trust', 'HTTPS', 'pass'));
  else checks.push(check('trust', 'HTTPS', 'warn', 'Link is not encrypted'));

  if (hostIs(host, RISKY_HOSTS)) checks.push(check('trust', 'Hosting', 'fail', `${host} is a form/short-link/free-site host, not a real applicant tracking system`));
  else if (hostIs(host, ATS_HOSTS)) checks.push(check('trust', 'Hosting', 'pass', `Hosted on a known applicant tracking system (${host})`));
  else if (companyDomain && hostIs(host, [companyDomain])) checks.push(check('trust', 'Hosting', 'pass', `On the company's own domain (${host})`));
  else if (hostIs(host, AGGREGATORS)) checks.push(check('trust', 'Hosting', 'info', `Job board listing (${host}); prefer applying on the company site`));
  else checks.push(check('trust', 'Hosting', 'warn', `Unrecognized domain ${host}${companyDomain ? ` (company domain is ${companyDomain})` : ''}`));

  if (job.origin === 'ai') {
    if (job.seenInSearch) checks.push(check('trust', 'Source', 'pass', "Link appeared in Claude's live search results"));
    else checks.push(check('trust', 'Source', 'warn', "Link wasn't in Claude's search results, so it may be made up"));
  }

  let text = '';
  let ld = [];
  if (page?.error) {
    checks.push(check('trust', 'Page reachable', 'warn', `Could not load: ${page.error}`));
  } else if (page) {
    text = htmlToText(page.html);
    ld = extractJobPostingLd(page.html);
    if (page.status === 404 || page.status === 410) checks.push(check('trust', 'Page reachable', 'fail', `HTTP ${page.status}: posting is gone`));
    else if (page.status >= 400) checks.push(check('trust', 'Page reachable', 'info', `HTTP ${page.status}: site blocks automated checks, open it yourself`));
    else checks.push(check('trust', 'Page reachable', 'pass', `HTTP ${page.status}`));

    if (page.status < 400 && CLOSED_PATTERNS.test(text.slice(0, 20000))) {
      checks.push(check('trust', 'Still open', 'fail', 'Page says the posting is closed or missing'));
    }
    if (page.redirects.length && hostOf(page.redirects[0]) !== host) {
      checks.push(check('trust', 'Redirects', 'info', `Redirected to ${host}`));
    }
    if (ld.length) {
      const p = ld[0];
      checks.push(check('trust', 'Structured posting data', 'pass', 'Page publishes schema.org JobPosting data'));
      if (p.validThrough && new Date(p.validThrough) < new Date()) {
        checks.push(check('trust', 'Still open', 'fail', `Posting expired ${String(p.validThrough).slice(0, 10)}`));
      }
      const org = p.hiringOrganization?.name || p.hiringOrganization;
      if (typeof org === 'string' && job.company && !org.toLowerCase().includes(job.company.toLowerCase().split(/\s+/)[0])) {
        checks.push(check('trust', 'Employer name', 'warn', `Page lists employer as "${org}"`));
      }
    } else if (page.status < 400 && text.length < 600) {
      checks.push(check('trust', 'Page content', 'info', 'Page renders with JavaScript, so only limited text could be checked'));
    }
  }

  const haystack = `${job.summary || ''} ${job.description || ''} ${text}`.slice(0, 60000);
  const scamHits = SCAM_PATTERNS.filter(([re]) => re.test(haystack)).map(([, why]) => why);
  if (scamHits.length) checks.push(check('trust', 'Scam signals', 'fail', scamHits.join('; ')));
  else checks.push(check('trust', 'Scam signals', 'pass', 'No common scam phrases found'));
  const freeMail = haystack.match(FREE_MAIL);
  if (freeMail) checks.push(check('trust', 'Contact email', 'warn', `Uses a personal email (${freeMail[0]})`));

  // --- Scope (co-op fit) ---
  const title = job.title || (ld[0]?.title ?? '');
  const isIntern = INTERN_TITLE.test(title) || /intern/i.test(String(ld[0]?.employmentType || ''));
  if (isIntern) checks.push(check('scope', 'Student role', 'pass', 'Title or posting marks it as intern/co-op'));
  else if (FULLTIME_TITLE.test(title)) checks.push(check('scope', 'Student role', 'fail', 'Full-time / new-grad role, not a co-op'));
  else checks.push(check('scope', 'Student role', 'warn', "Title doesn't say intern or co-op"));

  if (!isIntern && SENIOR_TITLE.test(title)) checks.push(check('scope', 'Seniority', 'fail', 'Senior/lead-level title'));

  const yrs = [...haystack.matchAll(/(\d{1,2})\s*\+?\s*(?:-\s*\d+\s*)?years?\s+(?:of\s+)?(?:professional\s+|industry\s+|relevant\s+|work\s+)?experience/gi)]
    .map((m) => Number(m[1]))
    .filter((n) => n < 30);
  if (yrs.length && Math.max(...yrs) >= 2) checks.push(check('scope', 'Experience asked', 'warn', `Asks for ${Math.max(...yrs)}+ years of experience`));

  const loc = `${job.location || ''}`;
  if (!profile.openToUS && US_LOC.test(loc) && !/canada|remote.*canada|toronto|waterloo|vancouver|montreal/i.test(loc)) {
    checks.push(check('scope', 'Location', 'warn', 'US-based: you would need a J-1 visa and US-eligible co-op approval'));
  }

  return { checks, text, ld };
}

function needsCompanyLookup(checks) {
  const hosting = checks.find((c) => c.label === 'Hosting');
  return !hosting || hosting.result !== 'pass';
}

async function aiReview(job, profile, heur) {
  const pageText = heur.text.slice(0, 14000);
  const lookup = needsCompanyLookup(heur.checks);
  const prompt = `You are checking a job posting for a University of Waterloo co-op student. Be skeptical and concise.

STUDENT
${profileSummary(profile)}

POSTING (as recorded)
${JSON.stringify({ title: job.title, company: job.company, companyDomain: job.companyDomain, url: job.url, location: job.location, term: job.term, summary: job.summary }, null, 2)}

AUTOMATED CHECK RESULTS
${heur.checks.map((c) => `- [${c.result}] ${c.label}: ${c.detail}`).join('\n')}

PAGE TEXT (may be empty if the site renders with JavaScript)
${pageText || '(none)'}
${heur.ld.length ? `\nSTRUCTURED JOBPOSTING DATA\n${JSON.stringify(heur.ld[0]).slice(0, 3000)}` : ''}
${lookup ? '\nThe link is not on a known ATS or the company domain. Use web search (at most 2 searches) to confirm the company exists, the domain belongs to it, and there are no scam reports.' : ''}

Field meanings: isCoopScope = an internship/co-op a current undergrad can do as a work term. termMatch = does it run in the student's target term. fitScore = 0-100 match between the student's skills and the role.
Answer with ONLY a JSON object (no comments) in a \`\`\`json block:
{
  "legitimacy": "likely_real | uncertain | likely_scam",
  "legitimacyReasons": ["short reason"],
  "isCoopScope": true,
  "scopeReasons": ["short reason"],
  "termMatch": "yes | no | unclear",
  "fitScore": 0,
  "fitNotes": "one or two sentences",
  "missingSkills": ["skill"],
  "fields": { "title": "", "company": "", "location": "", "term": "", "duration": "", "pay": "", "deadline": "YYYY-MM-DD or empty" }
}`;
  const res = await ask({
    system: 'You verify job postings for students. You never invent facts. If the evidence is thin, say "uncertain".',
    prompt,
    model: profile.model,
    webSearch: lookup,
    maxSearches: 2,
    maxTokens: 2000,
  });
  return { ...extractJson(res.text), usage: res.usage };
}

function summarize(checks, ai) {
  const group = (g) => checks.filter((c) => c.group === g);
  const verdictOf = (list) => (list.some((c) => c.result === 'fail') ? 'fail' : list.some((c) => c.result === 'warn') ? 'caution' : 'pass');

  let trust = verdictOf(group('trust'));
  let scope = verdictOf(group('scope'));
  if (ai) {
    if (ai.legitimacy === 'likely_scam') trust = 'fail';
    else if (ai.legitimacy === 'uncertain' && trust === 'pass') trust = 'caution';
    if (ai.isCoopScope === false) scope = 'fail';
    else if (ai.termMatch === 'no' && scope !== 'fail') scope = 'caution';
  }
  const overall = trust === 'fail' || scope === 'fail' ? 'rejected' : trust === 'pass' && scope === 'pass' ? 'verified' : 'caution';
  return { trust, scope, overall };
}

/** Verify one job. Returns a verification record plus any fields Claude filled in. */
export async function verifyJob(job, profile, { useAi = true } = {}) {
  let page = null;
  try {
    page = await fetchPage(job.url);
  } catch (e) {
    page = { error: e.name === 'TimeoutError' ? 'timed out' : e.cause?.code ? `${e.message} (${e.cause.code})` : e.message };
  }
  const heur = heuristicChecks(job, page, profile);
  const checks = heur.checks;

  let ai = null;
  let aiError = null;
  if (useAi) {
    try {
      ai = await aiReview(job, profile, heur);
      for (const r of ai.legitimacyReasons || []) checks.push(check('trust', 'Claude review', ai.legitimacy === 'likely_real' ? 'pass' : ai.legitimacy === 'likely_scam' ? 'fail' : 'warn', r));
      for (const r of ai.scopeReasons || []) checks.push(check('scope', 'Claude review', ai.isCoopScope ? 'pass' : 'fail', r));
      if (ai.termMatch === 'no') checks.push(check('scope', 'Term', 'warn', `Doesn't appear to run in ${profile.coopTerm || 'your term'}`));
    } catch (e) {
      aiError = e.message;
    }
  }

  const verdict = summarize(checks, ai);
  return {
    verification: {
      checkedAt: new Date().toISOString(),
      ...verdict,
      checks,
      page: page && !page.error ? { status: page.status, finalUrl: page.finalUrl, title: pageTitle(page.html).slice(0, 200) } : null,
      aiError,
    },
    fitScore: ai?.fitScore ?? job.fitScore ?? null,
    fitNotes: ai?.fitNotes || job.fitNotes || '',
    missingSkills: ai?.missingSkills || job.missingSkills || [],
    fields: ai?.fields || {},
    usage: ai?.usage,
  };
}

// Exported for tests / manual use.
export const _internals = { heuristicChecks, summarize, hostOf };
