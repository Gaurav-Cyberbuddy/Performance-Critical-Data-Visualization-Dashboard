'use client';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="dashboard-error" role="alert">
      <h2>Dashboard failed to load</h2>
      <p>{error.message || 'An unexpected error occurred.'}</p>
      <button type="button" className="regen-btn" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
