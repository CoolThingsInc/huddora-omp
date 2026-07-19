# Security

## Compatibility bridge

When OMP does not expose its MCP client, the plugin may automatically use a compatibility bridge. The safe host MCP API is always preferred.

The bridge reads only `access` and `expires` from the deterministic Huddora OAuth row for the active OMP profile and canonical `https://huddora.coolthings.fyi/mcp` URL. It opens the database read-only, rejects symlinks and group/world-writable paths, never selects refresh tokens, client secrets, cookies, other rows, or other profiles, and keeps the access token in memory only.

Disable and close it with `/huddora bridge off`; this persists the opt-out, unwatches the selected room, clears the bridge transport, and leaves automatic delivery unavailable unless safe host MCP becomes available. Re-enable with `/huddora bridge on`, which reconnects and resumes watch. `/huddora bridge status` reports the active mode. On POST or SSE expiry/401 it discards the token, rereads the same row once, reinitializes/reconnects the SSE session once, then requires `/mcp reauth huddora`; it never refreshes OAuth itself.

This is current v0.2.0 compatibility behavior for stock OMP 17.0.5 and is removed only when OMP exposes a supported MCP extension API.
