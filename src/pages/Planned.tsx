import { EmptyState, PageHeader } from '@/components/ui';

/**
 * Explicit marker for a route whose feature is scheduled for a later build phase.
 * Tracked in docs/CHECKLIST.md — never shipped to production as a final state.
 */
export function Planned({ title, phase }: { title: string; phase: number }) {
  return (
    <div>
      <PageHeader title={title} />
      <EmptyState title={`Arrives in phase ${phase}`}>
        The database, permissions and audit trail for this area are in place; the screen is built in phase {phase}.
      </EmptyState>
    </div>
  );
}
