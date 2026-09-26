import { confidenceBasis } from "@/lib/confidence";
import type { Verification } from "@/lib/types";

/** The report's overall confidence, what it rests on, and each model's score of the final answer. */
export function ConfidenceSummary({ report }: { report: Verification }) {
  const evaluations = report.evaluations ?? [];
  return (
    <div className="wb-confidence">
      <p>
        <strong>Confidence {report.confidence.overall.toFixed(2)}</strong>{" "}
        <span className="wb-muted">
          {confidenceBasis(report)} · {report.mock ? "mock, not independent model judgment" : "live deliberation"}
        </span>
      </p>
      {evaluations.length > 0 && (
        <ul>
          {evaluations.map((evaluation) => (
            <li key={evaluation.agent}>
              <strong>{evaluation.agent}</strong> scored the answer {evaluation.score.toFixed(2)}
              {evaluation.justification ? <> — {evaluation.justification}</> : <span className="wb-muted"> · no justification given</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
