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
    expect(await mailer.send(message)).toEqual({ id: 'tem-1' });
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
      additional_headers: [{ key: 'X-Test', value: '1' }],
    });
  });

  it('throws on an API error so the outbox retries', async () => {
    const mailer = new TemMailer({
      secretKey: 's',
      projectId: 'p',
      region: 'fr-par',
      fetch: async () => new Response('quota exceeded', { status: 429 }),
    });
    await expect(mailer.send(message)).rejects.toThrow('TEM API 429: quota exceeded');
  });
});

describe('ConsoleMailer', () => {
  it('prints the text part', async () => {
    const lines: string[] = [];
    await new ConsoleMailer((l) => lines.push(l)).send(message);
    expect(lines[0]).toContain('To: ada@example.org');
    expect(lines[0]).toContain('https://x.test/probe/confirm?token=abc');
  });
});
