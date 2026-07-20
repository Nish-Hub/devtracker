#!/usr/bin/env node
'use strict';
/**
 * DevTracker MCP server — Streamable HTTP transport (MCP_SERVER.md §4; ADR-DT-004).
 * For remote / headless / constrained-CLI environments (the office scenario).
 * Tool logic is shared with the stdio server via ./tools.js.
 *
 * Security posture:
 *  - Binds to 127.0.0.1 by default.
 *  - If bound to a non-loopback host, a bearer token (DEVTRACKER_MCP_TOKEN) is
 *    REQUIRED, or the server refuses to start.
 *
 * The routing + auth below is plain Node http (unit tested). The MCP protocol
 * itself is handled by the SDK's StreamableHTTPServerTransport, injected via the
 * `dispatch` function so the wiring can be tested with a fake offline.
 */
const http = require('http');
const { TOOLS, handleCall, DEFAULT_STORE_PATH } = require('./tools');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

function readJson(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    let over = false;
    req.on('data', c => {
      data += c;
      if (data.length > limitBytes) {
        over = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (over) return reject(new Error('payload too large'));
      if (!data) return resolve(undefined);
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Build the HTTP request handler. `dispatch(req,res,body)` speaks MCP. */
function createHandler({ token, dispatch }) {
  return async function handler(req, res) {
    const url = String(req.url || '');
    const pathOnly = url.split('?')[0];

    if (req.method === 'GET' && pathOnly === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, tools: TOOLS.map(t => t.name) }));
    }
    if (pathOnly !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
      return res.end(
        JSON.stringify({ error: 'method not allowed (stateless server accepts POST /mcp)' })
      );
    }
    if (token) {
      if ((req.headers['authorization'] || '') !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'unauthorized' }));
      }
    }
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
    try {
      await dispatch(req, res, body);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  };
}

/** Real MCP dispatch backed by the SDK's Streamable HTTP transport (stateless). */
async function makeSdkDispatch(storePath) {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import(
    '@modelcontextprotocol/sdk/types.js'
  );

  return async function dispatch(req, res, body) {
    const server = new Server(
      { name: 'devtracker', version: '0.1.0' },
      { capabilities: { tools: {} } }
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async r => {
      const { name, arguments: args } = r.params;
      try {
        return {
          content: [{ type: 'text', text: JSON.stringify(handleCall(name, args, storePath)) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
          isError: true,
        };
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      try {
        transport.close && transport.close();
        server.close && server.close();
      } catch (_) {
        /* ignore close errors */
      }
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}

async function main() {
  const port = Number(process.env.PORT || 7337);
  const host = process.env.HOST || '127.0.0.1';
  const token = process.env.DEVTRACKER_MCP_TOKEN || '';
  const storePath = DEFAULT_STORE_PATH;

  if (!LOOPBACK.has(host) && !token) {
    console.error(
      'Refusing to start: binding to a non-loopback host requires DEVTRACKER_MCP_TOKEN.'
    );
    process.exit(1);
  }

  const dispatch = await makeSdkDispatch(storePath);
  const server = http.createServer(createHandler({ token, dispatch }));
  server.listen(port, host, () => {
    console.error(
      `DevTracker MCP HTTP server on http://${host}:${port}/mcp` +
        `${token ? ' (bearer auth on)' : ' (no auth — loopback only)'}. Store: ${storePath}`
    );
  });
}

module.exports = { createHandler, readJson, makeSdkDispatch };

if (require.main === module) {
  main().catch(err => {
    console.error('DevTracker MCP HTTP fatal:', err);
    process.exit(1);
  });
}
