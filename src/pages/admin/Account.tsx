import { useAuth } from '@/lib/auth';
import { PageHeader } from '@/components/ui';
import { Section } from '@/components/more';
import { PasswordForm } from '@/components/PasswordForm';

export function Account() {
  const { session } = useAuth();
  return (
    <div>
      <PageHeader title="Your account" description={session?.user.email} />
      <Section title="Password">
        <PasswordForm />
      </Section>
    </div>
  );
}
