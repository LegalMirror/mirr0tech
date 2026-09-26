import type { AgreementDetail } from "@/lib/agreements";

/** Spinner plus bar for a running gateway job; the bar moves without a number until the job reports a percent. */
export function JobProgress({ progress }: { progress: AgreementDetail["progress"] }) {
  const percent = progress?.percent ?? null;
  return (
    <div
      className="wb-progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      aria-busy="true"
    >
      <div className={`wb-progress-track${percent == null ? " wb-progress-indeterminate" : ""}`}>
        <div className="wb-progress-fill" style={percent == null ? undefined : { width: `${percent}%` }} />
      </div>
      <p>
        <span className="wb-spinner" aria-hidden="true" />
        {percent == null ? "Starting…" : <strong>{percent}%</strong>}
        {progress?.confidence != null && (
          <>
            {" "}
            · confidence so far <strong>{progress.confidence.toFixed(2)}</strong>
          </>
        )}
      </p>
    </div>
  );
}
