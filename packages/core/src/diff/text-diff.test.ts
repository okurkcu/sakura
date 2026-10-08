import { describe, expect, it } from 'vitest';

import { diffTexts } from './text-diff.js';

const page = (text: string, title = 'Shop') => ({ title, text });
const dashboard = (time: string, visitor: string, extra = '') =>
  page(`Dashboard\n\nServer time: ${time}\nVisitor #${visitor}\n${extra}Latest order 1001: $42.00`);

describe('diffTexts', () => {
  it('finds nothing in the same text', () => {
    expect(diffTexts(page('a\nb'), page('a\nb'), page('a\n\nb'))).toEqual({
      removed: [],
      added: [],
      rawHunks: 0,
      noiseHunks: 0,
    });
  });

  it('reports added and removed lines', () => {
    const base = page('Log in\nEmail\nPassword\nSign in');
    const head = page('Log in\nEmail\nPassword\nSign in\nor\nContinue with Google');

    expect(diffTexts(base, base, head)).toMatchObject({
      removed: [],
      added: ['or', 'Continue with Google'],
    });
    expect(diffTexts(head, head, base)).toMatchObject({
      removed: ['or', 'Continue with Google'],
      added: [],
    });
  });

  it('sets aside lines that also differ between baseA and baseB', () => {
    expect(
      diffTexts(dashboard('10:00', '1'), dashboard('10:01', '22'), dashboard('10:02', '333')),
    ).toEqual({ removed: [], added: [], rawHunks: 1, noiseHunks: 1 });
  });

  it('keeps a real line added next to noisy ones', () => {
    expect(
      diffTexts(
        dashboard('10:00', '1'),
        dashboard('10:01', '22'),
        dashboard('10:02', '333', 'Orders today: 7\n'),
      ),
    ).toMatchObject({ removed: [], added: ['Orders today: 7'], noiseHunks: 0 });
  });

  it('reports a changed title', () => {
    expect(diffTexts(page('a'), page('a'), page('a', 'Shop · Sale'))).toMatchObject({
      removed: ['Title: Shop'],
      added: ['Title: Shop · Sale'],
    });
  });
});
