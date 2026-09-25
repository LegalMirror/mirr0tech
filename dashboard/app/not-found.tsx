import Link from "next/link";

export default function NotFound() {
  return (
    <section className="card">
      <h2>Not here</h2>
      <p className="muted">This dashboard has five screens: Policy, Lenders, Queue, Exit and Audit.</p>
      <Link href="/">Open the overview</Link>
    </section>
  );
}
