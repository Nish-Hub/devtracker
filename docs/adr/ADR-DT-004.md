# ADR-DT-004: Constrained office-environment strategy

* **Status:** PROPOSED
* **Date:** 2026-07-20
* **Reversibility:** Two-way door (reversible)

## Context
The office setup is CLI-only (no IDE integration); a terminal command appears to
trigger a remote MiniMax invocation. Whether DevTracker's MCP server can serve this
environment depends on whether the office CLI supports MCP or only a proprietary
connector format — a fact we cannot determine from DevTracker's side and must spike.

## Options Considered
* **Option: Feasibility spike first, build for solo case — agent recommendation**
  * Pros:
    - Avoids committing to office constraints before they're known
    - Solo case (Claude Desktop + one IDE) delivers value immediately
    - Keeps the design clean
  * Cons:
    - Office support remains unconfirmed for now

* **Option: Commit to MCP-over-HTTP for the office now**
  * Pros:
    - If the CLI speaks MCP, office folks get it directly
    - Forces the remote-transport work early
  * Cons:
    - Bets on unverified CLI MCP support
    - Wasted effort if the CLI needs a proprietary connector

* **Option: Build a connector shim for the office CLI format**
  * Pros:
    - Works even if the CLI doesn't speak MCP
    - Small if the four tools are well-defined
  * Cons:
    - Premature before the CLI's format is known
    - A second integration surface to maintain

## Decision Outcome & Rationale
**Chosen Option:** Undecided — Tech Lead to decide.

### Rationale
Agent recommendation: run a feasibility spike (does the office CLI accept MCP, or a
specific connector format?) and build for the solo case in the meantime. Reversible
because the four tools and the store are the durable assets; a thin shim can
translate to a proprietary format later if the spike requires it. Do not let the
office constraint drive the core design.

### Implementation note (v0.2)
The MCP server now also runs over **Streamable HTTP** (`npm run mcp:http`,
loopback-default with optional bearer token), so a remote/CLI client that speaks
MCP can already connect. The remaining unknown is purely the spike: whether the
office CLI speaks MCP at all. If it needs a proprietary connector format, the shim
option above becomes the path — the HTTP endpoint and shared tool layer make that
shim small.
