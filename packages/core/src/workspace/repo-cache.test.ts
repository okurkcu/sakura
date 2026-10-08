import { describe, expect, it } from 'vitest';

import { resolveRepoSource } from './repo-cache.js';

describe('resolveRepoSource', () => {
  it.each([
    'https://github.com/acme/shop',
    'https://github.com/acme/shop/',
    'https://github.com/acme/shop.git',
    'https://GitHub.com/acme/shop.git/',
    'HTTPS://github.com/acme/shop',
  ])('gives %s the same identity as https://github.com/acme/shop', (url) => {
    const source = resolveRepoSource(url, '/work');

    expect(source).toMatchObject({
      key: 'https://github.com/acme/shop',
      kind: 'https',
      location: url,
    });
    expect(source.dirName).toBe(resolveRepoSource('https://github.com/acme/shop', '/work').dirName);
  });

  it('keeps distinct repositories apart', () => {
    expect(resolveRepoSource('https://github.com/acme/shop', '/').dirName).not.toBe(
      resolveRepoSource('https://github.com/acme/Shop', '/').dirName,
    );
  });

  it('resolves local paths against the working directory', () => {
    expect(resolveRepoSource('../repos/shop', '/work/bdiff')).toMatchObject({
      key: '/work/repos/shop',
      location: '/work/repos/shop',
      kind: 'local',
    });
  });

  it('names the cache directory readably', () => {
    expect(resolveRepoSource('https://github.com/acme/shop.git', '/').dirName).toMatch(
      /^https-github-com-acme-shop-[0-9a-f]{8}$/,
    );
  });

  it.each([
    'ssh://git@github.com/acme/shop.git',
    'git@github.com:acme/shop.git',
    'file:///tmp/repo',
    'ext::sh -c touch% /tmp/pwned',
    'http://github.com/acme/shop',
    'https://user:secret@github.com/acme/shop',
  ])('rejects %s', (url) => {
    expect(() => resolveRepoSource(url, '/work')).toThrow(
      expect.objectContaining({ code: 'REPO_UNSUPPORTED' }),
    );
  });
});
