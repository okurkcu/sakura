import { detectAppRoot } from './detect-app-root.js';
import { detectCommands } from './detect-commands.js';
import { detectComposeServices } from './detect-compose-services.js';
import { detectDatabase } from './detect-database.js';
import { detectEnv } from './detect-env.js';
import { detectHealthPath } from './detect-health.js';
import { detectNodeVersion } from './detect-node-version.js';
import { detectPackageManager } from './detect-package-manager.js';
import { readPackageJson } from './repo-files.js';
import type { RepoFiles } from './repo-files.js';
import type { Recipe } from '../domain/recipe.js';

/** Port the app is started on inside its container. */
export const APP_PORT = 3000;

/**
 * Turns a repository snapshot into a {@link Recipe} with deterministic heuristics (no LLM).
 * Confidence starts `high`; anything bdiff had to guess lowers it, and the reason goes to `notes`.
 * Pure.
 *
 * @throws BdiffError `SETUP_UNSUPPORTED` when there is no Next.js app or its database can't be provided.
 */
export function detectRecipe(files: RepoFiles): Recipe {
  const app = detectAppRoot(files);
  const installRoot = readPackageJson(files, '.') === undefined ? app.appRoot : '.';
  const pm = detectPackageManager(files, installRoot);
  const node = detectNodeVersion(files, app.appRoot);
  const commands = detectCommands(pm.name, readPackageJson(files, app.appRoot), APP_PORT);
  const compose = detectComposeServices(files, app.appRoot);
  const database = detectDatabase(files, app.appRoot, pm.name, compose.postgres);

  const services = [...database.services];
  const redisEnv = compose.redis === undefined ? undefined : redisEnvVar(files, app.appRoot);
  if (compose.redis !== undefined && redisEnv !== undefined) {
    services.push({ kind: 'redis', version: compose.redis, envVar: redisEnv });
  }
  const env = detectEnv(
    files,
    app.appRoot,
    APP_PORT,
    new Set(services.map((service) => service.envVar)),
  );
  for (const [key, value] of Object.entries(database.env)) {
    env.env[key] = { value, source: 'generated' };
  }

  const notes = [
    ...app.notes,
    ...pm.notes,
    ...node.notes,
    ...commands.notes,
    ...compose.notes,
    ...database.notes,
    ...env.notes,
  ];
  const lowered: boolean[] = [
    app.appRoot !== '.',
    pm.lockfile === undefined,
    pm.notes.some((note) => note.startsWith('several lockfiles')),
    !node.certain,
    env.missing.length > 0,
    services.length > 0,
  ];
  const confidence = app.ambiguous ? 'low' : lowered.some(Boolean) ? 'medium' : 'high';

  return {
    installRoot,
    appRoot: app.appRoot,
    nodeVersion: node.version,
    packageManager: { name: pm.name, ...(pm.version === undefined ? {} : { version: pm.version }) },
    installCmd: pm.installCmd,
    buildCmd: commands.buildCmd,
    startCmd: commands.startCmd,
    port: APP_PORT,
    healthPath: detectHealthPath(files, app.appRoot),
    env: env.env,
    missingEnv: env.missing,
    services,
    dbSetupCmds: database.setupCmds,
    confidence,
    notes,
  };
}

/** The env key a redis service should fill, if the app's example env mentions one. */
function redisEnvVar(files: RepoFiles, appRoot: string): string | undefined {
  const keys = files.list
    .filter((file) => /(^|\/)\.env\.(example|sample|template|local\.example|dist)$/.test(file))
    .filter((file) => appRoot === '.' || file.startsWith(`${appRoot}/`) || !file.includes('/'))
    .flatMap((file) => [
      ...(files.read(file) ?? '').matchAll(
        /^\s*(?:export\s+)?([A-Z0-9_]*REDIS[A-Z0-9_]*URL)\s*=/gm,
      ),
    ])
    .map((match) => match[1]);
  return keys.find((key) => key !== undefined);
}
