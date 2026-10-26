import { Link, NavLink, Outlet } from 'react-router';
import { cx } from '@/lib/cx';

export function PublicLayout() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-ink-700 bg-ink-950/95">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <Link to="/events" className="font-display text-2xl font-bold uppercase tracking-wide">
            Fight <span className="text-accent-500">Night</span>
          </Link>
          <nav aria-label="Main" className="flex gap-1 text-sm">
            {[
              ['/events', 'Events'],
              ['/register', 'Register'],
            ].map(([to, label]) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  cx('rounded-md px-3 py-2 font-medium', isActive ? 'text-ink-100' : 'text-ink-400 hover:text-ink-100')
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
        <Outlet />
      </main>
      <footer className="border-t border-ink-700 py-6 text-center text-xs text-ink-400">
        Fight cards show confirmed, published bouts only. ·{' '}
        <Link to="/coach" className="underline-offset-2 hover:underline">
          Coach portal
        </Link>
      </footer>
    </div>
  );
}
