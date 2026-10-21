import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Invoker, anonymousPrincipal, buildRegistry, systemPrincipal } from '@mycel/core';
import { MemoryUnitOfWork, probeForm, probePage } from '@mycel/core/testing';
import { createMcpServer } from './index.js';

const TENANT = '01900000-0000-7000-8000-00000000aaaa';
const FORM = '01900000-0000-7000-8000-00000000f000';

async function connect(principal = systemPrincipal(TENANT, 'agent')) {
  const uow = new MemoryUnitOfWork();
  await uow.run(systemPrincipal(TENANT, 'test'), (ctx) => ctx.forms.insert(probeForm(FORM)));
  const server = createMcpServer(new Invoker(buildRegistry(), uow), async () => principal);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);

describe('MCP front', () => {
  it('exposes every use case as a tool and queries as resources', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'content.page.create',
      'content.page.get',
      'forms.form.get',
      'forms.submit',
      'supporters.get',
    ]);
    expect(
      tools.find((t) => t.name === 'content.page.create')?.inputSchema.properties
    ).toHaveProperty('blocks');
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((r) => r.uriTemplate).sort()).toEqual([
      'mycel://forms/{id}',
      'mycel://pages/{slug}',
      'mycel://supporters/{email}',
    ]);
  });

  it('runs the same use cases: create a page, read it as a resource, submit the form', async () => {
    const client = await connect();
    const created = await client.callTool({
      name: 'content.page.create',
      arguments: probePage(FORM),
    });
    expect(text(created)).toMatchObject({ slug: 'signup' });

    const res = await client.readResource({ uri: 'mycel://pages/signup' });
    expect(JSON.parse(String(res.contents[0]?.text))).toMatchObject({ slug: 'signup' });

    const submitted = await client.callTool({
      name: 'forms.submit',
      arguments: {
        formId: FORM,
        values: { email: 'agent@example.org', consent: true },
        locale: 'en',
      },
    });
    expect(text(submitted)).toMatchObject({ status: 'accepted' });
  });

  it('applies the same authorization as HTTP', async () => {
    const client = await connect(anonymousPrincipal(TENANT, ['forms:write']));
    const result = await client.callTool({
      name: 'supporters.get',
      arguments: { email: 'a@example.org' },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatchObject({ code: 'forbidden' });
  });
});
