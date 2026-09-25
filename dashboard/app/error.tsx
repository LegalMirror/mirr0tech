"use client";

export default function AppError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <section className="card" role="alert">
      <h2>Something broke</h2>
      <p className="error">{error.message}</p>
      <button onClick={reset}>Try again</button>
    </section>
  );
}
