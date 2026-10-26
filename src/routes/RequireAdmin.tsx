import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from '@/lib/auth';
import { isAdminUser } from '@/lib/access';
import { Spinner } from '@/components/ui';

/**
 * UI gate only. It hides the admin portal from users the server says are not admins;
 * every query behind it is still authorised by RLS and RPC checks in the database.
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { session, access, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner label="Checking your session" />
      </div>
    );
  }
  if (!session) {
    return <Navigate to="/admin/login" replace state={{ from: location.pathname }} />;
  }
  if (!isAdminUser(access)) {
    return <Navigate to="/admin/login" replace state={{ denied: true }} />;
  }
  return <>{children}</>;
}
