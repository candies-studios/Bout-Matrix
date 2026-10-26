import { useAuth } from '@/lib/auth';
import { isOrgAdmin } from '@/lib/access';
import { Badge, Card, PageHeader } from '@/components/ui';

export function Dashboard() {
  const { access, session } = useAuth();
  return (
    <div>
      <PageHeader title="Dashboard" description={`Signed in as ${session?.user.email ?? ''}`} />
      <Card>
        <h2 className="mb-3 text-xl font-semibold uppercase">Your access</h2>
        <div className="flex flex-wrap gap-2">
          {access?.is_super_admin && <Badge tone="danger">Super admin</Badge>}
          {isOrgAdmin(access) && <Badge tone="ok">Organisation admin</Badge>}
          {access?.event_roles.map((r) => (
            <Badge key={r.event_id} tone="info">
              {r.role === 'event_admin' ? 'Event admin' : 'Matchmaker'} · {r.event_id.slice(0, 8)}
            </Badge>
          ))}
        </div>
        <p className="mt-4 text-sm text-ink-400">
          Overview metrics (registrations, offers, confirmed bouts, email failures) are added in phase 7.
        </p>
      </Card>
    </div>
  );
}
