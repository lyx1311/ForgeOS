# ForgeOS v0.1.0 validation record

Date: 2026-07-19 (America/Halifax)

## Automated gates

- `npm run check`: passed.
- `npm test`: 45 tests passed across 7 files.
- `npm run build`: passed.
- Compose image production dependency audit: 0 vulnerabilities.
- `docker compose config --quiet`: passed with the local `.env` runtime paths configured.

## Real end-to-end flow

- Created a Chinese natural-language project with two explicitly numbered independent requirements.
- Persisted 2 requirement facts and 2 delivery branches, requested plan approval, then accepted `批准` through the message API.
- Exercised schema failure, candidate policy failure, `git diff --check` failure, review repair, retry from a child task, exact-SHA evidence invalidation, and deployment recovery without bypassing gates.
- Final project: `96d3c845-d6ec-4c7d-b708-86d07922d10f`.
- Final target HEAD: `61694a5cecdc49689798f71693f49fd7553c6a99`.
- Healthy preview at validation time: `http://127.0.0.1:6877`; `/` and `/health` returned HTTP 200.

## Persistence and selective invalidation

- A Compose restart preserved event sequence `335`, project HEAD, completed status, deployment state, and preview health.
- A real two-fact project change left the requirement-1 implementation pending, marked only requirement-2 revision-1 work stale, and generated 6 reconciliation nodes for requirement-2 revision 2.
- Shared planning invalidation is prevented from crossing into downstream tasks that declare a different fact dependency.

## Browser and security

- In-app browser verified project switching, natural-language input, DAG, event ledger, evidence/token panel, preview link, and the generated habit-tracker UI.
- Target preview visibly contained Chinese empty state plus current and longest streak columns; browser console error count was zero.
- The SiliconFlow key was absent from source, SQLite, API snapshots, container logs, and image history.
- ForgeOS had no Docker socket; runner-broker had neither the SiliconFlow secret nor the database mount.
