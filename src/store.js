// Tiny JSON-file store. Single user, single process, so a write queue is enough.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_DB = {
  profile: {
    name: '',
    email: '',
    school: 'University of Waterloo',
    program: '',
    year: '',
    coopTerm: '',            // e.g. "Summer 2027"
    termLength: '4 months',
    sequence: '',            // e.g. "Co-op #1"
    roles: 'Software engineering intern, data/ML intern',
    locations: 'Toronto, Waterloo, Remote (Canada)',
    workAuth: 'Canadian citizen / PR',
    openToUS: false,
    skills: '',
    resume: '',
    links: '',               // GitHub, LinkedIn, portfolio
    model: '',
  },
  jobs: [],
  contacts: [],
  searches: [],
};

let db = null;
let writeChain = Promise.resolve();

function load() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db = { ...structuredClone(DEFAULT_DB), ...parsed, profile: { ...DEFAULT_DB.profile, ...(parsed.profile || {}) } };
  } else {
    db = structuredClone(DEFAULT_DB);
  }
  return db;
}

function persist() {
  const snapshot = JSON.stringify(db, null, 2);
  writeChain = writeChain.then(async () => {
    const tmp = `${DB_FILE}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, snapshot);
    await fs.promises.rename(tmp, DB_FILE);
  });
  return writeChain;
}

export const id = () => crypto.randomUUID();

export function getDb() {
  return load();
}

export async function update(mutator) {
  load();
  const result = mutator(db);
  await persist();
  return result;
}

// Normalize a URL so the same posting found twice dedupes.
export function urlKey(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    for (const p of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|source$|gh_src$|lever-source)/i.test(p)) url.searchParams.delete(p);
    }
    return (url.host.replace(/^www\./, '') + url.pathname.replace(/\/+$/, '') + url.search).toLowerCase();
  } catch {
    return String(u || '').toLowerCase();
  }
}
