import type { Recipe } from '../../domain/recipe.js';
import { detectCommands } from '../detect-commands.js';
import { detectNodeVersion } from '../detect-node-version.js';
import { detectPackageManager } from '../detect-package-manager.js';
import { APP_PORT } from '../detect-recipe.js';
import { readPackageJson } from '../repo-files.js';
import type { RepoFiles } from '../repo-files.js';

/**
 * The recipe the repair loop patches when detection found none (`SETUP_UNSUPPORTED`): a Next.js
 * app at the repository root with the root's package manager, Node version and scripts, confidence
 * `low`, and why detection failed in `notes`. Pure.
 */
export function fallbackRecipe(files: RepoFiles, detectionError: string): Recipe {
  const pm = detectPackageManager(files, '.');
  const node = detectNodeVersion(files, '.');
  const commands = detectCommands(pm.name, readPackageJson(files, '.'), APP_PORT);
  return {
    installRoot: '.',
    appRoot: '.',
    nodeVersion: node.version,
    packageManager: { name: pm.name, ...(pm.version === undefined ? {} : { version: pm.version }) },
    installCmd: pm.installCmd,
    buildCmd: commands.buildCmd,
    startCmd: commands.startCmd,
    port: APP_PORT,
    healthPath: '/',
    env: {},
    missingEnv: [],
    services: [],
    dbSetupCmds: [],
    confidence: 'low',
    notes: [`recipe detection failed: ${detectionError}`, ...pm.notes, ...node.notes],
  };
}
