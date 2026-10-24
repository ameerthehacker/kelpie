/**
 * Sessions run a coding agent that can execute shell commands, so only local callers may
 * drive the daemon: Host must be a loopback name (defeats DNS rebinding), and any Origin
 * must be local (defeats cross-site requests).
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export const isLocalHost = (hostHeader: string | undefined) => LOCAL_HOSTS.has((hostHeader ?? '').replace(/:\d+$/, ''));

export function isLocalOrigin(origin: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}
