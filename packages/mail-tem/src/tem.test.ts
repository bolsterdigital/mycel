import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderConfirmationMail } from '@mycel/core';
import { ConsoleMailer, TemMailer } from './index.js';

const message = {
  ...renderConfirmationMail({
    locale: 'nl',
    tenantName: 'Probe',
    confirmUrl: 'https://x.test/probe/confirm?token=abc',
    from: { email: 'noreply@x.test', name: 'Probe' },
    to: 'ada@example.org',
  }),
  headers: { 'X-Test': '1' },
};

describe('TemMailer', () => {
  it('posts the Scaleway request shape and returns the message id', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const mailer = new TemMailer({
      secretKey: 'scw-secret',
      projectId: 'proj',
      region: 'fr-par',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return new Response(JSON.stringify({ emails: [{ id: 'tem-1' }] }), { status: 200 });
      },
    });
    expect(await mailer.send(message, 'mailing.confirmation:evt-1')).toEqual({
      providerId: 'tem-1',
    });
    expect(calls[0]?.url).toBe(
      'https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails'
    );
    expect((calls[0]?.init.headers as Record<string, string>)['X-Auth-Token']).toBe('scw-secret');
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toMatchObject({
      from: { email: 'noreply@x.test', name: 'Probe' },
      to: [{ email: 'ada@example.org', name: '' }],
      subject: 'Bevestig je inschrijving bij Probe',
      project_id: 'proj',
      additional_headers: [
        { key: 'X-Test', value: '1' },
        { key: 'X-Mycel-Send-Key', value: 'mailing.confirmation:evt-1' },
      ],
    });
  });

  it('lists by mail_rcpt, subject and window without a status filter, and says null on doubt', async () => {
    const urls: string[] = [];
    let reply: () => Response = () =>
      new Response(JSON.stringify({ emails: [{ id: 'tem-9' }, { id: 'tem-7' }], total_count: 2 }), {
        status: 200,
      });
    const mailer = new TemMailer({
      secretKey: 's',
      projectId: 'proj',
      region: 'fr-par',
      fetch: async (url) => {
        urls.push(String(url));
        return reply();
      },
    });
    const window = {
      since: new Date('2026-10-21T11:59:00.000Z'),
      until: new Date('2026-10-21T12:01:30.000Z'),
    };
    expect(await mailer.lookup(message, window)).toEqual({ providerIds: ['tem-9', 'tem-7'] });
    const q = new URL(urls[0]!).searchParams;
    expect(Object.fromEntries(q)).toEqual({
      project_id: 'proj',
      mail_rcpt: 'ada@example.org',
      subject: 'Bevestig je inschrijving bij Probe',
      since: '2026-10-21T11:59:00.000Z',
      until: '2026-10-21T12:01:30.000Z',
      page_size: '100',
    });
    expect(q.has('statuses')).toBe(false);
    expect(q.has('mail_to')).toBe(false);

    reply = () => new Response(JSON.stringify({ emails: [], total_count: 0 }), { status: 200 });
    expect(await mailer.lookup(message, window)).toEqual({ providerIds: [] });
    // Everything the core cannot count completely is null.
    reply = () => new Response('down', { status: 503 });
    expect(await mailer.lookup(message, window)).toBeNull();
    reply = () => {
      throw new Error('network');
    };
    expect(await mailer.lookup(message, window)).toBeNull();
    reply = () => new Response(JSON.stringify({ emails: [] }), { status: 200 });
    expect(await mailer.lookup(message, window)).toBeNull();
    reply = () =>
      new Response(JSON.stringify({ emails: [{ id: 'tem-1' }], total_count: 101 }), {
        status: 200,
      });
    expect(await mailer.lookup(message, window)).toBeNull();
    reply = () => new Response('not json', { status: 200 });
    expect(await mailer.lookup(message, window)).toBeNull();
  });

  it('aborts a send that takes longer than the timeout', async () => {
    const mailer = new TemMailer({
      secretKey: 's',
      projectId: 'p',
      region: 'fr-par',
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        ),
    });
    await expect(mailer.send(message, 'k')).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('throws on an API error, which the core records as an unknown outcome', async () => {
    const mailer = new TemMailer({
      secretKey: 's',
      projectId: 'p',
      region: 'fr-par',
      fetch: async () => new Response('quota exceeded', { status: 429 }),
    });
    await expect(mailer.send(message, 'k')).rejects.toThrow('TEM API 429: quota exceeded');
  });
});

describe('ConsoleMailer', () => {
  it('prints the text part and spools the message as JSON when asked', async () => {
    const lines: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'mycel-spool-'));
    const mailer = new ConsoleMailer((l) => lines.push(l), dir);
    await mailer.send(message, 'k1');
    expect(lines[0]).toContain('To: ada@example.org');
    expect(lines[0]).toContain('https://x.test/probe/confirm?token=abc');
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const spooled = JSON.parse(readFileSync(join(dir, files[0]!), 'utf8'));
    expect(spooled).toMatchObject({ key: 'k1', to: { email: 'ada@example.org' } });
    expect(spooled.text).toContain('https://x.test/probe/confirm?token=abc');
    const window = { since: new Date(Date.now() - 60_000), until: new Date(Date.now() + 60_000) };
    expect(await mailer.lookup(message, window)).toEqual({ providerIds: ['console-1'] });
    expect(await mailer.lookup({ ...message, to: { email: 'bob@example.org' } }, window)).toEqual({
      providerIds: [],
    });
    rmSync(dir, { recursive: true });
  });
});
