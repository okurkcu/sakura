import { parse } from 'yaml';

import { inDir } from './repo-files.js';
import type { RepoFiles } from './repo-files.js';

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

/** Backing-service images declared in a docker compose file. The app itself is never run from it. */
export interface ComposeServicesDetection {
  /** Image tag of a postgres service, if any. */
  readonly postgres?: string;
  /** Image tag of a redis service, if any. */
  readonly redis?: string;
  readonly notes: string[];
}

/** Reads postgres and redis image tags from the first compose file found (app dir, then root). */
export function detectComposeServices(files: RepoFiles, appRoot: string): ComposeServicesDetection {
  const dirs = appRoot === '.' ? ['.'] : [appRoot, '.'];
  for (const dir of dirs) {
    for (const name of COMPOSE_FILES) {
      const file = inDir(dir, name);
      const text = files.read(file);
      if (text === undefined) {
        continue;
      }
      let document: unknown;
      try {
        document = parse(text, { maxAliasCount: 50 });
      } catch {
        // A broken compose file is just ignored: it's optional information.
        return { notes: [`could not parse ${file}`] };
      }
      return { ...imageTags(document), notes: [] };
    }
  }
  return { notes: [] };
}

function imageTags(document: unknown): { postgres?: string; redis?: string } {
  const services =
    isRecord(document) && isRecord(document.services) ? Object.values(document.services) : [];
  const result: { postgres?: string; redis?: string } = {};
  for (const service of services) {
    const image =
      isRecord(service) && typeof service.image === 'string' ? service.image : undefined;
    const match =
      image === undefined
        ? null
        : /^(?:docker\.io\/)?(?:library\/)?(postgres|redis)(?::([\w][\w.-]{0,127}))?$/.exec(image);
    const kind = match?.[1];
    if (kind === 'postgres' || kind === 'redis') {
      result[kind] ??= match?.[2] ?? 'latest';
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
