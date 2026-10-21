import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Invoker, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import {
  FakeClock,
  MemoryIdentityStore,
  MemoryTenants,
  MemoryUnitOfWork,
  probeForm,
  probePage,
  probeTenant,
} from '@mycel/core/testing';
import { createAuthenticator } from '@mycel/api/compose';
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

// Generic MCP behaviour (tool list, schemas, authorization, error shape) is in
// registry.conformance.test.ts; this file keeps the signup flow end to end.
describe('MCP front', () => {
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
    expect(submitted.structuredContent).toMatchObject({ status: 'accepted' });
  });
});

describe('MCP front with a key from the table', () => {
  it('acts with the key until it is revoked, without restarting the server', async () => {
    const uow = new MemoryUnitOfWork();
    const invoker = new Invoker(buildRegistry(), uow);
    const admin = systemPrincipal(TENANT, 'test');
    const key = await invoker.run(useCases.createKey, admin, {
      name: 'agent',
      capabilities: ['content:read'],
    });
    const auth = createAuthenticator({
      identity: new MemoryIdentityStore(uow.store, new MemoryTenants([probeTenant(TENANT)])),
      uow,
      clock: new FakeClock(),
      agentToken: key.token,
      sessionId: 'session-1',
    });
    const server = createMcpServer(invoker, auth.agentPrincipal);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const read = () => client.callTool({ name: 'content.page.get', arguments: { slug: 'x' } });

    expect(text(await read())).toMatchObject({ code: 'not_found' });
    // The key's capabilities, not more: no member management for an agent.
    expect(text(await client.callTool({ name: 'tenant.keys.list', arguments: {} }))).toMatchObject({
      code: 'forbidden',
    });
    await invoker.run(useCases.revokeKey, admin, { id: key.id });
    const after = await read();
    expect(after.isError).toBe(true);
    expect(text(after)).toMatchObject({ code: 'forbidden', message: /revoked/ });
  });
});
