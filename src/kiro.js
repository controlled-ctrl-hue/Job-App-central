// Kiro provider: runs `kiro-cli chat --no-interactive` with a custom agent that
// can only use Kiro's web tools (no shell, no file writes), so text from web
// pages can't make it touch your machine. The prompt goes in on stdin and the
// answer comes back on stdout.
//
// Docs: https://kiro.dev/docs/cli/headless.md, https://kiro.dev/docs/custom-agents/creating.md
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CLI = () => process.env.KIRO_CLI_PATH || 'kiro-cli';
const TIMEOUT_MS = () => Number(process.env.KIRO_TIMEOUT_SECS || 600) * 1000;
const WEB_AGENT = 'job-app-web';
const OFFLINE_AGENT = 'job-app-offline';

// Isolated working directory so Kiro doesn't pick up steering/AGENTS.md from
// wherever you cloned this repo. Agents are written here at first use.
const WORKDIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'kiro-workspace');

const baseAgent = {
  includeMcpJson: false,
  excludedTools: ['write', 'shell'],
};
const AGENTS = {
  [WEB_AGENT]: {
    ...baseAgent,
    name: WEB_AGENT,
    description: 'Job App Central: web research only',
    prompt: 'You research jobs and public professional contacts for a student. Use web search and web fetch. Never invent URLs, people, or emails. Follow the output format in the request exactly.',
    tools: ['web'],
    permissions: {
      rules: [
        { capability: 'web_search', effect: 'allow' },
        { capability: 'web_fetch', effect: 'allow' },
        { capability: 'shell', effect: 'deny' },
        { capability: 'write', effect: 'deny' },
      ],
    },
  },
  [OFFLINE_AGENT]: {
    ...baseAgent,
    name: OFFLINE_AGENT,
    description: 'Job App Central: text only, no tools',
    prompt: 'You help a student with job applications. Follow the output format in the request exactly.',
    tools: [],
    permissions: {
      rules: [
        { capability: 'shell', effect: 'deny' },
        { capability: 'write', effect: 'deny' },
      ],
    },
  },
};

function ensureAgents() {
  const dir = path.join(WORKDIR, '.kiro', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, cfg] of Object.entries(AGENTS)) {
    const file = path.join(dir, `${name}.json`);
    const json = JSON.stringify(cfg, null, 2);
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== json) fs.writeFileSync(file, json);
  }
}

export class KiroError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

export function hasKiroKey() {
  return Boolean(process.env.KIRO_API_KEY);
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

function run(args, input) {
  if (!hasKiroKey()) throw new KiroError('KIRO_API_KEY is not set. Add it to .env and restart.', 400);
  ensureAgents();
  return new Promise((resolve, reject) => {
    // No shell: arguments are passed as an array, so nothing in the prompt is interpreted.
    const child = spawn(CLI(), args, {
      cwd: WORKDIR,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new KiroError(`kiro-cli timed out after ${TIMEOUT_MS() / 1000}s`, 504));
    }, TIMEOUT_MS());
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT'
        ? new KiroError('kiro-cli not found. Install it (macOS/Linux: curl -fsSL https://cli.kiro.dev/install | bash) or set KIRO_CLI_PATH.', 400)
        : e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const tail = stripAnsi(err).trim().split('\n').slice(-6).join('\n');
      if (code === 0) return resolve({ stdout: stripAnsi(out), stderr: stripAnsi(err) });
      if (code === 4) return reject(new KiroError(`kiro-cli could not find the app's agent (exit 4). ${tail}`));
      reject(new KiroError(`kiro-cli exited with code ${code}. ${tail || 'Check that KIRO_API_KEY is valid and your plan has credits.'}`));
    });
    child.stdin.on('error', () => {}); // process may exit before reading everything
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Same contract as claude.ask(): returns { text, searchedUrls, usage, model }. */
export async function kiroAsk({ system, prompt, model, webSearch = false, maxSearches = 8 }) {
  const args = ['chat', '--v3', '--no-interactive', '--agent', webSearch ? WEB_AGENT : OFFLINE_AGENT];
  if (model) args.push('--model', model);
  if (webSearch) args.push('--trust-tools=remote_web_search,web_fetch');

  const fullPrompt = [
    system ? `ROLE\n${system}\n` : '',
    webSearch ? `Use at most ${maxSearches} web searches.\n` : 'Do not use any tools.\n',
    prompt,
  ].join('\n');

  const { stdout } = await run(args, fullPrompt);
  // Kiro's text output doesn't list the pages it searched in a form we can rely on,
  // so searchedUrls stays empty and the "link was in search results" check reports
  // "not available". The page-load check still catches dead or made-up links.
  return {
    text: stdout,
    searchedUrls: null,
    usage: { input_tokens: 0, output_tokens: 0, web_searches: 0 },
    model: model || process.env.KIRO_MODEL || 'Kiro default',
  };
}

export async function kiroListModels() {
  const { stdout } = await run(['chat', '--list-models', '--format', 'json']);
  let data;
  try {
    data = JSON.parse(stdout.slice(stdout.search(/[[{]/)));
  } catch {
    return [{ id: 'auto', name: 'auto' }];
  }
  const list = Array.isArray(data) ? data : data.models || data.data || [];
  const models = list
    .map((m) => (typeof m === 'string' ? { id: m, name: m } : { id: m.id || m.modelId || m.model_id || m.name, name: m.name || m.displayName || m.id || m.modelId }))
    .filter((m) => m.id);
  return models.length ? models : [{ id: 'auto', name: 'auto' }];
}
