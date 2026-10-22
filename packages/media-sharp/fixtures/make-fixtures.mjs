// Regenerates the binary fixtures of sharp.test.ts (run from the repo root:
// `node packages/media-sharp/fixtures/make-fixtures.mjs`). Committed so the fixtures are
// reproducible; the files themselves are committed too, so the test never depends on this script.
//
//   exif-orientation-gps.jpg  40x20 pixels stored, EXIF Orientation 6 (shown 20x40), a GPS
//                             position and a camera make: everything render must remove.
//   bomb.png                  8000x8000 (64 megapixels) of one colour in a few kilobytes: a
//                             decompression bomb for the pixel limit.
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));

// Left half red, right half blue, so the test can see which way the image was turned.
const left = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ff0000' } })
  .png()
  .toBuffer();
await sharp({ create: { width: 40, height: 20, channels: 3, background: '#0000ff' } })
  .composite([{ input: left, left: 0, top: 0 }])
  .jpeg({ quality: 95 })
  .withExif({
    IFD0: { Make: 'MycelTestCam' },
    IFD3: {
      GPSLatitudeRef: 'N',
      GPSLatitude: '52/1 5/1 0/1',
      GPSLongitudeRef: 'E',
      GPSLongitude: '4/1 18/1 0/1',
    },
  })
  .withMetadata({ orientation: 6 })
  .toFile(`${dir}exif-orientation-gps.jpg`);

await sharp({
  create: { width: 8000, height: 8000, channels: 3, background: '#ffffff' },
  limitInputPixels: false,
})
  .png({ palette: true, colours: 2, compressionLevel: 9 })
  .toFile(`${dir}bomb.png`);
