import { diffArrays } from 'diff';

/** Lines of visible text head added or removed, once noise is set aside. */
export interface TextDiff {
  readonly removed: string[];
  readonly added: string[];
  /** Changed blocks of baseA vs head, before setting noise aside. */
  readonly rawHunks: number;
  /** Changed blocks that were noise only. */
  readonly noiseHunks: number;
}

/** A run of removed and added lines between unchanged ones. */
interface Hunk {
  /** Indexes in baseA of the removed lines. */
  readonly removed: number[];
  readonly added: string[];
}

/**
 * Line diff of the visible text of one page. Lines of baseA that differ in baseB are noise: in a
 * block of changes, each noisy removed line takes one added line with it (head's own variant of
 * that line, e.g. another server time); what remains is a real change. A page title counts as a
 * first line `Title: …`. Blank lines are ignored. Pure.
 */
export function diffTexts(
  baseA: { title: string; text: string },
  baseB: { title: string; text: string },
  head: { title: string; text: string },
): TextDiff {
  const [a, b, h] = [baseA, baseB, head].map(linesOf) as [string[], string[], string[]];
  const noisy = new Set(hunks(a, b).flatMap((hunk) => hunk.removed));
  const removed: string[] = [];
  const added: string[] = [];
  let rawHunks = 0;
  let noiseHunks = 0;
  for (const hunk of hunks(a, h)) {
    rawHunks += 1;
    const noisyCount = hunk.removed.filter((index) => noisy.has(index)).length;
    const realRemoved = hunk.removed
      .filter((index) => !noisy.has(index))
      .map((index) => a[index] ?? '');
    const realAdded = hunk.added.slice(noisyCount);
    if (realRemoved.length === 0 && realAdded.length === 0) {
      noiseHunks += 1;
    }
    removed.push(...realRemoved);
    added.push(...realAdded);
  }
  return { removed, added, rawHunks, noiseHunks };
}

function linesOf(page: { title: string; text: string }): string[] {
  return [`Title: ${page.title}`, ...page.text.split('\n')].filter((line) => line.trim() !== '');
}

/** The blocks of changes that turn `from` into `to`. */
function hunks(from: string[], to: string[]): Hunk[] {
  const result: Hunk[] = [];
  let current: { removed: number[]; added: string[] } | undefined;
  let index = 0;
  for (const change of diffArrays(from, to)) {
    if (!change.added && !change.removed) {
      if (current !== undefined) {
        result.push(current);
        current = undefined;
      }
      index += change.value.length;
      continue;
    }
    current ??= { removed: [], added: [] };
    if (change.removed) {
      for (let i = 0; i < change.value.length; i += 1) {
        current.removed.push(index + i);
      }
      index += change.value.length;
    } else {
      current.added.push(...change.value);
    }
  }
  if (current !== undefined) {
    result.push(current);
  }
  return result;
}
