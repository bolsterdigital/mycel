// Provider answers come from files in ../fixtures: the OpenAI chat-completion object as Ollama's
// compatible endpoint returns it (the live test below runs against that endpoint), with every
// field and placeholder content, so the boundary is exercised without a network or tenant data.
import { readFileSync } from 'node:fs';
import { createServer, type RequestListener, type Server } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { TextModelError } from '@mycel/core';
import { OpenAITextModel } from './index.js';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
const output = z.object({ alt: z.string().min(1) }).strict();
const request = {
  task: 'alt' as const,
  system: 'Describe the image.',
  parts: [
    { kind: 'text' as const, text: 'Locale: en' },
    { kind: 'image' as const, contentType: 'image/webp', bytes: new Uint8Array([1, 2, 3]) },
  ],
  output,
  maxTokens: 200,
  signal: new AbortController().signal,
};
const options = {
  baseUrl: 'http://localhost:11434/v1/',
  label: 'Local Ollama',
  textModel: 'text',
  visionModel: 'vision',
};

async function serve(handler: RequestListener): Promise<Server> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function address(server: Server): string {
  const bound = server.address();
  if (!bound || typeof bound === 'string') throw new Error('Expected a loopback TCP server');
  return `http://127.0.0.1:${bound.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

it('sends a schema-bound image request without an identifying user field', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(fixture('structured')));
  const model = new OpenAITextModel({ ...options, fetch: fetcher });
  expect(await model.complete(request)).toEqual({
    json: { alt: 'A red bicycle' },
    model: 'llava',
    usage: { inputTokens: 42, outputTokens: 7 },
  });
  expect(fetcher).toHaveBeenCalledOnce();
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe('http://localhost:11434/v1/chat/completions');
  const body = JSON.parse(init!.body as string);
  expect(body.model).toBe('vision');
  expect(body.user).toBeUndefined();
  expect(body.response_format.type).toBe('json_schema');
  expect(body.response_format.json_schema.schema.type).toBe('object');
  expect(body.messages[1].content[1].image_url.url).toBe('data:image/webp;base64,AQID');
});

it('falls back to json_object only for unsupported request shape', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 400 }))
    .mockResolvedValueOnce(Response.json(fixture('object')));
  const model = new OpenAITextModel({ ...options, fetch: fetcher });
  expect((await model.complete(request)).json).toEqual({ alt: 'A blue bicycle' });
  expect(JSON.parse(fetcher.mock.calls[1]![1].body).response_format).toEqual({
    type: 'json_object',
  });
});

it('uses the text model when no image is sent', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(fixture('structured')));
  const model = new OpenAITextModel({ ...options, fetch: fetcher });
  await model.complete({ ...request, parts: [{ kind: 'text', text: 'Bicycle' }] });
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).model).toBe('text');
});

describe('failure classification', () => {
  it('does not forward tenant content to a redirect destination', async () => {
    const received: string[] = [];
    const destination = await serve(async (incoming, response) => {
      let body = '';
      for await (const chunk of incoming) body += chunk;
      received.push(body);
      response.end();
    });
    const source = await serve((_incoming, response) => {
      response.writeHead(307, { location: `${address(destination)}/other-provider` });
      response.end();
    });
    try {
      const model = new OpenAITextModel({ ...options, baseUrl: address(source) });
      await expect(
        model.complete({
          ...request,
          parts: [{ kind: 'text', text: 'private tenant caption' }],
        })
      ).rejects.toEqual(new TextModelError('unavailable'));
      expect(received).toEqual([]);
    } finally {
      await close(source);
      await close(destination);
    }
  });

  it('classifies an abort while reading the response body as timeout', async () => {
    const source = await serve((_incoming, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.flushHeaders();
      response.write('{');
    });
    try {
      const model = new OpenAITextModel({ ...options, baseUrl: address(source) });
      await expect(
        model.complete({ ...request, signal: AbortSignal.timeout(100) })
      ).rejects.toEqual(new TextModelError('timeout'));
    } finally {
      await close(source);
    }
  });

  it.each([
    [401, 'rejected'],
    [429, 'unavailable'],
    [503, 'unavailable'],
  ] as const)('maps HTTP %i to %s without disclosing response text', async (status, failure) => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify(fixture('error-rate-limit')), { status })
    );
    const model = new OpenAITextModel({ ...options, fetch: fetcher as typeof fetch });
    await expect(model.complete(request)).rejects.toEqual(new TextModelError(failure));
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    'not json',
    JSON.stringify({ ...fixture('structured'), choices: [{ message: { content: '{"alt":""}' } }] }),
  ])('rejects invalid provider output', async (body) => {
    const model = new OpenAITextModel({ ...options, fetch: vi.fn(async () => new Response(body)) });
    await expect(model.complete(request)).rejects.toEqual(new TextModelError('invalid-output'));
  });
  it('maps an aborted request to timeout', async () => {
    const controller = new AbortController();
    const model = new OpenAITextModel({
      ...options,
      fetch: vi.fn(async () => {
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      }),
    });
    await expect(model.complete({ ...request, signal: controller.signal })).rejects.toEqual(
      new TextModelError('timeout')
    );
  });
});

it.skipIf(process.env.ASSIST_LIVE !== '1')('completes against local Ollama', async () => {
  const model = new OpenAITextModel({
    ...options,
    baseUrl: process.env.ASSIST_BASE_URL ?? options.baseUrl,
    textModel: process.env.ASSIST_TEXT_MODEL ?? 'llama3.2',
    visionModel: process.env.ASSIST_VISION_MODEL ?? 'llava',
  });
  const result = await model.complete({
    ...request,
    task: 'translate',
    parts: [{ kind: 'text', text: 'Return JSON with alt as the word bicycle.' }],
    signal: AbortSignal.timeout(30000),
  });
  expect(output.safeParse(result.json).success).toBe(true);
});
