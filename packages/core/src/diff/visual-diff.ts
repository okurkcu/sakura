import { countPixels, differingPixels, dilate, padTo, regionsOf, subtract } from './image.js';
import type { Mask } from './image.js';
import type { RgbaImage } from '../adapters/png.js';
import type { Box } from '../domain/finding.js';

/** Tuning of {@link diffScreenshots}. */
export interface VisualDiffOptions {
  /** pixelmatch threshold, 0 to 1; smaller is more sensitive. */
  readonly threshold: number;
  /**
   * How far the noise mask grows sideways and up/down. Wide sideways: noise is mostly text whose
   * width varies (a 5- vs 6-digit number), so head's variant can overhang both bases' pixels.
   */
  readonly noiseGrowX: number;
  readonly noiseGrowY: number;
  /** Changed pixels with at most this many unchanged pixels between them form one region. */
  readonly regionGap: number;
  /** Regions with fewer changed pixels are ignored. */
  readonly minRegionPixels: number;
}

/** Defaults of {@link diffScreenshots}. */
export const VISUAL_DIFF_DEFAULTS: VisualDiffOptions = {
  threshold: 0.1,
  noiseGrowX: 32,
  noiseGrowY: 4,
  regionGap: 8,
  minRegionPixels: 20,
};

/** What changed between the base and head screenshots of one page. */
export interface VisualDiff {
  /** Changed regions once noise is masked out, top to bottom. */
  readonly regions: Box[];
  /** Changed pixels once noise is masked out, on the padded canvas. */
  readonly changed: Mask;
  /** Head on the padded canvas, for the overlay. */
  readonly head: RgbaImage;
  /** Regions of baseA vs head before masking noise. */
  readonly rawRegions: number;
  /** Raw regions that masking noise removed entirely. */
  readonly noiseRegions: number;
}

/**
 * Compares the screenshots of one page: pads all three to the largest size; the pixels that
 * differ between baseA and baseB, grown a little, are noise; what differs between baseA and head
 * outside the noise is grouped into regions. Pure.
 */
export function diffScreenshots(
  baseA: RgbaImage,
  baseB: RgbaImage,
  head: RgbaImage,
  options: VisualDiffOptions = VISUAL_DIFF_DEFAULTS,
): VisualDiff {
  const width = Math.max(baseA.width, baseB.width, head.width);
  const height = Math.max(baseA.height, baseB.height, head.height);
  const [a, b, h] = [baseA, baseB, head].map((image) => padTo(image, width, height)) as [
    RgbaImage,
    RgbaImage,
    RgbaImage,
  ];
  const noise = dilate(
    differingPixels(a, b, options.threshold),
    options.noiseGrowX,
    options.noiseGrowY,
  );
  const raw = differingPixels(a, h, options.threshold);
  const changed = subtract(raw, noise);
  const rawRegions = regionsOf(raw, options.regionGap, options.minRegionPixels);
  const regions = regionsOf(changed, options.regionGap, options.minRegionPixels);
  const noiseRegions = rawRegions.filter(
    (region) => countPixels(changed, region) < options.minRegionPixels,
  ).length;
  return { regions, changed, head: h, rawRegions: rawRegions.length, noiseRegions };
}
