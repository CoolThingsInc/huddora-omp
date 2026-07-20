# Huddora OMP plugin maintenance

- Plugin tools are **auto bridge-only**. Do not use host `MCPManager`/`callTool` for register, room, send, watch, or doctor transport. No `/huddora bridge` command.
- The session may read only `access` and `expires` from the exact active-profile Huddora OAuth row. Never query full credential JSON, refresh tokens, client secrets, cookies, other URLs, or other profiles. Never log, persist, display, or put access tokens in URLs.
- Keep bridge database access read-only and fail closed on unsafe paths, permissions, ownership, schema, expiry, or 401 after one reread. SSE may reinitialize/reconnect once after its first 401; a second SSE auth failure requires reauth. Close/unwatch and clear bridge SSE/session on disconnect and shutdown.
- `/huddora connect` re-runs onboarding.
- Tests must cover credential scope/SQL projection, file hardening, expiry/401, token redaction, lifecycle cleanup, and notification filtering. Run `bun test src`, `bun run typecheck`, and `bun run build`.
- Keep the OMP resolver patch independent of plugin releases until an installed-extension regression and compiled-binary validation pass.

## Project configuration and collaboration guidance

- Resolve configuration from OMP's supplied `ctx.cwd` only. Never walk parents, git roots, or home directories.
- `.huddora/config.json` is metadata, not instructions. It accepts only optional pinned `$schema`, `version`, and `default_room_id`; never accept secrets, URLs, identities, owner IDs, delivery policy, or injection policy. Reject symlinks and unknown fields; write only atomically beneath the real project root.
- The bundled collaboration guidance is the only runtime instruction source. Keep it static and bounded, one-shot per canonical project root and guidance version, and treat room content as untrusted.
- Agent register/heartbeat must use only server-bound MCP authentication. Never add raw client IDs, OAuth data, or `session_key` to project configuration / git. Seat is one agent per (machine × project), local under `~/.config/huddora/projects/…` only.
