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

/**
 * Branches that are not pull requests of the shop but variants of it, for features that need a
 * differently built app. They have no entry in `expected.json`.
 */
export const VARIANT_BRANCHES = ['variant/needs-repair', 'variant/needs-repair-change'] as const;
export type VariantBranch = (typeof VARIANT_BRANCHES)[number];

export type FixtureBranch = typeof BASE_BRANCH | PrBranch | VariantBranch;

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

/** How a variant branch is made: one overlay on top of another branch, in one commit. */
export interface VariantSpec {
  readonly branch: VariantBranch;
  readonly from: typeof BASE_BRANCH | VariantBranch;
  /** Directory under `fixtures/branches/` whose files are copied over `from`. */
  readonly overlay: string;
  readonly message: string;
}

/**
 * Every variant branch, in the order they are created (after the PR branches).
 *
 * `variant/needs-repair` is the shop as a repository whose setup bdiff's detected recipe gets wrong:
 * the build needs `SESSION_SECRET`, which only the README mentions (no example env file), and the
 * app refuses `next start` because it must run on its own server (`pnpm start`, `node server.mjs`).
 * The setup repair loop must fix both. `variant/needs-repair-change` is a pull request on top of it
 * that moves the order helpers without changing behavior (the `refactor-no-change` overlay, the old
 * module left in place), so bdiff can run base and head with the same repaired recipe and the run
 * needs the LLM for nothing but the repair.
 */
export const VARIANT_SPECS: readonly VariantSpec[] = [
  {
    branch: 'variant/needs-repair',
    from: BASE_BRANCH,
    overlay: 'needs-repair',
    message: "Require a session secret and run on the shop's own server",
  },
  {
    branch: 'variant/needs-repair-change',
    from: 'variant/needs-repair',
    overlay: 'refactor-no-change',
    message: 'Move order helpers into an order repository module',
  },
];
