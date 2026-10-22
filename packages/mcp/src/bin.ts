#!/usr/bin/env node
// `npm run mcp -w @mycel/mcp`, `mycel-mcp` (bin) or the image's `mcp` entrypoint: the MCP server over stdio, acting as one agent session with the
// tenant and capabilities of MYCEL_API_KEY's row in `api_keys`. The row is read on every call, so
// revoking the key stops a running server. Stdout is the protocol channel: never console.log here;
// the runtime's log lines go to stderr.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRuntime } from '@mycel/api/compose';
import { createMcpServer } from './index.js';

const runtime = createRuntime(undefined, {
  service: 'mcp',
  writeLog: (line) => void process.stderr.write(line + '\n'),
});
const server = createMcpServer(runtime.invoker, () => runtime.agentPrincipal(), runtime.errors);
await server.connect(new StdioServerTransport());
process.on('SIGINT', () => void runtime.close().then(() => process.exit(0)));
