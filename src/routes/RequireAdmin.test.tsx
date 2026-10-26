import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { Session } from '@supabase/supabase-js';
import { AuthContext } from '@/lib/auth';
import type { Access } from '@/lib/access';
import { RequireAdmin } from './RequireAdmin';

function renderWith(session: Session | null, access: Access | null) {
  const router = createMemoryRouter(
    [
      { path: '/admin/login', element: <p>login page</p> },
      { path: '/admin/dashboard', element: <RequireAdmin><p>secret dashboard</p></RequireAdmin> },
    ],
    { initialEntries: ['/admin/dashboard'] },
  );
  render(
    <AuthContext.Provider
      value={{ session, access, loading: false, signIn: async () => null, signOut: async () => {}, refreshAccess: async () => {} }}
    >
      <RouterProvider router={router} />
    </AuthContext.Provider>,
  );
}

const session = { user: { email: 'a@b.co' } } as unknown as Session;
const base: Access = { user_id: 'u', is_super_admin: false, org_roles: [], event_roles: [], coach_id: null };

describe('RequireAdmin', () => {
  it('redirects anonymous visitors to the login page', () => {
    renderWith(null, null);
    expect(screen.getByText('login page')).toBeInTheDocument();
  });
  it('redirects signed-in users without an admin role (e.g. coaches)', () => {
    renderWith(session, { ...base, org_roles: [{ org_id: 'o', role: 'coach' }] });
    expect(screen.queryByText('secret dashboard')).toBeNull();
  });
  it('redirects staff with no event assignment', () => {
    renderWith(session, { ...base, org_roles: [{ org_id: 'o', role: 'staff' }] });
    expect(screen.queryByText('secret dashboard')).toBeNull();
  });
  it('admits org admins and assigned event staff', () => {
    renderWith(session, { ...base, org_roles: [{ org_id: 'o', role: 'org_admin' }] });
    expect(screen.getByText('secret dashboard')).toBeInTheDocument();
  });
});
