import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ArtifactDocumentBody, Artifacts } from '@kelpie/protocol';
import { api } from '@/lib/api';
import { ARTIFACTS, artifactsKey } from '@/lib/artifacts';

/**
 * A round-up's documents (the Markdown files in its scratch folder) and what the person accepted.
 * Refetched when an agent goes idle (the stream's `changes`), and polled while agents work, as
 * files can land at any time.
 */
export function useArtifacts(roundUpId: string | undefined, { working = false }: { working?: boolean } = {}) {
  return useQuery({
    queryKey: artifactsKey(roundUpId),
    queryFn: () => api<Artifacts>('GET', `/api/sessions/${roundUpId}/artifacts`),
    enabled: !!roundUpId,
    refetchInterval: working ? 15_000 : false,
  });
}

/** One document with its text. */
export function useArtifactDocument(roundUpId: string, path: string) {
  return useQuery({
    queryKey: [ARTIFACTS, roundUpId, 'document', path],
    queryFn: () => api<ArtifactDocumentBody>('GET', `/api/sessions/${roundUpId}/artifacts/document?${new URLSearchParams({ path })}`),
  });
}

/** Records the person's Accept (an `artifactKey`), and puts the list the daemon answers with in place. */
export function useAcceptArtifact(roundUpId: string) {
  const queryClient = useQueryClient();
  return (key: string) =>
    api<Artifacts>('POST', `/api/sessions/${roundUpId}/artifacts/accept`, { key }).then((list) => {
      queryClient.setQueryData(artifactsKey(roundUpId), list);
      void queryClient.invalidateQueries({ queryKey: [ARTIFACTS, roundUpId, 'document'] });
    });
}
