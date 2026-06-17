# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project does

CLI tool that exports all issues **and binary attachments** from a single Jira Cloud project to local disk. Jira Cloud's native export silently drops attachments; this fills that gap.

## Commands

```bash
pnpm start          # run the backup (requires .env)
pnpm dev            # re-run on file save (tsx watch)
pnpm typecheck      # TypeScript validation (no emit)
```

Copy `.env.example` to `.env` and fill in the four required vars (`JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`) before running.

## Architecture

Four source files in `src/`, no build step — `tsx` runs TypeScript directly.

| File | Role |
|---|---|
| `index.ts` | Orchestrator: load config → fetch issues → write `issues.json` → download attachments |
| `jira-client.ts` | Jira REST API — pagination, auth header, 429 backoff |
| `downloader.ts` | Attachment streaming to disk, path-traversal sanitization, per-file soft failure |
| `types.ts` | Pure TypeScript interfaces, no runtime code |

**Data flow:**
```
.env → loadConfig()
  → fetchAllIssues() (paginated 100/page via /rest/api/3/search)
  → output/{YYYY-MM-DDTHH-mm}/issues.json
  → per-attachment: downloadAttachment() → output/.../attachments/{issueKey}/{filename}
```

## Key constraints

- **ESM-only**: `"type": "module"` in package.json. All imports use `.js` extensions even for `.ts` source files (NodeNext resolution requirement).
- **No HTTP library**: native `fetch` only (Node 18+).
- **Sequential downloads with 150ms gap**: intentional rate-limit courtesy for Atlassian.
- **Soft failure per attachment**: `downloadAttachment` never throws — one bad file won't abort the run.
- **No resume**: each run creates a fresh timestamped directory from zero.
- **Deprecated pagination**: `startAt`-based pagination (marked `TODO` in `jira-client.ts:11`) — Atlassian is migrating to cursor-based `nextPageToken`.
- **No tests**: test plan steps were written (referenced as `T-5.x` in comments) but never implemented.
