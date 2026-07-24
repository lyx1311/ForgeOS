# Threat model

v0.1.1 assumes one trusted local operator and does not claim hostile multi-tenant isolation.

- The UI binds only to `127.0.0.1`; there is no authentication because there is no remote access.
- The model key is a Compose secret and is excluded from Git, images, events, logs and runner mounts.
- The ForgeOS service has no Docker socket. The broker has the socket but accepts a narrow bearer-authenticated API and validates all paths beneath the configured workspace root.
- Task containers run non-root with no network, read-only root filesystem, dropped capabilities, no-new-privileges and CPU, memory, PID and time limits. Their candidate worktree is mounted read-only; only the restricted `/tmp` filesystem is writable.
- Candidate paths reject absolute paths, traversal and symlink escape. `package.json` and the fixed Dockerfile are protected from model changes.
- Test and build gates verify the worktree HEAD and cleanliness before and after execution. Merge requires a clean fast-forward from the frozen base and passed evidence for the exact candidate SHA.
- Healthy preview containers use `unless-stopped` so Docker daemon restarts preserve local preview availability without granting ForgeOS the Docker socket.

Compromise of `runner-broker` still implies Docker-host control because it holds the socket. Do not expose its network or ForgeOS itself beyond the local machine.
