import type { RgbaImage } from '../adapters/png.js';
import type { Box } from '../domain/finding.js';

/** A `width` × `height` image of one color (opaque white by default), for image tests. */
export function solid(
  width: number,
  height: number,
  color: readonly [number, number, number, number] = [255, 255, 255, 255],
): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data.set(color, i * 4);
  }
  return { width, height, data };
}

/** A copy of `image` with `box` painted in `color` (opaque black by default), for image tests. */
export function paint(
  image: RgbaImage,
  box: Box,
  color: readonly [number, number, number, number] = [0, 0, 0, 255],
): RgbaImage {
  const data = new Uint8Array(image.data);
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      data.set(color, (y * image.width + x) * 4);
    }
  }
  return { width: image.width, height: image.height, data };
}
