# ADR-DT-003: Offline embeddings & vector store

* **Status:** PROPOSED
* **Date:** 2026-07-20
* **Reversibility:** One-way door (hard to undo)

## Context
The context layer backs `query_context_db`: a semantic index over stories, docs,
code, decisions, and milestones so agents pull what's relevant on demand. The app
is offline-first, but embeddings require a model — creating tension between "truly
offline" and "call an embedding API". The store also becomes hard to migrate once
a project is fully indexed.

## Options Considered
* **Option: Local embedding model + SQLite vector index — agent recommendation**
  * Pros:
    - True offline; no data leaves the machine
    - One store (reuses ADR-DT-001 SQLite) via a vector extension
    - No per-call cost or rate limits
  * Cons:
    - Bundles a model/runtime; larger install
    - Local embedding quality below top hosted models

* **Option: Remote embedding API**
  * Pros:
    - Best embedding quality; nothing to bundle
    - Trivial to implement
  * Cons:
    - Breaks offline-first; sends project content to a third party
    - Cost, rate limits, network dependency

* **Option: Bundled standalone vector store (separate service)**
  * Pros:
    - Purpose-built retrieval, strong filtering
    - Scales beyond a single file
  * Cons:
    - Extra service to run and sync alongside the workspace store
    - Heavy for a solo desktop tool

## Decision Outcome & Rationale
**Chosen Option:** Undecided — Tech Lead to decide.

### Rationale
Agent recommendation: local embedding model + a vector index inside the SQLite
store, keeping the whole thing offline and single-store. Hide the embedding source
behind the `query_context_db` interface so a remote model can be swapped in later
without touching callers. Defer a standalone vector service until scale demands it.
