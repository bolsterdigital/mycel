// The committed demo photos are what their README and `DEMO_IMAGES` say they are: the same
// bytes (hash), a JPEG of the stated size, and no larger than the largest variant, so the seed
// uploads exactly the reviewed files. Rejected: checking only that the files exist (a
// recompressed or swapped photo would pass, and its source record would silently be wrong).

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { VARIANT_WIDTHS } from '@mycel/core';
import { DEMO_IMAGES } from '@mycel/core/testing';
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
