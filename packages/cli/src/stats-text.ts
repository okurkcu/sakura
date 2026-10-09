import type { Distribution, GroupStats, Stats } from './stats.js';

/** `bdiff stats` as text for the terminal. Pure. */
export function formatStats(stats: Stats): string {
  const { overall } = stats;
  const lines = [
    `bdiff stats: ${String(overall.runs)} runs (${String(overall.succeeded)} success, ${String(overall.failed)} failed, ${String(overall.skipped)} skipped)`,
    '',
    ...groupLines(overall),
    '',
    'Success criteria',
    ...stats.criteria.map(
      (criterion) =>
        `  ${criterion.verdict.toUpperCase().padEnd(4)}  ${criterion.description}: ${criterion.measured}`,
    ),
  ];
  if (stats.groups !== undefined) {
    lines.push('', `By ${stats.groups.by}`);
    for (const [value, group] of Object.entries(stats.groups.values)) {
      lines.push(
        `  ${value}: ${String(group.runs)} runs · setup ${percent(group.setup.rate)} · median ${duration(group.durationMs.median)} · findings mean ${number(group.findingsPerRun.mean)} · LLM median ${usd(group.llmCostUsd.median)}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

function groupLines(group: GroupStats): string[] {
  const row = (label: string, value: string) => `${label.padEnd(22)}${value}`;
  const reasons = Object.entries(group.failureReasons)
    .map(([code, count]) => `${code} ${String(count)}`)
    .join(', ');
  return [
    row(
      'Setup success',
      `${percent(group.setup.rate)} (${String(group.setup.succeeded)}/${String(group.setup.attempted)}); repaired ${String(group.repaired.succeeded)}/${String(group.repaired.attempted)}`,
    ),
    row('Skip rate', percent(group.skipRate)),
    row('Duration', spread(group.durationMs, duration)),
    ...Object.entries(group.stageMs).map(([stage, times]) =>
      row(`  ${stage}`, spread(times, duration)),
    ),
    row(
      'LLM cost per PR',
      `${spread(group.llmCostUsd, usd)} · total ${usd(group.llmCostUsd.total)}`,
    ),
    row(
      'Compute per PR',
      `${spread(group.computeSeconds, seconds)} · total ${seconds(group.computeSeconds.total)}`,
    ),
    row('Noise ratio', `${percent(group.noiseRatio)} of raw differences`),
    row(
      'Findings per PR',
      `median ${number(group.findingsPerRun.median)} · mean ${number(group.findingsPerRun.mean)}`,
    ),
    row(
      'Breaking/unexpected',
      `${percent(group.breakingOrUnexpected.rate)} of successful runs (${String(group.breakingOrUnexpected.runs)})`,
    ),
    row('Failure reasons', reasons === '' ? 'none' : reasons),
  ];
}

function spread(values: Distribution, unit: (value: number | null) => string): string {
  return `median ${unit(values.median)} · p90 ${unit(values.p90)}`;
}

function percent(value: number | null): string {
  return value === null ? '–' : `${String(Math.round(value * 100))}%`;
}

function duration(ms: number | null): string {
  return ms === null
    ? '–'
    : ms < 60_000
      ? `${(ms / 1000).toFixed(1)} s`
      : `${(ms / 60_000).toFixed(1)} min`;
}

function usd(value: number | null): string {
  return value === null ? '–' : `$${value.toFixed(4)}`;
}

function seconds(value: number | null): string {
  return value === null ? '–' : `${String(Math.round(value))} s`;
}

function number(value: number | null): string {
  return value === null ? '–' : String(Math.round(value * 10) / 10);
}
