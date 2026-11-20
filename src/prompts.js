// Prompt builders. Kept in one place so they're easy to tune.

export function profileSummary(p) {
  const line = (k, v) => (v ? `${k}: ${v}\n` : '');
  return (
    line('Name', p.name) +
    line('School', p.school) +
    line('Program', p.program) +
    line('Year', p.year) +
    line('Target co-op term', p.coopTerm) +
    line('Term length', p.termLength) +
    line('Co-op sequence', p.sequence) +
    line('Target roles', p.roles) +
    line('Preferred locations', p.locations) +
    line('Work authorization', p.workAuth) +
    line('Open to US roles (J-1)', p.openToUS ? 'yes' : 'no') +
    line('Skills', p.skills) +
    line('Links', p.links) +
    (p.resume ? `Resume:\n${p.resume.slice(0, 6000)}\n` : '')
  ).trim();
}

const today = () => new Date().toISOString().slice(0, 10);

export function discoverJobsPrompt(profile, { focus, count, exclude }) {
  return `Today is ${today()}. Find real, currently open co-op / internship postings for this University of Waterloo student.

STUDENT
${profileSummary(profile)}

${focus ? `FOCUS FOR THIS SEARCH: ${focus}\n` : ''}
RULES
- Search the live web. Prefer the employer's own careers page or its applicant tracking system (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, etc.). Use LinkedIn/Indeed only if there is no direct link.
- Every "url" MUST be a page you actually saw in search results and MUST be the specific posting, not a careers home page. Never construct or guess URLs.
- Only roles for students: internship, co-op, work term, student position. Skip full-time, new-grad, and senior roles.
- Match the target term and length when the posting states them. Include postings that don't state a term but say so in "term".
- Respect work authorization: ${profile.openToUS ? 'US roles are OK.' : 'skip US-only roles; Canada and Canada-remote only.'}
- Skip anything that looks like a scam (fees, chat-app interviews, cheque deposits, vague "remote assistant" roles).
- Aim for ${count} postings across different companies.${exclude.length ? `\n- Already have these, do not repeat: ${exclude.slice(0, 80).join(', ')}` : ''}

Return ONLY a JSON array in a \`\`\`json block. Each item:
{"title":"","company":"","companyDomain":"company.com","url":"","location":"","remote":"onsite|hybrid|remote|unknown","term":"e.g. Summer 2027 or unspecified","duration":"","deadline":"YYYY-MM-DD or empty","postedDate":"YYYY-MM-DD or empty","pay":"","summary":"two sentences","requirements":["..."],"whyFit":"one sentence tied to the student's skills","fitScore":0}`;
}

export function discoverContactsPrompt(profile, { focus, companies, count }) {
  return `Today is ${today()}. Find people this University of Waterloo co-op student could reasonably cold-email about internship / co-op opportunities.

STUDENT
${profileSummary(profile)}

${companies.length ? `PRIORITIZE THESE COMPANIES: ${companies.join(', ')}\n` : ''}${focus ? `FOCUS: ${focus}\n` : ''}
WHO TO FIND
- University / campus recruiters, technical recruiters, engineering managers or founders at small companies, and Waterloo alumni who publicly invite student outreach.
- Prefer people at companies that hire Waterloo co-ops.

PRIVACY AND ACCURACY RULES
- Only include people whose name and role you saw on a public page (company site, team page, conference talk, public LinkedIn profile, personal site).
- "email" must be an address that is publicly published on a page you saw. Never guess or construct an email from a name pattern. Leave it empty otherwise.
- "sourceUrl" must be the page where you found the person.
- Aim for ${count} people.

Return ONLY a JSON array in a \`\`\`json block. Each item:
{"name":"","title":"","company":"","companyDomain":"","profileUrl":"","email":"","sourceUrl":"","reason":"one sentence: why this person is a good contact","hook":"one specific, true detail to mention in an email"}`;
}

export function coldEmailPrompt(profile, contact, job) {
  return `Write a short cold email from this co-op student to the contact below.

STUDENT
${profileSummary(profile)}

CONTACT
${JSON.stringify({ name: contact.name, title: contact.title, company: contact.company, reason: contact.reason, hook: contact.hook }, null, 2)}
${job ? `\nRELATED POSTING\n${JSON.stringify({ title: job.title, url: job.url, summary: job.summary }, null, 2)}` : ''}

GUIDELINES
- Under 130 words. Plain text. No flattery, no buzzwords, no "I hope this email finds you well".
- One specific reason for writing to this person (use the hook only if it's concrete).
- One or two concrete things the student has built or done, taken from the resume. Don't invent anything.
- A small, easy ask (a 15-minute chat, or who to talk to about ${profile.coopTerm || 'co-op'} roles).
- Sign off with the student's name and links.

Return ONLY JSON in a \`\`\`json block: {"subject":"","body":""}`;
}

export function extractJobPrompt(url, pageText) {
  return `Extract the job posting at ${url} from this page text. Use only what's on the page; leave fields empty if not stated.

PAGE TEXT
${pageText.slice(0, 14000) || '(page text unavailable)'}

Return ONLY JSON in a \`\`\`json block:
{"title":"","company":"","companyDomain":"","location":"","remote":"onsite|hybrid|remote|unknown","term":"","duration":"","deadline":"YYYY-MM-DD or empty","postedDate":"","pay":"","summary":"two sentences","requirements":["..."]}`;
}
