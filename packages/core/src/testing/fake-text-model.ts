// CI and e2e use a deterministic model. It records exactly what crossed the model boundary, so
// privacy tests can inspect parts without replacing any of our own modules.

import { fromMarkdown, toMarkdown } from '../content/markdown.js';
import type { TextModel } from '../assist/ports.js';
import { TextModelError, type ModelFailure } from '../assist/ports.js';

const defaultAlt = { alt: 'Beschrijving van afbeelding' };

function translateMarkdown(source: string, locale: string): string {
  const parsed = fromMarkdown(source);
  if (!parsed.ok) return source;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const node = value as { type?: string; text?: string; content?: unknown };
    if (node.type === 'text' && node.text) node.text = `[${locale}] ${node.text}`;
    if (node.content) visit(node.content);
  };
  visit(parsed.doc);
  return toMarkdown(parsed.doc);
}

export class FakeTextModel implements TextModel {
  readonly requests: Parameters<TextModel['complete']>[0][] = [];
  failure: ModelFailure | null = null;
  delayMs = 0;
  result: unknown = defaultAlt;
  describe() {
    return { label: 'Fake model', models: { text: 'fake-text', vision: 'fake-vision' } };
  }
  async complete(request: Parameters<TextModel['complete']>[0]) {
    this.requests.push(request);
    if (this.delayMs)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        request.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new TextModelError('timeout'));
          },
          { once: true }
        );
      });
    if (this.failure) throw new TextModelError(this.failure);
    let json = this.result;
    if (request.task === 'translate' && this.result === defaultAlt) {
      const part = request.parts[0];
      if (!part || part.kind !== 'text') throw new TextModelError('invalid-output');
      const input = JSON.parse(part.text) as { to: string; values: Record<string, string> };
      json = {
        values: Object.fromEntries(
          Object.entries(input.values).map(([key, value]) => [
            key,
            key.endsWith('.props.content')
              ? translateMarkdown(value, input.to)
              : `[${input.to}] ${value}`,
          ])
        ),
      };
    }
    return {
      json,
      model: request.task === 'translate' ? 'fake-text' : 'fake-vision',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}
