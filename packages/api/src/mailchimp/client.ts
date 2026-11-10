// Mailchimp's server prefix is credential-derived and closed; provider text never escapes this
// boundary. Rejected: tenant supplied API URLs, redirects and raw provider errors in logs.
import { z } from 'zod';
import { UseCaseError } from '@mycel/core';

const Server = z.string().regex(/^us[1-9][0-9]{0,2}$/);
export const Member = z.object({
  id: z.string(),
  email_address: z.string().email(),
  status: z.enum(['subscribed', 'unsubscribed', 'cleaned', 'pending', 'transactional', 'archived']),
  merge_fields: z.record(z.string(), z.unknown()).default({}),
  last_changed: z.string().datetime({ offset: true }),
  timestamp_opt: z.string().optional(),
});
export type Member = z.infer<typeof Member>;
export interface MailchimpResponse {
  status: number;
  body: unknown;
}
export type MailchimpRequest = (input: {
  server: string;
  credential: string;
  method: 'GET' | 'PUT' | 'PATCH';
  path: string;
  body?: unknown;
}) => Promise<MailchimpResponse>;

/** A total deadline and bounded response apply even when headers arrive but the body stalls. */
export const requestMailchimp: MailchimpRequest = (input) => createMailchimpRequester()(input);

export function createMailchimpRequester(fixtureOrigin?: string): MailchimpRequest {
  if (fixtureOrigin && !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(fixtureOrigin))
    throw new Error('invalid Mailchimp fixture origin');
  return async (input) => {
    const server = Server.parse(input.server);
    if (!/^\/[a-zA-Z0-9_/?=&%,.-]*$/.test(input.path)) throw new Error('invalid provider path');
    const response = await fetch(
      `${fixtureOrigin ?? `https://${server}.api.mailchimp.com`}/3.0${input.path}`,
      {
        method: input.method,
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: {
          authorization: `Basic ${Buffer.from(`mycel:${input.credential}`).toString('base64')}`,
          'content-type': 'application/json',
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      }
    );
    if (!response.body) return { status: response.status, body: null };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 1024 * 1024) throw new Error('provider response too large');
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    return {
      status: response.status,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
    };
  };
}
export function mailchimpServer(credential: string) {
  const matched = /^[a-fA-F0-9]{32}-(us[1-9][0-9]{0,2})$/.exec(credential);
  if (!matched) throw new UseCaseError('invalid_input', 'invalid Mailchimp credential');
  return matched[1]!;
}

/** Discovery reads only account/audience/schema data, never list member addresses. */
export async function inspectMailchimp(credential: string, request = requestMailchimp) {
  const server = mailchimpServer(credential);
  const read = async (path: string) => {
    let result: MailchimpResponse;
    try {
      result = await request({ server, credential, method: 'GET', path });
    } catch {
      throw new UseCaseError('conflict', 'Mailchimp is unavailable');
    }
    if (result.status !== 200)
      throw new UseCaseError('conflict', 'Mailchimp account or audience is unavailable');
    return result.body;
  };
  const root = z
    .object({ account_id: z.string(), account_name: z.string() })
    .parse(await read('/'));
  const lists = z
    .object({
      total_items: z.number(),
      lists: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9]+$/), name: z.string() })),
    })
    .parse(await read('/lists?count=1000&fields=lists.id,lists.name,total_items'));
  // Discovery is bounded. A large account needs a deliberate selection, never silent truncation.
  if (lists.total_items > lists.lists.length)
    throw new UseCaseError('conflict', 'Mailchimp account exceeds the audience discovery limit');
  const audiences = [];
  for (const list of lists.lists) {
    const fields = z
      .object({
        total_items: z.number(),
        merge_fields: z.array(
          z.object({ tag: z.string(), name: z.string(), type: z.string(), required: z.boolean() })
        ),
      })
      .parse(await read(`/lists/${list.id}/merge-fields?count=1000`));
    if (fields.total_items > fields.merge_fields.length)
      throw new UseCaseError('conflict', 'Mailchimp audience exceeds the field discovery limit');
    audiences.push({ id: list.id, name: list.name, fields: fields.merge_fields });
  }
  return { server, accountId: root.account_id, accountName: root.account_name, audiences };
}
