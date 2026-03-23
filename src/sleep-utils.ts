/** Utilities for the sleep pipeline — extracted for testability. */

/**
 * Build platform-specific spawn command for invoking copilot with a prompt file.
 * Windows uses pwsh.exe + Get-Content; Unix uses /bin/sh + cat.
 */
export function buildSpawnCommand(
  platform: string,
  promptFile: string,
): { command: string; args: string[] } {
  if (platform === 'win32') {
    const cmd = `copilot -p (Get-Content -Raw '${promptFile}') --disable-builtin-mcps`;
    return { command: 'pwsh.exe', args: ['-NoProfile', '-NoLogo', '-Command', cmd] };
  }
  const cmd = `copilot -p "$(cat '${promptFile}')" --disable-builtin-mcps`;
  return { command: '/bin/sh', args: ['-c', cmd] };
}
