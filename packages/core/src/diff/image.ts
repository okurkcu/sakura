import pixelmatch from 'pixelmatch';

import type { RgbaImage } from '../adapters/png.js';
import type { Box } from '../domain/finding.js';

/** One flag per pixel of an image, row-major: 1 where set. */
export interface Mask {
  readonly width: number;
  readonly height: number;
  readonly bits: Uint8Array;
}

/**
 * The image on a `width` × `height` canvas, padded right and below with transparent pixels (which
 * compare like a white page). Returns the image itself when it already has that size. Pure.
 */
export function padTo(image: RgbaImage, width: number, height: number): RgbaImage {
  if (image.width === width && image.height === height) {
    return image;
  }
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < image.height; y += 1) {
    data.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), y * width * 4);
  }
  return { width, height, data };
}

/**
 * The pixels that differ between two images of the same size, by pixelmatch's perceptual
 * comparison; anti-aliasing differences don't count. Pure.
 */
export function differingPixels(a: RgbaImage, b: RgbaImage, threshold: number): Mask {
  const { width, height } = a;
  const output = new Uint8Array(width * height * 4);
  pixelmatch(a.data, b.data, output, width, height, {
    threshold,
    includeAA: false,
    diffMask: true,
    checkerboard: false,
  });
  const bits = new Uint8Array(width * height);
  for (let i = 0; i < bits.length; i += 1) {
    bits[i] = (output[i * 4 + 3] ?? 0) > 0 ? 1 : 0;
  }
  return { width, height, bits };
}

/** The mask grown by `rx` pixels left and right and `ry` pixels up and down (a box). Pure. */
export function dilate(mask: Mask, rx: number, ry: number): Mask {
  const { width, height } = mask;
  const horizontal = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    spread(mask.bits, horizontal, y * width, 1, width, rx);
  }
  const bits = new Uint8Array(width * height);
  for (let x = 0; x < width; x += 1) {
    spread(horizontal, bits, x, width, height, ry);
  }
  return { width, height, bits };
}

/** One line of a separable dilation: `to[i]` is set when any `from` within `radius` is. */
function spread(
  from: Uint8Array,
  to: Uint8Array,
  start: number,
  step: number,
  length: number,
  radius: number,
): void {
  let lastSet = -Infinity;
  for (let i = 0; i < length; i += 1) {
    if (from[start + i * step] === 1) {
      lastSet = i;
    }
    if (i - lastSet <= radius) {
      to[start + i * step] = 1;
    }
  }
  let nextSet = Infinity;
  for (let i = length - 1; i >= 0; i -= 1) {
    if (from[start + i * step] === 1) {
      nextSet = i;
    }
    if (nextSet - i <= radius) {
      to[start + i * step] = 1;
    }
  }
}

/** The pixels set in `mask` but not in `minus`. Pure. */
export function subtract(mask: Mask, minus: Mask): Mask {
  const bits = mask.bits.map((bit, i) => (bit === 1 && minus.bits[i] !== 1 ? 1 : 0));
  return { width: mask.width, height: mask.height, bits };
}

/** How many pixels are set, optionally only inside `box`. Pure. */
export function countPixels(mask: Mask, box?: Box): number {
  const x0 = box?.x ?? 0;
  const y0 = box?.y ?? 0;
  const x1 = box === undefined ? mask.width : box.x + box.width;
  const y1 = box === undefined ? mask.height : box.y + box.height;
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      count += mask.bits[y * mask.width + x] ?? 0;
    }
  }
  return count;
}

/**
 * Groups the set pixels into regions: pixels with at most `gap` unset pixels between them, along a
 * row or a column, belong together. Each region is the bounding box of its pixels; regions with
 * fewer than `minPixels` are dropped. Sorted top to bottom, then left to right. Pure.
 */
export function regionsOf(mask: Mask, gap: number, minPixels: number): Box[] {
  const { width, height } = mask;
  const reach = Math.ceil(gap / 2);
  const joined = dilate(mask, reach, reach);
  const visited = new Uint8Array(width * height);
  const boxes: Box[] = [];
  const stack: number[] = [];
  for (let start = 0; start < joined.bits.length; start += 1) {
    if (joined.bits[start] !== 1 || visited[start] === 1) {
      continue;
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let pixels = 0;
    visited[start] = 1;
    stack.push(start);
    for (let index = stack.pop(); index !== undefined; index = stack.pop()) {
      const x = index % width;
      const y = (index - x) / width;
      if (mask.bits[index] === 1) {
        pixels += 1;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
      for (const next of [
        x > 0 ? index - 1 : -1,
        x < width - 1 ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y < height - 1 ? index + width : -1,
      ]) {
        if (next >= 0 && joined.bits[next] === 1 && visited[next] !== 1) {
          visited[next] = 1;
          stack.push(next);
        }
      }
    }
    if (pixels >= minPixels) {
      boxes.push({ x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 });
    }
  }
  return boxes.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** The smallest box around every box. Pure. */
export function unionBox(boxes: readonly Box[]): Box | undefined {
  if (boxes.length === 0) {
    return undefined;
  }
  const x0 = Math.min(...boxes.map((box) => box.x));
  const y0 = Math.min(...boxes.map((box) => box.y));
  const x1 = Math.max(...boxes.map((box) => box.x + box.width));
  const y1 = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

const OVERLAY_DIM = 0.35;
const CHANGED = [230, 0, 60] as const;
const OUTLINE = [255, 140, 0] as const;

/**
 * The head screenshot faded, with changed pixels in red and each region outlined in orange, for a
 * reviewer to see what changed at a glance. Pure.
 */
export function renderOverlay(head: RgbaImage, changed: Mask, regions: readonly Box[]): RgbaImage {
  const data = new Uint8Array(head.data.length);
  for (let i = 0; i < changed.bits.length; i += 1) {
    const at = i * 4;
    if (changed.bits[i] === 1) {
      data.set([...CHANGED, 255], at);
      continue;
    }
    const alpha = (head.data[at + 3] ?? 0) / 255;
    for (let c = 0; c < 3; c += 1) {
      // Blend over white (transparent padding is white), then fade toward white.
      const blended = (head.data[at + c] ?? 255) * alpha + 255 * (1 - alpha);
      data[at + c] = Math.round(255 - (255 - blended) * OVERLAY_DIM);
    }
    data[at + 3] = 255;
  }
  for (const box of regions) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      paint(data, head.width, x, box.y);
      paint(data, head.width, x, box.y + box.height - 1);
    }
    for (let y = box.y; y < box.y + box.height; y += 1) {
      paint(data, head.width, box.x, y);
      paint(data, head.width, box.x + box.width - 1, y);
    }
  }
  return { width: head.width, height: head.height, data };
}

function paint(data: Uint8Array, width: number, x: number, y: number): void {
  data.set([...OUTLINE, 255], (y * width + x) * 4);
}
