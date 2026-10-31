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
  'demo-chocolade-kruidnoten.jpg':
    '9527d4e0cb0317afbb098f2c6cd83aae9029d6dd07c312ee28cc58b418f0dcb7',
  'demo-stadhuis.jpg': '91fd7728e7014def52efe1eef8bafa3b00e5cae1c98aeb94b1b23943a456e61c',
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
