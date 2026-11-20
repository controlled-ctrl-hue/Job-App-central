# Job App Central

A job board that runs on your own computer. It uses AI with live web search (through Kiro, or the Anthropic API directly) to find co-op and internship postings and people you could cold-email. It checks each posting before you apply and tracks your applications.

Built for a University of Waterloo co-op search, but every setting can be changed in the Profile tab.

## Quick start

You need Node.js 20 or newer. The app has no npm dependencies.

### With Kiro (default)

1. Install `kiro-cli`:
   - macOS: `brew install kiro-cli`, or `curl -fsSL https://cli.kiro.dev/install | bash`
   - Linux: `curl -fsSL https://cli.kiro.dev/install | bash`
   - Windows 11 (PowerShell): `irm 'https://cli.kiro.dev/install.ps1' | iex`
2. Create an API key at https://app.kiro.dev under **API Keys**. You need a Pro plan or higher. The key starts with `ksk_` and is shown only once.
3. Run:

```bash
git clone https://github.com/controlled-ctrl-hue/Job-App-central.git
cd Job-App-central
cp .env.example .env        # then paste your key after KIRO_API_KEY=
npm start                   # or: node src/server.js
```

Usage comes out of your Kiro plan's credits.

### With an Anthropic key instead

Set `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY=` in `.env` (key from https://console.anthropic.com/).

Open http://localhost:4317. Fill in the **Profile** tab first: program, target term, skills, and your resume as plain text. Then press **Find jobs**.

## What it does

**Jobs tab**
- **Find jobs**: the AI searches the web for open intern/co-op postings that match your profile. Add an optional focus such as "fintech in Toronto". New results are compared with your board by link, so a posting is never added twice.
- **Add a link**: paste any posting URL. The app reads the page, pulls out the details, and runs the same checks.
- Each row shows the verification result, a fit score, days left before the deadline, a status dropdown, and an **Apply** button that opens the posting in a new tab. When you return, the app asks whether you applied and records the date if you did.
- Click a row to see the summary, why it fits, skill gaps, requirements, every verification check, your notes, and the deadline.
- Star postings, filter by status, sort by fit/deadline/newest, and export to CSV.

**People tab**
- The AI finds recruiters, campus recruiters, engineering managers, and Waterloo alumni whose names and roles appear on a public page. It skips the rest.
- An email is filled in only if it was published on the source page. The app never guesses addresses.
- **Draft email** writes a short, specific cold email from your resume. You can edit it, then open it in your mail app or copy it. The status updates to Emailed.

**Activity tab**: every search with its token use and web-search count, so you can watch your API spend.

## How verification works

Each posting gets two verdicts. **Real posting** checks whether the posting is legitimate. **Co-op scope** checks whether it suits a co-op student. They combine into **Verified**, **Caution**, or **Failed checks**. Postings that fail are hidden by default, and Apply warns you before opening one.

Automatic checks (no AI):
- The link is on a known applicant tracking system (Greenhouse, Lever, Ashby, Workday, ...) or on the company's own domain. Google Forms, link shorteners, and free site builders fail.
- The link appeared in the AI's real search results (Anthropic backend only; Kiro's CLI doesn't report its search results, so this shows as info and the page-load check covers made-up links).
- The page loads and doesn't say the posting is closed. Expired `validThrough` dates in the page's JobPosting data also fail.
- Common scam patterns: fees, cheque deposits, buying equipment, interviews over Telegram/WhatsApp, crypto payment, requests for your SIN or bank details up front, and personal Gmail-style contact addresses.
- Scope: the title says intern/co-op. Senior or new-grad titles fail. Asking for 2+ years of experience gets a warning, and so do US roles if you haven't opted in (they need a J-1 visa).

AI review: the AI reads the page text and the check results, then judges legitimacy, co-op scope, term match, and fit. If the link isn't on a known ATS or the company's domain, it also searches the web to confirm the company exists and to look for scam reports.

These checks reduce risk but can't remove it. Never pay to apply, and never share banking details or your SIN before a verified offer.

## Privacy and security

- The server only listens on `127.0.0.1` and rejects requests from other sites (Host and Origin checks), so a web page you visit can't read or change your data.
- Your profile and board are stored in `data/db.json` on your computer. That folder and `.env` are git-ignored. Data leaves your machine only when it's sent to Kiro or the Claude API.
- With Kiro, the app runs `kiro-cli` with its own agent that can only use the web search and web fetch tools. Shell and file-write tools are excluded, so text on a scraped page can't make it run commands or edit files. It runs in `data/kiro-workspace/`, away from your other projects.
- The page checker refuses to fetch private or local network addresses, so a malicious link can't probe your home network.
- Scraped text is always rendered as plain text, and the page uses a strict Content Security Policy.

## Configuration

`.env` options (see `.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_PROVIDER` | `kiro` if `KIRO_API_KEY` is set, else `anthropic` | Which backend to use |
| `KIRO_API_KEY` | (required for Kiro) | Your Kiro API key (`ksk_...`) |
| `KIRO_MODEL` | Kiro's default | Model ID such as `claude-sonnet-4.6`. You can also pick one in Profile. |
| `KIRO_CLI_PATH` | `kiro-cli` | Path to the CLI if it isn't on your PATH |
| `KIRO_TIMEOUT_SECS` | `600` | Max seconds per `kiro-cli` run |
| `ANTHROPIC_API_KEY` | (required for Anthropic) | Your Anthropic API key |
| `CLAUDE_MODEL` | newest Sonnet your key can use | Force a model ID. You can also pick one in Profile. |
| `WEB_SEARCH_TOOL` | `web_search_20250305` | Claude web search tool version |
| `PORT` | `4317` | Local port |
| `DATA_DIR` | `./data` | Where `db.json` is stored |

## Cost

A "Find jobs" run makes up to 12 web searches plus one short AI review per posting. With Kiro, this uses your plan's credits; check usage in your Kiro account, since the CLI doesn't report token counts to the app. With Anthropic, the Activity tab shows token and search counts for each run.

## Limits

- WaterlooWorks is behind a login, so it isn't searched. Use the app alongside it.
- Some career sites (Workday, LinkedIn) block automated requests or build the page with JavaScript. Those checks show as "info" rather than failing, and the AI review carries more weight.

## Project layout

```
src/server.js      HTTP server, API routes, background tasks
src/claude.js      AI client: picks the backend; Claude Messages API calls (web search, pause_turn)
src/kiro.js        Kiro backend: runs kiro-cli headless with a web-only agent
src/prompts.js     All prompts in one place
src/verify.js      Posting verification (checks + AI review)
src/fetchPage.js   Safe page fetcher (blocks private IPs, size/time limits)
src/store.js       JSON file storage
public/            UI (plain HTML/CSS/JS, no build step)
```
