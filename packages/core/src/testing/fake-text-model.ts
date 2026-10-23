// CI and e2e use a deterministic model. It records exactly what crossed the model boundary, so
// privacy tests can inspect parts without replacing any of our own modules.

import type { TextModel } from '../assist/ports.js';
import { TextModelError, type ModelFailure } from '../assist/ports.js';

export class FakeTextModel implements TextModel {
  readonly requests: Parameters<TextModel['complete']>[0][] = [];
  failure: ModelFailure | null = null;
  delayMs = 0;
  result: unknown = { alt: 'Beschrijving van afbeelding' };
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
    return { json: this.result, model: 'fake-vision', usage: { inputTokens: 1, outputTokens: 1 } };
  }
}
