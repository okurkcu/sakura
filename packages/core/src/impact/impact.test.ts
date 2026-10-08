import { describe, expect, it } from 'vitest';

import { affectedRoutes } from './impact-mapping.js';
import { buildImpactPlan, DEFAULT_IMPACT_LIMITS } from './impact-plan.js';
import { discoverRoutes, exportedMethods } from './route-discovery.js';
import { classifyChange, skipReason } from './skip-rules.js';
import { readImportAliases } from './tsconfig-aliases.js';
import type { Route } from '../domain/impact.js';
import { createRepoFiles } from '../recipe/repo-files.js';

const page = (path: string, file: string, dynamic = false): Route => ({
  path,
  kind: 'page',
  file,
  dynamic,
});
const api = (
  path: string,
  file: string,
  method: Route['method'] = 'GET',
  dynamic = false,
): Route => ({
  path,
  kind: 'api',
  method,
  file,
  dynamic,
});

describe('classifyChange / skipReason', () => {
  it.each([
    ['README.md', 'docs'],
    ['docs/setup.mdx', 'docs'],
    ['LICENSE', 'docs'],
    ['CHANGELOG.md', 'docs'],
    ['.github/PULL_REQUEST_TEMPLATE.md', 'docs'],
    ['app/blog/post.mdx', 'runtime'],
    ['pages/about.md', 'runtime'],
    ['src/lib/sum.test.ts', 'tests'],
    ['components/button.spec.tsx', 'tests'],
    ['__tests__/home.tsx', 'tests'],
    ['e2e/login.ts', 'tests'],
    ['app/test/page.tsx', 'runtime'],
    ['.github/workflows/ci.yml', 'ci'],
    ['.circleci/config.yml', 'ci'],
    ['pnpm-lock.yaml', 'lockfile'],
    ['apps/web/package-lock.json', 'lockfile'],
    ['app/page.tsx', 'runtime'],
    ['next.config.ts', 'runtime'],
    ['package.json', 'runtime'],
    ['public/logo.png', 'runtime'],
  ])('%s is %s', (file, kind) => {
    expect(classifyChange(file)).toBe(kind);
  });

  it.each([
    [[{ status: 'modified', path: 'README.md' }], 'docs-only'],
    [[{ status: 'added', path: 'src/a.test.ts' }], 'tests-only'],
    [[{ status: 'modified', path: '.github/workflows/ci.yml' }], 'ci-only'],
    [[{ status: 'modified', path: 'pnpm-lock.yaml' }], 'lockfile-only'],
    [
      [
        { status: 'modified', path: 'README.md' },
        { status: 'modified', path: 'e2e/x.ts' },
      ],
      'non-runtime-only',
    ],
    [[], 'no-changes'],
    [
      [
        { status: 'modified', path: 'README.md' },
        { status: 'modified', path: 'app/page.tsx' },
      ],
      undefined,
    ],
    [[{ status: 'renamed', path: 'docs/a.md', oldPath: 'app/a/page.tsx' }], undefined],
  ] as const)('%j → %s', (changed, reason) => {
    expect(skipReason(changed)).toBe(reason);
  });
});

describe('discoverRoutes', () => {
  it('finds App Router pages and handlers, ignoring groups, slots, private and intercepting folders', () => {
    const files = createRepoFiles(
      {
        'app/api/orders/route.ts':
          'export async function GET() {}\nexport const POST = async () => {};',
        'app/api/health/route.ts': 'export function GET() {}',
        'app/api/legacy/route.js':
          'const handler = () => {};\nexport { handler as GET, handler as HEAD };',
      },
      [
        'app/page.tsx',
        'app/layout.tsx',
        'app/(marketing)/about/page.tsx',
        'app/blog/[slug]/page.tsx',
        'app/docs/[[...path]]/page.mdx',
        'app/@modal/(.)photo/[id]/page.tsx',
        'app/_components/card/page.tsx',
        'app/dashboard/@stats/page.tsx',
        'app/dashboard/page.tsx',
        'app/globals.css',
      ],
    );

    expect(
      discoverRoutes(files, '.').map((route) => [
        route.method ? `${route.method} ${route.path}` : route.path,
        route.dynamic,
      ]),
    ).toEqual([
      ['/', false],
      ['/about', false],
      ['GET /api/health', false],
      ['GET /api/legacy', false],
      ['HEAD /api/legacy', false],
      ['GET /api/orders', false],
      ['POST /api/orders', false],
      ['/blog/[slug]', true],
      ['/dashboard', false],
      ['/dashboard', false],
      ['/docs/[[...path]]', true],
    ]);
  });

  it('finds Pages Router pages and API routes in src/ and a monorepo app', () => {
    const files = createRepoFiles({}, [
      'apps/web/src/pages/index.tsx',
      'apps/web/src/pages/_app.tsx',
      'apps/web/src/pages/_document.tsx',
      'apps/web/src/pages/404.tsx',
      'apps/web/src/pages/settings/index.tsx',
      'apps/web/src/pages/users/[id].tsx',
      'apps/web/src/pages/api/hello.ts',
      'apps/web/src/pages/styles.css',
      'apps/admin/pages/index.tsx',
    ]);

    expect(discoverRoutes(files, 'apps/web')).toEqual([
      page('/', 'apps/web/src/pages/index.tsx'),
      api('/api/hello', 'apps/web/src/pages/api/hello.ts'),
      page('/settings', 'apps/web/src/pages/settings/index.tsx'),
      page('/users/[id]', 'apps/web/src/pages/users/[id].tsx', true),
    ]);
  });

  it.each([
    ['export async function GET(req) {}', ['GET']],
    ['export function* GET() {}', ['GET']],
    ['export const DELETE = handler; export let PATCH = x;', ['PATCH', 'DELETE']],
    ['export { a as POST }', ['POST']],
    ['function GET() {} // not exported', []],
    ['export const GETTER = 1;', []],
  ])('finds the exported methods of %j', (source, methods) => {
    expect(exportedMethods(source)).toEqual(methods);
  });
});

describe('affectedRoutes', () => {
  const routes = [
    page('/', 'app/page.tsx'),
    page('/login', 'app/login/page.tsx'),
    page('/shop', 'app/shop/page.tsx'),
    page('/shop/cart', 'app/shop/cart/page.tsx'),
    api('/api/orders', 'app/api/orders/route.ts'),
    page('/legacy', 'pages/legacy.tsx'),
    page('/old', 'pages/old/index.tsx'),
  ];
  const graph = new Map<string, string[]>([
    ['app/layout.tsx', ['app/globals.css']],
    ['app/shop/layout.tsx', ['components/shop-nav.tsx']],
    ['app/page.tsx', ['components/hero.tsx']],
    ['app/login/page.tsx', ['components/button.tsx']],
    ['app/shop/page.tsx', ['lib/prices.ts']],
    ['app/api/orders/route.ts', ['lib/prices.ts', 'lib/db.ts']],
    ['components/hero.tsx', ['components/button.tsx']],
    ['pages/_app.tsx', ['styles/app.css']],
  ]);

  it.each([
    { changed: ['app/login/page.tsx'], affected: ['/login'] },
    { changed: ['components/button.tsx'], affected: ['/', '/login'] },
    { changed: ['lib/prices.ts'], affected: ['/shop', 'GET /api/orders'] },
    { changed: ['app/globals.css'], affected: ['/', '/login', '/shop', '/shop/cart'] },
    { changed: ['components/shop-nav.tsx'], affected: ['/shop', '/shop/cart'] },
    { changed: ['styles/app.css'], affected: ['/legacy', '/old'] },
  ])('maps $changed to $affected', ({ changed, affected }) => {
    const result = affectedRoutes(changed, routes, graph);

    expect(
      result.affected
        .map((route) => (route.kind === 'api' ? `GET ${route.path}` : route.path))
        .sort(),
    ).toEqual([...affected].sort());
    expect(result.unmappedFiles).toEqual([]);
  });

  it('reports files that reach no route', () => {
    expect(affectedRoutes(['next.config.ts', 'lib/db.ts'], routes, graph)).toEqual({
      affected: [api('/api/orders', 'app/api/orders/route.ts')],
      unmappedFiles: ['next.config.ts'],
    });
  });
});

describe('buildImpactPlan', () => {
  const routes = [
    page('/', 'app/page.tsx'),
    page('/about', 'app/about/page.tsx'),
    page('/blog', 'app/blog/page.tsx'),
    page('/blog/[slug]', 'app/blog/[slug]/page.tsx', true),
    page('/contact', 'app/contact/page.tsx'),
    page('/pricing', 'app/pricing/page.tsx'),
    page('/docs/intro', 'app/docs/intro/page.tsx'),
    api('/api/health', 'app/api/health/route.ts'),
  ];

  it('probes affected static routes with high confidence, listing dynamic ones as not probed', () => {
    const plan = buildImpactPlan({
      routes,
      affected: [routes[3], routes[1], routes[7]].filter(
        (route): route is Route => route !== undefined,
      ),
      unmappedFiles: [],
      limits: DEFAULT_IMPACT_LIMITS,
    });

    expect(plan).toMatchObject({
      pages: [page('/about', 'app/about/page.tsx')],
      endpoints: [api('/api/health', 'app/api/health/route.ts')],
      notProbed: [{ route: { path: '/blog/[slug]' }, reason: 'dynamic-params' }],
      confidence: 'high',
    });
  });

  it('caps pages and endpoints, listing the rest as not probed', () => {
    const plan = buildImpactPlan({
      routes,
      affected: routes,
      unmappedFiles: [],
      limits: { maxPages: 2, maxEndpoints: 0 },
    });

    expect(plan.pages.map((route) => route.path)).toEqual(['/', '/about']);
    expect(plan.endpoints).toEqual([]);
    expect(plan.notProbed.map((entry) => [entry.route.path, entry.reason])).toEqual([
      ['/blog', 'cap'],
      ['/blog/[slug]', 'dynamic-params'],
      ['/contact', 'cap'],
      ['/docs/intro', 'cap'],
      ['/pricing', 'cap'],
      ['/api/health', 'cap'],
    ]);
  });

  it('falls back to / and three top-level static pages with low confidence when nothing maps', () => {
    const plan = buildImpactPlan({
      routes,
      affected: [],
      unmappedFiles: ['next.config.ts'],
      limits: DEFAULT_IMPACT_LIMITS,
    });

    expect(plan.pages.map((route) => route.path)).toEqual(['/', '/about', '/blog', '/contact']);
    expect(plan).toMatchObject({ confidence: 'low', unmappedFiles: ['next.config.ts'] });
    expect(plan.notes.join()).toContain('next.config.ts');
  });

  it('has medium confidence when only some changed files map', () => {
    const plan = buildImpactPlan({
      routes,
      affected: [routes[1]].filter((route): route is Route => route !== undefined),
      unmappedFiles: ['public/logo.png'],
      limits: DEFAULT_IMPACT_LIMITS,
    });

    expect(plan.confidence).toBe('medium');
  });
});

describe('readImportAliases', () => {
  it("reads prefix and exact aliases, inheriting baseUrl through relative extends; paths replace the parent's", () => {
    const files = createRepoFiles({
      'tsconfig.base.json':
        '{ "compilerOptions": { "baseUrl": "./src", "paths": { "~/*": ["./*"] } } }',
      'apps/web/tsconfig.json': `{
        // comments and trailing commas are fine
        "extends": ["../../tsconfig.base.json", "@tsconfig/next/tsconfig.json"],
        "compilerOptions": { "paths": { "@/*": ["./*"], "config": ["./config.ts"], "x/*/y": ["./*"], }, },
      }`,
    });

    const aliases = readImportAliases(files, 'apps/web', '/repo');

    expect(aliases.alias).toEqual({
      '@': '/repo/src',
      config$: '/repo/src/config.ts',
    });
    expect(aliases.moduleRoots).toEqual(['/repo/src']);
    expect(aliases.notes.join('\n')).toMatch(
      /skipped "extends": "@tsconfig\/next[\s\S]*unsupported path alias "x\/\*\/y"/,
    );
  });

  it('resolves inherited paths without a baseUrl from the config that declares them', () => {
    const files = createRepoFiles({
      'tsconfig.json': '{ "compilerOptions": { "paths": { "@ui/*": ["./packages/ui/src/*"] } } }',
      'apps/web/tsconfig.json': '{ "extends": "../../tsconfig.json" }',
    });

    expect(readImportAliases(files, 'apps/web', '/repo')).toEqual({
      alias: { '@ui': '/repo/packages/ui/src' },
      moduleRoots: [],
      notes: [],
    });
  });

  it('uses jsconfig.json and resolves relative to it without a baseUrl', () => {
    const files = createRepoFiles({
      'jsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
    });

    expect(readImportAliases(files, '.', '/repo')).toMatchObject({
      alias: { '@': '/repo/src' },
      moduleRoots: [],
    });
  });

  it('returns no aliases without a config', () => {
    expect(readImportAliases(createRepoFiles({}), '.', '/repo')).toEqual({
      alias: {},
      moduleRoots: [],
      notes: [],
    });
  });
});
