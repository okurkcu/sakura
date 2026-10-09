import type { DatasetTags } from '@bdiff/cli';

import type { Candidate } from './schema.js';

/** The most files a candidate PR may change; larger PRs are left out. */
export const MAX_CHANGED_FILES = 30;

const PR_TYPE_WEIGHT: Readonly<Record<DatasetTags['prType'], number>> = {
  ui: 1,
  api: 1,
  mixed: 0.9,
  refactor: 0.6,
};
const DIFFICULTY_WEIGHT: Readonly<Record<DatasetTags['difficulty'], number>> = {
  easy: 1,
  realistic: 0.7,
};

/**
 * How well a PR fits the experiment, 0–1: PRs that change pages or APIs over refactors, repos that
 * are easy to set up, and small PRs (each changed file costs a little, down to half at
 * {@link MAX_CHANGED_FILES}). Pure.
 */
export function scoreCandidate(
  tags: Pick<DatasetTags, 'prType' | 'difficulty'>,
  changedFiles: number,
): number {
  const size = 1 - Math.min(changedFiles, MAX_CHANGED_FILES) / (2 * MAX_CHANGED_FILES);
  const score = PR_TYPE_WEIGHT[tags.prType] * DIFFICULTY_WEIGHT[tags.difficulty] * size;
  return Math.round(score * 1000) / 1000;
}

/** Candidates best first: by score, then repository and PR number for a stable order. Pure. */
export function rankCandidates(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort(
    (a, b) =>
      b.score - a.score ||
      (a.repo.fullName < b.repo.fullName ? -1 : a.repo.fullName > b.repo.fullName ? 1 : 0) ||
      (a.prNumber ?? 0) - (b.prNumber ?? 0),
  );
}

/**
 * At most `perRepo` candidates per repository, keeping the best ones (input order), so a few busy
 * repositories cannot fill the list. Pure.
 */
export function capPerRepo(candidates: readonly Candidate[], perRepo: number): Candidate[] {
  const counts = new Map<string, number>();
  return candidates.filter((candidate) => {
    const count = counts.get(candidate.repo.fullName) ?? 0;
    counts.set(candidate.repo.fullName, count + 1);
    return count < perRepo;
  });
}
