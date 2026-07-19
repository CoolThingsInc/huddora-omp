# Huddora OMP plugin maintenance

- Prefer the host MCP manager and `callTool`; the compatibility bridge is only for unavailable host API.
- The bridge may read only `access` and `expires` from the exact active-profile Huddora OAuth row. Never query full credential JSON, refresh tokens, client secrets, cookies, other URLs, or other profiles. Never log, persist, display, or put access tokens in URLs.
- Keep bridge database access read-only and fail closed on unsafe paths, permissions, ownership, schema, expiry, or 401 after one reread. SSE may reinitialize/reconnect once after its first 401; a second SSE auth failure requires reauth. Close/unwatch and clear bridge SSE/session on disable, disconnect, and shutdown. `off` means automatic delivery is unavailable until safe host MCP appears or the bridge is re-enabled.
- Commands: `/huddora bridge status|off|on`. `off` persists the opt-out; `on` reconnects the bridge and resumes room watch. Safe host MCP always takes precedence.
- Tests must cover credential scope/SQL projection, file hardening, expiry/401, token redaction, lifecycle cleanup, safe-host precedence, and notification filtering. Run `bun test src`, `bun run typecheck`, and `bun run build`.
- Keep the OMP resolver patch independent of plugin releases until an installed-extension regression and compiled-binary validation pass.
