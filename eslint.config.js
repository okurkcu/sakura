import js from '@eslint/js';
import { recommended as eslintCommentsRecommended } from '@eslint-community/eslint-plugin-eslint-comments/configs';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import { createNodeResolver, importX } from 'eslint-plugin-import-x';
import globals from 'globals';
import { configs as tseslintConfigs } from 'typescript-eslint';

/**
 * Package boundaries. `core` is the engine and must stay independent of its consumers;
 * `report` may only depend on `core`. `cli` is the composition root and may import anything.
 * Enforced twice: by package name (clear message) and by resolved path (catches relative imports).
 */
const boundaryMessage = (pkg, forbidden) =>
  `${pkg} must not import from ${forbidden}. See "Architecture" in CLAUDE.md.`;

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '.bdiff/**',
      // The fixture app is a separate Next.js project with its own toolchain.
      'fixtures/sample-next-app/**',
      'fixtures/branches/**',
    ],
  },

  js.configs.recommended,
  tseslintConfigs.strictTypeChecked,
  tseslintConfigs.stylisticTypeChecked,
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  eslintCommentsRecommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      'import-x/resolver-next': [
        createTypeScriptImportResolver({
          conditionNames: ['bdiff-source', 'types', 'import', 'node', 'default'],
        }),
        createNodeResolver(),
      ],
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // Every eslint-disable (e.g. for a non-null assertion) must say why.
      '@eslint-community/eslint-comments/require-description': 'error',
      '@eslint-community/eslint-comments/disable-enable-pair': ['error', { allowWholeFile: true }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'import-x/consistent-type-specifier-style': ['error', 'prefer-top-level'],
      'import-x/no-cycle': 'error',
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', ['parent', 'sibling', 'index']],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
    },
  },

  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-console': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@bdiff/cli', '@bdiff/cli/*'],
              message: boundaryMessage('@bdiff/core', '@bdiff/cli'),
            },
            {
              group: ['@bdiff/report', '@bdiff/report/*'],
              message: boundaryMessage('@bdiff/core', '@bdiff/report'),
            },
          ],
        },
      ],
      'import-x/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './packages/core',
              from: ['./packages/cli', './packages/report'],
              message: boundaryMessage('@bdiff/core', '@bdiff/cli or @bdiff/report'),
            },
          ],
        },
      ],
    },
  },

  {
    files: ['packages/report/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@bdiff/cli', '@bdiff/cli/*'],
              message: boundaryMessage('@bdiff/report', '@bdiff/cli'),
            },
          ],
        },
      ],
      'import-x/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './packages/report',
              from: './packages/cli',
              message: boundaryMessage('@bdiff/report', '@bdiff/cli'),
            },
          ],
        },
      ],
    },
  },

  {
    files: ['**/*.js'],
    extends: [tseslintConfigs.disableTypeChecked],
  },

  prettier,
);
