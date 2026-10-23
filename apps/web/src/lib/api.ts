export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A JSON call to the daemon. Writes always send JSON: the daemon refuses anything else (CSRF guard). */
export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const write = method !== 'GET' && method !== 'HEAD';
  const res = await fetch(url, {
    method,
    ...(write ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}),
  });
  const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(json.error ?? `${res.status} ${res.statusText}`, res.status);
  return json as T;
}

export const isGone = (err: unknown) => err instanceof HttpError && err.status === 404;
