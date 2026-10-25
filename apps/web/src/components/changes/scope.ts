import { lazy } from 'react';
import type { ReviewView } from '@/lib/review';

/** Which diff a comment is made on, and the commit its lines are read at. */
export interface DiffScope {
  roundUpId: string;
  view: ReviewView;
  /** The agent, for its own diff. */
  viewSessionId?: string;
  /** The diff's new side (`Changes.headSha`). */
  commitSha?: string;
}

/** The diff renderer and its highlighter are big: they load with the first diff shown. */
export const LazyDiffView = lazy(() => import('./diff-view'));
