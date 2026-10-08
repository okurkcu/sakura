/** The base branch of the fixture repo. */
export const BASE_BRANCH = 'main';

/** The fixture's pull request branches, each with a known expected behavior change. */
export const PR_BRANCHES = [
  'pr/ui-change',
  'pr/api-breaking',
  'pr/refactor-no-change',
  'pr/docs-only',
] as const;

export type PrBranch = (typeof PR_BRANCHES)[number];
export type FixtureBranch = typeof BASE_BRANCH | PrBranch;

/** How a PR branch is made from `main`. */
export interface BranchSpec {
  readonly branch: PrBranch;
  /** Directory under `fixtures/branches/` whose files are copied over `main`, replacing or adding. */
  readonly overlay: string;
  /** Files of `main` removed on this branch, relative to the app root. */
  readonly deletes: readonly string[];
  readonly message: string;
}

/** Every PR branch, in the order they are created. */
export const BRANCH_SPECS: readonly BranchSpec[] = [
  {
    branch: 'pr/ui-change',
    overlay: 'ui-change',
    deletes: [],
    message: 'Add "Continue with Google" to the login page',
  },
  {
    branch: 'pr/api-breaking',
    overlay: 'api-breaking',
    deletes: [],
    message: 'Format the latest order total and include its currency',
  },
  {
    branch: 'pr/refactor-no-change',
    overlay: 'refactor-no-change',
    deletes: ['lib/orders.ts'],
    message: 'Move order helpers into an order repository module',
  },
  {
    branch: 'pr/docs-only',
    overlay: 'docs-only',
    deletes: [],
    message: 'Document the pages in the README',
  },
];
