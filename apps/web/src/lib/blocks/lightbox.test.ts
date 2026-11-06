import { describe, expect, it } from 'vitest';
import { largerImage } from './lightbox.js';

const image = (width: number, alt = 'Een plein') => ({
  alt,
  large: { src: `/media/x/w${width}.webp`, width, height: Math.round(width * 0.75) },
});

describe('largerImage (Dreamkit: at least 10% wider than on the page)', () => {
  it('opens where the file is 10% wider than its rail, and not below', () => {
    // Float rail 368 px: 405 opens, 404 does not; content 704 px: 775 opens, 774 does not.
    expect(largerImage(image(405), 'float-left')).not.toBeNull();
    expect(largerImage(image(404), 'float-right')).toBeNull();
    expect(largerImage(image(775), 'content')).not.toBeNull();
    expect(largerImage(image(774), 'content')).toBeNull();
    expect(largerImage(image(1197), 'wide')).not.toBeNull();
    expect(largerImage(image(1196), 'wide')).toBeNull();
  });

  it('never opens a full-width image, one without an alt or without a variant', () => {
    expect(largerImage(image(1920), 'full')).toBeNull();
    expect(largerImage(image(1920, ''), 'content')).toBeNull();
    expect(largerImage({ alt: 'x', large: null }, 'content')).toBeNull();
    expect(largerImage(image(1920, ''), 'gallery')).toBeNull();
  });

  it('opens every described image in a gallery, whatever its size', () => {
    expect(largerImage(image(320), 'gallery')).toEqual(image(320).large);
  });
});
