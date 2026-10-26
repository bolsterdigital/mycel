// Read identity from Lighthouse's own measured document. A separate Playwright probe could
// pass while Lighthouse measures a login page. This artifact adds no scoring category.
import BaseGatherer from 'lighthouse/core/gather/base-gatherer.js';
import Audit from 'lighthouse/core/audits/audit.js';

export class IdentityGatherer extends BaseGatherer {
  meta = { supportedModes: ['navigation'] };
  async getArtifact({ driver }) {
    return driver.executionContext.evaluate(
      async () => {
        await document.fonts.ready;
        const main = document.querySelector('main');
        const has = (selector) => Boolean(main?.querySelector(selector));
        const images = [...(main?.querySelectorAll('img') ?? [])];
        return {
          url: location.href,
          locale: document.documentElement.lang,
          title: document.querySelector('h1')?.textContent?.trim(),
          canonical: document.querySelector('link[rel="canonical"]')?.href,
          noindex: /noindex/i.test(document.querySelector('meta[name="robots"]')?.content ?? ''),
          words: main?.textContent.trim().split(/\s+/u).length ?? 0,
          images: images.length,
          // Lazy images below the viewport need not be downloaded yet. Every image's URL is
          // independently checked after the timed navigation, without altering its scores.
          imageUrls: images.map((image) => image.currentSrc || image.src),
          brokenImages: images.some((image) => image.complete && image.naturalWidth === 0),
          fonts: [...document.fonts]
            .filter((font) => font.status === 'loaded')
            .map((f) => f.family)
            .join(','),
          themeStylesheet: Boolean(
            document.querySelector('link[rel="stylesheet"][href*="/_theme/"]')
          ),
          form: has('form[method="post"]'),
          h2: has('h2'),
          ul: has('ul'),
          ol: has('ol'),
          quote: has('blockquote'),
          link: has('a[href]'),
          siteName: document.querySelector('.admin-site-name')?.textContent?.trim(),
          authenticated: Boolean(document.querySelector('form[action*="logout"]')),
          populated: has('.content-list li'),
          writer: has('.writing-surface .ProseMirror'),
          itemText: main?.textContent.includes('De straat die ruimte maakt'),
        };
      },
      { useIsolation: true }
    );
  }
}

export class IdentityAudit extends Audit {
  static get meta() {
    return {
      id: 'mycel-identity',
      title: 'Mycel measured page identity',
      description: 'Identity is evaluated separately from Lighthouse scores.',
      scoreDisplayMode: 'informative',
      requiredArtifacts: ['MycelIdentity'],
    };
  }
  static audit() {
    return { score: null };
  }
}
