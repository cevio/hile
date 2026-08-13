'use client';

export default function ErrorBoundary({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <main data-testid="host-error-boundary">
      <h1>Host caught a remote plugin error</h1>
      <pre>{error.message}</pre>
      <button type="button" onClick={reset}>Retry</button>
    </main>
  );
}
