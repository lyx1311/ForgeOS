# Architecture

ForgeOS has two Compose services. `forgeos` owns the HTTP UI, append-only SQLite event ledger, projections, orchestration, model gateway, Git repositories and worktrees. `runner-broker` owns the Docker socket and exposes only fixed test, build and preview operations on validated workspace paths.

Every mutation appends an event and updates its projection in one transaction. Requirements are versioned facts. Tasks record exact fact revisions; revising a fact marks only direct consumers and their descendants stale. Test and review evidence is bound to a candidate commit, and merge rejects evidence for any other SHA.

The delivery graph is `analysis → planning → implementation → test → review → merge → deploy`. Repair nodes are added after failed evidence. The only public writes are natural-language project creation and project messages. Model outputs are candidates validated by Zod and deterministic policy; models cannot update state, run arbitrary commands, merge, or deploy directly.
