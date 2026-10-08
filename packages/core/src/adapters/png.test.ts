import { describe, expect, it } from 'vitest';

import { pngCodec } from './png.js';
import { paint, solid } from '../testing/images.js';

describe('pngCodec', () => {
  it('round-trips an image', () => {
    const image = paint(
      solid(5, 3, [10, 20, 30, 255]),
      { x: 1, y: 1, width: 2, height: 1 },
      [200, 100, 0, 128],
    );

    const decoded = pngCodec.decode(pngCodec.encode(image));

    expect(decoded).toEqual({ width: 5, height: 3, data: image.data });
  });

  it('rejects bytes that are not a PNG', () => {
    expect(() => pngCodec.decode(new TextEncoder().encode('not a png'))).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }) as Error,
    );
  });
});
