# Security

## Compatibility bridge

When OMP does not expose its MCP client, the plugin may automatically use a compatibility bridge. The safe host MCP API is always preferred.

The bridge reads only `access` and `expires` from the deterministic Huddora OAuth row for the active OMP profile and canonical `https://huddora.coolthings.fyi/mcp` URL. It opens the database read-only, rejects symlinks and group/world-writable paths, never selects refresh tokens, client secrets, cookies, other rows, or other profiles, and keeps the access token in memory only.

Disable and close it with `/huddora bridge off`; re-enable with `/huddora bridge on`. `/huddora bridge status` reports the active mode. On expiry or 401 it discards the token, rereads the same row once, then requires `/mcp reauth huddora`; it never refreshes OAuth itself.

This fallback is temporary compatibility behavior and will be removed when OMP exposes a supported MCP extension API.
