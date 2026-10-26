import { createBrowserRouter, Navigate, Outlet } from 'react-router';
import { AdminLayout } from '@/layouts/AdminLayout';
import { PublicLayout } from '@/layouts/PublicLayout';
import { RequireAdmin } from '@/routes/RequireAdmin';
import { AdminLogin } from '@/pages/admin/AdminLogin';
import { Dashboard } from '@/pages/admin/Dashboard';
import { Planned } from '@/pages/Planned';
import { NotFound } from '@/pages/NotFound';

export const routes = [
  { path: '/', element: <Navigate to="/events" replace /> },
  {
    element: <PublicLayout />,
    children: [
      { path: '/register', element: <Planned title="Register" phase={3} /> },
      { path: '/register/fighter', element: <Planned title="Fighter registration" phase={3} /> },
      { path: '/register/coach', element: <Planned title="Coach registration" phase={3} /> },
      { path: '/register/success', element: <Planned title="Registration received" phase={3} /> },
      { path: '/offers/:offerToken', element: <Planned title="Bout offer" phase={6} /> },
      { path: '/events', element: <Planned title="Events" phase={7} /> },
      { path: '/events/:eventSlug', element: <Planned title="Event" phase={7} /> },
      { path: '/events/:eventSlug/fight-card', element: <Planned title="Fight card" phase={7} /> },
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
          { path: 'dashboard', element: <Dashboard /> },
          { path: 'fighters', element: <Planned title="Fighters" phase={3} /> },
          { path: 'coaches', element: <Planned title="Coaches" phase={3} /> },
          { path: 'gyms', element: <Planned title="Gyms" phase={3} /> },
          { path: 'events', element: <Planned title="Events" phase={4} /> },
          { path: 'matchmaking', element: <Planned title="Matchmaking" phase={5} /> },
          { path: 'bouts', element: <Planned title="Bouts" phase={6} /> },
          { path: 'fight-cards', element: <Planned title="Fight cards" phase={7} /> },
          { path: 'emails', element: <Planned title="Emails" phase={6} /> },
          { path: 'audit-logs', element: <Planned title="Audit log" phase={7} /> },
          { path: 'settings', element: <Planned title="Settings" phase={7} /> },
        ],
      },
    ],
  },
  { path: '*', element: <NotFound /> },
];

export const router = createBrowserRouter(routes);
