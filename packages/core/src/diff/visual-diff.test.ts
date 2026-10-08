import { describe, expect, it } from 'vitest';

import { diffScreenshots } from './visual-diff.js';
import { paint, solid } from '../testing/images.js';

const page = solid(200, 120);
const noiseA = paint(page, { x: 10, y: 10, width: 30, height: 10 });
const noiseB = paint(page, { x: 10, y: 10, width: 40, height: 10 });

describe('diffScreenshots', () => {
  it('finds nothing in identical screenshots', () => {
    expect(diffScreenshots(page, page, page)).toMatchObject({
      regions: [],
      rawRegions: 0,
      noiseRegions: 0,
    });
  });

  it('finds a change that baseB does not have', () => {
    const head = paint(page, { x: 50, y: 60, width: 40, height: 20 });

    expect(diffScreenshots(page, page, head)).toMatchObject({
      regions: [{ x: 50, y: 60, width: 40, height: 20 }],
      rawRegions: 1,
      noiseRegions: 0,
    });
  });

  it('masks what differs between baseA and baseB, even when head overhangs it sideways', () => {
    const head = paint(page, { x: 10, y: 10, width: 60, height: 10 });

    expect(diffScreenshots(noiseA, noiseB, head)).toMatchObject({
      regions: [],
      rawRegions: 1,
      noiseRegions: 1,
    });
  });

  it('keeps a real change next to noise', () => {
    const head = paint(paint(page, { x: 10, y: 10, width: 35, height: 10 }), {
      x: 20,
      y: 80,
      width: 50,
      height: 10,
    });

    expect(diffScreenshots(noiseA, noiseB, head)).toMatchObject({
      regions: [{ x: 20, y: 80, width: 50, height: 10 }],
      rawRegions: 2,
      noiseRegions: 1,
    });
  });

  it('pads a shorter page and finds content added below', () => {
    const taller = paint(solid(200, 160), { x: 0, y: 130, width: 100, height: 20 });

    const diff = diffScreenshots(page, page, taller);

    expect(diff.regions).toEqual([{ x: 0, y: 130, width: 100, height: 20 }]);
    expect(diff.head.height).toBe(160);
  });

  it('ignores specks smaller than the minimum region', () => {
    const head = paint(page, { x: 100, y: 100, width: 2, height: 2 });

    expect(diffScreenshots(page, page, head).regions).toEqual([]);
  });
});
