import { describe, expect, it } from 'vitest';
import type { RenderBlock, RenderModel } from '#lib/blocks/model.js';
import { ui } from '../../../i18n/index.js';
import { campaignThanksPath, shareLinks } from './campaign-thanks.js';

const form = (formId: string) => ({ formId }) as never;
const card = (formId: string | null, href = '/petitie') =>
  ({
    type: 'campaign-card',
    variant: 'full',
    width: 'content',
    campaign: { href },
    form: formId ? form(formId) : null,
    body: null,
  }) as unknown as RenderBlock;
const model = (
  blocks: RenderBlock[],
  campaignForm: string | null = null
): Pick<RenderModel, 'campaign' | 'blocks'> => ({
  blocks,
  campaign: campaignForm ? ({ form: form(campaignForm) } as never) : null,
});

describe('campaignThanksPath (ADR 038 rule 8)', () => {
  it("thanks on the landing page itself for the landing page's own form", () => {
    expect(campaignThanksPath(model([], 'f1'), [], 'f1', '/petitie')).toBe('/petitie/thanks');
    expect(campaignThanksPath(model([], 'f1'), [], 'f1', '/en/petition')).toBe(
      '/en/petition/thanks'
    );
  });

  it("goes from a card to the landing page's thanks, with the host as `back`", () => {
    expect(campaignThanksPath(model([card('f1')]), [], 'f1', '/gast')).toBe(
      '/petitie/thanks?back=%2Fgast'
    );
    expect(campaignThanksPath(model([]), [card('f1', '/')], 'f1', '/')).toBe('/thanks?back=%2F');
  });

  it('leaves every other form to the page it is on', () => {
    expect(campaignThanksPath(model([card('f1')]), [], 'f2', '/gast')).toBeNull();
    expect(campaignThanksPath(model([card(null)]), [], 'f1', '/gast')).toBeNull();
    expect(campaignThanksPath(model([], 'f1'), [], 'f2', '/petitie')).toBeNull();
  });
});

describe('shareLinks', () => {
  it('links mail, WhatsApp and Bluesky with title and address, no script', () => {
    const links = shareLinks('Veilige vistrappen', 'https://otterdam.example/petitie', ui('nl'));
    expect(links.map((l) => l.label)).toEqual(['E-mail', 'WhatsApp', 'Bluesky']);
    expect(links[0]!.href).toBe(
      'mailto:?subject=Veilige%20vistrappen&body=https%3A%2F%2Fotterdam.example%2Fpetitie'
    );
    expect(links[1]!.href).toBe(
      'https://wa.me/?text=Veilige%20vistrappen%20https%3A%2F%2Fotterdam.example%2Fpetitie'
    );
    expect(links[2]!.href).toMatch(/^https:\/\/bsky\.app\/intent\/compose\?text=Veilige%20/);
  });
});
