import type { Attachment } from '@kelpie/protocol';
export { fileSize } from '@kelpie/protocol';
import { HttpError } from '@/lib/api';

/** An upload the daemon has stored, ready to send in a message's `attachments`. */
export type Upload = Attachment & { id: string };

/** Files already uploaded, per round-up: a message re-sent after a failure doesn't upload them twice. */
const uploaded = new WeakMap<File, Map<string, Promise<Upload>>>();

/**
 * Uploads a file to a round-up's scratch folder, once per file and round-up (a failed upload is tried
 * again next time). The body is the raw bytes (the daemon only takes
 * JSON or octet-stream writes, its CSRF guard); the name goes URI-encoded in a header.
 */
export function uploadFile(sessionId: string, file: File): Promise<Upload> {
  const bySession = uploaded.get(file) ?? new Map<string, Promise<Upload>>();
  uploaded.set(file, bySession);
  let upload = bySession.get(sessionId);
  if (!upload) {
    upload = send(sessionId, file);
    bySession.set(sessionId, upload);
    upload.catch(() => bySession.delete(sessionId));
  }
  return upload;
}

async function send(sessionId: string, file: File): Promise<Upload> {
  const res = await fetch(`/api/sessions/${sessionId}/uploads`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent(file.name || 'file'),
      ...(file.type ? { 'x-file-type': file.type } : {}),
    },
    body: file,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(`Couldn't upload ${file.name}: ${json.error ?? `${res.status} ${res.statusText}`}`, res.status);
  return json as Upload;
}

/** Where an upload can be fetched (images and PDFs show in place, anything else downloads). */
export const uploadUrl = (sessionId: string, id: string) => `/api/sessions/${sessionId}/uploads/${id}`;

/** Images the browser can show as a thumbnail (SVG is downloaded, never shown). */
export function isImage(mime: string | undefined): boolean {
  const m = mime?.toLowerCase();
  return !!m?.startsWith('image/') && m !== 'image/svg+xml';
}
