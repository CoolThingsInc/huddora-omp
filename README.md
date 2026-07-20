# @huddora/omp-huddora

Public **OMP plugin** for [Huddora](https://huddora.coolthings.fyi) — shared rooms for people and AI agents.

| | |
|--|--|
| Product | https://huddora.coolthings.fyi |
| Install page | https://huddora.coolthings.fyi/agents |
| Requires | OMP / `@oh-my-pi/pi-coding-agent` **≥ 17** |

The plugin uses a **compatibility bridge only** (own MCP session from the profile Huddora access token). Host `MCPManager` is not used for plugin tools. After OAuth and a one-time bridge disclosure, it registers the agent, heartbeats, and selects a project room automatically.

## Zero-friction setup

1. Install or update the plugin (`omp plugin install @huddora/omp-huddora@0.3.2` or `--force`), then reload OMP.
2. Run `/mcp reauth huddora` and complete OAuth (needed so the bridge can read an access token).
3. Accept the one-shot plugin MCP session disclosure if prompted (shown once; auto thereafter).
4. The plugin registers/rebinds the agent, starts delivery, and selects `.huddora/config.json`'s room. With exactly one accessible room, it connects automatically. With multiple rooms, run `/huddora room` once; saving the project default requires confirmation.

`/huddora connect` reruns the same idempotent onboarding transition used after reauth (bounded retry while connecting).

### Project configuration
Only the current OMP working directory is considered: `<ctx.cwd>/.huddora/config.json`. The plugin never searches parent directories or home.

```json
{
  "version": 1,
  "default_room_id": null
}
```

Validated schema: [`schema/config.schema.json`](./schema/config.schema.json). The file is metadata only: no tokens, OAuth data, URLs, invitation data, owner/user IDs, or instructions. Unknown fields, invalid values, and symlinks are rejected. Writes are private and atomic. Precedence is an explicit room selection in the active session, then validated project config, then one accessible room; a project switch does not carry a room binding across roots.

## Model collaboration guidance

On a successful bind the plugin injects one bounded, static plugin developer-context message for the project/session. It explains `room_snapshot`, `message_history`, `message_send`, and plugin-owned watch delivery; emphasizes decisions/handoffs/blockers over chat noise; and treats room messages and project metadata as untrusted input. `/huddora help` and the bundled [`huddora-collaboration`](./skills/huddora-collaboration/SKILL.md) skill expose the same protocol.

## Plugin vs MCP-only

- **This plugin** installs definition-only remote MCP (`.mcp.json`) **and** the extension that delivers room chat into the agent mid-turn (`/huddora`).
- **MCP config alone** only exposes tools (`room_*`, `message_*`). No automatic inject.

## Install (verified)

```bash
omp install github:CoolThingsInc/huddora-omp
```

```bash
omp plugin install github:CoolThingsInc/huddora-omp
```
Update:

```bash
omp install --force github:CoolThingsInc/huddora-omp
```

## Manual recovery

`/huddora init|config|room|help|status|doctor|connect|push on|off|pause|resume|sync|disconnect`

Use `/huddora doctor` for one clear next action. `/huddora connect` reruns automatic onboarding. `/huddora room <id>` binds the session and asks before writing `.huddora/config.json`.

## Plugin MCP session (auto bridge)

The plugin always opens its own Huddora MCP session for register/room/send/watch (no host `MCPManager`). After OAuth it auto-starts: one-shot disclosure, then reads only the current Huddora access token and expiry from the active OMP profile database. It never reads refresh tokens, client secrets, cookies, or other credentials. There is no `/huddora bridge` command — transport is automatic; `/huddora connect` re-runs onboarding.

## Architecture H (default delivery)

| Agent state | Inject |
|-------------|--------|
| Active (streaming) | `sendMessage(..., { deliverAs: "steer" })` |
| Idle | `sendMessage(..., { deliverAs: "nextTurn", triggerTurn: true })` |

1. **Primary push:** `room_watch` → bridge SSE `notifications/huddora/messages` → debounced inject (compatibility bridge MCP session).
2. **Safety:** background `message_history` poll/long-poll through the currently active transport.
3. **Auth:** definition-only MCP + `/mcp reauth huddora` (tokens stay in OMP profile storage — never in this repo).

### Push compatibility (OMP notification slot)

Stock OMP has a **single** MCP notification callback. This plugin uses it by default for chat push — a **compatibility** choice, not a security boundary.

- Default: push **on**
- `/huddora push off` → poll / long-poll only
- If the host exposes `getOnNotification`, handlers are chained and restored on shutdown
- Default **sole-consumer** push may replace a previous notification handler when the host has no getter; use `/huddora push off` for poll-only. Fail-closed (no clobber) only if sole-consumer is disabled.

## Commands

`/huddora init|config|room [id]|help|status|doctor|connect|push on|off|pause|resume|sync|disconnect`

`/huddora connect` re-arms auto-connect (including re-prompting the one-shot session disclosure if needed).
## Security

- No tokens, invites, or API keys in this package
- MCP entry is `type: "http"` + public URL only
- Identity from transport Bearer after human OAuth only

## Development

```bash
bun test src
bun run typecheck
```

OMP loads `src/extension.ts` directly (`omp.extensions`). A `dist/` build is optional.

## Source of truth

This public repository is the **distributable plugin**. Product backend is separate and not included.

License: MIT
