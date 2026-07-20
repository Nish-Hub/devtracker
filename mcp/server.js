#!/usr/bin/env node
'use strict';
/**
 * DevTracker MCP server — stdio transport (MCP_SERVER.md §4).
 * For local single-user clients (Claude Desktop, IDE MCP clients on the same
 * machine). Tool logic lives in ./tools.js and is shared with http-server.js.
 */
const { TOOLS, handleCall, DEFAULT_STORE_PATH } = require('./tools');

async function main() {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import(
    '@modelcontextprotocol/sdk/types.js'
  );

  const server = new Server(
    { name: 'devtracker', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async req => {
    const { name, arguments: args } = req.params;
    try {
      return { content: [{ type: 'text', text: JSON.stringify(handleCall(name, args)) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`DevTracker MCP server running (stdio). Store: ${DEFAULT_STORE_PATH}`);
}

// Re-exported so existing tests (../test/mcp.test.js) keep working.
module.exports = { TOOLS, handleCall };

if (require.main === module) {
  main().catch(err => {
    console.error('DevTracker MCP fatal:', err);
    process.exit(1);
  });
}
