import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import './index.css';
import { App } from './App';
import { Toaster } from './components/ui/sonner';
import { APP_PATHS } from './lib/routes';
import { initTheme } from './lib/theme';

initTheme();

// `/` (a new round-up) and `/r/:roundUpId` share one mounted App, so creating a round-up from `/`
// and moving to its URL keeps the conversation (and the message being sent) on screen.
const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: APP_PATHS.map((path) => (path === '/' ? { index: true, element: null } : { path, element: null })),
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);

// Round-up data is kept fresh by the daemon's event stream, not by refetching.
const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: 1 } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* Motion follows the person's reduced-motion setting: no movement, fades only. */}
      <MotionConfig reducedMotion="user">
        <RouterProvider router={router} />
        <Toaster position="bottom-center" />
      </MotionConfig>
    </QueryClientProvider>
  </StrictMode>,
);
