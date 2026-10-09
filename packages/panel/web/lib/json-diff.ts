/** One line of a unified diff: kept, removed (`-`) or added (`+`), or a fold of kept lines. */
export interface DiffRow {
  readonly kind: ' ' | '-' | '+' | '…';
  readonly text: string;
}

/** Longest input (lines per side) that is diffed line by line; longer ones are compared whole. */
const MAX_LINES = 1_500;

/**
 * A unified line diff of two texts (longest common subsequence), with unchanged runs longer than
 * `2 × context` folded into one `…` row. Pure.
 */
export function lineDiff(before: string, after: string, context = 3): DiffRow[] {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      ...a.map((text): DiffRow => ({ kind: '-', text })),
      ...b.map((text): DiffRow => ({ kind: '+', text })),
    ];
  }
  // lengths[i][j] = LCS length of a[i..] and b[j..].
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = lengths[i] ?? [];
    const below = lengths[i + 1] ?? [];
    for (let j = b.length - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      rows.push({ kind: ' ', text: a[i] ?? '' });
      i += 1;
      j += 1;
    } else if (
      i < a.length &&
      (j >= b.length || (lengths[i + 1]?.[j] ?? 0) >= (lengths[i]?.[j + 1] ?? 0))
    ) {
      // Removed lines first, like `diff -u`.
      rows.push({ kind: '-', text: a[i] ?? '' });
      i += 1;
    } else {
      rows.push({ kind: '+', text: b[j] ?? '' });
      j += 1;
    }
  }
  return fold(rows, context);
}

function fold(rows: readonly DiffRow[], context: number): DiffRow[] {
  const out: DiffRow[] = [];
  let run: DiffRow[] = [];
  const flush = (atStart: boolean, atEnd: boolean) => {
    const keepBefore = atStart ? 0 : context;
    const keepAfter = atEnd ? 0 : context;
    if (run.length > keepBefore + keepAfter + 1) {
      out.push(...run.slice(0, keepBefore));
      out.push({
        kind: '…',
        text: `${String(run.length - keepBefore - keepAfter)} unchanged lines`,
      });
      out.push(...run.slice(run.length - keepAfter));
    } else {
      out.push(...run);
    }
    run = [];
  };
  rows.forEach((row) => {
    if (row.kind === ' ') {
      run.push(row);
    } else {
      flush(out.length === 0, false);
      out.push(row);
    }
  });
  flush(out.length === 0, true);
  return out;
}

/** JSON pretty-printed for a diff: two spaces, keys in their order. Pure. */
export function prettyJson(value: unknown): string {
  // `JSON.stringify` gives undefined for undefined, functions and symbols.
  const text = JSON.stringify(value, null, 2) as string | undefined;
  return text ?? 'undefined';
}
