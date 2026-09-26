// Shapes written by scripts/export-ui.js. A gateway that serves GET /v1/policy returns the same shape.

export type ProfileId = "custodial-rwa" | "rwa-secondary" | "wildcat-credit";
export type Effect = "permit" | "require" | "forbid";
export type Tri = boolean | null;

export type Condition =
  | { type: "fact"; name: string }
  | { type: "all" | "any"; children: Condition[] }
  | { type: "not"; child: Condition };

export type QuoteLocation = {
  /** Offsets into the bundled normalized text the compiler hashed */
  start: number;
  end: number;
  /** Which document of the bundle, and where the quote sits in that document's display text */
  part: number;
  displayStart: number;
  displayEnd: number;
};

export type DnfTerm = { pos: number[]; neg: number[]; posMask: string; negMask: string };

export type Rule = {
  id: string;
  action: string;
  effect: Effect;
  condition: Condition;
  source: { clause: string; quote: string };
  rationale: string;
  clauseId: number;
  dnf: DnfTerm[];
  quotes: QuoteLocation[];
};

export type Term = {
  name: string;
  value: string;
  unit: string;
  source: { clause: string; quote: string };
  rationale: string;
  quotes: QuoteLocation[];
};

export type Unresolved = {
  clause: string;
  description: string;
  anchor: { part: number; offset: number } | null;
};

export type DocumentPart = {
  name: string;
  sha256: string;
  textSha256: string;
  start: number;
  end: number;
  display: string;
};

export type ClauseEntry = {
  clauseId: number;
  ruleId: string;
  action: string;
  effect: Effect;
  clause: string;
  quote: string;
};

export type ParagraphStatus = "compiled" | "unresolved" | "not-executable";

/** One paragraph of a document part and what the compiler made of it. */
export type Paragraph = {
  part: number;
  displayStart: number;
  displayEnd: number;
  /** Clause path as the document numbers it, e.g. "MLA 13) e)" or "2.1.1" */
  label: string;
  kind: "heading" | "definition" | "boilerplate" | "clause" | "text";
  status: ParagraphStatus;
  rules: string[];
  terms: string[];
  /** Indexes into PolicyData.unresolved */
  unresolved: number[];
  components: string[];
};

export type Coverage = {
  paragraphs: Paragraph[];
  /** Paragraphs counted, i.e. excluding headings and page furniture */
  total: number;
  counts: Record<ParagraphStatus, number>;
  rules: number;
  terms: number;
};

export type ComponentInfo = {
  id: string;
  version: string;
  kind: string;
  venue: string | null;
  description: string;
  rules: string[];
  terms: string[];
};

export type ProgramWord = { offset: number; label: string; hex: string };

export type ActionProgram = {
  action: string;
  index: number;
  hex: string;
  byteLength: number;
  header: ProgramWord[];
  rules: {
    clauseId: number;
    ruleId: string | null;
    effect: Effect;
    byteStart: number;
    byteEnd: number;
    words: ProgramWord[];
  }[];
};

export type BuybackInstruction = {
  name: string;
  opcode: number;
  bytes: string;
  args: Record<string, string>;
  source: string;
};

export type Buyback =
  | { available: false; reason: string }
  | {
      available: true;
      terms: {
        price: string;
        cap: string;
        deadline: string;
        deadlineTimestamp: number;
        capPosition: string;
        capAsset: string;
      };
      placeholders: { maker: string; positionToken: string; asset: string };
      instructions: BuybackInstruction[];
      program: string;
      order: { maker: string; traits: string; data: string };
      strategyHash: string;
      /** The tender-offer variant (addendum A1.5), when the agreement carries a ceiling and a window */
      auction: {
        ceiling: string;
        windowHours: string;
        capAssetCeiling: string;
        instructions: BuybackInstruction[];
        program: string;
      } | null;
    };

/** What the deliberation established about the extraction: one entry per claim, a confidence per rule. */
export type Verification = {
  provider: "noolog";
  jobId: string;
  mock: boolean;
  agents: string[];
  rounds: number;
  winner: { round: number; agent: string; score: number | null } | null;
  convergence: number | null;
  claims: {
    key: string;
    ref: string;
    claim: string;
    verdicts: {
      agent: string;
      verdict: "verified" | "contested" | "unverified" | "wrong" | "unknown";
      reason: string | null;
    }[];
    disputed: boolean;
    score: number;
  }[];
  /** What an evaluator pushed back on, with its counter-position and how sure it was */
  contested: {
    key: string | null;
    ref: string | null;
    claim: string;
    evaluator: string;
    position: string;
    confidence: "high" | "medium" | "low";
    verdict: string | null;
  }[];
  confidence: {
    overall: number;
    byRef: Record<string, number>;
    verified: number;
    total: number;
    counts: { verified: number; contested: number; unverified: number; wrong: number; unknown: number };
  };
};

export type PolicyData = {
  schemaVersion: 1;
  profile: ProfileId;
  act: number;
  label: string;
  venue: string;
  title: string;
  parties: { name: string; role: string }[];
  source: {
    name: string;
    sha256: string;
    textSha256: string;
    parts: { name: string; sha256: string; textSha256: string }[] | null;
  };
  policyHash: string;
  clauseTableHash: string;
  equivalenceChecks: number;
  demo: boolean;
  config: Record<string, unknown> & { assumptions: string[] };
  verification?: Verification;
  extraction: { provider: string; model: string | null };
  factOrder: string[];
  actionOrder: string[];
  text: string;
  documents: DocumentPart[];
  rules: Rule[];
  terms: Term[];
  unresolved: Unresolved[];
  clauseTable: ClauseEntry[];
  programs: ActionProgram[];
  buyback: Buyback | null;
  /** The component library blocks this profile links against */
  components: ComponentInfo[];
  /** Rule id / term name → enforcing component ids */
  enforcedBy: { rules: Record<string, string[]>; terms: Record<string, string[]> };
  coverage: Coverage;
};

export type ProfileSummary = {
  profile: ProfileId;
  act: number;
  label: string;
  venue: string;
  title: string;
  policyHash: string;
  /** Paragraph counts without the paragraphs themselves, for the overview */
  coverage?: Omit<Coverage, "paragraphs">;
};

/** A wallet the policy decides about: a lender (credit) or an investor (custodial). */
export type Party = {
  id: string;
  name: string;
  address: string;
  role: "lender" | "investor" | "borrower" | "stranger";
  facts: Record<string, Tri>;
  /** Unix seconds of the screening behind the attested facts, or null when none is live */
  screenedAt: number | null;
  sanctions: "clear" | "flagged" | "unknown";
  /** A reviewer's resolution of a queue item, if any */
  resolution?: "approved" | "rejected";
};

export type AuditEvent = {
  id: string;
  at: string;
  kind:
    | "Attested"
    | "Revoked"
    | "CredentialDecision"
    | "PolicyChecked"
    | "Fill"
    | "QuoteRefused"
    | "Shipped"
    | "Minted"
    | "Refused";
  subject: string;
  action: string;
  summary: string;
  /** The fact set the decision ran on, so the row can replay the trace */
  facts: Record<string, Tri>;
  txHash: string | null;
  /** Block-explorer link for the transaction on a public chain */
  explorer?: string | null;
  /** Live gateway only: what the chain decided, and the clause it named when it refused */
  outcome?: "ok" | "refused";
  clauseId?: number | null;
  venue: string;
};

/** Where the stack lives: the record `scripts/deploy-stack.js` writes, as `/v1/stack` serves it */
export type Deployment = {
  chainId: number;
  attestor: string;
  sanctions: string;
  usdc: string;
  rwa: {
    policyHash: string;
    oracle: string;
    token: string;
    hook: string;
    router: string;
    poolManager: string;
  };
  credit: {
    policyHash: string;
    oracle: string;
    roleProvider: string;
    market: string;
    router: string;
    aqua: string;
  };
};

/** The relying-party context a World ID request opens with (server-signed), or a mock one. */
export type WorldIdContext = {
  app_id: string;
  rp_id: string;
  action: string;
  environment: string;
  mock: boolean;
  rp_context: { rp_id: string; nonce: string; created_at: number; expires_at: number; signature: string };
};
