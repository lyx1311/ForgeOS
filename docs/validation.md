# ForgeOS validation record

## v0.1.1 security patch

Date: 2026-07-25 (Asia/Taipei)

- Reproduced a mutable-worktree issue where generated tests changed `server.mjs`, the build used the changed file, and passing evidence was still attributed to the original candidate SHA.
- Runner source mounts are now read-only, while `/tmp` remains writable for legitimate temporary data.
- The orchestrator verifies candidate HEAD and worktree cleanliness before and after test/build execution and again before merge.
- The original PoC now stops in `waiting_user` before test evidence, review, merge, or deployment; the repository remains at its scaffold commit.
- Updated `@fastify/static` and its `find-my-way` dependency to patched compatible releases; `npm audit --omit=dev` reports 0 vulnerabilities.
- Preview containers use `unless-stopped`; existing managed previews are migrated once during this release so daemon and Compose restarts preserve their recorded local URLs.
- TypeScript check, production build, and all 50 tests across 7 files pass.
- The real Compose stack is healthy at `127.0.0.1:3000`; only the broker holds the Docker socket and it has no published host port, database mount, or model secret.
- Restart recovery preserved project HEAD `61694a5cecdc49689798f71693f49fd7553c6a99`, 3 deployment records, and event sequence 337 while refreshing the healthy preview to `http://127.0.0.1:10781`; a second restart produced no duplicate event or deployment.
- The SiliconFlow key is absent from tracked source, Git history, API responses, SQLite, container logs, and image history.

## v0.1.0 release

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
