# ADR-DT-001: Source-of-truth data store

* **Status:** PROPOSED
* **Date:** 2026-07-20
* **Reversibility:** One-way door (hard to undo)

## Context
The workspace source of truth lives in browser `localStorage`
(`devtracker:workspace:v3`). An MCP server is a separate process and cannot read
localStorage, so no agent-facing tool can work until state moves to a store both
the UI and an external process can reach. This choice is hard to reverse once data
and history accumulate, so it needs a Tech Lead call.

## Options Considered
* **Option: Keep localStorage + report/paste bridge**
  * Pros:
    - No new infrastructure
    - Nothing to migrate
  * Cons:
    - Agents still cannot reach state live — the manual-bridge problem remains
    - No path to a queryable context DB

* **Option: Single JSON file on disk**
  * Pros:
    - Matches today's Export shape exactly; trivial migration
    - Human-readable, git-friendly
    - Readable by an external process
  * Cons:
    - Weak under concurrent writes (UI + MCP)
    - Poor fit for semantic search / large context index

* **Option: Embedded SQLite (+ JSON export) — agent recommendation**
  * Pros:
    - Safe concurrent read/write via WAL; transactional history
    - Natural home for the context vector index
    - Keeps JSON as the portable Export/Import format
  * Cons:
    - More moving parts (schema, migrations, a native/embedded dependency)
    - Slightly heavier build

## Decision Outcome & Rationale
**Chosen Option:** Undecided — Tech Lead to decide.

### Rationale
Agent recommendation: SQLite for the live store with JSON retained for
Export/Import, because milestones/decisions/context are growing, queryable,
concurrently-written data. If SQLite is deferred, start with the JSON file but
freeze the schema so migration to SQLite is mechanical. The only option to
actively reject is keeping localStorage as the primary store — it blocks the
entire MCP direction.
