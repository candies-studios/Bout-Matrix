import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, friendlyError } from './supabase';
import type { Access } from './access';

interface AuthState {
  session: Session | null;
  access: Access | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
  refreshAccess: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [access, setAccess] = useState<Access | null>(null);
  const [loading, setLoading] = useState(true);

  // Access is always fetched from the server (my_access RPC), never derived from local claims.
  const loadAccess = useCallback(async (s: Session | null) => {
    if (!s) {
      setAccess(null);
      return;
    }
    const { data, error } = await supabase.rpc('my_access');
    setAccess(error ? null : (data as Access | null));
  }, []);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSession(data.session);
      await loadAccess(data.session);
      if (active) setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      // Defer the RPC so it does not run inside the auth callback.
      setTimeout(() => void loadAccess(s), 0);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [loadAccess]);

  const value = useMemo<AuthState>(
    () => ({
      session,
      access,
      loading,
      signIn: async (email, password) => {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) return /invalid/i.test(error.message) ? 'Incorrect email or password.' : friendlyError(error);
        await loadAccess(data.session);
        return null;
      },
      signOut: async () => {
        await supabase.auth.signOut();
        setAccess(null);
      },
      refreshAccess: () => loadAccess(session),
    }),
    [session, access, loading, loadAccess],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- hook colocated with its provider
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

// eslint-disable-next-line react-refresh/only-export-components -- exported for tests
export { AuthContext };
