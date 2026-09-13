<div align="center">

# 🎙️ Voice to Code

**Say it in the meeting. Ship it from the meeting.**

Live meeting transcription that turns spoken wake phrases into GitHub issues and pull requests, implemented by [Cursor](https://cursor.com) cloud agents.

[![Next.js](https://img.shields.io/badge/Next.js-16.3-black?logo=next.js&logoColor=white)](https://nextjs.org)
[![React](https://img.shields.io/badge/React-19.2-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/tests-148%20passing-brightgreen?logo=vitest&logoColor=white)](#testing)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.13-339933?logo=node.js&logoColor=white)](https://nodejs.org)

</div>

---

## What it does

You are on a call. Someone describes a bug. Instead of writing it down and forgetting it, you say the wake phrase out loud — and by the end of the meeting the issue exists, or the pull request is already open.

| Say this | And this happens |
| --- | --- |
| 🗣️ **"grok make an issue"** | A GitHub issue is drafted from the spoken context and created in your repo |
| 🗣️ **"grok make a PR"**<br/>🗣️ **"grok make a pull request"** | The request is planned against the related issue, then implemented by a cloud agent that opens a PR |

Wake-phrase matching is fuzzy on purpose: speech-to-text rarely hears *"grok"* cleanly, so `grock`, `groq`, `croak`, `brock` and a dozen other near-misses all resolve to the same token via alias table plus edit-distance matching.

> [!NOTE]
> Transcription comes from **Google Meet's live captions**, read from the DOM by a small Chrome extension. There is no ASR service and no audio key to manage.

---

## How it works

```
   Google Meet tab                Chrome extension              Next.js app
  ┌────────────────┐            ┌──────────────────┐        ┌────────────────┐
  │ live captions  │──DOM read─▶│  content script  │──msg──▶│ transcript UI  │
  │   (CC on)      │            │   + background   │        │ keyword detect │
  └────────────────┘            └──────────────────┘        └───────┬────────┘
                                                                    │
                                                       POST /api/commands
                                                                    │
                                                                    ▼
                                                          ┌───────────────────┐
                                                          │  command pipeline │
                                                          └───────────────────┘
```

A wake phrase in the rolling transcript window POSTs to `/api/commands`, which runs a six-stage pipeline. Each stage may **continue**, **skip**, or **halt**, and every decision is appended to a log that the UI can render:

| # | Stage | Responsibility |
| :-: | --- | --- |
| 1 | `resolveIntent` | Turn the matched wake phrase into an issue/PR intent |
| 2 | `matchIssues` | Search the repo for issues the transcript may already be about |
| 3 | `addIssueContext` | Ask Grok whether the transcript adds new facts; comment them on the match |
| 4 | `resolveIssue` | Decide: reuse the matched issue, or create a new one |
| 5 | `decidePrNeeded` | Was this a PR trigger, or issue-only? |
| 6 | `execute` | Launch the Cursor cloud agent (plan → implement → `autoCreatePR`) |

The runner in `src/lib/pipeline/run.ts` knows nothing about GitHub or Cursor — it only understands the stage interface, which keeps every stage independently testable.

---

## Prerequisites

| Requirement | Notes |
| --- | --- |
| **Node.js ≥ 22.13** | Required by `@cursor/sdk` |
| **GitHub account** | OAuth sign-in; scopes `read:user`, `user:email`, `repo` |
| **Cursor account** | API key **+** the Cursor GitHub App installed on the repos you'll discuss |
| **Google Chrome** | For the unpacked caption extension in [`extension/`](extension/) |

---

## Quick start

```bash
git clone git@github.com:Gsschenk12/voice-to-code-hackathon.git
cd voice-to-code-hackathon
npm install
cp .env.example .env
openssl rand -base64 32   # paste into AUTH_SECRET
npm run dev
```

Then open **http://localhost:3000** and follow the setup below.

---

## Setup

### 1. Environment

Secrets live in a gitignored **`.env`** at the repo root (Next.js loads it automatically).

```ini
AUTH_SECRET=<openssl rand -base64 32>
AUTH_URL=http://localhost:3000
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
```

> [!IMPORTANT]
> Your **Cursor API key is not an env var**. You paste it into the meeting setup UI, and it is stored on the Auth.js session — server-side only, never sent back to the browser.

### 2. GitHub OAuth App

Create one at [GitHub → Developer settings → OAuth Apps](https://github.com/settings/developers):

| Field | Value |
| --- | --- |
| Homepage URL | `http://localhost:3000` |
| Authorization callback URL | `http://localhost:3000/api/auth/callback/github` |

Copy the **Client ID** and **Client secret** into `.env`. The `repo` scope is what lets cloud agents create issues on your behalf.

### 3. Cursor

1. Create an API key at [Cursor Dashboard → Integrations](https://cursor.com/dashboard/integrations).
2. Install the [Cursor GitHub App](https://cursor.com/docs/integrations/github) on every repo you plan to discuss — cloud agents can only clone repos already authorized for that app.
3. In the app: **Meeting setup** (`/meeting`) → paste key → **Save key** → **Load from Cursor** → pick a repo.

### 4. Meet captions extension

```
chrome://extensions  →  Developer mode  →  Load unpacked  →  select extension/
```

Full details, including the popup status badges, are in [`extension/README.md`](extension/README.md).

### 5. Run a meeting

1. **Sign in with GitHub**
2. **Set up meeting** → save Cursor key → load repos → pick repo → **Start meeting**
3. Open a Meet tab **in the same Chrome profile** and turn captions on (**CC**)
4. Click **Start listening** — speaker-attributed captions stream into the transcript pane
5. Say a wake phrase and watch the agent row appear

<details>
<summary><b>✅ Verification checklist</b></summary>

<br/>

- [ ] GitHub sign-in redirects back and shows your username
- [ ] Meeting setup accepts a Cursor API key
- [ ] **Load from Cursor** lists repositories
- [ ] Starting a meeting opens the live page for the selected repo
- [ ] Extension loaded, Meet CC on, **Start listening** shows caption text
- [ ] A wake phrase creates a pending agent row, then an issue or PR link

</details>

---

## API

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/commands` | Run the pipeline for a detected wake phrase |
| `GET` | `/api/repos` | List Cursor-authorized repositories |
| `GET` | `/api/agents/[id]` | Poll cloud agent status, summary, and PR link |
| `*` | `/api/auth/[...nextauth]` | Auth.js GitHub OAuth |

All routes require an authenticated session; the command, repo, and agent routes additionally require a saved Cursor API key.

---

## Project layout

```
src/
├── app/
│   ├── api/            # commands, repos, agents, auth route handlers
│   └── meeting/        # setup page + live meeting page
├── components/         # MeetingSetup, MeetingLive, TranscriptPane, AgentStatus
├── hooks/              # useKeywordDetector, useMeetCaptionStream
└── lib/
    ├── keywords.ts     # wake-phrase normalization + fuzzy matching
    ├── cursor.ts       # @cursor/sdk wrapper, model resolution, retries
    ├── github.ts       # Octokit helpers (issues, comments, search)
    ├── pipeline/       # stage runner + the six pipeline stages
    └── triggers/       # transcript sources for offline scanning
extension/              # Chrome MV3 extension that scrapes Meet captions
sample-transcripts/     # fixtures for the dry-run scanner
```

---

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Next.js dev server |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run test` | Run the Vitest suite once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run scan:samples` | Dry-run the trigger scan over `sample-transcripts/` |

### Testing

```bash
npm run test
```

**148 tests across 19 files** cover wake-phrase matching, caption parsing, every pipeline stage, GitHub helpers, Cursor retry behavior, and client persistence. `npm run scan:samples` exercises the detection path end-to-end against recorded transcripts without launching a single agent — the fastest way to iterate on keyword logic.

---

## Design notes

- **Repo picking goes through Cursor, not GitHub.** The picker calls `Cursor.repositories.list` rather than GitHub's `/user/repos`, because a repo is only usable if the Cursor GitHub App can already clone it.
- **Agents can't create issues with their own token.** Cursor's sandbox token lacks the permission, so issue commands inject your GitHub OAuth token as `GITHUB_TOKEN`, letting the agent run `gh issue create`.
- **PRs are planned, then executed.** A PR command resolves the associated issue first (matched or freshly created), plans against it, then runs that plan on a cloud agent with `autoCreatePR: true` — producing a branch, atomic commits, and a PR body that links the issue.
- **State is client-side.** Transcript and launched agents live in the browser. No database — this is a hackathon scaffold.
- **Caption scraping is best-effort.** Meet's DOM is not a public API. Selectors prefer `aria-label` / `aria-live` and fall back to structural parsing, but Google can change it at any time.

---

<div align="center">
<sub>Built at a hackathon. Powered by Cursor cloud agents.</sub>
</div>
