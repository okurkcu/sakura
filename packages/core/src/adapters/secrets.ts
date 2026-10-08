/**
 * Environment variables that hold bdiff's own credentials. They are stripped from child process
 * environments and redacted from logs.
 */
export const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN'] as const;
