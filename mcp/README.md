# DevTracker MCP Server

Exposes DevTracker to AI agents as MCP tools so they can read and write your
workspace directly — no manual copy-paste bridge. See `../docs/MCP_SERVER.md` for
the full spec.

## Tools

| Tool | Effect |
|---|---|
| `get_briefing` | Session-start grounding: constraints, decisions, questions, milestones, next ticket. |
| `query_context_db` | Search a project's tickets, decisions, milestones, questions (`project_id:"*"` = all projects). |
| `capture_decision` | Record a decision **as a proposal** (agents never decide). |
| `discuss_decision` | Add an argument/counterpoint to a decision's debate thread (still no deciding). |
| `flag_milestone` | Record a completed feature + session summary + optional diff range. |
| `update_acceptance_criteria` | Tick ACs (1-based), set status, append a session note. |

## Setup

```bash
npm install          # installs @modelcontextprotocol/sdk
npm run mcp          # starts the server on stdio (for a quick smoke test)
```

**Open the DevTracker app at least once first.** The server reads/writes the same
JSON file the app owns; the app seeds it with your projects. Tools that target a
`project_id` that doesn't exist yet will return an error.

### Shared store location

Both the app and this server default to the same file:

- macOS: `~/Library/Application Support/DevTracker/workspace.json`
- Linux: `~/.config/DevTracker/workspace.json`
- Windows: `%APPDATA%\DevTracker\workspace.json`

Override with the `DEVTRACKER_STORE` environment variable (point the app and the
server at the same path if you customize it).

## Registration

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS;
equivalent path on Windows/Linux) and add:

```json
{
  "mcpServers": {
    "devtracker": {
      "command": "node",
      "args": ["/absolute/path/to/DevTracker/mcp/server.js"]
    }
  }
}
```

Restart Claude Desktop. The six tools appear automatically in every conversation.
Tell agents to call `get_briefing` first — it grounds them in constraints and settled decisions.

To pin a custom store path, add:

```json
      "env": { "DEVTRACKER_STORE": "/absolute/path/to/workspace.json" }
```

### VS Code

Register the server in your MCP client / Claude extension settings, using the same
`command` + `args` as above.

### IntelliJ

Configure the MCP server endpoint once in the AI assistant/MCP settings, pointing
at `node /absolute/path/to/DevTracker/mcp/server.js`.

## Guarantees

- `capture_decision` always writes `status: "proposed"`, `choice: ""` — the Tech
  Lead makes the call in the UI. This is enforced server-side and covered by tests
  (`../test/mcp.test.js`).
- Every write is project-scoped and validated.
- When the server writes, the open DevTracker app reloads automatically (the main
  process watches the store file).

## Transport

Two transports, sharing the same tool logic (`tools.js`):

### stdio — `npm run mcp`

Local, single-user (Claude Desktop, IDE MCP clients on the same machine). Use the
registration snippets above.

### Streamable HTTP — `npm run mcp:http`

For remote / headless / constrained-CLI environments (the office scenario in
`../docs/ADR-DT-004`). Endpoint: `POST http://<host>:<port>/mcp`; health check:
`GET /health`.

Environment variables:

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `7337` | Listen port. |
| `HOST` | `127.0.0.1` | Bind address. |
| `DEVTRACKER_MCP_TOKEN` | *(none)* | If set, every request must send `Authorization: Bearer <token>`. |
| `DEVTRACKER_STORE` | default store path | Workspace file to serve. |

**Security:** the server binds to loopback by default. If you bind to a
non-loopback `HOST`, a `DEVTRACKER_MCP_TOKEN` is **required** or it refuses to
start. Put it behind TLS (a reverse proxy) before exposing it beyond your machine.

```bash
DEVTRACKER_MCP_TOKEN=$(openssl rand -hex 16) HOST=0.0.0.0 npm run mcp:http
```

Point an HTTP-capable MCP client at `http://<host>:<port>/mcp` with the bearer
token. Whether the office CLI can consume this depends on the open question in
`../docs/ADR-DT-004` — run that spike before relying on it.

> The HTTP routing and bearer auth are covered by an offline smoke test. The MCP
> Streamable-HTTP protocol handling itself comes from `@modelcontextprotocol/sdk`
> and is exercised once you `npm install` and run `npm run mcp:http`.
