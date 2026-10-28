import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Invoker, buildRegistry, systemPrincipal } from '@mycel/core';
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

// What only MCP has: a published page as a resource, and structured content beside the text.
// Generic MCP behaviour (tool list, schemas, authorization, error shape) is in
// registry.conformance.test.ts. The signup flow end to end is api/app.test.ts; key revocation
// for the agent is api/auth.test.ts (memory) and api/auth-runtime.test.ts (Postgres); one audit
// row per command is core registry.conformance.test.ts.
describe('MCP front', () => {
  it('reads a published page as a resource, only in its published locale', async () => {
    const client = await connect();
    const input = probePage(FORM);
    input.document.blocks[0] = {
      type: 'heading',
      version: 1,
      props: { text: { nl: 'Meld je aan', en: 'EN-DRAFT-MARKER' } },
    };
    const created = await client.callTool({ name: 'content.item.create', arguments: input });
    expect(created.structuredContent).toEqual(text(created));
    const { item, revision } = text(created);
    expect(item).toMatchObject({ slug: 'signup' });
    await client.callTool({
      name: 'content.item.publish',
      arguments: { itemId: item.id, revisionId: revision.id, locale: 'nl' },
    });

    const res = await client.readResource({ uri: 'mycel://published/page/signup' });
    const page = String(res.contents[0]?.text);
    expect(JSON.parse(page)).toMatchObject({ slug: 'signup', locale: 'nl' });
    expect(page).not.toContain('EN-DRAFT-MARKER');
  });
});
