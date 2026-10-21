// `npm run mcp -w @mycel/mcp`: the MCP server over stdio, acting as an agent principal of the
// tenant named by MYCEL_API_KEY_TENANT. Stdout is the protocol channel: never console.log here.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRuntime } from '@mycel/api/compose';
import { createMcpServer } from './index.js';

const runtime = createRuntime();
const server = createMcpServer(runtime.invoker, () => runtime.agentPrincipal());
await server.connect(new StdioServerTransport());
process.on('SIGINT', () => void runtime.close().then(() => process.exit(0)));
