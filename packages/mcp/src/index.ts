// MCP front (ADR 009 rules 7-8): every use case in the registry becomes a tool, and queries that
// declare a `resource` template are also MCP resources. Authorization is the Invoker's, the same
// code path the HTTP API and the web app use; nothing here is specific to a use case.

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { UseCaseError, type Invoker, type Principal, type UseCase } from '@mycel/core';

/**
 * MCP describes tool inputs as JSON Schema objects. Refined schemas (`.superRefine`) are
 * unwrapped for the description; the Invoker still validates against the full schema.
 */
function objectSchema(schema: z.ZodTypeAny): z.AnyZodObject {
  let s: z.ZodTypeAny = schema;
  while (s instanceof z.ZodEffects) s = s.innerType();
  if (!(s instanceof z.ZodObject)) throw new Error('use case input must be an object schema');
  return s.passthrough();
}

const asText = (value: unknown) => JSON.stringify(value, null, 2);

export function createMcpServer(invoker: Invoker, principal: () => Promise<Principal>): McpServer {
  const server = new McpServer({ name: 'mycel', version: '0.0.0' });

  for (const useCase of invoker.registry.list() as UseCase[]) {
    server.registerTool(
      useCase.name,
      {
        description: useCase.description,
        inputSchema: objectSchema(useCase.input),
        annotations: { readOnlyHint: useCase.kind === 'query' },
      },
      async (args) => {
        try {
          const result = await invoker.call(await principal(), useCase.name, args);
          return { content: [{ type: 'text', text: asText(result) }] };
        } catch (e) {
          if (!(e instanceof UseCaseError)) throw e;
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: asText({ code: e.code, message: e.message, issues: e.issues }),
              },
            ],
          };
        }
      }
    );

    if (useCase.kind === 'query' && useCase.resource) {
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
  }
  return server;
}
