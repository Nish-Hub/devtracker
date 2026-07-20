# DevTracker — Shared Data Layer Design

> The blocking step. Nothing in `MCP_SERVER.md` works until this exists.
> Decision: `adr/ADR-DT-001.md`.

---

## 1. Why the current store can't stay

The source of truth today is `localStorage` under keys like
`devtracker:workspace:v3` (see `js/data.js` → `STORAGE_KEY`, and `js/app.js`
`load()` / `save()`). localStorage is:

- **Renderer-only.** It exists inside the browser/Electron window. A separate
  process (an MCP server launched by Claude Desktop, VSCode, or the office CLI)
  has no API to read or write it.
- **Single-writer.** No coordination model for a second writer.
- **Opaque to search.** The context vector DB (§3.4 of the design) needs a real
  queryable store, not a serialized blob.

An MCP server is a process on stdio or an HTTP socket. For it to serve
`capture_decision` / `flag_milestone` / `query_context_db`, the workspace must live
where **both the UI and that process** can reach it: a file or an embedded DB on
disk.

---

## 2. Options (summary; full trade-offs in ADR-DT-001)

1. **Keep localStorage, add a paste/report bridge.** No new store; agents still
   can't reach it live. Rejected — this is the manual-bridge problem the whole
   design exists to remove.
2. **Single JSON file on disk** (`workspace.json` per project). Simplest; matches
   today's Export shape exactly. Weak for concurrent writes and semantic search.
3. **Embedded SQLite** (recommended primary), with JSON kept as Export/Import
   format. Handles concurrent access, transactions, and — via a vector extension —
   the context index. More moving parts.

Recommended: **SQLite for the live store + JSON for portability.** A JSON-only
start is acceptable if SQLite is deferred, but plan the schema so migration is
mechanical.

---

## 3. Ownership & access model

```
                 ┌─────────────────────────────┐
                 │   workspace store (disk)     │
                 │   SQLite (+ JSON export)     │
                 └─────────────┬───────────────┘
        file/DB access         │        file/DB access (+ lock)
        via IPC                │
   ┌─────────────────┐         │        ┌──────────────────────┐
   │ Electron main   │◄────────┘───────►│  MCP server process  │
   │ (owns the file) │                  │  (stdio / HTTP)      │
   └───────┬─────────┘                  └──────────┬───────────┘
           │ contextBridge IPC                     │ MCP tools
   ┌───────▼─────────┐                  ┌──────────▼───────────┐
   │ Renderer (UI)   │                  │  External agent      │
   │ js/app.js       │                  │  (IDE / Claude / CLI)│
   └─────────────────┘                  └──────────────────────┘
```

Two viable topologies:

- **A. Main process owns the store; MCP server is a child of Electron.** The MCP
  server talks to the store through the same main-process layer (or a thin shared
  module). One writer path, easiest consistency. Requires DevTracker to be running.
- **B. Store is a standalone file/DB; UI and a standalone MCP server both open it.**
  MCP works even when the UI is closed (good for headless/office use), but you need
  a real concurrency strategy (WAL + a write lock, or a single-writer daemon).

Recommendation: start with **A** for the solo desktop case (simplest, and the UI is
usually open), and design the store module so it can be lifted into a standalone
daemon (**B**) later for headless/office use.

---

## 4. Concurrency & integrity

- Use SQLite **WAL mode** so a reader (UI) and a writer (MCP) don't block each
  other; wrap multi-row writes in transactions.
- If two writers are ever possible (topology B), funnel all writes through a single
  module/daemon or take a short-lived write lock; last-writer-wins on a JSON file is
  not safe for the milestone/decision history you care about.
- Emit a lightweight **change signal** (file watch, or an IPC/event on write) so the
  UI refreshes when the MCP server mutates state — otherwise an agent captures a
  decision and the open UI shows stale data.

---

## 5. Schema to freeze (start from the current Export shape)

Normalize what `js/data.js` already models. Tables (SQLite) or top-level arrays
(JSON):

- `projects(id, name, code, description, active)`
- `tickets(id, project_id, title, effort, deps[], description, definition_of_done,
  technical_notes, status, scratchpad)`
- `acceptance_criteria(ticket_id, idx, text, done)`
- `sessions(ticket_id, date, summary, next_steps, raw)`
- `decisions(id, project_id, date, title, context, reversibility, status, choice,
  rationale)` + `decision_options(decision_id, name, pros[], cons[])`
- `milestones(id, project_id, title, description, status, date, session_summary,
  diff_ref)`
- `questions(id, project_id, lane, text, resolved)`
- `context_chunks(id, project_id, source, ref, text, embedding, metadata)` —
  new, backs the vector DB.

Keep the JSON Export/Import as the canonical portable format; the SQLite schema is
its normalized projection. Add a schema `version` and a mechanical migrator (note:
today's `load()` silently drops non-v3 state — the new migrator must not).

---

## 6. Migration path

1. On first launch of the new build, if `localStorage[devtracker:workspace:v3]`
   exists and no disk store is present, import it into the disk store, then treat
   disk as authoritative.
2. Keep `save()`/`load()` names but redirect them through the IPC/store module so
   the rest of `app.js` changes minimally.
3. Verify with a round-trip test: localStorage blob → disk store → JSON export →
   re-import → deep-equal.

---

## 7. Definition of done

- The UI reads and writes exclusively through the shared store (no direct
  `localStorage` for workspace data).
- A separate process can open the same store and read a project's decisions,
  milestones, tickets, and context chunks.
- Concurrent read (UI) + write (external) does not corrupt state, and the UI
  reflects external writes without a manual reload.
- Existing localStorage workspaces migrate automatically and Export/Import still
  round-trips.
