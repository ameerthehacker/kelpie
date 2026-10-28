import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ArtifactDocumentBody, Artifacts } from '@kelpie/protocol';
import { api } from '@/lib/api';
import { artifactsKey, documentKey } from '@/lib/artifacts';

/**
 * A round-up's documents (the Markdown files in its scratch folder) and what the person accepted.
 * Refetched when a file there is written (the stream's `artifacts`).
 */
export function useArtifacts(roundUpId: string | undefined) {
  return useQuery({
    queryKey: artifactsKey(roundUpId),
    queryFn: () => api<Artifacts>('GET', `/api/sessions/${roundUpId}/artifacts`),
    enabled: !!roundUpId,
  });
}

/** One document with its text; refetched when it is written again (the stream's `artifacts`). */
export function useArtifactDocument(roundUpId: string, path: string) {
  return useQuery({
    queryKey: documentKey(roundUpId, path),
    queryFn: () => api<ArtifactDocumentBody>('GET', `/api/sessions/${roundUpId}/artifacts/document?${new URLSearchParams({ path })}`),
  });
}

/**
 * Records the person's Accept (an `artifactKey`; for a document, `seen` is the `updatedAt` they
 * read), and puts the list the daemon answers with in place. Refused when it moved on since: then
 * the list and the document are fetched again, to show what it is now.
 */
export function useAcceptArtifact(roundUpId: string) {
  const queryClient = useQueryClient();
  return (key: string, seen?: number) =>
    api<Artifacts>('POST', `/api/sessions/${roundUpId}/artifacts/accept`, { key, ...(seen !== undefined ? { seen } : {}) }).then(
      (list) => queryClient.setQueryData(artifactsKey(roundUpId), list),
      (err: unknown) => {
        void queryClient.invalidateQueries({ queryKey: artifactsKey(roundUpId), exact: true });
        if (key.startsWith('doc:')) void queryClient.invalidateQueries({ queryKey: documentKey(roundUpId, key.slice(4)), exact: true });
        throw err;
      },
    );
}
