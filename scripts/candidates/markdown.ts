import type { CandidatesFile } from './schema.js';

/** Escapes text for a Markdown table cell. */
function cell(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

/**
 * `candidates.md`: totals by type, difficulty and author, then one table row per candidate in
 * rank order. Pure.
 */
export function candidatesMarkdown(file: CandidatesFile): string {
  const { candidates } = file;
  const count = (key: 'prType' | 'difficulty' | 'author') => {
    const totals = new Map<string, number>();
    for (const candidate of candidates) {
      totals.set(candidate.tags[key], (totals.get(candidate.tags[key]) ?? 0) + 1);
    }
    return [...totals.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([value, n]) => `${value} ${String(n)}`)
      .join(', ');
  };
  const lines = [
    '# Dataset candidates',
    '',
    `Generated ${file.generatedAt} by \`pnpm candidates\`: ${String(candidates.length)} merged PRs since ${file.since} across ${String(file.repos)} repositories. Pick entries for \`dataset.json\` from \`candidates.json\`.`,
    '',
    `- Type: ${count('prType')}`,
    `- Difficulty: ${count('difficulty')}`,
    `- Author: ${count('author')}`,
    '',
    '| # | Score | Repository | PR | Type | Difficulty | Author | Files | Setup signals | Validation |',
    '| -: | -: | --- | --- | --- | --- | --- | -: | --- | --- |',
    ...candidates.map((candidate, index) => {
      const { signals } = candidate.repo;
      const setup = [
        `${signals.router} router`,
        signals.database === 'none' ? 'no db' : signals.database,
        signals.envExample ? '.env.example' : undefined,
        signals.dockerCompose ? 'compose' : undefined,
        signals.monorepo ? `monorepo (${signals.appRoot})` : undefined,
      ]
        .filter((part) => part !== undefined)
        .join(', ');
      const validation =
        candidate.validation === undefined
          ? ''
          : candidate.validation.status === 'ok'
            ? `ok (${candidate.validation.confidence})`
            : candidate.validation.code;
      return `| ${String(index + 1)} | ${candidate.score.toFixed(2)} | ${cell(candidate.repo.fullName)} (★${String(candidate.repo.stars)}) | [#${String(candidate.prNumber ?? '')} ${cell(candidate.title)}](${candidate.url}) | ${candidate.tags.prType} | ${candidate.tags.difficulty} | ${cell(candidate.author)} | ${String(candidate.changedFiles.length)} | ${setup} | ${validation} |`;
    }),
    '',
  ];
  return lines.join('\n');
}
