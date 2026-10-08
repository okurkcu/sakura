import { describe, expect, it } from 'vitest';

import {
  countPixels,
  differingPixels,
  dilate,
  padTo,
  regionsOf,
  renderOverlay,
  subtract,
  unionBox,
} from './image.js';
import type { Mask } from './image.js';
import { paint, solid } from '../testing/images.js';

const mask = (rows: string[]): Mask => ({
  width: rows[0]?.length ?? 0,
  height: rows.length,
  bits: Uint8Array.from(rows.join('').split(''), (c) => (c === '#' ? 1 : 0)),
});
const show = (m: Mask): string[] =>
  Array.from({ length: m.height }, (_, y) =>
    Array.from(m.bits.subarray(y * m.width, (y + 1) * m.width), (bit) =>
      bit === 1 ? '#' : '.',
    ).join(''),
  );

describe('padTo', () => {
  it('pads right and below with transparent pixels', () => {
    const padded = padTo(solid(1, 1, [9, 9, 9, 255]), 2, 2);

    expect([...padded.data]).toEqual([9, 9, 9, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('returns an image of the right size as is', () => {
    const image = solid(2, 2);

    expect(padTo(image, 2, 2)).toBe(image);
  });
});

describe('differingPixels', () => {
  it('marks the pixels that differ', () => {
    const a = solid(6, 4);
    const b = paint(a, { x: 1, y: 1, width: 2, height: 2 });

    expect(show(differingPixels(a, b, 0.1))).toEqual(['......', '.##...', '.##...', '......']);
  });

  it('treats transparent padding like a white page', () => {
    expect(countPixels(differingPixels(solid(3, 3), solid(3, 3, [0, 0, 0, 0]), 0.1))).toBe(0);
  });
});

describe('dilate, subtract, countPixels', () => {
  it('grows a mask separately sideways and up/down', () => {
    expect(show(dilate(mask(['.....', '..#..', '.....']), 2, 0))).toEqual([
      '.....',
      '#####',
      '.....',
    ]);
    expect(show(dilate(mask(['.....', '..#..', '.....']), 0, 1))).toEqual([
      '..#..',
      '..#..',
      '..#..',
    ]);
  });

  it('subtracts and counts', () => {
    const left = mask(['##.', '##.']);
    const right = mask(['.#.', '...']);

    expect(show(subtract(left, right))).toEqual(['#..', '##.']);
    expect(countPixels(left)).toBe(4);
    expect(countPixels(left, { x: 1, y: 0, width: 2, height: 2 })).toBe(2);
  });
});

describe('regionsOf', () => {
  const pixels = mask(['##......##', '##......##', '..........', '..........', '.....#....']);

  it('groups set pixels into regions, top to bottom, dropping small ones', () => {
    expect(regionsOf(pixels, 2, 2)).toEqual([
      { x: 0, y: 0, width: 2, height: 2 },
      { x: 8, y: 0, width: 2, height: 2 },
    ]);
  });

  it('joins pixels with at most the gap between them', () => {
    expect(regionsOf(pixels, 12, 1)).toEqual([{ x: 0, y: 0, width: 10, height: 5 }]);
  });
});

describe('unionBox', () => {
  it('bounds every box', () => {
    expect(
      unionBox([
        { x: 2, y: 3, width: 1, height: 1 },
        { x: 0, y: 5, width: 4, height: 2 },
      ]),
    ).toEqual({ x: 0, y: 3, width: 4, height: 4 });
    expect(unionBox([])).toBeUndefined();
  });
});

describe('renderOverlay', () => {
  it('paints changed pixels red, outlines regions and fades the rest', () => {
    const head = solid(4, 4, [0, 0, 0, 255]);
    const overlay = renderOverlay(head, mask(['....', '.#..', '....', '....']), [
      { x: 0, y: 0, width: 3, height: 3 },
    ]);
    const pixel = (x: number, y: number) => [
      ...overlay.data.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4),
    ];

    expect(pixel(1, 1)).toEqual([230, 0, 60, 255]);
    expect(pixel(0, 0)).toEqual([255, 140, 0, 255]);
    expect(pixel(3, 3)).toEqual([166, 166, 166, 255]);
  });
});
