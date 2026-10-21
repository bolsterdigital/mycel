// MCP front (ADR 009): every use case in the registry becomes a tool (commands) or a resource
// (queries) with the same authorization as HTTP. Nothing here is specific to a use case.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { UseCaseRegistry } from '@mycel/core';

export function createMcpServer(registry: UseCaseRegistry): McpServer {
  const server = new McpServer({ name: 'mycel', version: '0.0.0' });
  for (const useCase of registry.list()) {
    // Tool registration with Zod input shapes follows once the first use case exists; the
    // registry already carries input/output schemas, so this is a mechanical mapping.
    void useCase;
  }
  return server;
}
