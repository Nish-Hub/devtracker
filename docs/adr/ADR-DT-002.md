# ADR-DT-002: External integration approach

* **Status:** PROPOSED
* **Date:** 2026-07-20
* **Reversibility:** Two-way door (reversible)

## Context
Real agent work happens outside DevTracker — in IDEs, Claude Desktop, and CLI
tools. We need to feed those conversations back into DevTracker (decisions,
milestones, context) without the human acting as a manual copy-paste bridge on
every turn.

## Options Considered
* **Option: IDE plugin / sidebar**
  * Pros:
    - Familiar surface inside the editor
    - Full control over UX
  * Cons:
    - Human is still the manual bridge (clicks to log/flag/query)
    - One build per IDE; no CLI story

* **Option: Structured report paste**
  * Pros:
    - Reuses the existing session-report parser
    - No new protocol
  * Cons:
    - Still human-in-the-loop copy-paste; friction remains
    - Nothing happens autonomously during the session

* **Option: MCP server — agent recommendation**
  * Pros:
    - Agents call tools directly; no manual bridge
    - One integration serves rich IDEs and CLI-only environments
    - Open standard; configure once per environment
  * Cons:
    - Requires the shared data store first (ADR-DT-001)
    - Raises security stakes: agent-written content becomes an XSS vector until
      render paths are sanitized

## Decision Outcome & Rationale
**Chosen Option:** Undecided — Tech Lead to decide.

### Rationale
Agent recommendation: MCP server. It is the only option that removes the human
bridge and serves both target environments from one build. Reversible: the store
(ADR-DT-001) is the durable asset; the integration layer on top can change. Adopt
MCP but pair it with the sanitization work and the proposed-only write rule so the
human edge and the renderer stay safe.
