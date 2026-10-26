import { Link } from 'react-router';

export function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-5xl font-bold uppercase">Not found</h1>
      <p className="text-ink-400">That page does not exist or is not public.</p>
      <Link to="/events" className="text-accent-400 underline-offset-2 hover:underline">
        Back to events
      </Link>
    </div>
  );
}
