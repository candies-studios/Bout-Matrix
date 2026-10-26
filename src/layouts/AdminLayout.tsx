import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { useAuth } from '@/lib/auth';
import { isOrgAdmin } from '@/lib/access';
import { Button } from '@/components/ui';
import { cx } from '@/lib/cx';

const NAV: { to: string; label: string; orgAdminOnly?: boolean }[] = [
  { to: '/admin/dashboard', label: 'Dashboard' },
  { to: '/admin/events', label: 'Events' },
  { to: '/admin/fighters', label: 'Fighters' },
  { to: '/admin/coaches', label: 'Coaches' },
  { to: '/admin/gyms', label: 'Gyms' },
  { to: '/admin/matchmaking', label: 'Matchmaking' },
  { to: '/admin/bouts', label: 'Bouts' },
  { to: '/admin/fight-cards', label: 'Fight cards' },
  { to: '/admin/emails', label: 'Emails' },
  { to: '/admin/audit-logs', label: 'Audit log', orgAdminOnly: true },
  { to: '/admin/settings', label: 'Settings', orgAdminOnly: true },
];

export function AdminLayout() {
  const { access, session, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const items = NAV.filter((n) => !n.orgAdminOnly || isOrgAdmin(access));

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[240px_1fr]">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-ink-800 focus:p-2">
        Skip to content
      </a>
      <header className="flex items-center justify-between border-b border-ink-700 bg-ink-900 px-4 py-3 lg:hidden">
        <span className="font-display text-xl font-bold uppercase">Fight Desk</span>
        <Button variant="secondary" aria-expanded={open} aria-controls="admin-nav" onClick={() => setOpen((v) => !v)}>
          Menu
        </Button>
      </header>
      <aside
        id="admin-nav"
        className={cx('border-r border-ink-700 bg-ink-900 lg:block lg:min-h-dvh', open ? 'block' : 'hidden')}
      >
        <div className="hidden px-5 py-5 lg:block">
          <span className="font-display text-2xl font-bold uppercase">
            Fight <span className="text-accent-500">Desk</span>
          </span>
        </div>
        <nav aria-label="Admin" className="flex flex-col px-2 pb-4">
          {items.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                cx(
                  'rounded-md border-l-2 px-3 py-2.5 text-sm font-medium',
                  isActive ? 'border-accent-500 bg-ink-800 text-ink-100' : 'border-transparent text-ink-400 hover:bg-ink-850 hover:text-ink-100',
                )
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-ink-700 px-5 py-4 text-sm">
          <p className="truncate text-ink-400" title={session?.user.email}>
            {session?.user.email}
          </p>
          <button className="mt-2 text-ink-300 underline-offset-2 hover:underline" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </aside>
      <main id="main" className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-8 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}
