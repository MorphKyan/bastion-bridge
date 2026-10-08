# Project guidance

- This project uses TypeScript / Node.js 24 and native tmux control mode.
- Run `npm run check`, `npm test`, and, for browser changes, `npm run build && npm run test:web`.
- Tests must use a private temporary state directory and dedicated local tmux socket. Never run the test suite against real bastion assets.
- Keep credentials outside the repository. Never print passwords or verification codes, add them to command arguments, or include them in tool prompts. Use private files or hidden browser inputs.
- Every managed terminal write must pass through the session manager and check the current lease. Stale completions and timeout callbacks must not affect a new owner.
- Execution completion is determined by a unique output frame, not silence or generic prompt matching. Shell prompts are used to confirm the terminal is safe to reuse.
- Preserve SSH when stopping the daemon. Unknown results must never trigger automatic command retries.
- No Git remote is configured; do not add one without an explicit request.

## Asset access

- Use this project's `ai-term` CLI / MCP for Qizhi assets listed in the local private configuration. Select by configured IP and retain one persistent managed session per asset.
- Use `acquire → exec → release` with the current lease token. Enter passwords and verification codes through the web interface or private files as documented in README.md.
- All other servers continue to use their existing direct-SSH connections. Preserve `/root/.ssh/config`, SSH keys, host records, and the `qizhi-bastion` alias.
- Keep the project's configuration/state and managed sessions, OpenSSH, and shared tmux installation.

## Local Java

If Java is needed, select JDK 21 per command using `JAVA_HOME=/opt/jdks/jdk-21 PATH=/opt/jdks/jdk-21/bin:$PATH`. SDKMAN is at `/root/.sdkman` and has a different default Java.
