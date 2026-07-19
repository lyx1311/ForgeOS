# Operations and recovery

Health is available at `/api/health`. Project snapshots and event streams rebuild the UI after browser or container restarts. SQLite uses WAL and a named volume; managed repositories and worktrees are stored under `.forgeos/workspaces`.

Normal restart: `docker compose down`, then `docker compose up -d`. This preserves state. If a task was interrupted, its persisted task and changeset remain inspectable; a later message can resume or create a repair decision. Never delete a worktree manually while its task is active.

Validation sequence: `npm run check`, `npm test`, `npm run build`, `docker compose config`, image build, Compose health, a minimal live SiliconFlow JSON call, then the browser acceptance flow. Test suites mock SiliconFlow by default and do not spend API credits.

Back up the SQLite volume and `.forgeos/workspaces` together so event state and Git SHAs remain consistent. Rotate the SiliconFlow secret by replacing its secret file and recreating only the `forgeos` container.
