import { lazy, Suspense, type FC } from 'react';
import { createBrowserRouter, Navigate, Outlet } from 'react-router';
import { AdminLayout } from '@/layouts/AdminLayout';
import { PublicLayout } from '@/layouts/PublicLayout';
import { RequireAdmin } from '@/routes/RequireAdmin';
import { AdminLogin } from '@/pages/admin/AdminLogin';
import { NotFound } from '@/pages/NotFound';
import { Spinner } from '@/components/ui';
import { importWithReload } from '@/lib/staleBuild';

// Route-level code splitting: public visitors never download admin code.
function page<K extends string>(loader: () => Promise<Record<K, FC>>, name: K) {
  const load = importWithReload(loader);
  // eslint-disable-next-line react-refresh/only-export-components -- route table, not a hot-reloaded module
  const C = lazy(async () => ({ default: (await load())[name] as FC }));
  return (
    <Suspense fallback={<div className="flex justify-center py-16"><Spinner /></div>}>
      <C />
    </Suspense>
  );
}

export const routes = [
  { path: '/', element: <Navigate to="/events" replace /> },
  {
    element: <PublicLayout />,
    children: [
      { path: '/register', element: page(() => import('@/pages/register/RegisterLanding'), 'RegisterLanding') },
      { path: '/register/fighter', element: page(() => import('@/pages/register/FighterRegistration'), 'FighterRegistration') },
      { path: '/register/coach', element: page(() => import('@/pages/register/CoachRegistration'), 'CoachRegistration') },
      { path: '/register/success', element: page(() => import('@/pages/register/RegisterSuccess'), 'RegisterSuccess') },
      { path: '/offers/:offerToken', element: page(() => import('@/pages/public/OfferPage'), 'OfferPage') },
      { path: '/events', element: page(() => import('@/pages/public/EventsList'), 'EventsList') },
      { path: '/events/:eventSlug', element: page(() => import('@/pages/public/EventPage'), 'EventPage') },
      { path: '/events/:eventSlug/fight-card', element: page(() => import('@/pages/public/FightCardPage'), 'FightCardPage') },
      { path: '/coach', element: page(() => import('@/pages/coach/CoachPortal'), 'CoachPortal') },
    ],
  },
  { path: '/admin/login', element: <AdminLogin /> },
  {
    path: '/admin',
    element: (
      <RequireAdmin>
        <Outlet />
      </RequireAdmin>
    ),
    children: [
      {
        element: <AdminLayout />,
        children: [
          { index: true, element: <Navigate to="dashboard" replace /> },
          { path: 'dashboard', element: page(() => import('@/pages/admin/Dashboard'), 'Dashboard') },
          { path: 'fighters', element: page(() => import('@/pages/admin/FightersAdmin'), 'FightersAdmin') },
          { path: 'fighters/:fighterId', element: page(() => import('@/pages/admin/FighterDetail'), 'FighterDetail') },
          { path: 'coaches', element: page(() => import('@/pages/admin/CoachesAdmin'), 'CoachesAdmin') },
          { path: 'gyms', element: page(() => import('@/pages/admin/GymsAdmin'), 'GymsAdmin') },
          { path: 'events', element: page(() => import('@/pages/admin/EventsAdmin'), 'EventsAdmin') },
          { path: 'events/:eventId', element: page(() => import('@/pages/admin/EventDetail'), 'EventDetail') },
          { path: 'matchmaking', element: page(() => import('@/pages/admin/Matchmaking'), 'Matchmaking') },
          { path: 'bouts', element: page(() => import('@/pages/admin/Bouts'), 'Bouts') },
          { path: 'fight-cards', element: page(() => import('@/pages/admin/FightCards'), 'FightCards') },
          { path: 'emails', element: page(() => import('@/pages/admin/Emails'), 'Emails') },
          { path: 'audit-logs', element: page(() => import('@/pages/admin/AuditLogs'), 'AuditLogs') },
          { path: 'settings', element: page(() => import('@/pages/admin/Settings'), 'Settings') },
          { path: 'account', element: page(() => import('@/pages/admin/Account'), 'Account') },
        ],
      },
    ],
  },
  { path: '*', element: <NotFound /> },
];

// BASE_URL is '/' normally and '/Bout-Matrix/' on GitHub Pages.
export const basename = import.meta.env.BASE_URL.replace(/\/$/, '') || '/';
export const router = createBrowserRouter(routes, { basename });
