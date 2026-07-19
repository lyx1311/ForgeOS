# ForgeOS v0.1.0

ForgeOS is a local, single-user prototype of a persistent software-engineering organization. A user describes a Node web application in natural language; ForgeOS persists requirements and decisions, proposes a task DAG, waits for plan approval, changes code in Git worktrees, validates the exact commit in restricted containers, reviews it, fast-forwards `main`, and starts a local preview.

## Run locally

Prerequisites: Docker Desktop with the WSL 2 Linux engine.

1. Put the SiliconFlow key in `.secrets/siliconflow_api_key` and create a random 32+ character `.secrets/runner_broker_token`.
2. Copy `.env.example` to `.env` and set `FORGEOS_HOST_WORKSPACE_ROOT` to this repository's absolute `.forgeos/workspaces` directory.
3. Run `docker compose up --build -d`.
4. Open <http://127.0.0.1:3000> and describe a project. Approve its plan in natural language.

State lives in the `forgeos-state` volume and `.forgeos/workspaces`. `docker compose down` preserves it; do not use `down -v` unless deliberately deleting all project history.

## Development

`npm test` runs deterministic tests without model calls. `npm run check` type-checks and `npm run build` creates `dist/`. The live SiliconFlow and Docker acceptance checks are documented in `docs/operations.md`.

## Boundaries

This release is for trusted local use. It has no accounts or public ingress. Only `runner-broker` receives the Docker socket; task containers never receive the socket, model key, database, or unrelated workspaces. See `docs/threat-model.md` and `docs/architecture.md`.
