# ForgeOS implementation state

Last updated: 2026-07-19 14:22 America/Halifax

## Current goal

Complete, verify, merge, and locally deploy the ForgeOS v0.1.0 minimal end-to-end loop, then create the annotated `v0.1.0` tag.

## Completed

- Bootstrapped `main` at `a34f6d3` and implemented the MVP in the `feat/mvp` worktree.
- Migrated the SiliconFlow key to ignored `.secrets/siliconflow_api_key`; created an ignored broker token.
- Installed and verified Docker Desktop with the WSL 2 backend.
- Implemented the event ledger, rebuildable SQLite projections, fact revisions, dynamic DAG, questions, evidence, model usage, Git worktrees, restricted runner broker, deployment preview, Fastify API, SSE, and browser UI.
- Verified SiliconFlow Chat Completions and JSON mode with `Qwen/Qwen2.5-7B-Instruct`.
- Previously passed TypeScript checks, build, 32 tests, Compose build/health, and a zero-vulnerability production dependency audit.

## Current blocker

- No implementation blocker remains. Release packaging, Git merge, final main deployment, and tagging are pending.

## Pending

1. Run the final release gate from the feature worktree and record the exact results.
2. Commit `feat/mvp`, merge into `main`, migrate runtime workspaces, and rebuild from `main`.
3. Verify recovery from the main checkout, create annotated tag `v0.1.0`, and remove the feature worktree.

## Important constraints

- All user writes enter through natural-language messages; status, DAG, evidence, timeline, and costs remain read-only.
- Event history is immutable and authoritative. Failed test history is preserved.
- Model output is untrusted structured candidate data; deterministic code controls state, budgets, DAG validity, Git, evidence, merge, and deployment gates.
- Only the internal broker holds the Docker socket. Runner containers have no network, run non-root with restricted capabilities/resources, and receive one exact worktree mount.
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

## Latest validation

- TypeScript check, build, and 45 tests pass.
- Compose production builds report 0 vulnerabilities.
- Real project `96d3c845-d6ec-4c7d-b708-86d07922d10f` completed with final HEAD `61694a5cecdc49689798f71693f49fd7553c6a99` and healthy preview `http://127.0.0.1:6877`.
- Compose restart preserved sequence 335, HEAD, completed status, broker health, and preview health.
- Real fact-boundary check kept requirement 1 pending while requirement 2 revision 1 became stale and revision 2 received a reconciliation DAG.
- In-app browser showed chat, DAG, ledger, evidence/cost, and the target preview with no console errors.
- Key scan found no secret in source, SQLite, APIs, logs, or image history. ForgeOS has no Docker socket; broker has no model key or database mount.
