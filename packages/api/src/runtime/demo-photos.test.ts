// The committed demo photos are what their README and `DEMO_IMAGES` say they are: the same
// bytes (hash), a JPEG of the stated size, and no larger than the largest variant, so the seed
// uploads exactly the reviewed files. Rejected: checking only that the files exist (a
// recompressed or swapped photo would pass, and its source record would silently be wrong).

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { VARIANT_WIDTHS } from '@mycel/core';
import { DEMO_IMAGES, OTTERDAM_PHOTOS } from '@mycel/core/testing';
import { createSharpProcessor } from '@mycel/media-sharp';
import { describe, expect, it } from 'vitest';

const PHOTOS = new URL('../../demo-photos/', import.meta.url);

const SHA256: Record<string, string> = {
  'demo-pepernoten.jpg': '53eae10d4ee0373b3a1e11200ba674dbdc74c42bdae49a50cb99b4fc460dc140',
  'demo-brood.jpg': '554d36c22d57a5435e3f4a76f5df561239956a77b2323cfb91e6eea24f964741',
  'demo-bloem.jpg': 'b3ca37d41e58f24eb4e46c86d2803178600f91d07f1d9e5c0eb5d45a60534851',
  'demo-overleg.jpg': '343a8d9e3da8e3af7fd5593e99f0db41be05e616a2a3067856fb2a6179824cf2',
};

describe('demo photos', () => {
  const sharp = createSharpProcessor();

  it.each(DEMO_IMAGES.map((i) => [i.filename, i] as const))(
    '%s is the reviewed JPEG of the stated size',
    async (filename, image) => {
      const bytes = new Uint8Array(await readFile(new URL(filename, PHOTOS)));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(SHA256[filename]);
      expect(await sharp.probe(bytes)).toMatchObject({
        format: 'jpeg',
        width: image.width,
        height: image.height,
      });
      expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(VARIANT_WIDTHS.at(-1)!);
      expect(image.source.licence).toBe('CC0 1.0');
    }
  );

  it('lists every photo in the README with its hash', async () => {
    const readme = await readFile(new URL('README.md', PHOTOS), 'utf8');
    for (const [filename, hash] of Object.entries(SHA256)) {
      expect(readme).toContain(`\`${filename}\``);
      expect(readme).toContain(hash);
    }
  });
});

const OTTERDAM_FILES = new URL('../../demo-sites/otterdam/', import.meta.url);

/** The Otterdam photos (MY-264): same check, public domain instead of CC0, at most 150 KB. */
const OTTERDAM_SHA256: Record<string, string> = {
  'otter-drinkt.jpg': '32a65cb05b79ea94e370bf39d0ee71574d75cea89ff791dcbd4c74b4296fe37a',
  'otter-familie.jpg': '0ed1b71a67bc394f9c60bab835c20d03b08371b24ed23601088120ac67e5b7a0',
  'otter-glijbaan.jpg': 'c17fc3829d079742d16c604eeaf6a8437437755aa55653bbc3c29ef89ce7889d',
  'otter-oever.jpg': '43183f2a483acb3e58ae56f3ef05ad72f95839cad024b99e478fc0b23ff4601c',
  'otter-portret.jpg': '506453233336ba924c81dbac64511f9467ad0e8d9a8b597447160a8b6fc25003',
  'otter-sporen.jpg': 'c83a181000018b522d6ff26a860278113e0447a32e53f1a1da0243bebc4aea61',
  'otter-zandbank.jpg': '832e8e0a024e11da61eb772ba51adbcdbd488b572780d03f8ae561fe932ea6e9',
  'otters-drijven.jpg': '994893452088f7fe09be87a9c6d8bb49437e7236189998ccbb256431ac74fc09',
  'otters-kijken.jpg': '42379c2b17381ef3cbd75b066da56586076fcdde96e11b2cb19941d9f1133d72',
  'otters-panorama.jpg': '13c66585bd386aa603a8d8e255916f1c88cd590992b17e7c832bb976927c3019',
};

describe('Otterdam photos', () => {
  const sharp = createSharpProcessor();

  it.each(OTTERDAM_PHOTOS.map((p) => [p.filename, p] as const))(
    '%s is the reviewed JPEG of the stated size',
    async (filename, photo) => {
      const bytes = new Uint8Array(await readFile(new URL(filename, OTTERDAM_FILES)));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(OTTERDAM_SHA256[filename]);
      expect(bytes.length).toBeLessThanOrEqual(150 * 1024);
      expect(await sharp.probe(bytes)).toMatchObject({
        format: 'jpeg',
        width: photo.width,
        height: photo.height,
      });
    }
  );

  it('lists every photo in the README with its hash, and no other', async () => {
    const readme = await readFile(new URL('README.md', OTTERDAM_FILES), 'utf8');
    for (const [filename, hash] of Object.entries(OTTERDAM_SHA256)) {
      expect(readme).toContain(`\`${filename}\``);
      expect(readme).toContain(hash);
    }
    expect(Object.keys(OTTERDAM_SHA256).sort()).toEqual(
      OTTERDAM_PHOTOS.map((p) => p.filename).sort()
    );
  });
});
