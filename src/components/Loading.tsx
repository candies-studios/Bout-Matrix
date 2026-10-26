import { Alert, Spinner } from './ui';

export function Loading({ loading, error, children }: { loading: boolean; error: string | null; children: React.ReactNode }) {
  if (error) return <Alert>{error}</Alert>;
  if (loading)
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  return <>{children}</>;
}
