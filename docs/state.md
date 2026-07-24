# ForgeOS implementation state

Last updated: 2026-07-25 Asia/Taipei

## Current goal

Maintain the released ForgeOS v0.1.1 prototype with immutable candidate execution and exact-SHA evidence integrity.

## Completed

- Bootstrapped `main` at `a34f6d3` and implemented the MVP in the `feat/mvp` worktree.
- Migrated the SiliconFlow key to ignored `.secrets/siliconflow_api_key`; created an ignored broker token.
- Installed and verified Docker Desktop with the WSL 2 backend.
- Implemented the event ledger, rebuildable SQLite projections, fact revisions, dynamic DAG, questions, evidence, model usage, Git worktrees, restricted runner broker, deployment preview, Fastify API, SSE, and browser UI.
- Verified SiliconFlow Chat Completions and JSON mode with `Qwen/Qwen2.5-7B-Instruct`.
- Previously passed TypeScript checks, build, 32 tests, Compose build/health, and a zero-vulnerability production dependency audit.
- Added deterministic extraction/planning fallbacks, normalized model candidates, bounded repair/recovery, selective fact invalidation, SHA revalidation, and deploy-only recovery.
- Completed the two-requirement live loop, merged `feat/mvp` into `main`, migrated runtime repositories to root `.forgeos/workspaces`, rebuilt Compose from `main`, and created annotated tag `v0.1.0`.
- Redesigned the repository homepage with a project-native visual system, an English default README, and a fully localized Simplified Chinese README.
- Published the repository to `github.com/lyx1311/ForgeOS` and adopted the Apache License 2.0, including SPDX package metadata and bilingual README notices.
- Reproduced and fixed mutable candidate worktrees: Runner mounts are read-only and orchestration checks HEAD and cleanliness around every test/build gate and before merge.
- Released the validated security patch as v0.1.1 and removed the untracked, superseded Codex Security scan artifacts.

## Current blocker

- None for the v0.1.1 local single-user scope.

## Pending

- No v0.1.1 release task remains; future work starts from a new versioned goal.

## Important constraints

- All user writes enter through natural-language messages; status, DAG, evidence, timeline, and costs remain read-only.
- Event history is immutable and authoritative. Failed test history is preserved.
- Model output is untrusted structured candidate data; deterministic code controls state, budgets, DAG validity, Git, evidence, merge, and deployment gates.
- Only the internal broker holds the Docker socket. Runner containers have no network, run non-root with restricted capabilities/resources, and receive one exact read-only worktree mount.
- Secrets must not enter Git, images, SQLite, logs, or API responses.
- The application binds only to `127.0.0.1` and remains a trusted local single-user prototype.

## Architecture decisions

- Node 24 + TypeScript + Fastify + SQLite + Zod in a single repository.
- `forgeos` owns state/orchestration/model/Git; `runner-broker` owns a narrow Docker operation protocol.
- MCR `devcontainers/javascript-node:24-bookworm` is the base image because Docker Hub pulls fail with EOF in this environment.
- Exact commit SHA evidence and fast-forward-only target-project merging are mandatory.
- Low-cost models are the default; deterministic local fallbacks keep project creation available when extraction/planning output is malformed.
- Explicit requirement markers set a deterministic minimum branch count; model output cannot merge separately numbered requirements.
- Candidate text is normalized, third-party imports are rejected, and `server.mjs` must preserve `/health`.
- Fact invalidation respects downstream fact boundaries; cancelled planning branches are not schedulable.
- Retry restores the owning implementation from any failed delivery child and revalidates test/review evidence on the new SHA.
- Candidate worktree integrity is checked before and after test/build execution and immediately before merge; any deviation stops the delivery chain without passing evidence.
- Preview containers use `unless-stopped`; existing managed previews are migrated during v0.1.1 validation so Docker daemon restarts preserve their local URLs.

## Latest validation

- The mutable-worktree PoC completed and merged before the fix; after the fix it stops before test evidence, build, review, merge, and deployment.
- Focused Git, broker, and orchestrator security tests pass: 26 tests across 3 files.
- Production dependencies were updated to patched compatible releases and `npm audit --omit=dev` reports 0 vulnerabilities.

- TypeScript check, build, and 50 tests across 7 files pass.
- Compose production builds and `npm audit --omit=dev` report 0 vulnerabilities.
- Real project `96d3c845-d6ec-4c7d-b708-86d07922d10f` remains completed at HEAD `61694a5cecdc49689798f71693f49fd7553c6a99` with healthy preview `http://127.0.0.1:10781`.
- Compose restart preserved sequence 337, 3 deployment records, HEAD, completed status, broker health, and preview HTTP 200; a second recovery made no duplicate event or deployment.
- Real fact-boundary check kept requirement 1 pending while requirement 2 revision 1 became stale and revision 2 received a reconciliation DAG.
- In-app browser showed chat, DAG, ledger, evidence/cost, and the target preview with no console errors.
- Key scan found no secret in source, SQLite, APIs, logs, or image history. ForgeOS has no Docker socket; broker has no model key or database mount.
- The final v0.1.1 Compose has both services healthy; ForgeOS binds only `127.0.0.1:3000`, only the broker has the Docker socket, and the broker has no host port, database mount, or model secret.
