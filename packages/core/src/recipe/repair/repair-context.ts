import path from 'node:path';

import { inDir, isRelevantFile } from '../repo-files.js';
import type { RepoFiles } from '../repo-files.js';

/** Deepest directory level the file tree shows (the root's files are level 1). */
export const TREE_DEPTH = 3;
/** Most entries of the file tree; the rest is counted, not listed. */
export const MAX_TREE_ENTRIES = 300;
/** Longest file content sent; longer files are cut, with a marker. */
export const MAX_DOCUMENT_CHARS = 8_000;
/** Longest README excerpt sent. */
export const MAX_README_CHARS = 6_000;
/** Most `package.json` files sent (root and app root first). */
const MAX_PACKAGE_JSONS = 6;

/** README headings whose sections explain how to set up and run the app. */
const SETUP_HEADING =
  /setup|set up|install|getting started|quick ?start|develop|running|\brun\b|environment|\benv\b|config|start|prerequisite|deploy/i;
const ENV_EXAMPLE = /^\.env\.(example|sample|template|local\.example|dist)$/;
const README = /^readme(\.md|\.mdx|\.txt)?$/i;

/** One repository file as the repair prompt shows it. */
export interface ContextDocument {
  readonly path: string;
  readonly content: string;
}

/** What the repair loop shows the LLM about the repository. */
export interface RepairRepoContext {
  /** Files and directories up to {@link TREE_DEPTH} levels, at most {@link MAX_TREE_ENTRIES}. */
  readonly tree: readonly string[];
  /** Entries left out of `tree`. */
  readonly treeCut: number;
  /** `package.json` files, example env files and the README's setup sections. */
  readonly documents: readonly ContextDocument[];
}

/** Whether the repair loop reads `file`: what recipe detection reads, plus READMEs. */
export function isRepairContextFile(file: string): boolean {
  return isRelevantFile(file) || README.test(path.posix.basename(file));
}

/**
 * The repository as the repair prompt shows it: a depth-limited file tree; the `package.json` of
 * the root, the app root and other packages; example env files and the README setup sections of
 * the root and the app root. Real `.env` files are never read. Pure.
 */
export function repairRepoContext(files: RepoFiles, appRoot: string): RepairRepoContext {
  const entries = fileTree(files.list);
  const tree = entries.slice(0, MAX_TREE_ENTRIES);

  const dirs = [...new Set(['.', appRoot])];
  const packageJsons = [
    ...dirs.map((dir) => inDir(dir, 'package.json')),
    ...files.list.filter(
      (file) => path.posix.basename(file) === 'package.json' && file.split('/').length <= 3,
    ),
  ];
  const documents: ContextDocument[] = [];
  for (const file of [...new Set(packageJsons)].slice(0, MAX_PACKAGE_JSONS)) {
    pushDocument(documents, files, file, MAX_DOCUMENT_CHARS);
  }
  for (const dir of dirs) {
    for (const file of files.list.filter(
      (entry) => path.posix.dirname(entry) === dir && ENV_EXAMPLE.test(path.posix.basename(entry)),
    )) {
      pushDocument(documents, files, file, MAX_DOCUMENT_CHARS);
    }
    const readme = files.list.find(
      (entry) => path.posix.dirname(entry) === dir && README.test(path.posix.basename(entry)),
    );
    const text = readme === undefined ? undefined : files.read(readme);
    if (readme !== undefined && text !== undefined) {
      documents.push({ path: readme, content: readmeSetupSections(text) });
    }
  }
  return { tree, treeCut: entries.length - tree.length, documents };
}

/**
 * The sections of a Markdown README whose heading is about setup, installing, configuration or
 * running; the start of the README when no heading matches. At most {@link MAX_README_CHARS}. Pure.
 */
export function readmeSetupSections(markdown: string): string {
  const sections: string[][] = [];
  let current: string[] | undefined;
  for (const line of markdown.split('\n')) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading !== null) {
      current = SETUP_HEADING.test(heading[1] ?? '') ? [line] : undefined;
      if (current !== undefined) {
        sections.push(current);
      }
    } else {
      current?.push(line);
    }
  }
  const text =
    sections.length > 0 ? sections.map((lines) => lines.join('\n').trim()).join('\n\n') : markdown;
  return cut(text.trim(), MAX_README_CHARS);
}

/** Every file and directory up to {@link TREE_DEPTH} levels deep, directories with a `/`. */
function fileTree(list: readonly string[]): string[] {
  const entries = new Set<string>();
  for (const file of list) {
    const parts = file.split('/');
    for (let depth = 1; depth <= Math.min(parts.length, TREE_DEPTH); depth++) {
      const isDir = depth < parts.length;
      entries.add(`${parts.slice(0, depth).join('/')}${isDir ? '/' : ''}`);
    }
  }
  return [...entries].sort();
}

function pushDocument(
  documents: ContextDocument[],
  files: RepoFiles,
  file: string,
  maxChars: number,
): void {
  const content = files.read(file);
  if (content !== undefined) {
    documents.push({ path: file, content: cut(content, maxChars) });
  }
}

function cut(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (cut by bdiff)` : text;
}
