// ADR 026 over MCP: a save on an older base merges, a value both changed is a typed conflict
// with each path in its issues, and a key without `content:write` is refused before any merge.
// ADR 027 likewise for a block operation (rebased, or a conflict naming the block) and an author
// update on an older `updatedAt`.
// The same scenario runs over HTTP in packages/api (content-merge.conformance.test.ts); the merge
// itself is core's (`content/merge/merge.test.ts`).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { Invoker, buildRegistry, type Principal } from '@mycel/core';
import { MemoryUnitOfWork, principal } from '@mycel/core/testing';
import { createMcpServer } from './index.js';

const heading = (id: string, nl: string) => ({
  id,
  type: 'heading',
  version: 1,
  props: { text: { nl } },
});
const doc = (title: string, three = 'Drie', seven = 'Zeven') => ({
  type: 'page',
  defaultLocale: 'nl',
  locales: ['nl'],
  title: { nl: title },
  blocks: [heading('b3', three), heading('b7', seven)],
});

const writer = principal({ capabilities: ['content:read', 'content:write'] });
const reader = principal({ capabilities: ['content:read'] });

type Call = (name: string, input: unknown) => Promise<{ ok: boolean; body: any }>;

/** One MCP client per principal over a registry shared by the test. */
function front(invoker: Invoker) {
  return (p: Principal): Call => {
    let client: Promise<Client> | null = null;
    const connect = async () => {
      const server = createMcpServer(invoker, async () => p);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: 'test', version: '0' });
      await Promise.all([server.connect(a), c.connect(b)]);
      return c;
    };
    return async (name, input) => {
      client ??= connect();
      const r = await (
        await client
      ).callTool({ name, arguments: input as Record<string, unknown> });
      return {
        ok: !r.isError,
        body: JSON.parse((r as { content: { text: string }[] }).content[0]!.text),
      };
    };
  };
}

describe('content.item.update on an older base over MCP', () => {
  it('merges different blocks into one revision that names the merge', async () => {
    const as = front(new Invoker(buildRegistry(), new MemoryUnitOfWork()));
    const call = as(writer);
    const created = await call('content.item.create', { slug: 'merge', document: doc('Titel') });
    const { item, revision } = created.body;
    const agent = await call('content.item.update', {
      itemId: item.id,
      baseRevisionId: revision.id,
      document: doc('Titel', 'Agent drie'),
    });
    expect(agent.ok).toBe(true);
    const editor = await call('content.item.update', {
      itemId: item.id,
      baseRevisionId: revision.id,
      document: doc('Titel', 'Drie', 'Redacteur zeven'),
    });
    expect(editor.ok).toBe(true);
    expect(editor.body.revision.provenance).toEqual({
      merged: { baseRevisionId: revision.id, latestRevisionId: agent.body.revision.id },
    });
    expect(editor.body.revision.document.blocks.map((b: any) => b.props.text.nl)).toEqual([
      'Agent drie',
      'Redacteur zeven',
    ]);
  });

  it('refuses a value both changed with its path, and a reader before any merge', async () => {
    const as = front(new Invoker(buildRegistry(), new MemoryUnitOfWork()));
    const call = as(writer);
    const { item, revision } = (
      await call('content.item.create', { slug: 'merge', document: doc('Titel') })
    ).body;
    await call('content.item.update', {
      itemId: item.id,
      baseRevisionId: revision.id,
      document: doc('Hun titel'),
    });
    const lost = await call('content.item.update', {
      itemId: item.id,
      baseRevisionId: revision.id,
      document: doc('Mijn titel', 'Drie', 'Mijn zeven'),
    });
    expect(lost.ok).toBe(false);
    expect(lost.body.code).toBe('conflict');
    expect(lost.body.issues.map((i: { path: string }) => i.path)).toEqual([
      'baseRevisionId',
      'document.title.nl',
    ]);
    const refused = await as(reader)('content.item.update', {
      itemId: item.id,
      baseRevisionId: revision.id,
      document: doc('Titel', 'Drie', 'Lezer'),
    });
    expect(refused).toMatchObject({ ok: false, body: { code: 'forbidden' } });
  });
});

describe('block operations and entity updates on an older base over MCP (ADR 027)', () => {
  it('rebases a block operation whose block did not change and names the merge', async () => {
    const as = front(new Invoker(buildRegistry(), new MemoryUnitOfWork()));
    const call = as(writer);
    const { item, revision } = (
      await call('content.item.create', { slug: 'rebase', document: doc('Titel') })
    ).body;
    const editor = await call('content.item.update', {
      itemId: item.id,
      baseRevisionId: revision.id,
      document: doc('Titel', 'Drie', 'Redacteur zeven'),
    });
    const agent = await call('content.block.update', {
      itemId: item.id,
      baseRevisionId: revision.id,
      blockId: 'b3',
      props: { text: { nl: 'Agent drie' } },
    });
    expect(agent.ok).toBe(true);
    expect(agent.body.revision.provenance).toEqual({
      merged: { baseRevisionId: revision.id, latestRevisionId: editor.body.revision.id },
    });
    expect(agent.body.revision.document.blocks.map((b: any) => b.props.text.nl)).toEqual([
      'Agent drie',
      'Redacteur zeven',
    ]);
  });

  it('refuses a block operation on a changed block with its path, and a reader before any rebase', async () => {
    const as = front(new Invoker(buildRegistry(), new MemoryUnitOfWork()));
    const call = as(writer);
    const { item, revision } = (
      await call('content.item.create', { slug: 'rebase', document: doc('Titel') })
    ).body;
    await call('content.item.update', {
      itemId: item.id,
      baseRevisionId: revision.id,
      document: doc('Titel', 'Hun drie'),
    });
    const op = {
      itemId: item.id,
      baseRevisionId: revision.id,
      blockId: 'b3',
      props: { text: { nl: 'Mijn drie' } },
    };
    const lost = await call('content.block.update', op);
    expect(lost.ok).toBe(false);
    expect(lost.body.code).toBe('conflict');
    expect(lost.body.issues.map((i: { path: string }) => i.path)).toEqual([
      'baseRevisionId',
      'document.blocks[id=b3]',
    ]);
    const refused = await as(reader)('content.block.update', { ...op, blockId: 'b7' });
    expect(refused).toMatchObject({ ok: false, body: { code: 'forbidden' } });
  });

  it('refuses an author update on an older updatedAt, and a reader before the check', async () => {
    const as = front(new Invoker(buildRegistry(), new MemoryUnitOfWork()));
    const call = as(writer);
    const author = (await call('content.author.create', { slug: 'sam', name: 'Sam' })).body;
    const theirs = await call('content.author.update', {
      authorId: author.id,
      baseUpdatedAt: author.updatedAt,
      name: 'Sam de Vries',
    });
    expect(theirs.ok).toBe(true);
    const lost = await call('content.author.update', {
      authorId: author.id,
      baseUpdatedAt: author.updatedAt,
      name: 'Sam V.',
    });
    expect(lost).toMatchObject({
      ok: false,
      body: {
        code: 'conflict',
        issues: [
          {
            path: 'baseUpdatedAt',
            message: 'content.entity.conflict',
            params: { updatedAt: theirs.body.updatedAt },
          },
        ],
      },
    });
    const refused = await as(reader)('content.author.update', {
      authorId: author.id,
      baseUpdatedAt: theirs.body.updatedAt,
      name: 'Lezer',
    });
    expect(refused).toMatchObject({ ok: false, body: { code: 'forbidden' } });
  });
});
