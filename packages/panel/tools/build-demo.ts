/**
 * `pnpm panel:demo <workspace> --live <runId> <runId>…`: copies real runs of a workspace into the
 * demo of `bdiff ui --demo` (`packages/panel/demo/`): the given runs as finished runs, the `--live`
 * one as the run replayed in progress. Only what the panel shows is copied, and local paths are
 * replaced (`/demo/.bdiff`, `/demo/fixture-repo`) so no machine's paths end up in the repository.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { nodeFileSystem } from '@bdiff/core';
import type { FileSystem } from '@bdiff/core';

import { PANEL_PATHS } from '../src/server/web-build.js';

/** Files and directories of a run the panel uses. */
const KEPT = [
  'run.json',
  'result.json',
  'events.jsonl',
  'compose.yml',
  'report/',
  'ui/',
  'diff/',
  'api/',
  'logs/',
];
const TEXT = ['.json', '.jsonl', '.yml', '.log', '.html'];

/** Whether the panel uses `file` (relative to a run directory). Pure. */
export function keptFile(file: string): boolean {
  return KEPT.some((kept) => (kept.endsWith('/') ? file.startsWith(kept) : file === kept));
}

/** `text` with each `[from, to]` replaced everywhere, longest `from` first. Pure. */
export function replacePaths(
  text: string,
  replacements: readonly (readonly [string, string])[],
): string {
  return [...replacements]
    .sort(([a], [b]) => b.length - a.length)
    .reduce((current, [from, to]) => current.split(from).join(to), text);
}

/** Copies runs into the demo directory, replacing local paths in text files. */
export async function buildDemo(
  fs: FileSystem,
  options: {
    readonly workspace: string;
    readonly demoDir: string;
    readonly finished: readonly string[];
    readonly live: string;
    /** Extra local paths to replace, e.g. the fixture repository. */
    readonly replacements: readonly (readonly [string, string])[];
  },
): Promise<number> {
  const replacements = [
    [path.resolve(options.workspace), '/demo/.bdiff'] as const,
    ...options.replacements,
  ];
  await fs.rm(options.demoDir);
  let copied = 0;
  const copy = async (runId: string, target: string) => {
    const from = path.join(options.workspace, 'runs', runId);
    for (const file of (await fs.listFiles(from, { ignoreDirs: ['worktrees'] })).filter(keptFile)) {
      const destination = path.join(target, runId, file);
      await fs.mkdir(path.dirname(destination));
      if (TEXT.includes(path.extname(file))) {
        await fs.writeFile(
          destination,
          replacePaths(await fs.readFile(path.join(from, file)), replacements),
        );
      } else {
        await fs.writeFile(destination, await fs.readFileBytes(path.join(from, file)));
      }
      copied += 1;
    }
  };
  for (const runId of options.finished) {
    await copy(runId, path.join(options.demoDir, 'runs'));
  }
  await copy(options.live, path.join(options.demoDir, 'live', 'runs'));
  return copied;
}

async function main(): Promise<void> {
  const [workspace, ...rest] = process.argv.slice(2);
  const liveAt = rest.indexOf('--live');
  const live = liveAt >= 0 ? rest[liveAt + 1] : undefined;
  const finished = rest.filter((_, index) => index !== liveAt && index !== liveAt + 1);
  if (workspace === undefined || live === undefined || finished.length === 0) {
    process.stderr.write('usage: pnpm panel:demo <workspace> --live <runId> <runId>…\n');
    process.exitCode = 2;
    return;
  }
  // Fixture repositories are built in temp directories; their paths are machine-specific too.
  const repoPaths = new Set<string>();
  for (const runId of [...finished, live]) {
    const record = JSON.parse(
      await nodeFileSystem.readFile(path.join(workspace, 'runs', runId, 'run.json')),
    ) as {
      target: { repoUrl: string };
    };
    repoPaths.add(record.target.repoUrl);
  }
  const count = await buildDemo(nodeFileSystem, {
    workspace,
    demoDir: PANEL_PATHS.demo,
    finished,
    live,
    replacements: [
      ...[...repoPaths]
        .filter((repo) => repo.startsWith('/'))
        .map((repo) => [repo, '/demo/fixture-repo'] as const),
      [path.resolve(process.cwd()), '/demo/bdiff'],
      [process.env.HOME ?? '/nonexistent-home', '/demo/home'],
    ],
  });
  process.stdout.write(`${String(count)} files copied to ${PANEL_PATHS.demo}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
