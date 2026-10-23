// Registry conformance for the MCP front (testing.md): generic over `buildRegistry().list()`, so a
// new use case is covered without touching this file. Domain behaviour lives in mcp.test.ts.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCESS,
  Invoker,
  buildRegistry,
  toJsonSchema,
  type Capability,
  type Principal,
  type UseCase,
} from '@mycel/core';
import { MemoryUnitOfWork } from '@mycel/core/testing';
import { createMcpServer } from './index.js';

const TENANT = '01900000-0000-7000-8000-00000000aaaa';
const registry = buildRegistry();
const useCases = registry.list();

async function connect(capabilities: Capability[]) {
  const principal: Principal = {
    tenantId: TENANT,
    // An agent never carries tenant:admin, and the member and key use cases refuse one that
    // claims it (TODO #20a); background work is the actor that does hold it without a membership.
    actor: capabilities.includes('tenant:admin')
      ? { kind: 'system', job: 'conformance' }
      : { kind: 'agent', sessionId: 'conformance', keyId: 'conformance' },
    capabilities,
    entitlements: DEFAULT_ACCESS.entitlements,
    tenantStatus: DEFAULT_ACCESS.status,
  };
  const server = createMcpServer(
    new Invoker(registry, new MemoryUnitOfWork()),
    async () => principal
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'conformance', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const payload = (r: unknown) =>
  JSON.parse((r as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>;

describe('MCP conformance: listing', () => {
  // The first listing converts every use case's schemas over a fresh MCP connection; since vitest
  // 5 that warm-up lands in this test and took 8s on a CI runner (PR #24), over the 5s default.
  it(
    'lists exactly the registry as tools, with its input and output schemas',
    { timeout: 30_000 },
    async () => {
      const { tools } = await (await connect([])).listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(useCases.map((u) => u.name).sort());
      for (const u of useCases) {
        const tool = tools.find((t) => t.name === u.name)!;
        expect(tool.description).toBe(u.description);
        expect(tool.inputSchema).toEqual(toJsonSchema(u.input, 'input'));
        expect(tool.outputSchema).toMatchObject(toJsonSchema(u.output, 'output'));
        expect(tool.annotations?.readOnlyHint).toBe(u.kind === 'query');
      }
    }
  );

  it('lists every query with a resource as a resource template', async () => {
    const { resourceTemplates } = await (await connect([])).listResourceTemplates();
    expect(resourceTemplates.map((r) => r.uriTemplate).sort()).toEqual(
      useCases
        .filter((u) => u.kind === 'query' && u.resource)
        .map((u) => u.resource!.uriTemplate)
        .sort()
    );
  });
});

describe.each(useCases.map((u) => [u.name, u] as const))('MCP conformance: %s', (_n, useCase) => {
  const call = async (capabilities: Capability[], args: unknown) =>
    (await connect(capabilities)).callTool({
      name: useCase.name,
      arguments: args as Record<string, unknown>,
    });

  it('returns forbidden for a principal without the capability', async () => {
    const result = await call([], useCase.examples[0].input);
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'forbidden' });
  });

  it('returns invalid_input with issues for arguments that violate the schema', async () => {
    const result = await call([useCase.requires], brokenArgs(useCase));
    expect(result.isError).toBe(true);
    const error = payload(result);
    if (
      useCase.actors &&
      !useCase.actors.includes(useCase.requires === 'tenant:admin' ? 'system' : 'agent')
    ) {
      expect(error).toMatchObject({ code: 'forbidden' });
      return;
    }
    expect(error).toMatchObject({ code: 'invalid_input' });
    expect((error.issues as unknown[]).length).toBeGreaterThan(0);
  });

  it('accepts examples[0] with exactly the required capability', async () => {
    const result = await call([useCase.requires], useCase.examples[0].input);
    if (
      useCase.actors &&
      !useCase.actors.includes(useCase.requires === 'tenant:admin' ? 'system' : 'agent')
    ) {
      expect(result.isError).toBe(true);
      expect(payload(result)).toMatchObject({ code: 'forbidden' });
      return;
    }
    // The example's data need not exist in an empty tenant: not_found and conflict are fine.
    if (result.isError) expect(['not_found', 'conflict']).toContain(payload(result).code);
    else expect(result.structuredContent).toBeDefined();
  });
});

/**
 * Every input field set to a value no scalar or object schema of a real field accepts. An input
 * without fields gets an unknown one, so such a use case has to declare its input strict.
 */
function brokenArgs(useCase: UseCase): Record<string, unknown> {
  const properties = Object.keys(toJsonSchema(useCase.input, 'input').properties ?? {});
  if (!properties.length) return { unexpected: [null] };
  return Object.fromEntries(properties.map((field) => [field, [null]]));
}
