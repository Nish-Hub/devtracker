# DevTracker — MCP Server Spec

> Depends on `DATA_LAYER.md` (the shared store must exist first).
> Direction decision: `adr/ADR-DT-002.md`.

---

## 1. Purpose

Expose DevTracker to AI agents as a **Model Context Protocol** server so agents
call native tools during a session — capturing decisions, flagging milestones,
querying context, updating tickets — **without the human copy-pasting on every
turn**. Once registered in an environment, every conversation there has the tools
available automatically.

---

## 2. Design rules (non-negotiable)

1. **Never decide.** `capture_decision` writes `status: "proposed"`, `choice: ""`,
   always. The agent supplies options with pros/cons; the Tech Lead decides in the
   UI. This is the product's whole reason to exist.
2. **Propose, don't finalize.** `flag_milestone` records a *candidate* milestone the
   Tech Lead can confirm; it does not silently mutate delivery status.
3. **Untrusted input.** Everything an agent sends is untrusted. Validate against a
   schema, reject unknown fields, and store as data — the UI must escape it on
   render (fix the known `innerHTML`/SVG XSS paths first; add CSP).
4. **Scoped writes.** Every tool takes a `project_id`; a tool call cannot touch
   another project's state.
5. **Idempotency where it matters.** Repeated `capture_decision` for the same
   logical decision should update, not duplicate (dedupe on a stable client key or
   title+project).

---

## 3. Tools

### 3.1 `query_context_db` (read)

Semantic + structured search over a project's stories, docs, code, decisions, and
milestones. Agents pull what's relevant on demand instead of being handed
everything.

```jsonc
// input
{
  "project_id": "CTXR",
  "query": "how did we handle Jina rate limits",
  "kinds": ["decision", "doc", "code", "ticket", "milestone"], // optional filter
  "limit": 8
}
// output
{
  "results": [
    { "kind": "decision", "id": "ADR-003", "score": 0.82,
      "title": "Vector store for retrieval", "snippet": "…", "ref": "decisions/ADR-003" }
  ]
}
```

Backed by `context_chunks` (see `DATA_LAYER.md` §5) and the embedding choice in
`ADR-DT-003`.

### 3.2 `capture_decision` (write — proposed only)

```jsonc
// input
{
  "project_id": "CTXR",
  "title": "Choose vector store for retrieval",
  "context": "CTXR-8 needs a vector backend; hard to reverse once indexed.",
  "reversibility": "one-way",           // one-way | two-way | ""
  "options": [
    { "name": "MongoDB Atlas Vector Search", "pros": ["Reuses Mongo"], "cons": ["Lock-in"] },
    { "name": "Qdrant", "pros": ["Purpose-built"], "cons": ["Extra service"] }
  ],
  "client_key": "vector-store-choice"   // optional, for idempotency
}
// output
{ "id": "ADR-004", "status": "proposed" }
```

Server forces `status: "proposed"` and `choice: ""` regardless of input. Maps onto
the existing `normalizeDecision` shape in `js/app.js`.

### 3.3 `flag_milestone` (write — candidate)

```jsonc
// input
{
  "project_id": "CTXR",
  "title": "End-to-end retrieval MVP",
  "description": "Repo indexed and queried via REST + MCP.",
  "session_summary": "Wired ingestion → embedding → Mongo → search endpoint.",
  "diff": { "from": "abc1234", "to": "def5678" }  // git range; server resolves via existing get-git-log IPC
}
// output
{ "id": "MS-003", "status": "planned" }
```

The `session_summary` is a distilled summary (not the raw transcript). `diff` is
stored as a reference/range and rendered on the Milestones tab by reusing the
Electron Git integration.

### 3.4 `update_acceptance_criteria` (write)

```jsonc
// input
{
  "project_id": "CTXR",
  "ticket_id": "CTXR-5",
  "completed_ac": [1, 3],                  // 1-based, matches session-report parsing
  "status": "in_progress",                 // todo | in_progress | done (optional)
  "session": { "summary": "…", "next_steps": "…" }  // optional, appended to history
}
// output
{ "ticket_id": "CTXR-5", "done_ac": [1, 3], "status": "in_progress" }
```

Same effect as pasting a session report today (`applyReport`), but called directly
by the agent.

---

## 4. Transport

- **stdio** for local single-user (Claude Desktop, IDE clients on the same
  machine). Default.
- **Streamable HTTP** for remote/headless use (the office scenario, or a shared
  DevTracker daemon). Behind auth if exposed beyond localhost.

Ship stdio first; HTTP is the door to §7.

---

## 5. Registration (one-time per environment)

- **Claude Desktop** — add the server to
  `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS;
  equivalent path on Windows/Linux), pointing at the DevTracker MCP entrypoint.
- **VSCode** — register the server in the MCP client / Claude extension config.
- **IntelliJ** — configure the MCP server endpoint once.

After setup, every agent conversation in that environment has DevTracker tools
without being re-told.

> Verify current config file names and MCP client support in each tool before
> writing the setup guide — these evolve; don't hardcode from memory.

---

## 6. Server ↔ store relationship

The MCP server does **not** own state. It reads/writes the shared store from
`DATA_LAYER.md`:

- Topology A (recommended start): MCP server is a child of Electron and writes
  through the main-process store module.
- Topology B (later): standalone MCP daemon opens the store directly (WAL + write
  lock) so it works with the UI closed.

On every write, emit the change signal so an open UI refreshes.

---

## 7. Definition of done

- An agent in Claude Desktop can, in one session and with no manual paste:
  query context, capture a decision (lands `proposed`), flag a milestone
  (lands `planned`), and update a ticket's acceptance criteria.
- Captured decisions never arrive `decided`; the Tech Lead gate is intact.
- All agent-supplied strings render safely in the UI (XSS paths fixed, CSP set).
- Writes are project-scoped, schema-validated, and idempotent on `client_key`.
