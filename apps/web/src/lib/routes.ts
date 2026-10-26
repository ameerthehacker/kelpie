import { matchRoutes } from 'react-router';
import { ROUND_UP_ROUTE } from './round-ups.js';
import { WORKBENCH_ROUTE } from './workbench.js';

/** Kelpie's pages, as main.tsx mounts them; any other path redirects home. */
export const APP_PATHS = ['/', ROUND_UP_ROUTE, '/approvals', '/workbench', WORKBENCH_ROUTE, '/settings'];

const appRoutes = APP_PATHS.map((path) => ({ path }));

/** Whether `pathname` is one of Kelpie's pages. */
export const isAppPath = (pathname: string) => !!matchRoutes(appRoutes, pathname);
