import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router';
import { z } from 'zod';
import { useAuth } from '@/lib/auth';
import { isAdminUser } from '@/lib/access';
import { Alert, Button, Card, Field, Input } from '@/components/ui';

const LoginSchema = z.object({
  email: z.email('Enter a valid email address.'),
  password: z.string().min(8, 'Password must be at least 8 characters.'),
});

export function AdminLogin() {
  const { session, access, loading, signIn, signOut } = useAuth();
  const location = useLocation();
  const state = (location.state ?? {}) as { from?: string; denied?: boolean };
  const [errors, setErrors] = useState<Partial<Record<'email' | 'password', string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!loading && session && isAdminUser(access)) {
    return <Navigate to={state.from ?? '/admin/dashboard'} replace />;
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    const parsed = LoginSchema.safeParse(data);
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [i.path[0], i.message])));
      return;
    }
    setErrors({});
    setSubmitting(true);
    setFormError(await signIn(parsed.data.email, parsed.data.password));
    setSubmitting(false);
  }

  const signedInWithoutAccess = !loading && session && !isAdminUser(access);

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <h1 className="mb-1 text-3xl font-bold uppercase">
          Admin <span className="text-accent-500">sign in</span>
        </h1>
        <p className="mb-6 text-sm text-ink-400">Accounts are created by an organisation administrator.</p>

        {signedInWithoutAccess ? (
          <div className="flex flex-col gap-4">
            <Alert tone="warn">
              {session.user.email} is signed in but has no administrator access. Ask an organisation administrator to assign
              you a role.
            </Alert>
            <Button variant="secondary" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        ) : (
          <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
            {formError && <Alert>{formError}</Alert>}
            <Field label="Email" required error={errors.email}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} name="email" type="email" autoComplete="email" aria-describedby={describedBy} aria-invalid={invalid} />
              )}
            </Field>
            <Field label="Password" required error={errors.password}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                />
              )}
            </Field>
            <Button type="submit" loading={submitting}>
              Sign in
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
