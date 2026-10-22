// MCP front (ADR 009 rules 7-8): every use case in the registry becomes a tool, and queries that
// declare a `resource` template are also MCP resources. Authorization and validation are the
// Invoker's, the same code path the HTTP API and the web app use; nothing here names a use case.
//
// Tools are served from the low-level `Server` rather than `McpServer.registerTool`: the latter
// validates arguments itself before the handler runs, which would answer a caller without the
// capability with a schema error and give invalid input a different error shape than HTTP. Here
// the tool schemas are core's `toJsonSchema`, identical to the OpenAPI document's.

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  UseCaseError,
  toJsonSchema,
  type ErrorReporter,
  type Invoker,
  type Principal,
  type UseCase,
} from '@mycel/core';

const asText = (value: unknown) => JSON.stringify(value, null, 2);

/** The tool listing for one use case; exported for the conformance suite. */
export function toolOf(useCase: UseCase): Tool {
  // MCP requires an object at the top of both schemas; a union of objects says so explicitly.
  const output = toJsonSchema(useCase.output, 'output');
  return {
    name: useCase.name,
    description: useCase.description,
    inputSchema: toJsonSchema(useCase.input, 'input') as Tool['inputSchema'],
    outputSchema: { type: 'object', ...output } as Tool['outputSchema'],
    annotations: {
      readOnlyHint: useCase.kind === 'query',
      destructiveHint: useCase.kind === 'command' && useCase.effect !== undefined,
    },
  };
}

/** The same `{ code, message, issues }` the HTTP front puts in its Problem Details extensions. */
function toolError(e: UseCaseError): CallToolResult {
  return {
    isError: true,
    content: [
      { type: 'text', text: asText({ code: e.code, message: e.message, issues: e.issues }) },
    ],
  };
}

export function createMcpServer(
  invoker: Invoker,
  principal: () => Promise<Principal>,
  /** Unexpected failures; the caller only sees "internal error". Tests leave it out. */
  errors?: ErrorReporter
): McpServer {
  const server = new McpServer({ name: 'mycel', version: '0.0.0' });
  const useCases = invoker.registry.list();
  const tools = useCases.map(toolOf);

  server.server.registerCapabilities({ tools: { listChanged: false } });
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (!invoker.registry.get(params.name))
      throw new McpError(ErrorCode.InvalidParams, `unknown tool "${params.name}"`);
    try {
      const result = await invoker.call(await principal(), params.name, params.arguments ?? {});
      return {
        content: [{ type: 'text', text: asText(result) }],
        structuredContent: result as Record<string, unknown>,
      };
    } catch (e) {
      if (e instanceof UseCaseError) return toolError(e);
      errors?.capture(e, { tags: { tool: params.name } });
      throw new McpError(ErrorCode.InternalError, 'internal error');
    }
  });

  for (const useCase of useCases) {
    if (useCase.kind !== 'query' || !useCase.resource) continue;
    server.registerResource(
      useCase.name,
      new ResourceTemplate(useCase.resource.uriTemplate, { list: undefined }),
      { description: useCase.description, mimeType: 'application/json' },
      async (uri, variables) => {
        const input = Object.fromEntries(
          Object.entries(variables).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])
        );
        const result = await invoker.call(await principal(), useCase.name, input);
        return {
          contents: [{ uri: uri.href, mimeType: 'application/json', text: asText(result) }],
        };
      }
    );
  }
  return server;
}
