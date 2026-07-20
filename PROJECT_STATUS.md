# DevTracker — Project Status

> **Version:** 0.2 · **Date:** 2026-07-20
> A persistent memory layer between a human tech lead and AI development agents.
> Companion docs: `docs/DESIGN.md`, `docs/DATA_LAYER.md`, `docs/MCP_SERVER.md`, `docs/adr/`.

---

## 1. What DevTracker is

An offline-first, framework-free engineering workspace (plain HTML/CSS/vanilla JS,
run as an Electron desktop app) that preserves project memory — tickets, decisions,
milestones, questions, and context — so a human tech lead can move at AI speed
without losing the thread, and so agents stay grounded in the same context.

**Design invariant — the human edge:** agents *generate options and capture
context*; the tech lead *makes the calls*. No agent path may mark a decision
`decided`.

---

## 2. Architecture

```
                 ┌──────────────────────────────────┐
                 │  workspace.json (shared store)    │  source of truth
                 └───────────────┬──────────────────┘
        IPC (+ file watch)       │       file read/write
   ┌───────────────────┐         │        ┌───────────────────────────┐
   │ Electron main      │◄───────┴───────►│  MCP server               │
   │ (owns the file,    │                 │  stdio  +  Streamable HTTP │
   │  git, AI proxy)    │                 │  (5 tools)                │
   └─────────┬─────────┘                  └────────────┬──────────────┘
   contextBridge (preload)                             │ MCP tools
   ┌─────────▼─────────┐                   ┌───────────▼──────────────┐
   │ Renderer UI        │                  │ External agent            │
   │ js/app.js          │                  │ (Claude Desktop / IDE /   │
   │                    │                  │  CLI)                     │
   └───────────────────┘                   └──────────────────────────┘
```

Key decisions (all reversible; captured as proposed ADRs for the tech lead):

- **ADR-DT-001** — source of truth moved from browser `localStorage` to a shared
  JSON file on disk (SQLite is the recommended later upgrade).
- **ADR-DT-002** — external integration via an **MCP server** (not an IDE plugin).
- **ADR-DT-003** — context search is an offline **lexical** index today, behind an
  interface that can swap to neural embeddings.
- **ADR-DT-004** — constrained-office path: HTTP transport now exists; only the
  "does the office CLI speak MCP?" spike remains.

---

## 3. Feature status

| Area | Status | Notes |
|---|---|---|
| Shared data store (localStorage → file) | ✅ Done | IPC-owned, atomic writes, file-watch → live UI refresh. |
| Persistence / Export-Import | ✅ Done | JSON round-trips; normalization backfills missing fields. |
| Decisions (pros/cons, reversibility) | ✅ Done | Agents capture as **proposed** only; tech lead decides. |
| Decision branch view + debate + review | ✅ Done | Options render as a pros/cons branch tree; per-decision debate window (human ↔ AI ↔ external agents via `discuss_decision`); advisory AI review. |
| Home / mission control | ✅ Done | Project stat cards → status modal / open; "Needs your call" inbox; catch-up + activity timeline; cross-project search; prompt library with token estimates; static HTML status export. |
| Standing constraints | ✅ Done | Per-project durable rules; injected into session briefs, agent chat, and `get_briefing`. |
| Diagram gallery | ✅ Done | Multiple diagrams per project (.excalidraw/.drawio/.svg/images); offline naive Excalidraw preview; open in diagrams.net / external editor; AI review → per-finding ticket/question creation. |
| Retrieval (ADR-DT-003 interim) | ✅ Done | BM25 + title boost + phrase bonus behind the same swappable interface; neural embeddings still pluggable later. |
| Drift flags | ✅ Done | Lexical heuristic: decided choices absent from the indexed repo + stale-ADR nudges. |
| OrchestratorLLM smart routing | ✅ Done | Vendored router core (`js/orchestrator/`); provider capability tags + smart-routing toggle in AI settings; AI calls routed by task Big O class through a verify+escalate cascade with a hard privacy guard; routing logged (model/class/escalations/tokens/cost) to the Home timeline. Built from the standalone OrchestratorLLM project (`~/Documents/OrchestratorLLM`). |
| MCP server — stdio | ✅ Done | 6 tools; wiring verified end-to-end offline. |
| MCP server — Streamable HTTP | ✅ Done | Loopback default, bearer-token auth; routing/auth tested. |
| `query_context_db` | ✅ Done | Lexical TF-IDF search over workspace + ingested code/docs. |
| Repo code/doc ingestion | ✅ Done | `store/ingest.js`, "Index repo → context" button, `npm run ingest`. |
| Milestones + detail view | ✅ Done | Session summary + git-resolved diff on expand. |
| Security hardening | ✅ Done | SVG sanitize, CSP, path-traversal + URL-scheme checks, AI key off renderer. |
| Neural embeddings | ⛔ Open | Interface ready; model not wired (ADR-DT-003). |
| Office-CLI feasibility spike | ⛔ Open | External; needs the office tooling (ADR-DT-004). |

---

## 4. The six MCP tools

| Tool | Effect |
|---|---|
| `get_briefing` | One-call session grounding: constraints, decided/proposed decisions, open questions, milestones, next unblocked ticket, recent activity. |
| `query_context_db` | BM25 search over tickets, decisions, milestones, questions, ingested code/docs; `project_id:"*"` searches every project. |
| `capture_decision` | Record a decision **as a proposal** (`status:"proposed"`, `choice:""` — enforced). |
| `discuss_decision` | Add an argument/counterpoint to a decision's debate thread (no choice/status access). |
| `flag_milestone` | Record a completed feature + session summary + optional git diff range. |
| `update_acceptance_criteria` | Tick ACs (1-based), set status, append a session note. |

---

## 5. File map (added / changed)

**New — backend**

- `store/workspace-store.js` — shared JSON store: load/save (atomic), normalize, mutators, collision-resistant IDs.
- `store/context-index.js` — offline lexical search behind the `query_context_db` interface.
- `store/ingest.js` — walk repo, chunk code/docs, write `contextChunks`.
- `mcp/tools.js` — shared tool definitions + dispatch (used by both transports).
- `mcp/server.js` — stdio MCP server.
- `mcp/http-server.js` — Streamable HTTP MCP server (auth, loopback default).
- `mcp/README.md` — registration + transport/security guide.

**New — tests & docs**

- `test/store.test.js`, `test/context.test.js`, `test/mcp.test.js`, `test/ingest.test.js`
- `docs/DESIGN.md`, `docs/DATA_LAYER.md`, `docs/MCP_SERVER.md`, `docs/adr/ADR-DT-001…004.md`

**Changed**

- `main.js` — store IPC + file watch; `get-git-diff`, `index-repo`, `ai-request` handlers; path-traversal + URL-scheme hardening.
- `preload.js` — `store`, `getGitDiff`, `indexRepo`, `aiRequest` bridges.
- `js/app.js` — file hydration/mirroring, SVG sanitizer, milestone detail view, index button, unified `aiHttp` proxy path, chat-drawer close fix, honest provider status label.
- `index.html` — Content-Security-Policy; chat drawer starts hidden.
- `package.json` — `@modelcontextprotocol/sdk` dep; `mcp`, `mcp:http`, `ingest` scripts.

---

## 6. How to run

```bash
cd DevTracker
npm install            # pulls @modelcontextprotocol/sdk
npm start              # launch the Electron app (seeds the shared workspace file)
npm test               # 21 unit tests
npm run mcp            # MCP server over stdio
npm run mcp:http       # MCP server over HTTP (loopback; set DEVTRACKER_MCP_TOKEN to expose)
npm run ingest -- CTXR # index the repo into project CTXR's context
```

Register the MCP server with Claude Desktop / an IDE per `mcp/README.md`, then
ask an agent to `capture_decision` — it should appear in the Decisions tab as
**proposed**.

---

## 7. Testing

- **21 unit tests** (store, context index, MCP dispatch, ingestion) — all passing.
- **stdio MCP** verified end-to-end with a simulated client (tools/list, tool
  calls, proposed-gate, error path).
- **HTTP MCP** routing + auth verified over real TCP (health 200, no-token 401,
  bad path 404, `GET /mcp` 405, authed calls 200, malformed body 400).
- Not runnable in the build sandbox (needs your machine): `npm install`, Electron
  GUI, and the real SDK HTTP transport swap-in.

---

## 8. Recent fixes

- **Chat drawer close** — inline `display:flex` was overriding the `hidden`
  attribute; now toggles `display` directly.
- **AI provider calls** — third-party APIs block renderer CORS; all AI calls now
  route through a main-process proxy (`ai-request`), keeping the key off the
  renderer. A partially-configured provider (missing endpoint/key) now shows an
  honest "Local mode — missing …" label instead of a false "Connected."

---

## 9. Open items / next steps

1. **Embeddings** — wire a local embedding model behind `query_context_db` with a
   lexical fallback (ADR-DT-003).
2. **Office-CLI spike** — confirm whether the office CLI speaks MCP or needs a
   proprietary connector shim (ADR-DT-004).
3. **On-machine verification** — `npm install` + `npm test` + `npm start`, and a
   live MCP round-trip from Claude Desktop.
4. Optional: SQLite upgrade for the store once the context index grows.
