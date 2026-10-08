import { PNG } from 'pngjs';

import { BdiffError } from '../errors/bdiff-error.js';

/** An RGBA image: row-major, 4 bytes per pixel. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Turns PNG files into pixels and back. The diff engine's only image I/O goes through it. */
export interface ImageCodec {
  /** @throws BdiffError `INVALID_INPUT` when the bytes are not a PNG. */
  decode(png: Uint8Array): RgbaImage;
  encode(image: RgbaImage): Uint8Array;
}

/** The real {@link ImageCodec}, over pngjs. */
export const pngCodec: ImageCodec = {
  decode: (png) => {
    try {
      const image = PNG.sync.read(Buffer.from(png));
      return { width: image.width, height: image.height, data: new Uint8Array(image.data) };
    } catch (error) {
      throw new BdiffError('INVALID_INPUT', 'Not a readable PNG image', { cause: error });
    }
  },
  encode: (image) => {
    const png = new PNG({ width: image.width, height: image.height });
    png.data = Buffer.from(image.data);
    return new Uint8Array(PNG.sync.write(png));
  },
};
