import type { Exec } from '@bdiff/core';

/** Every container, network and volume of a compose project still present, as Docker ids. */
export async function composeLeftovers(
  exec: Exec,
  project: string,
  signal: AbortSignal,
): Promise<string[]> {
  const filter = `label=com.docker.compose.project=${project}`;
  const found: string[] = [];
  for (const args of [
    ['ps', '--all', '--quiet', '--filter', filter],
    ['network', 'ls', '--quiet', '--filter', filter],
    ['volume', 'ls', '--quiet', '--filter', filter],
  ]) {
    const result = await exec.run('docker', args, { timeoutMs: 30_000, signal });
    found.push(...result.stdout.split('\n').filter((line) => line.trim() !== ''));
  }
  return found;
}
