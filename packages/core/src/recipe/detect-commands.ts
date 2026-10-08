import { execPrefix, runScript } from './detect-package-manager.js';
import { stringField } from './repo-files.js';
import type { PackageJson } from './repo-files.js';
import type { PackageManagerName } from '../domain/recipe.js';

/** How to build and start the app. */
export interface CommandsDetection {
  readonly buildCmd: string[];
  readonly startCmd: string[];
  readonly notes: string[];
}

/**
 * Production build and start, never `next dev`. The repository's `build` script is used when it
 * runs `next build` (it often adds steps such as `prisma generate`); otherwise `next build` runs
 * directly. Start is always `next start` on `port`, listening on all interfaces so the host can
 * reach the container.
 */
export function detectCommands(
  pm: PackageManagerName,
  appPackage: PackageJson | undefined,
  port: number,
): CommandsDetection {
  const notes: string[] = [];
  const buildScript = stringField(appPackage?.scripts, 'build');
  let buildCmd: string[];
  if (buildScript !== undefined && /\bnext\s+build\b/.test(buildScript)) {
    buildCmd = runScript(pm, 'build');
  } else {
    buildCmd = [...execPrefix(pm), 'next', 'build'];
    if (buildScript !== undefined) {
      notes.push(
        `build script "${buildScript}" does not run next build; running next build directly`,
      );
    }
  }
  const startScript = stringField(appPackage?.scripts, 'start');
  if (startScript !== undefined && !/\bnext\s+start\b/.test(startScript)) {
    notes.push(`start script "${startScript}" is not next start; using next start`);
  }
  return {
    buildCmd,
    startCmd: [...execPrefix(pm), 'next', 'start', '-p', String(port), '-H', '0.0.0.0'],
    notes,
  };
}
