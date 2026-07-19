# DevTracker -- Project Context

> **Version:** 0.1 (Project Foundation) **Date:** July 2026

# Vision

DevTracker is not intended to be another task tracker.

Its purpose is to become a **persistent memory layer between a human
software engineer and AI development agents** (Claude, ChatGPT, Gemini,
Codex, Cursor, etc.).

The guiding principle is:

> Every feature should reduce the amount of context a human has to
> re-explain to an AI.

------------------------------------------------------------------------

# Background

The project started from an HTML-based dependency tracker for the
ContextRAG MVP.

Existing capabilities included:

-   Dependency graph with auto layout
-   Cycle detection
-   Stage status tracking
-   XP and badges
-   Local persistence
-   Progress dashboard

During review, we identified a fundamental limitation:

> The tracker was an excellent solo tracker but not an AI collaboration
> tool.

The browser knew the project state.

The AI did not.

------------------------------------------------------------------------

# Original Review Summary

## What worked

-   Dependency graph
-   Auto layout
-   XP and gamification
-   Local persistence
-   Progress tracking

## Gaps

-   No edit stage
-   No export/import
-   Badge consistency quirks

## Fundamental Problem

The application stores project knowledge inside browser storage.

Every new AI session starts with zero memory.

That causes repeated explanations and loss of engineering context.

------------------------------------------------------------------------

# Desired Human ↔ AI Workflow

1.  Open tracker
2.  Select next unblocked ticket
3.  Generate AI Session Brief
4.  Paste into Claude/ChatGPT
5.  Work together
6.  AI returns Session Report
7.  Paste Session Report back
8.  Tracker updates itself

This closed feedback loop is the core product vision.

------------------------------------------------------------------------

# Functional Requirements

## Tier 1

-   Rich ticket specifications
-   Acceptance Criteria
-   Definition of Done
-   Technical Notes
-   Session History
-   Copy Session Brief
-   Paste Session Report
-   Decision Log (ADR-lite)

## Tier 2

-   Open Questions
-   AC progress on graph nodes
-   Context-aware briefs

## Tier 3

-   Edit Ticket
-   Next-up highlighting
-   Export / Import JSON

------------------------------------------------------------------------

# Product Philosophy

DevTracker should become an Engineering Workspace instead of a task
tracker.

It should preserve:

-   Decisions
-   Context
-   History
-   Rationale
-   Sessions
-   Blockers

not merely completion status.

------------------------------------------------------------------------

# Proposed Architecture

    project
    tickets
    decisions
    sessions
    timeline
    questions
    settings
    metrics

Each ticket evolves into:

    Ticket
     ├── Description
     ├── Acceptance Criteria
     ├── Definition of Done
     ├── Technical Notes
     ├── Dependencies
     ├── Files
     ├── Sessions
     ├── Questions
     └── Status

------------------------------------------------------------------------

# Planned Repository Structure

``` text
devtracker/
│
├── index.html
├── css/
├── js/
│   ├── graph/
│   ├── dashboard/
│   ├── ticket/
│   ├── session/
│   ├── ai/
│   ├── decisions/
│   └── export/
├── docs/
└── data/
```

------------------------------------------------------------------------

# Architecture Decisions

## ADR-001

Split the monolithic HTML into modular HTML/CSS/JavaScript while
remaining framework-free.

## ADR-002

Replace the existing node-centric state model with a project-centric
workspace model.

------------------------------------------------------------------------

# Sprint Roadmap

## Sprint 1

-   Modular architecture
-   Rich tickets
-   Session history
-   Decision log
-   Storage v3
-   Edit ticket

## Sprint 2

-   AI Session Brief
-   AI Session Report parser
-   Open questions
-   AI memory

## Sprint 3

-   Dashboard
-   Timeline
-   Next-up highlighting
-   JSON export/import

------------------------------------------------------------------------

# Engineering Standards

-   SOLID
-   DRY
-   KISS
-   Vanilla JavaScript
-   Modular code
-   No frameworks
-   Documentation-first

------------------------------------------------------------------------

# Team Roles

## Tech Lead (User)

-   Product vision
-   Prioritization
-   Architecture reviews
-   Sprint acceptance

## Principal Engineer (ChatGPT)

-   System design
-   UI/UX
-   Code quality
-   Documentation
-   Technical decisions
-   AI workflow

------------------------------------------------------------------------

# Long-term Vision

DevTracker should evolve into an AI-first development workspace
supporting multiple AI assistants.

Future AI integrations should include:

-   Claude
-   ChatGPT
-   Gemini
-   Codex
-   Cursor
-   GitHub Copilot

through a common "Generate AI Context" workflow.

------------------------------------------------------------------------

# North Star

> Build a workspace that preserves engineering knowledge so humans never
> have to repeatedly explain the same project context to AI assistants.
