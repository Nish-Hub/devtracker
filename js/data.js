export const STORAGE_KEY = 'devtracker:workspace:v3';

const ticket = (id, title, effort, line, deps, description, acceptanceCriteria, definitionOfDone, technicalNotes) => ({
  id, title, effort, line, deps, description, acceptanceCriteria: acceptanceCriteria.map(text => ({ text, done: false })),
  definitionOfDone, technicalNotes, status: 'todo', sessions: [], scratchpad: ''
});

const projectTemplate = (id, name, code, description, tickets, decisions, questions, selectedTicketId) => ({
  id,
  name,
  code,
  description,
  tickets,
  decisions,
  questions,
  selectedTicketId
});

export const DEFAULT_WORKSPACE = {
  version: 3,
  activeProjectId: 'CTXR',
  projects: [
    projectTemplate(
      'CTXR',
      'ContextRAG MVP',
      'CTXR',
      'A retrieval workspace for engineering context.',
      [
    ticket('CTXR-1', 'Bootstrap Spring Boot', 'XS', 'critical', [], 'Create the Java 21 service foundation with a clean package structure and a health endpoint.', ['Spring Boot app starts on the documented port', 'Java 21 toolchain is enforced', 'Health endpoint returns a successful response', 'Base package and error handling are established'], 'The repository builds from a clean checkout and the service exposes a verified health check.', 'Use Java 21: it matches the office runtime. Keep the foundation intentionally small.'),
    ticket('CTXR-2', 'MongoDB + config layer', 'XS', 'critical', ['CTXR-1'], 'Connect the service to MongoDB and establish typed, environment-driven configuration.', ['Mongo connection properties are externalised', 'A local development profile is documented', 'Connection failure produces an actionable error', 'Configuration is covered by a focused test'], 'A developer can start the application against local MongoDB without changing source code.', 'Prefer Spring configuration properties over scattered environment lookups.'),
    ticket('CTXR-3', 'Jina embedding service', 'S', 'critical', ['CTXR-2'], 'Implement the boundary that turns content into embeddings through Jina.', ['Embedding client reads its API key from configuration', 'Single-text embedding returns a validated vector', 'Timeout and rate-limit failures are handled', 'Client contract has unit tests'], 'A stable embedding abstraction is available to ingestion and search code.', 'Keep provider-specific DTOs behind an interface; Jina limits may require backoff.'),
    ticket('CTXR-4', 'Document model + storage', 'S', 'adapter', ['CTXR-2'], 'Define the canonical indexed document model and persist documents with metadata and embedding fields.', ['Document schema includes source, content, metadata and embedding', 'Repository can create and retrieve a document', 'Indexes needed for retrieval are declared', 'Validation rejects incomplete documents'], 'The storage model is ready for every source adapter without source-specific fields leaking into it.', 'Keep source metadata flexible; preserve source URL and a deterministic external ID.'),
    ticket('CTXR-5', 'GitHub code adapter', 'M', 'critical', ['CTXR-3', 'CTXR-4'], 'Ingest source files from a GitHub repository, chunk them, embed them, and save the resulting documents.', ['Repository and branch are configurable', 'Supported code files are fetched and chunked', 'Chunks are embedded and persisted', 'Reruns are idempotent', 'Errors identify the affected file'], 'A sample repository can be indexed end to end and queried from MongoDB.', 'Start with one repository. Use deterministic IDs to make re-indexing safe.'),
    ticket('CTXR-6', 'GitHub issues adapter', 'S', 'adapter', ['CTXR-4'], 'Index GitHub issues and comments into the canonical document store.', ['Issue title, body and comments are captured', 'Issue metadata links back to GitHub', 'Content is embedded and persisted', 'Closed/open state is represented'], 'A repository’s issue history can be retrieved alongside code context.', 'Share ingestion conventions with the code adapter; do not duplicate persistence logic.'),
    ticket('CTXR-7', 'Markdown docs adapter', 'S', 'adapter', ['CTXR-4'], 'Index Markdown documentation from the local repository or a configured path.', ['Markdown files are discovered recursively', 'Front matter and headings become metadata', 'Documents are chunked and stored', 'Unsupported files are skipped safely'], 'Project documentation can be retrieved with traceable file references.', 'Preserve file paths and headings so responses can cite their source.'),
    ticket('CTXR-8', 'Vector search REST API', 'S', 'search', ['CTXR-4'], 'Expose a search endpoint that embeds a query and returns relevant context.', ['Request validates query and result limit', 'Query embedding is generated through the shared service', 'Results include score and source metadata', 'Empty results have a clear response', 'Endpoint is integration tested'], 'A caller can retrieve relevant indexed context through a documented HTTP contract.', 'Begin with the MongoDB vector search path; keep ranking details internal.'),
    ticket('CTXR-9', 'Python MCP server', 'M', 'critical', ['CTXR-5', 'CTXR-6', 'CTXR-7', 'CTXR-8'], 'Provide an MCP server that gives AI clients a focused search-context tool.', ['MCP server starts with documented configuration', 'Search tool calls the REST API', 'Tool schema is concise and discoverable', 'Failures are returned as useful tool errors', 'A real MCP client smoke test passes'], 'An AI coding agent can retrieve ContextRAG knowledge through MCP.', 'Keep Python thin: it adapts MCP to the REST API rather than duplicating retrieval logic.'),
    ticket('CTXR-10', 'PR scope + ship MVP', 'M', 'critical', ['CTXR-9'], 'Prepare a narrow, demonstrable MVP release and capture operating instructions.', ['Demo path is written and reproducible', 'Known limitations are documented', 'Configuration examples are safe to share', 'PR has focused scope and review notes', 'End-to-end smoke test is recorded'], 'The MVP is reviewable, runnable, and has a clear next iteration.', 'Optimise for a credible vertical slice rather than production completeness.')
      ],
      [
        { id: 'ADR-001', date: '2026-07-19', decision: 'Use Java 21 for the backend.', rationale: 'The office runtime runs Java 21; compatibility wins over adopting a newer release.' },
        { id: 'ADR-002', date: '2026-07-19', decision: 'Keep DevTracker framework-free and modular.', rationale: 'The workspace must be portable, inspectable, and easy for any AI agent to change.' }
      ],
      [
        { id: 'Q-001', lane: 'human', text: 'Which repository should be indexed first for the MVP demo?', resolved: false },
        { id: 'Q-002', lane: 'agent', text: 'What Jina API rate limits should the ingestion worker target?', resolved: false }
      ],
      'CTXR-1'
    ),
    projectTemplate(
      'DEVUI',
      'DevTracker UI',
      'DEVUI',
      'A companion project tracking the desktop UI and local Git integration.',
      [
        ticket('DEVUI-1', 'Update project selector', 'XS', 'ui', [], 'Add a project chooser so each workspace can own its own issue and decision history.', ['Project selector renders current project', 'New projects can be added from the header', 'Tickets and decisions update with project selection'], 'Project switching works without mixing state from other workspaces.', 'Keep the UI minimal and the selector easy to use.'),
        ticket('DEVUI-2', 'Show Git history per workspace', 'S', 'integrations', ['DEVUI-1'], 'Ensure the Git view remains available and clear when desktop mode is active for any selected project.', ['Git history note explains browser limitations', 'Git view refreshes after project changes', 'Commit list is readable with author and message'], 'The Git pane accurately reflects the local repository when the desktop app is used.', 'Git history is only available in Electron/desktop mode due to browser security restrictions.')
      ],
      [
        { id: 'ADR-003', date: '2026-07-19', decision: 'Store project state by project id.', rationale: 'Multiple concurrent workspaces should not share tickets, questions, or decisions unless explicitly merged.' }
      ],
      [
        { id: 'Q-003', lane: 'human', text: 'Should project selector changes preserve the previous project state automatically?', resolved: false }
      ],
      'DEVUI-1'
    )
  ]
};

export const effortXP = { XS: 15, S: 30, M: 60, L: 120 };
