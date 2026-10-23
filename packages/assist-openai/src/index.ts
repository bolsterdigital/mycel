// This adapter owns the OpenAI-compatible wire format, not the assistance policy. Rejected:
// importing a provider SDK into core or passing provider errors through to tenant logs.

import { TextModelError, toJsonSchema, type TextModel } from '@mycel/core';
import { z } from 'zod';

const Reply = z.object({
  model: z.string().min(1),
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
    })
    .optional(),
});

type Request = Parameters<TextModel['complete']>[0];
export interface OpenAITextModelOptions {
  baseUrl: string;
  apiKey?: string;
  label: string;
  textModel: string;
  visionModel: string;
  fetch?: typeof fetch;
}

export class OpenAITextModel implements TextModel {
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: OpenAITextModelOptions) {
    const base = new URL(options.baseUrl);
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new Error(
        'ASSIST_BASE_URL must be an HTTP(S) API root without credentials, query or fragment'
      );
    if (!options.label.trim() || !options.textModel.trim() || !options.visionModel.trim())
      throw new Error('Assistance provider label and model names are required');
    this.endpoint = `${base.href.replace(/\/$/, '')}/chat/completions`;
    this.fetcher = options.fetch ?? fetch;
  }

  describe() {
    return {
      label: this.options.label,
      models: { text: this.options.textModel, vision: this.options.visionModel },
    };
  }

  async complete(request: Request): ReturnType<TextModel['complete']> {
    const hasImage = request.parts.some((part) => part.kind === 'image');
    const model = hasImage ? this.options.visionModel : this.options.textModel;
    const content = request.parts.map((part) =>
      part.kind === 'text'
        ? { type: 'text' as const, text: part.text }
        : {
            type: 'image_url' as const,
            image_url: {
              url: `data:${part.contentType};base64,${Buffer.from(part.bytes).toString('base64')}`,
            },
          }
    );
    const body = {
      model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content },
      ],
      max_tokens: request.maxTokens,
    };
    const schema = toJsonSchema(request.output, 'output');
    const send = async (format: 'json_schema' | 'json_object') => {
      const response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify({
          ...body,
          response_format:
            format === 'json_schema'
              ? { type: 'json_schema', json_schema: { name: 'mycel_assist', strict: true, schema } }
              : { type: 'json_object' },
        }),
        signal: request.signal,
      });
      return response;
    };
    try {
      let response = await send('json_schema');
      // Some compatible servers reject json_schema but accept json_object. Never retry auth,
      // rate-limit or server failures, and never include the provider's response in an error.
      if (response.status === 400 || response.status === 422) response = await send('json_object');
      if (!response.ok)
        throw new TextModelError(
          response.status === 429 || response.status >= 500 ? 'unavailable' : 'rejected'
        );
      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        throw new TextModelError('invalid-output');
      }
      const reply = Reply.safeParse(raw);
      if (!reply.success) throw new TextModelError('invalid-output');
      let json: unknown;
      try {
        json = JSON.parse(reply.data.choices[0]!.message.content);
      } catch {
        throw new TextModelError('invalid-output');
      }
      const parsed = request.output.safeParse(json);
      if (!parsed.success) throw new TextModelError('invalid-output');
      return {
        json: parsed.data,
        model: reply.data.model,
        usage: {
          inputTokens: reply.data.usage?.prompt_tokens ?? 0,
          outputTokens: reply.data.usage?.completion_tokens ?? 0,
        },
      };
    } catch (error) {
      if (error instanceof TextModelError) throw error;
      if (
        request.signal.aborted ||
        (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
      )
        throw new TextModelError('timeout');
      throw new TextModelError('unavailable');
    }
  }
}
