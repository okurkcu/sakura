import { describe, expect, it } from 'vitest';

import { commandProblem, recipeCommandProblems } from './command-allowlist.js';
import type { PackageManagerName } from '../../domain/recipe.js';
import { STUB_RECIPE } from '../../testing/stub-stages.js';
import { createRepoFiles } from '../repo-files.js';

const files = createRepoFiles(
  {
    'package.json': JSON.stringify({ scripts: { build: 'next build', start: 'node server.mjs' } }),
    'apps/web/package.json': JSON.stringify({ scripts: { 'start:prod': 'node server.js' } }),
  },
  ['server.mjs', 'scripts/seed.mjs', 'apps/web/server.js'],
);
const at = (packageManager: PackageManagerName, cwd = '.') => ({ packageManager, cwd, files });

describe('commandProblem', () => {
  it.each<[PackageManagerName, string[]]>([
    ['pnpm', ['pnpm', 'install', '--frozen-lockfile']],
    ['pnpm', ['pnpm', 'i']],
    ['npm', ['npm', 'ci']],
    ['npm', ['npm', 'install']],
    ['yarn', ['yarn', 'install', '--immutable']],
    ['yarn', ['yarn']],
    ['bun', ['bun', 'install']],
    ['pnpm', ['pnpm', 'run', 'build']],
    ['npm', ['npm', 'run', 'start']],
    ['npm', ['npm', 'run-script', 'build']],
    ['pnpm', ['pnpm', 'start']],
    ['yarn', ['yarn', 'build']],
    ['bun', ['bun', 'start']],
    ['pnpm', ['pnpm', 'exec', 'next', 'start', '-p', '3000', '-H', '0.0.0.0']],
    ['npm', ['npm', 'exec', '--', 'next', 'build']],
    ['npm', ['npm', 'exec', 'prisma', 'migrate', 'deploy']],
    ['bun', ['bun', 'x', 'drizzle-kit', 'push']],
    ['yarn', ['yarn', 'next', 'build']],
    ['pnpm', ['pnpm', 'prisma', 'db', 'push']],
    ['pnpm', ['npx', 'prisma', 'migrate', 'deploy']],
    ['pnpm', ['npx', 'drizzle-kit', 'migrate']],
    ['pnpm', ['node', 'server.mjs']],
    ['pnpm', ['node', './scripts/seed.mjs', '--force']],
  ])('allows %s: %j', (pm, argv) => {
    expect(commandProblem(argv, at(pm))).toBeUndefined();
  });

  it.each<[PackageManagerName, string[], RegExp]>([
    ['pnpm', ['sh', '-c', 'pnpm install'], /only pnpm/],
    ['pnpm', ['bash', 'setup.sh'], /only pnpm/],
    ['pnpm', ['curl', 'https://example.com/install.sh'], /only pnpm/],
    ['pnpm', ['npm', 'install'], /only pnpm \(the recipe's package manager\)/],
    ['npm', ['npx', 'create-next-app'], /npx may only run next, prisma, drizzle-kit/],
    ['npm', ['npx', 'cowsay'], /npx may only run/],
    ['pnpm', ['pnpm', 'exec', 'rm', '-rf', '/'], /pnpm exec may only run/],
    ['npm', ['npm', 'exec', '--', 'node', '-e', '1'], /npm exec may only run/],
    ['pnpm', ['pnpm', 'dlx', 'evil-package'], /"pnpm dlx" is not an allowed command/],
    ['npm', ['npm', 'publish'], /"npm publish" is not an allowed command/],
    ['npm', ['npm', 'build'], /"npm build" is not an allowed command/],
    ['pnpm', ['pnpm', 'run', 'deploy'], /script "deploy" is not defined in package.json/],
    ['pnpm', ['pnpm'], /a subcommand is required/],
    ['pnpm', ['node', '-e', 'require("child_process")'], /node may only run a file/],
    ['pnpm', ['node', '--require', './x.js', 'server.mjs'], /node may only run a file/],
    ['pnpm', ['node', '/etc/passwd'], /node may only run a file/],
    ['pnpm', ['node', '../outside.js'], /outside the repository/],
    ['pnpm', ['node', 'missing.js'], /missing\.js does not exist/],
  ])('rejects %s: %j', (pm, argv, problem) => {
    expect(commandProblem(argv, at(pm))).toMatch(problem);
  });

  it('reads scripts and files relative to the directory the command runs in', () => {
    expect(commandProblem(['pnpm', 'run', 'start:prod'], at('pnpm', 'apps/web'))).toBeUndefined();
    expect(commandProblem(['node', 'server.js'], at('pnpm', 'apps/web'))).toBeUndefined();
    expect(commandProblem(['pnpm', 'run', 'build'], at('pnpm', 'apps/web'))).toMatch(
      /not defined in apps\/web\/package\.json/,
    );
    expect(commandProblem(['node', '../../server.mjs'], at('pnpm', 'apps/web'))).toBeUndefined();
  });
});

describe('recipeCommandProblems', () => {
  it('accepts what recipe detection produces', () => {
    expect(recipeCommandProblems(STUB_RECIPE, files)).toEqual([]);
  });

  it('checks every command: install at the install root, the rest at the app root', () => {
    const problems = recipeCommandProblems(
      {
        ...STUB_RECIPE,
        appRoot: 'apps/web',
        installCmd: ['pnpm', 'run', 'start:prod'],
        dbSetupCmds: [['sh', 'seed.sh']],
        buildCmd: ['pnpm', 'run', 'start:prod'],
        startCmd: ['curl', 'x'],
      },
      files,
    );

    expect(problems).toEqual([
      expect.stringMatching(/script "start:prod" is not defined in package\.json/),
      expect.stringMatching(/"sh seed\.sh"/),
      expect.stringMatching(/"curl x"/),
    ]);
  });
});
