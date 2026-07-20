# DevTracker — Design Doc (v2)

> **Version:** 0.2 (MCP direction) · **Date:** July 2026
> Supersedes the framing in `PROJECT_CONTEXT.md` §Vision where they differ.
> Companion docs: `DATA_LAYER.md`, `MCP_SERVER.md`, `adr/ADR-DT-00x.md`.

---

## 1. Problem

Development with AI agents moves faster than a human tech lead can track. Decisions
scatter, context evaporates, and the project drifts out of hand because the pace
outstrips the human's ability to keep the thread.

The goal is to **bring the human to scale**: give the tech lead a structured,
persistent project memory so they can act quickly *and* well, and give the agents
the same grounded context so they stay aligned.

**Primary user:** a solo tech lead / architect driving projects through AI agents.
**Secondary:** office dev teams in constrained (CLI-only) environments (§7).

**Design invariant — the human edge:** agents *generate options and capture
context*; the tech lead *makes the calls*. Nothing in this design may let an agent
mark a decision `decided`.

---

## 2. What exists today

- Offline, framework-free workspace: plain `index.html`, run in a browser or as an
  Electron desktop app.
- Persistence in browser **localStorage**; Export/Import round-trips the same JSON
  shape.
- Core loop: copy a ticket's **session brief** → work with an AI → paste back a
  **session report** → acceptance criteria and history update.
- Electron adds a **Git view** (`get-git-log` IPC with numstat) and an **ADR file
  writer** (`write-adr-file` → `docs/adr/{id}.md`).
- Decisions already model options + pros/cons + reversibility (one/two-way door) +
  `proposed → decided → superseded`. The brief tells agents not to decide
  `proposed` items. **This is the asset to build on.**

---

## 3. New capabilities

| Tab / layer | Purpose |
|---|---|
| **Architecture** | Stable system-design reference (IO files, structure, skeleton) so humans and agents don't drift. Partially built today. |
| **Decisions** | Agent generates pros/cons; tech lead reviews and acts; can loop back to refine. Persistent trade-off trail. Built today; extend for agent capture. |
| **Milestones** | Per-project list of completed features; agent can add them; clicking one shows a **session summary + code diff**. Diff reuses the existing Git IPC. |
| **Context (vector DB)** | Semantic index over stories, docs, code, decisions, milestones. Agents **search and pull** what's relevant on demand instead of being handed everything upfront. |
| **Persistence** | Everything permanent project memory. Survives close/reopen and Export/Import. |

---

## 4. The hard part

The tabs only help if agent interaction happens **inside** DevTracker. Real work
happens **outside** it — IDEs, Claude Desktop, CLI tools — where the agent can't
use DevTracker context, can't flag decisions, and can't update milestones without
the human copy-pasting on every turn.

**Central question:** how do we tap into agent conversations in external tools and
feed them back into DevTracker without the human as a manual bridge?

**Chosen direction:** expose DevTracker as an **MCP server** so agents call native
tools directly. Rejected: IDE plugin (human is still the bridge) and structured
paste (still manual copy-paste). See `adr/ADR-DT-002.md`.

---

## 5. The blocking constraint (read before planning)

The build order can't start with the MCP tools, because **the source of truth today
lives in browser localStorage** — and an MCP server is a *separate process* invoked
by Claude Desktop / an IDE / the office CLI. That process **cannot read
localStorage.** No `capture_decision`, `flag_milestone`, or `query_context_db` can
work until the workspace lives somewhere both the UI and an external process can
reach.

**Therefore step zero is relocating the source of truth** to a file or embedded DB
on disk. This is close to a one-way door — every downstream feature assumes a shared,
process-independent store. Full analysis in `DATA_LAYER.md`; decision in
`adr/ADR-DT-001.md`.

Two more consequences of going server-first:

1. **Security stakes rise.** Once agents write content that the UI renders with
   `innerHTML`, a prompt-injected or repo-poisoned agent becomes a stored-XSS
   vector into an Electron renderer that holds `desktopApi` (file read, git exec,
   shell). The known unescaped paths (SVG preview; any `innerHTML` that skips
   `esc()`) must be fixed **as part of** the MCP milestone, not after. Add a
   Content-Security-Policy to `index.html`.
2. **Preserve the human gate at the tool boundary.** `capture_decision` must always
   write `status: "proposed"`, `choice: ""`. `flag_milestone` proposes; the tech
   lead confirms. Agent autonomy is for *capturing context*, never *deciding*.

---

## 6. Reordered build plan

0. **Shared data layer** — move the source of truth out of localStorage into a
   file/SQLite store owned by the Electron main process, exposed to the renderer
   over IPC and to external processes for the MCP server. (`DATA_LAYER.md`,
   `ADR-DT-001`.)
1. **Lock the schema** on that store (tickets, decisions, milestones, sessions,
   acceptance criteria, context chunks). Keep JSON Export/Import for portability.
2. **Data models + tabs** for Architecture, Decisions, Milestones against the
   shared store.
3. **MCP server + sanitization together** — the four tools of §6-old, reading/
   writing the shared store; fix XSS paths and add CSP in the same milestone.
4. **Context vector DB** backing `query_context_db` (`ADR-DT-003`).
5. **Registration** for Claude Desktop + one IDE; document setup.
6. **Office feasibility spike** — does the office CLI speak MCP or a proprietary
   connector format? (`ADR-DT-004`, §7.)

---

## 7. Constrained office environment (secondary)

Office setup is CLI-only (no IDE integration); a terminal command appears to
trigger a remote MiniMax invocation. If DevTracker is an MCP server it *may* serve
this environment too — but only if the office CLI supports MCP. The MiniMax
harness looks custom, which makes a proprietary connector format more likely than
MCP-native support. **Treat §7 as a feasibility spike, not a design driver.** Build
for the solo case first; a thin connector shim can translate to the four tools if
needed. Note: "connector" (a packaged integration) and "MCP" (the open protocol)
are related but not interchangeable — the office conversation may hinge on exactly
that distinction.

---

## 8. Open questions

- Exact JSON workspace schema to freeze on the new store (start from current
  Export shape).
- Does the office CLI support MCP or a specific connector format? (Blocks §7.)
- Embedding + vector store for offline-first: local embedding model vs. remote API
  vs. bundled index. (`ADR-DT-003`.)
- Milestone diff capture: extend the existing `get-git-log` IPC to snapshot a diff
  range per milestone.

---

## 9. Decisions to ratify

These are captured as proposed ADRs in `docs/adr/` for the Tech Lead to decide:

- **ADR-DT-001** — Source-of-truth data store (localStorage → file/SQLite).
- **ADR-DT-002** — External integration approach (MCP server).
- **ADR-DT-003** — Offline embeddings + vector store.
- **ADR-DT-004** — Constrained office-environment strategy.

---

## 10. Implementation status (v0.2)

Built and tested offline:

- Shared JSON data store + IPC; renderer migrated off localStorage (§5–6 step 0–1).
- MCP server with all four tools over **both stdio and Streamable HTTP** (bearer
  auth, loopback-default). Proposed-only decision gate enforced.
- Context DB: offline **lexical** index + **repo code/doc ingestion**
  (`store/ingest.js`, "Index repo → context" button, `npm run ingest`).
- Milestone detail view: session summary + git-resolved diff.
- Security: SVG sanitize, CSP, path-traversal + URL-scheme hardening.

Still open (need your machine or an external spike):

- Neural embeddings (index is lexical, behind the same interface — ADR-DT-003).
- Office-CLI feasibility spike: does it speak MCP or a proprietary connector
  format? (ADR-DT-004). HTTP transport now exists, so this is the only blocker.
- `npm install` + `npm start` / `npm test` verification on macOS.
