# Job Search Copilot

Production-minded job triage and application-prep assistant for software engineering roles.

This project helps you evaluate postings, decide whether to apply, choose a resume strategy, generate practical application assets, and track what happened after you applied, while keeping hard rules and realism constraints explicit.

## A. Project Overview

The app ingests job posts (pasted text, URL, or a one-click capture from the Chrome extension), extracts structured data, scores fit conservatively, recommends whether to apply, suggests a resume, and supports on-demand generation of application materials.

A Gmail dashboard reads your application emails, groups them into applications with their current status, recovers the original job description for each one, and scores it blind to the outcome so you can see whether the fit score predicts real results.

A low-cost agentic layer sits on top: a daily agent that finds your next steps (follow-ups, thank-yous, interview prep) and an on-demand chat assistant that answers questions about your search. Email drafts and most tracker changes wait for your approval. Silent applications auto-lapse in the tracker (and un-lapse if a later email shows progress); the app never sends email (see "Agentic layer" below).

It is designed as an operator assistant, not an autonomous applier. I built it in Cursor with an AI coding agent (see section N).

## B. Features

**Triage and prep**

- Structured job extraction from pasted text/URL inputs
- Conservative fit scoring: capability ± survivability adjustment − gap dock, with explicit hard gates and rule penalties
- Recommendation is the score tier, nothing else: Strong apply (80+), Apply (65–79), Apply but weak (stretch) (50–64), Weak (under 50, including hard-gated roles, which are capped at 25 and show the gate reason)
- Resume recommendation between your two resume variants: `BASE` (general) and `AI` (specialized). See section H. Older records may show legacy `SWE`/`SIE`/`EARLY_CAREER`
- On-demand generation of cover letter, why-company, talking points, and bullet candidates
- Tracker workflow with an explicit "confirm applied" flow, editable applied date, and notes. The tracker is ordered by applied date, newest first; a lapsed or rejected role keeps its applied date, and rows never applied to sort last. Last-updated times live on the dashboard (and in the date tooltip)
- Tracker import from a spreadsheet (`xlsx`)
- Top Jobs: daily scan of LinkedIn, Indeed, ZipRecruiter, and Remote Hunter job-alert emails (needs Gmail connected). Only remote or NYC roles that are still open are kept; roles are de-duplicated against the tracker and past applications, scored, and filtered by score. A cheap batched pre-screen ranks queued alert titles first, so the few paid scorings (5 per run, $2/month cap) go to the most promising roles. Listed roles are rechecked and hidden once the posting closes. "I applied" confirms you applied today, moves the row onto the tracker, and hides it from Top Jobs
- Local resume context grounding from files on your machine

**Chrome extension (capture)**

- Side panel that captures the JD from the current page and scores it with your local API
- Capture methods, best first: your text selection, JSON-LD `JobPosting` data, known JD containers on common boards, or paste
- Duplicate captures of the same URL are reused. "Re-score" forces a fresh score
- Recent captures list with a link to the full assessment in the web app

**Gmail dashboard (`/`)**

- Google OAuth with exactly two scopes: `gmail.readonly` and `gmail.drafts.create` (create drafts only, never send). Full email bodies are never stored, only a per-message classification
- Free rule-based prefilter, then an LLM classifier: applied, assessment, interview, rejected, offer, other. Calendar invites from company domains count as interviews
- Groups emails into applications by company and role, tracks status and the furthest stage reached (e.g. "rejected after interviewing"), and flags estimated applied dates when no confirmation email exists. Two openings at one company stay separate when their titles name different specialties ("Content Data Products" vs "AI Platforms and Products"), and a bare "Software Engineer" email only joins an opening when exactly one matches. Meeting or stage names ("Initial Screen Call", "Phone Interview") are not treated as job titles- Interview rounds: each interview email gets a small extra LLM read for the round number, what the round is and who it's with. Emails about the same round (invite, calendar invite, reschedule) are grouped together, and the status shows "Recruiter screen", "2nd round", "3rd round · technical with Jane Doe", or "rejected after 2nd round". Each sync also backfills round details for older interview emails, whatever their age
- Interview vs interviewing: the "Interview" status card counts applications that reached an interview in the window. Being actively in process is shown separately: an "Interviewing" pill (an open application with an upcoming interview or interview email in the last 21 days, otherwise "Interviewed") and an "Interviewing now" list in the upcoming interviews card
- Upcoming interviews: the top of the dashboard lists confirmed interview times from the last 60 days of email, soonest first, with company, role, round, date and time (with a "Today" / "Tomorrow" / "In N days" badge). Reschedules replace the earlier time; cancelled interviews and rejected roles drop off. Times stated without a timezone use `USER_TIMEZONE` (defaults to your machine's zone)
- Scoring details: click any fit score to open the full breakdown: category scores, survivability, hard gates and the rules that fired, penalties, extractor output and the stored JD. Scores given before this snapshot existed can be audited with "Run diagnostic re-score", which re-runs the stored JD and saves the result separately. The original score never changes
- Matches applications to tracker rows and suggests status updates (e.g. "Update to Rejected"). A row matches on company (exact, or the shorter name leading the longer word for word, so "Pave" = "Pave Finance"), a similar role, and applied dates within 21 days
- Scored applications with no tracker row are added to the tracker automatically, once, from the stored score (never re-scored), with their Gmail status history
- Interview prep: "Prep" on an upcoming interview opens a short brief (company bio, the round, likely questions with what to say, your strongest matches and weak spots, questions to ask). It's generated once per application, stored, and never feeds the score. Answers are kept to complete sentences. The brief can be read as sections, a minimal page, tabs, rehearsal flip cards, or an atmospheric layout
- 7- or 30-day window. Syncing again only processes new mail

**JD recovery and blind scoring**

For each application, the app tries to find the original posting, verifies it is the same job, and only then scores it. The scorer sees only the JD text and a company hint, never the emails or the outcome. Steps, cheapest first, stopping at the first verified match:

1. The email itself: an inline JD, or posting links (Greenhouse, Lever, Ashby, Workday, LinkedIn guest pages, JSON-LD)
2. Company job boards named in the emails (sender domains, Workday tenant links, Greenhouse embeds)
3. Guessed board slugs on the free public APIs: Greenhouse, Lever, Ashby, SmartRecruiters, Workable (cached per company)
4. Serper web search, only when no company board was found, within a lifetime query budget

Verification rules:

- Requisition ID match, or exactly one open job on the company's own board with a near-identical title (strict title similarity, level markers like I/II kept)
- Ties are broken by the title or city named in the email. Identical postings repeated per location are merged
- Anything weaker is kept as a candidate for you to pick, or you can paste the JD yourself

Scores are final: a scored row is never re-scored by later syncs, recovery runs, or a change in the application's key. Each new score stores its full scoring detail (click the score to see it). A deliberate one-off rescore of every stored JD is only done by hand after a scoring bug fix, never automatically.

**Agentic layer (approval-based)**

Two features act on your behalf, both built so that the model only reads and suggests. Email drafts and most tracker changes go through a card you approve. One exception: after 30 days of silence on an open application, the tracker is marked `lapsed` automatically; a later process email (interview, assessment, offer, rejection) moves it forward again.

*Next steps agent (dashboard card)*

- Once a day, after the first Gmail sync past 7am (or "Refresh" on the card), free rules scan your applications for:
  - a pending request to reply to (schedule, assessment, offer)
  - an interview in the next 3 days (prep)
  - an interview in the last 2 days (thank-you)
  - no reply for 7–29 days mid-process (follow-up)
- Open tracker rows with no email for 30+ days are marked `lapsed` automatically (no Next steps card). A later Gmail update moves the row from `lapsed` to the new status (interviewing, assessment, offer, rejected)
- One gpt-5-mini call then ranks the new items, explains each in a sentence, and writes short email drafts. Items written on an earlier day are rewritten in that same daily call, so priorities and wording stay current; items written today, dismissed, or done are not paid for again. Due times show the date with a live countdown ("Oct 6, 10:45 AM (in 23h)"), so the text never carries a stale "in N hours". About $0.001–0.02 per day
- What it does on its own: write suggestions and draft text inside the app, and auto-lapse / un-lapse tracker rows from Gmail silence or later process email. What waits for you: "Approve" on remaining tracker-change cards; "Create Gmail draft" opens an editor (recipient + text) and saves a reply draft in the original thread

*Chat assistant (every page)*

- "Ask assistant" (bottom right) answers plain-language questions ("What should I do today?", "Which applications went quiet?", "Draft a follow-up for my last interview") from your applications, tracker, Top Jobs queue, Next steps, stored JDs, and costs
- It works through read-only lookup tools, at most 6 model steps per message with only the last 6 turns of history sent. About $0.002–0.01 per message
- It can propose three actions, each shown as a card: change a tracker status, draft a reply email (editable before it's saved as a Gmail draft), or score a queued Top Jobs listing. Approve runs exactly the stored card, once; the model can't trigger it itself

*Safety and cost model*

- Gmail permissions are read + create drafts. The app has no send permission and no send code; every email is sent by you from Gmail. Recipients are checked (one address, no no-reply/ATS senders) and replies are threaded to the original message
- Every paid feature has a hard monthly cap, spread evenly over the days left in the month: Top Jobs $2, Next steps agent $1.50, chat assistant $1.50, insights summary $0.30. When a day's share is used up, the feature falls back to free rules or says so without calling the model
- The cost card shows this month's spend per feature against its cap

**Application insights (dashboard card)**

- Compares the applications that led to a call or interview (a recruiter screen or later, or an offer) with the ones that didn't, across your whole tracker and Gmail history. A Gmail application linked to a tracker row counts once. Assessments alone, rejections, lapsed roles and 30+ days of silence count as no; applications under 30 days old are left out as too early
- Shows whether the fit score predicts callbacks (callback rate per score tier with plausible ranges, and an AUC check against chance, shown with the callback count and a Wilson interval). Headlines stay calibrated: a named test can be called conclusive; the card does not lead with a single "Conclusive" pill. With a small number of callbacks the wording is that the pattern is promising, not a firm apply rule
- Coverage: how many decided applications have a fit score, how many don't and why (posting not found, fetch failed, unverified match, scoring failed, tracker row never scored, no JD), callbacks among scored vs outside that group, and whether the applied date is confirmed (tracker date or Gmail applied email) or inferred
- Seniority and screening: campus / new-grad vs junior vs mid vs senior from stored title, years, and existing rules (not a new classifier). Crossed with degree (required vs equivalent vs none). Specialized AI / FDE is a cross-cut, not a seniority band. Cells are descriptive when counts are small
- Also shows what the roles that heard back have in common (resume, location and work model, seniority, years asked, employer scale, applicant pool, domain, language gaps, degree, salary, where the posting lives, posting age, day applied), and the good fits (65+) that went quiet. Employer scale splits Mid-size from Unknown. Each pattern row shows how many applications could not be classified for that feature
- Every comparison is tested for chance (Fisher's exact test with a false-discovery correction across all patterns). A pattern is only called conclusive with at least 15 applications on each side, enough responses, and a gap of 10+ points. When nothing clears that bar the card says the differences look like randomness
- Conclusive patterns that are knowable before you apply become proposal cards. Nothing changes until you approve one; approved adjustments apply only to roles scored from then on (±4 each, ±8 total, never on hard-gated roles), show up as "Your history" in the scoring details, and stay frozen with that role. Existing scores never change, and you can turn an adjustment off at any time
- Runs weekly after a Gmail sync, or on demand with Re-run. The statistics are free; an optional plain-English summary uses a $0.30/month cap (`INSIGHTS_MONTHLY_BUDGET_USD`), well under a cent per run
- The older fit-score-by-outcome detail is folded into the card
- From Gmail, an application counts as reaching a person when a call or interview was booked (a calendar invite or a confirmed time), or when an employer's person (not an automated sender) emailed about an interview. A staffing agency's own screening call doesn't count; it only counts once the agency books an interview with the employer (hiring manager, technical, team, onsite or final round) or an offer. Leftover invites that can't be tied to a role don't count as an extra application when that company already has one
- The tracker's "Heard back?" button in the status column cycles through Heard back ✓ (a call or interview happened, e.g. a phone screen with no email trail), No call ✕ (none happened, whatever Gmail shows) and unmarked. For mail from before Gmail was connected, run the Gmail backfill (see section K)

**Dashboard metrics**
- Where the JDs came from: verified and candidate counts per source (email, company boards, Serper, pasted), with Serper usefulness and budget
- OpenAI cost: today, last 7 days, this month (with per-feature caps), per scored role, per email, and by feature, estimated from OpenAI-reported token counts
- A low-budget warning when 20% or less of the Serper budget is left

**Look and feel**

- Three themes from the picker in the top bar: Paper (default: warm cream paper, ink text, terracotta accent, serif headings), Dark (indigo), and Classic dark (the original). The choice is remembered per browser
- Score pills always keep their tier colors (green 80+, blue 65+, amber 50+, red below) in every theme

**Recent fixes**

Data integrity:

- Tests can no longer touch your real database: under vitest, `getDb()` refuses to connect unless a test harness injected an isolated DB. A JD recovery test had been writing fixture jobs into the tracker through the auto-add step; those rows were removed
- Score snapshots saved under the old recommendation labels ("Yes", "If quick", "Skip") are shown with the current tier label on read; the stored scores are unchanged

Scoring:

- A posting that states a field-specific bachelor's as required and a separate "or equivalent" line is scored as conflicting (a middle dock), not as a full equivalent-experience pass
- A platform/SRE-style title alone no longer puts a role in the infrastructure lane; it needs at least one infrastructure or enablement signal. Product-builder JDs (React/frontend, user experience, LLM features) stay in a product lane. Listings that explicitly ask for personal projects or open source floor employer-recognizability and credential signal when the candidate has a portfolio
- Go detection no longer fires on English "go" ("evaluations that go beyond benchmarks"). "Golang" always counts; a bare "Go" only counts in a language context: listed with other languages or frameworks, under a `Languages:`/`Stack:` label, alone on a line, or framed as "experience with Go", "Go services", "Strong Go required". One shared detector is used everywhere, including the deterministic extractor that previously copied every match into required skills
- The seniority hard gate (caps the score at 25) only fires when the posting obviously wants more experience: 5+ minimum years (from the years field or Required text; ranges count by their lower bound), senior-depth asks (capacity planning, performance tuning, memory management…), or people-leadership asks (direct reports, managing a team, years leading). A Senior/Staff/Principal title or Seniority label without those asks is an ambitious stretch, not a gate. An inferred "senior" label with nothing in the posting to back it is flagged for manual review. The heuristic extractor reads seniority from the title only, so body text like "senior client engineers" or "technical staff at our clients" no longer marks a role senior
- Experience gap: below the gate, the JD's years range is weighed against `screeningYears` in your profile. The dock is 2 points per year under the minimum plus 1 per year the range extends above it (at 2 years: "2–6 years" −4, "2–5 years" −3, "3–5 years" −4, "2+ years" 0; max −8). A mid-level label with no stated years is −3 unless the title says junior/entry/associate/I. The title stretch counts as −8, and the two together are capped at −12
- These seniority/experience docks are applied as a ceiling on level fit (18/20 minus the dock in level-fit points), not as a separate subtraction. The AI's level fit already judges experience, so a role it already marked down isn't docked twice, while a role it rated fully matched loses about the dock. The reason and the ceiling are shown under "Rules that fired"
- New scores store the AI's raw category scores, so a rule fix can be replayed on stored scores exactly (no AI calls, no run-to-run noise) with `replayStoredScore`
- The location hard gate no longer fires on a preferred location ("Based in San Francisco (preferred)"), regardless of how the extractor reads the work model
- All scored roles were rescored once after these fixes, then replayed deterministically with the experience-gap and level-fit-ceiling rules
- Referral language is gone. The old labels (`apply_cold`, `referral_gated`, `stretch_signal`, `skip`, `no`) came from a capability/survivability matrix that could disagree with the score, and nearly every 50–84 role read "get a referral". The recommendation is now the four score tiers above, the "referral advice" line under the score was removed, and stored roles were relabeled without changing any score

Gmail dashboard:

- Calendar invites Gmail renames for new senders ("Invitation from an unknown sender: …") are recognised as interviews; older dropped invites are re-checked automatically
- Applications split by a mangled company name are merged when they share the same company email domain
- A new booking after the previous round's interview was held starts the next round, so a follow-up meeting isn't folded into the recruiter screen
- Interview confirmation phrasing ("your interview with … is confirmed", recruiter/initial screen) is recognised as application mail. A meeting title is not stored as the job title, so it doesn't create a fake opening

## C. Repo Structure (High-Level)

- `apps/api/` - Express API, scoring/rules/orchestration, Gmail sync and JD recovery, import/verify scripts
  - `src/services/gmail/` - OAuth, sync, prefilter/classifier, application grouping
  - `src/services/gmail/jdRecovery/` - email evidence, ATS board APIs, posting fetchers, matching, Serper, metrics
  - `src/services/llm/` - OpenAI Responses client (structured calls and the tool-calling loop), usage/cost tracking, per-feature monthly budgets
  - `src/services/agent/` - daily Next steps agent (rule-based candidates, one budgeted LLM pass, suggestions store)
  - `src/services/assistant/` - chat assistant (tools, proposal cards, thread storage)
  - `src/services/proposals/` - the only code paths that apply approved actions (tracker status, Gmail draft)
  - `src/services/topJobs/` - alert parsing, pre-screen, location/open checks, budgeted scoring
  - `src/services/insights/` - callback statistics, coverage and seniority tables, weekly summary
- `apps/web/` - React + Vite frontend (Dashboard, Add Job, Top Jobs, Tracker)
- `apps/extension/` - Chrome MV3 side-panel extension (React + Vite)
- `scripts/` - root helper scripts (eval/regression utilities)
- `.env.example` - safe template for local environment config

## D. Setup Instructions

1. Install dependencies:
   - `npm install`
2. Create your local env file from the template:
   - `cp .env.example .env`
3. Fill in local values in `.env` (Mongo + OpenAI at minimum; see section E).
4. Start the API:
   - `npm run dev` (same as `npm run dev --workspace api`)
5. Start the web app in a second terminal:
   - `npm run dev:web`
6. Optional: set up the Chrome extension (section J) and the Gmail dashboard (section K).

## E. Environment Variables

The app reads environment configuration from the repository-root `.env`. See `.env.example` for every key with comments.

Required:

- `PORT`, `MONGO_URI`, `MONGO_DB_NAME`
- `OPENAI_API_KEY`, `OPENAI_MODEL` (default `gpt-5-mini`)

Optional, by feature:

- **Triage / resumes:** `RESUME_CONTEXT_DIR`, `PRELOAD_RESUME_CONTEXT_ON_START`, `TRIAGE_FAST_MODE`, `TRIAGE_SKIP_LLM_RESUME_SELECTION_IN_FAST_MODE`
- **Tracker seed:** `AUTO_IMPORT_TRACKER_ON_START`, `TRACKER_SEED_WORKBOOK_PATH`
- **Web:** `VITE_API_BASE_URL` (web -> API base URL)
- **Top Jobs:** `TOP_JOBS_SYNC_ENABLED`, `TOP_JOBS_*` (Gmail connection required; `SERPER_API_KEY` enables the Indeed/ZipRecruiter fallback), `TOP_JOBS_MONTHLY_BUDGET_USD` (default $2), `TOP_JOBS_MAX_TRIAGES_PER_SYNC` (default 5)
- **Next steps agent:** `AGENT_ENABLED` (default true), `AGENT_MONTHLY_BUDGET_USD` (default $1.50)
- **Chat assistant:** `ASSISTANT_MONTHLY_BUDGET_USD` (default $1.50)
- **Application insights summary:** `INSIGHTS_MONTHLY_BUDGET_USD` (default $0.30)
- **Extension:** `EXTENSION_API_TOKEN` (shared secret, also pasted into the extension options)
- **Gmail:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `WEB_APP_URL`, `GMAIL_CLASSIFY_REASONING_EFFORT` (default `minimal`)
- **JD recovery:** `SERPER_API_KEY` (optional fallback), `SERPER_MAX_QUERIES_TOTAL` (default `1250`), `JD_RECOVERY_MAX_PER_RUN` (default `5`)
- **Cost estimate:** `OPENAI_INPUT_PRICE_PER_M`, `OPENAI_CACHED_INPUT_PRICE_PER_M`, `OPENAI_OUTPUT_PRICE_PER_M` (defaults are gpt-5-mini list prices)

## F. Running API + Web + Extension

- API dev server: `npm run dev`
- Web dev server: `npm run dev:web`
- Extension build: `npm run build:extension` (or `npm run dev:extension` to rebuild on change)
- Build API + web: `npm run build`
- API tests: `npm test`

Scripts run with `tsx`. If `npx tsx` is blocked in your environment, use `node --import tsx <file>`.

## G. Mongo Setup

1. Run a local MongoDB instance (or provide a remote URI in `MONGO_URI`).
2. Set `MONGO_DB_NAME` in `.env`.
3. Start the API and verify it connects successfully in logs.

Default local URI in `.env.example`:

- `mongodb://127.0.0.1:27017/job_agent_mvp`

Gmail and recovery collections: `gmail_auth`, `gmail_messages` (classifications only), `application_evaluations` (recovered JD + blind score + outcome), `ats_boards` (board slug cache), `serper_usage`, `llm_usage` (per-call token counts and cost, tagged by feature).

Agentic layer collections: `agent_suggestions` and `agent_meta` (Next steps), `assistant_threads` and `assistant_proposals` (chat assistant), `gmail_outbox` (a log of every draft the app created).

## H. Make It Yours: Resumes and Profile

Scoring is only as good as what the app knows about you. There are three pieces to set up.

### 1. Your resume files (local-only, gitignored)

The app works with two resume variants:

- `BASE`: your general resume, used by default.
- `AI`: a specialized variant, used when a posting's core work matches its focus. It's named for applied-AI roles, but it can be any second track you apply to, such as data, mobile, or infrastructure.

Put them in `apps/api/data/resumes/` (or point `RESUME_CONTEXT_DIR` elsewhere) using these filenames:

- `base_resume.txt` or `base_resume.pdf`
- `ai_resume.txt` or `ai_resume.pdf`

You only need one variant to get started. The easiest way to install one is from a PDF, which copies the PDF and extracts the text the loader prefers:

```bash
cd apps/api
node --import tsx scripts/extract-resume-text.mts BASE /path/to/your-base-resume.pdf
node --import tsx scripts/extract-resume-text.mts AI /path/to/your-specialized-resume.pdf
```

If both `.txt` and `.pdf` exist for a variant, `.txt` wins. Restart the API after replacing a resume, because resume contexts are cached in memory.

### 2. Your candidate profile (local-only, gitignored)

The scorer reads your profile from `user_profile.json` in the same resume folder (`apps/api/data/resumes/user_profile.json` by default). It covers:

- headline
- strengths and weaker areas
- degree status and training
- target roles and location preferences
- flagship projects with measurable outcomes
- estimated professional years, plus optional `screeningYears`: the years to weigh against a JD's experience bar (e.g. `2` when ongoing project work makes a 2-year bar realistic). Falls back to estimated professional years
- sponsorship, citizenship and clearance status
- home location
- certifications
- hard constraints, such as "do not invent years of experience"

To create it, copy the fictional example in `apps/api/src/config/userProfile.example.ts` into JSON form, then replace every value with your own. The field types are defined in `apps/api/src/types/userProfile.ts`.

If the file is missing, the API logs a warning and scores against the example profile. Tests always use the example profile, so editing your own never changes test results.

Keep claims factual. The scorer uses them to judge requirement overlap and how well your resume would survive a screen, so inflated claims produce inflated scores. Restart the API after editing the profile.

### 3. Resume variant descriptions

`apps/api/src/config/resumeProfiles.ts` tells the selector when each variant fits. Each entry has:

- `bestFor` and `avoidFor`
- `summaryStyle`
- `emphasisKeywords`
- `exampleRationale`

Edit these to describe your own two resumes.

### Keep personal data out of git

`apps/api/data/resumes/*`, the top-level `data/` folder, and all `*.pdf`, `*.docx` and `*.xlsx` files are gitignored. Before you push, run `git status` to confirm nothing personal is staged.

## I. Tracker Import / Verify Scripts

- Import tracker spreadsheet: `npm run import:tracker --workspace api`
- Verify tracker reseed behavior: `npm run verify:tracker --workspace api`
- Re-score tracker roles: `npm run rescore:tracker` / `npm run rescore:tracker-all`
- Pull Top Jobs once: `npm run sync:top-jobs --workspace api`
- Remove old JSearch/jobsbase Top Jobs rows: `npm run purge:legacy-top-jobs --workspace api` (dry run; add `-- --yes` to delete)

Startup behavior:

- By default, API boot auto-imports `data/job_role_scores_current.xlsx` if present. Disable with `AUTO_IMPORT_TRACKER_ON_START=false` or override the path with `TRACKER_SEED_WORKBOOK_PATH`.
- Rows already imported are left alone on later imports, so status changes, notes and "Heard back" marks made in the app survive restarts. The one exception: if a row's outcome text changes in the spreadsheet, its status is updated and the change is added to its history.
- Outcome text mentioning an interview, panel, screen, onsite, hiring manager or final round imports as interviewing.
- API startup also preloads local resume context by default to reduce first-triage latency.

Triage speed notes:

- `TRIAGE_FAST_MODE=true` keeps extraction/scoring quality but skips the LLM resume-selection tie-break when deterministic selection is ambiguous.

Root-level helper scripts:

- `npm run eval:seed`
- `npm run eval:run`

## J. Chrome Extension Setup

1. Set `EXTENSION_API_TOKEN` in `.env` to any long random string and restart the API.
2. Build the extension: `npm run build:extension`.
3. In Chrome, open `chrome://extensions`, enable Developer mode, click "Load unpacked", and choose `apps/extension/dist`.
4. Open the extension options and set the API base URL (default `http://localhost:4000/api`), the same token, and the web app URL.
5. On a job posting, click the extension icon to open the side panel and capture. Select the JD text first if auto-detection picks the wrong block.

Captures are scored in the background and appear like an Add Job result: open the full assessment, then confirm applied to add it to the tracker. Capturing at apply time is the most reliable way to get a JD for every application.

## K. Gmail Dashboard + JD Recovery Setup

1. In Google Cloud Console, create an OAuth client of type "Web application" with the redirect URI `http://localhost:4000/api/gmail/oauth/callback`, and enable the Gmail API.
2. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, and `WEB_APP_URL` in `.env`, then restart the API.
3. In the OAuth consent screen's Data access, add exactly `gmail.readonly` and `gmail.drafts.create`. Open the web app dashboard (`/`), click Connect Gmail, and approve. If you connected before drafts existed, the dashboard shows a Reconnect prompt; everything except drafting works until you do. `npm run verify:gmail-drafts --workspace api` checks the grant live (creates two test drafts to yourself, confirms sending is refused).
4. Click "Sync now" (the dashboard also syncs on load if the last sync is over 15 minutes old). While the API runs it also syncs in the background every `GMAIL_AUTO_SYNC_MINUTES` (default 15, `0` disables); a manual sync resets that timer, and only new emails and new applications cost anything. Recovery starts automatically after each sync and scores up to `JD_RECOVERY_MAX_PER_RUN` roles per run. "Recover JDs" starts a run by hand.
5. Optional: set `SERPER_API_KEY` to enable the web search fallback. Serper's 2,500 free queries are a one-time grant, so the default budget is half of that.
6. Optional: catch up on mail from before you connected Gmail with `npm run backfill:gmail --workspace api -- 2025-09-01 2026-09-04` (start and end dates). It uses the same filters and classifier as a sync, skips mail already processed, and doesn't auto-add tracker rows. Classification counts against the Gmail budget, so backfill a few months at a time.

Working the dashboard:

- **Needs your pick:** choose the right posting from the candidates, or paste the JD.
- **Not found:** the note says why (e.g. "board has no open jobs (posting likely closed)" or the closest title on the board). Paste the JD if you still care about the role.
- Click the fit score for the full scoring detail (rules that fired, hard gates, extractor output, stored JD). Hover the JD match badge for every step that was tried.

Suggested routine: sync once a day, clear "Needs your pick" weekly, and read the score-vs-outcome card once there are about 30 outcomes.

## L. Cost Notes

All job-board lookups and the Gmail API are free. Costs are OpenAI calls (and Serper after its free credits):

- Email classification: about 0.03-0.05¢ per email (minimal reasoning effort)
- Scoring a role (extraction + scoring): about 1.25¢
- Top Jobs pre-screen: a fraction of a cent per batch of alert titles; scoring a listed role about 2¢
- Next steps agent: about 0.1–2¢ per day
- Chat assistant: about 0.2–1¢ per message
- Application insights: free statistics, plus under 0.1¢ for the weekly summary
- Typical daily use (5-10 applications): a few dollars a month. The target is under $5/month overall, and the capped features (Top Jobs $2, agent $1.50, assistant $1.50, insights $0.30) can never exceed their limits

The dashboard's OpenAI cost card shows actual spend from recorded token counts, including this month's spend per feature against its cap.

## M. Important Privacy Note

Before publishing this project publicly:

- Do not commit `.env` or secrets.
- Do not commit personal resume files.
- Do not commit personal/local tracker artifacts.
- Always commit only `.env.example` (never real keys).

Gmail access is read + create drafts; the app cannot send email. Email bodies are fetched on demand and never stored. Only classifications, subjects/senders, and recovered job descriptions are kept in your local Mongo.

This repository is configured so local resume files and common secret/local artifact paths are ignored by git. You are still responsible for reviewing staged files before pushing.

## N. How this was built (Cursor)

I developed Job Search Copilot in **Cursor**, using its coding agent to plan and implement most of the full-stack work (API, scoring, Gmail, React UI). Cursor writes the bulk of the code. I do not type every line, and Cursor does not independently design the product.

Division of responsibility:

- **I decide** behavior, cost, safety, and scope: what to build, what to skip, standing rules (frozen scores, Gmail drafts only, never send, no commit unless I ask), and whether a plan is good enough to implement.
- **Cursor implements** from an approved plan: explores the repo, drafts slices and file lists, writes the change, and runs tests.
- **I keep ownership** by reviewing the diff, using the app, debugging when something is wrong, and being able to explain the resulting behavior.

Example: application insights. I wanted richer analytics (seniority tables, a funnel, better models). Cursor measured the existing **$0.30/month** cap and **~$0.003** weekly summary, then proposed only free statistics on stored fields — no new OpenAI call per application, no historical rescore. I approved that scope and rejected the funnel for a later slice (too few later-round outcomes). I then inspected the implementation and tests before treating it as done.
