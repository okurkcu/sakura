import path from 'node:path';

import { diffApiCaptures } from './api-diff.js';
import { toFinding, sortFindings } from './findings.js';
import type { FindingDraft } from './findings.js';
import { countPixels, renderOverlay, unionBox } from './image.js';
import { diffRuntime } from './runtime-diff.js';
import { severityOf } from './severity.js';
import { diffTexts } from './text-diff.js';
import { diffScreenshots } from './visual-diff.js';
import type { FileSystem } from '../adapters/file-system.js';
import type { ImageCodec } from '../adapters/png.js';
import type { ApiCapture, ApiProbe } from '../domain/api-probe.js';
import type { Finding } from '../domain/finding.js';
import type { ImpactPlan } from '../domain/impact.js';
import type { ProbeRun } from '../domain/stage.js';
import type { UiCapture } from '../domain/ui-capture.js';
import type { Stage, StageContext } from '../pipeline/stage.js';

/** Dependencies of the diff stage: file access and the PNG codec, its only I/O. */
export interface DiffStageDeps {
  readonly fs: FileSystem;
  readonly images: ImageCodec;
}

/** Differences counted for the run record. */
interface Tally {
  raw: number;
  noise: number;
}

/**
 * The diff stage: turns the UI and API captures into findings. Each page and request is compared
 * on head against baseA; whatever already differs between baseA and baseB is noise and set aside.
 * Pages: a page that stops loading or changes status is one finding; otherwise new runtime
 * errors, text and visual changes (with an overlay image). Requests: see `diffApiCaptures`.
 * Findings are sorted and have stable ids; counts go to the run record.
 */
export function createDiffStage(
  deps: DiffStageDeps,
): Stage<{ impact: ImpactPlan; ui: UiCapture[]; api: ApiProbe }, Finding[]> {
  return {
    name: 'diff',
    run: async ({ ui, api }, ctx) => {
      const tally: Tally = { raw: 0, noise: 0 };
      const drafts: FindingDraft[] = [];
      for (const route of [...new Set(ui.map((capture) => capture.route))]) {
        const [a, b, h] = (['baseA', 'baseB', 'head'] as const).map((run) =>
          ui.find((capture) => capture.probeRun === run && capture.route === route),
        );
        if (a === undefined || b === undefined || h === undefined) {
          continue;
        }
        drafts.push(...(await diffPage(route, a, b, h, deps, ctx, tally)));
      }
      for (const request of api.requests) {
        const [a, b, h] = (['baseA', 'baseB', 'head'] as const).map((run) =>
          findApi(api.captures, run, request.key),
        );
        if (a === undefined || b === undefined || h === undefined) {
          continue;
        }
        const diff = diffApiCaptures(a, b, h);
        tally.raw += diff.raw;
        tally.noise += diff.noise;
        const endpoint = request.endpoint ?? `${request.method} ${request.path}`;
        drafts.push(
          ...diff.changes.map((change): FindingDraft => ({
            kind: change.kind,
            severity: severityOf(change.kind, {
              ...(change.noLongerAnswers === true ? { noLongerAnswers: true } : {}),
              ...(typeof change.before === 'number' && typeof change.after === 'number'
                ? { statusBefore: change.before, statusAfter: change.after }
                : {}),
            }),
            location: {
              endpoint,
              ...(change.jsonPath === undefined ? {} : { jsonPath: change.jsonPath }),
            },
            ...(change.before === undefined ? {} : { before: change.before }),
            ...(change.after === undefined ? {} : { after: change.after }),
            evidence: [a.artifact, h.artifact],
            requestKey: request.key,
          })),
        );
      }
      const findings = sortFindings(drafts.map(toFinding));
      ctx.addCounts({ rawDiffs: tally.raw, noiseDiffs: tally.noise, findings: findings.length });
      ctx.logger.info('findings', {
        findings: findings.length,
        rawDiffs: tally.raw,
        noiseDiffs: tally.noise,
      });
      return findings;
    },
  };
}

/** The findings of one page. */
async function diffPage(
  route: string,
  a: UiCapture,
  b: UiCapture,
  h: UiCapture,
  deps: DiffStageDeps,
  ctx: StageContext,
  tally: Tally,
): Promise<FindingDraft[]> {
  if (a.error !== undefined || b.error !== undefined) {
    // No reference (baseA) or no noise baseline (baseB): nothing trustworthy to compare.
    ctx.logger.warn('page not compared: a base capture failed', { route });
    return [];
  }
  if (h.error !== undefined) {
    tally.raw += 1;
    return [
      {
        kind: 'failed-request',
        severity: severityOf('failed-request', { noLongerAnswers: true }),
        location: { route },
        before: { status: a.status },
        after: { error: h.error.code, message: h.error.message },
        evidence: [a.screenshot],
      },
    ];
  }
  if (a.status !== h.status) {
    tally.raw += 1;
    if (a.status !== b.status) {
      tally.noise += 1;
      return [];
    }
    return [
      {
        kind: 'status-changed',
        severity: severityOf('status-changed', {
          ...(a.status === null ? {} : { statusBefore: a.status }),
          ...(h.status === null ? {} : { statusAfter: h.status }),
        }),
        location: { route },
        before: a.status,
        after: h.status,
        evidence: [a.screenshot, h.screenshot],
      },
    ];
  }

  const drafts: FindingDraft[] = [];
  const runtime = diffRuntime(a, b, h);
  tally.raw += runtime.raw;
  tally.noise += runtime.noise;
  for (const signal of runtime.signals) {
    const kind = signal.source === 'failed-request' ? 'failed-request' : 'runtime-error';
    drafts.push({
      kind,
      severity: severityOf(kind, { pageError: signal.source === 'page-error' }),
      location: { route },
      after: { source: signal.source, message: signal.message },
      evidence: [h.screenshot],
    });
  }

  const text = diffTexts(a, b, h);
  tally.raw += text.rawHunks;
  tally.noise += text.noiseHunks;
  if (text.removed.length > 0 || text.added.length > 0) {
    drafts.push({
      kind: 'text',
      severity: severityOf('text'),
      location: { route },
      before: text.removed,
      after: text.added,
      evidence: [a.screenshot, h.screenshot],
    });
  }

  if (a.screenshot !== undefined && b.screenshot !== undefined && h.screenshot !== undefined) {
    const [imageA, imageB, imageH] = await Promise.all(
      [a.screenshot, b.screenshot, h.screenshot].map(async (file) =>
        deps.images.decode(await deps.fs.readFileBytes(file)),
      ),
    );
    if (imageA !== undefined && imageB !== undefined && imageH !== undefined) {
      const visual = diffScreenshots(imageA, imageB, imageH);
      tally.raw += visual.rawRegions;
      tally.noise += visual.noiseRegions;
      const bbox = unionBox(visual.regions);
      if (bbox !== undefined) {
        const overlay = ctx.paths.diffOverlay(route);
        await deps.fs.mkdir(path.dirname(overlay));
        await deps.fs.writeFile(
          overlay,
          deps.images.encode(renderOverlay(visual.head, visual.changed, visual.regions)),
        );
        drafts.push({
          kind: 'visual',
          severity: severityOf('visual'),
          location: { route, bbox },
          after: { regions: visual.regions, changedPixels: countPixels(visual.changed) },
          evidence: [a.screenshot, h.screenshot, overlay],
        });
      }
    }
  }
  return drafts;
}

function findApi(
  captures: readonly ApiCapture[],
  run: ProbeRun,
  key: string,
): ApiCapture | undefined {
  return captures.find((capture) => capture.probeRun === run && capture.requestKey === key);
}
