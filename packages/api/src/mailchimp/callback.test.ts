// A posted status is not provider evidence. The capability authenticates only a bounded read
// trigger; malformed and foreign bodies cannot select a tenant or mutate consent.
import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCESS } from '@mycel/core';
import { MemoryUnitOfWork } from '@mycel/core/testing';
import { createMailchimpCallbackApp } from './callback.js';

describe('Mailchimp incoming HTTP boundary', () => {
  it('answers probes, ignores forged capability/status and rejects oversized bodies', async () => {
    const uow = new MemoryUnitOfWork();
    const app = createMailchimpCallbackApp({
      signer: uow.signer,
      uow,
      access: async () => DEFAULT_ACCESS,
    });
    expect((await app.request('/unknown')).status).toBe(204);
    const forged = await app.request('/unknown', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'data[id]=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&status=subscribed&tenantId=foreign',
    });
    expect(forged.status).toBe(204);
    expect(uow.store.jobs).toHaveLength(0);
    const oversized = await app.request('/unknown', {
      method: 'POST',
      body: 'x'.repeat(16 * 1024 + 1),
    });
    expect(oversized.status).toBe(413);
  });
});
