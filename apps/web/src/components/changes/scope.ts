import { lazy } from 'react';

export type { DiffScope } from '@/lib/review';

/** The diff renderer and its highlighter are big: they load with the first diff shown. */
export const LazyDiffView = lazy(() => import('./diff-view'));
