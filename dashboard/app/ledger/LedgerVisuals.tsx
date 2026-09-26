import { fmtTime } from "@/lib/format";
import type { Ledger } from "@/lib/ledger";

const PERMIT = "var(--permit)";
const FORBID = "var(--forbid)";
const LINE = "var(--border)";
const INK = "var(--text-primary)";
const MUTED = "var(--text-secondary)";

const counts = (ledger: Ledger) => ({
  admitted: ledger.decisions.filter((d) => d.allowed).length,
  refused: ledger.decisions.filter((d) => !d.allowed).length,
});

/** Wallets reach the pool only through the hook; each transfer clause can stop them there. */
export function BoundaryDiagram({ ledger }: { ledger: Ledger }) {
  const { admitted, refused } = counts(ledger);
  const clauses = ledger.boundaries.transferClauses;
  const refusedBy = (clauseId: number) => ledger.decisions.filter((d) => !d.allowed && d.clauseId === clauseId).length;
  const callbacks = Object.entries(ledger.boundaries.callbacks);
  const clauseY = (i: number) => 150 + i * 44;
  const height = Math.max(250, clauseY(clauses.length) + 10);
  return (
    <svg viewBox={`0 0 760 ${height}`} role="img" aria-label={`Hook boundary: ${admitted} admitted, ${refused} refused`} style={{ width: "100%", height: "auto" }}>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill={MUTED} />
        </marker>
      </defs>
      <g>
        <rect x="10" y="40" width="150" height="70" rx="10" fill="none" stroke={LINE} />
        <text x="85" y="68" textAnchor="middle" fill={INK} fontSize="14" fontWeight="600">Wallets</text>
        <text x="85" y="90" textAnchor="middle" fill={MUTED} fontSize="12">{admitted + refused} attempts</text>
      </g>
      <line x1="160" y1="75" x2="258" y2="75" stroke={MUTED} markerEnd="url(#arrow)" />
      <g>
        <rect x="260" y="20" width="200" height="110" rx="10" fill="none" stroke={INK} strokeWidth="1.5" />
        <text x="360" y="42" textAnchor="middle" fill={INK} fontSize="14" fontWeight="600">Policy hook</text>
        {callbacks.map(([name, on], i) => (
          <g key={name}>
            <rect x="275" y={52 + i * 24} width="170" height="19" rx="9" fill="none" stroke={on ? PERMIT : LINE} />
            <text x="360" y={65 + i * 24} textAnchor="middle" fill={on ? INK : MUTED} fontSize="11">
              {on ? "gated · " : ""}
              {name.replace(/^before/, "").replace(/([A-Z])/g, " $1").trim().toLowerCase()}
            </text>
          </g>
        ))}
      </g>
      <line x1="460" y1="60" x2="578" y2="60" stroke={PERMIT} strokeWidth={admitted ? 3 : 1} markerEnd="url(#arrow)" />
      <text x="519" y="52" textAnchor="middle" fill={PERMIT} fontSize="12">{admitted} admitted</text>
      <g>
        <rect x="580" y="30" width="170" height="60" rx="10" fill="none" stroke={LINE} />
        <text x="665" y="55" textAnchor="middle" fill={INK} fontSize="14" fontWeight="600">Uniswap v4 pool</text>
        <text x="665" y="75" textAnchor="middle" fill={MUTED} fontSize="11">fee {ledger.boundaries.poolKey.fee / 10000}% · tick {ledger.boundaries.poolKey.tickSpacing}</text>
      </g>
      {clauses.map((clause, i) => {
        const n = refusedBy(clause.clauseId);
        return (
          <g key={clause.clauseId}>
            <path d={`M 360 130 C 360 ${clauseY(i)}, 470 ${clauseY(i) + 15}, 578 ${clauseY(i) + 15}`} fill="none" stroke={n ? FORBID : LINE} strokeWidth={n ? 2.5 : 1} strokeDasharray={n ? undefined : "4 4"} />
            <rect x="580" y={clauseY(i)} width="170" height="32" rx="8" fill="none" stroke={n ? FORBID : LINE} />
            <text x="590" y={clauseY(i) + 20} fill={INK} fontSize="11">
              §{clause.clauseId} {clause.ruleId.replace(/^transfer-/, "")}
            </text>
            <text x="560" y={clauseY(i) + 12} textAnchor="end" fill={n ? FORBID : MUTED} fontSize="11">
              {n} refused
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Allowed and refused per deciding clause, as bars. */
export function ClauseBars({ ledger }: { ledger: Ledger }) {
  const rows = ledger.byClause.map((entry) => ({ label: entry.ruleId ?? "admitted (no clause refused)", allowed: entry.allowed, refused: entry.refused }));
  const max = Math.max(1, ...rows.map((row) => row.allowed + row.refused));
  return (
    <svg viewBox={`0 0 760 ${rows.length * 30 + 10}`} role="img" aria-label="Decisions by clause" style={{ width: "100%", height: "auto" }}>
      {rows.map((row, i) => {
        const y = 5 + i * 30;
        const allowedWidth = (row.allowed / max) * 440;
        const refusedWidth = (row.refused / max) * 440;
        return (
          <g key={row.label}>
            <text x="0" y={y + 15} fill={INK} fontSize="12">{row.label}</text>
            <rect x="260" y={y + 3} width={allowedWidth} height="16" rx="3" fill={PERMIT} />
            <rect x={260 + allowedWidth} y={y + 3} width={refusedWidth} height="16" rx="3" fill={FORBID} />
            <text x={266 + allowedWidth + refusedWidth} y={y + 15} fill={MUTED} fontSize="11">
              {row.allowed} allowed · {row.refused} refused
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Every decision in time: on-chain admissions above, refusals the gateway recorded below. */
export function DecisionTimeline({ ledger }: { ledger: Ledger }) {
  const times = ledger.decisions.map((d) => new Date(d.at).getTime()).filter((t) => !Number.isNaN(t));
  if (!times.length) return null;
  const [from, to] = [Math.min(...times), Math.max(...times)];
  const x = (t: number) => 90 + (to === from ? 330 : ((t - from) / (to - from)) * 650);
  const lanes = [
    { label: "on chain", y: 30, source: "multibaas" },
    { label: "refused", y: 70, source: "gateway" },
  ];
  return (
    <svg viewBox="0 0 760 110" role="img" aria-label="Decision timeline" style={{ width: "100%", height: "auto" }}>
      {lanes.map((lane) => (
        <g key={lane.label}>
          <text x="0" y={lane.y + 4} fill={MUTED} fontSize="11">{lane.label}</text>
          <line x1="90" y1={lane.y} x2="740" y2={lane.y} stroke={LINE} />
        </g>
      ))}
      {ledger.decisions.map((d, i) => {
        const t = new Date(d.at).getTime();
        if (Number.isNaN(t)) return null;
        const lane = d.source === "gateway" ? lanes[1] : lanes[0];
        return (
          <circle key={`${d.at}-${i}`} cx={x(t)} cy={lane.y} r="6" fill={d.allowed ? PERMIT : FORBID}>
            <title>{`${fmtTime(d.at)} · ${d.subject} · ${d.venue ?? d.action} · ${d.allowed ? "allowed" : `refused · ${d.clause?.ruleId ?? `§${d.clauseId}`}`}`}</title>
          </circle>
        );
      })}
      <text x="90" y="102" fill={MUTED} fontSize="10">{fmtTime(new Date(from).toISOString())}</text>
      <text x="740" y="102" textAnchor="end" fill={MUTED} fontSize="10">{fmtTime(new Date(to).toISOString())}</text>
    </svg>
  );
}
