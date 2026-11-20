# Job App Central

A job board that runs on your own computer. It uses Claude (with live web search) to find co-op and internship postings and people you could cold-email. It checks each posting before you apply and tracks your applications.

Built for a University of Waterloo co-op search, but every setting can be changed in the Profile tab.

## Quick start

You need Node.js 20 or newer and an Anthropic API key (https://console.anthropic.com/). The app has no npm dependencies.

```bash
git clone https://github.com/controlled-ctrl-hue/Job-App-central.git
cd Job-App-central
cp .env.example .env        # then paste your key after ANTHROPIC_API_KEY=
npm start                   # or: node src/server.js
```

Open http://localhost:4317. Fill in the **Profile** tab first: program, target term, skills, and your resume as plain text. Then press **Find jobs**.

## What it does

**Jobs tab**
- **Find jobs**: Claude searches the web for open intern/co-op postings that match your profile. Add an optional focus such as "fintech in Toronto". New results are compared with your board by link, so a posting is never added twice.
- **Add a link**: paste any posting URL. The app reads the page, pulls out the details, and runs the same checks.
- Each row shows the verification result, a fit score, days left before the deadline, a status dropdown, and an **Apply** button that opens the posting in a new tab. When you return, the app asks whether you applied and records the date if you did.
- Click a row to see the summary, why it fits, skill gaps, requirements, every verification check, your notes, and the deadline.
- Star postings, filter by status, sort by fit/deadline/newest, and export to CSV.

**People tab**
- Claude finds recruiters, campus recruiters, engineering managers, and Waterloo alumni whose names and roles appear on a public page. It skips the rest.
- An email is filled in only if it was published on the source page. The app never guesses addresses.
- **Draft email** writes a short, specific cold email from your resume. You can edit it, then open it in your mail app or copy it. The status updates to Emailed.

**Activity tab**: every search with its token use and web-search count, so you can watch your API spend.

## How verification works

Each posting gets two verdicts. **Real posting** checks whether the posting is legitimate. **Co-op scope** checks whether it suits a co-op student. They combine into **Verified**, **Caution**, or **Failed checks**. Postings that fail are hidden by default, and Apply warns you before opening one.

Automatic checks (no AI):
- The link is on a known applicant tracking system (Greenhouse, Lever, Ashby, Workday, ...) or on the company's own domain. Google Forms, link shorteners, and free site builders fail.
- The link appeared in Claude's real search results. This catches links the AI made up.
- The page loads and doesn't say the posting is closed. Expired `validThrough` dates in the page's JobPosting data also fail.
- Common scam patterns: fees, cheque deposits, buying equipment, interviews over Telegram/WhatsApp, crypto payment, requests for your SIN or bank details up front, and personal Gmail-style contact addresses.
- Scope: the title says intern/co-op. Senior or new-grad titles fail. Asking for 2+ years of experience gets a warning, and so do US roles if you haven't opted in (they need a J-1 visa).

Claude review: Claude reads the page text and the check results, then judges legitimacy, co-op scope, term match, and fit. If the link isn't on a known ATS or the company's domain, Claude also searches the web to confirm the company exists and to look for scam reports.

These checks reduce risk but can't remove it. Never pay to apply, and never share banking details or your SIN before a verified offer.

## Privacy and security

- The server only listens on `127.0.0.1` and rejects requests from other sites (Host and Origin checks), so a web page you visit can't read or change your data.
- Your profile and board are stored in `data/db.json` on your computer. That folder and `.env` are git-ignored. Data leaves your machine only when it's sent to the Claude API.
- The page checker refuses to fetch private or local network addresses, so a malicious link can't probe your home network.
- Scraped text is always rendered as plain text, and the page uses a strict Content Security Policy.

## Configuration

`.env` options (see `.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | (required) | Your API key |
| `CLAUDE_MODEL` | newest Sonnet your key can use | Force a model ID. You can also pick one in Profile. |
| `WEB_SEARCH_TOOL` | `web_search_20250305` | Claude web search tool version |
| `PORT` | `4317` | Local port |
| `DATA_DIR` | `./data` | Where `db.json` is stored |

## Cost

A "Find jobs" run makes up to 12 web searches plus one short Claude review per posting. Exact cost depends on the model. The Activity tab shows token and search counts for each run, and Anthropic's pricing page lists the rates.

## Limits

- WaterlooWorks is behind a login, so it isn't searched. Use the app alongside it.
- Some career sites (Workday, LinkedIn) block automated requests or build the page with JavaScript. Those checks show as "info" rather than failing, and the Claude review carries more weight.

## Project layout

```
src/server.js      HTTP server, API routes, background tasks
src/claude.js      Claude Messages API client (web search, pause_turn handling)
src/prompts.js     All prompts in one place
src/verify.js      Posting verification (checks + Claude review)
src/fetchPage.js   Safe page fetcher (blocks private IPs, size/time limits)
src/store.js       JSON file storage
public/            UI (plain HTML/CSS/JS, no build step)
```
