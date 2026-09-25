# ETHGlobal Tokyo 2026 submission text

**Project:** mirr0tech · **Tagline:** links a tokenized asset's off-chain legal clauses to the on-chain code that executes them.

**Description (short).** A legal agreement goes in; out comes a policy grounded in verbatim quotes, hashed to the document, and compiled into each venue the asset passes through. Act 1: a Securitize/BlackRock transfer-agent agreement becomes a permissioned fund token and a Uniswap v4 hook that is the token's only door into a pool. Act 2: the Wildcat template Master Loan Agreement, a Lender Check Policy and a one-clause buyback addendum become a Wildcat role provider and a 1inch Aqua strategy whose SwapVM program carries the agreement as an opcode. Every refusal names the clause. One token, its whole legal life, on Sepolia.

**How it's made.** Documents are normalized and hashed; an AST of rules and terms (each with a verbatim quote) compiles to DNF bitmasks with three-valued logic, proved equivalent to the JS interpreter over every assignment, then emitted as `CompiledPolicy.sol` plus program templates. Facts are attested with expiry or read from the oracle the agreement names. 1inch: `MirrortechRouter` = official SwapVM + `LimitOpcodes` + two instructions (`PolicyGuard` evaluates maker and taker at every fill and `quote()`; `FixedRateBalances` pins the addendum's rate), shipped to the unmodified canonical Aqua registry; fixed-price and Dutch-auction templates. Uniswap v4: hook address mined for its permission bits, transient handshake so the token refuses any pool transfer the hook did not admit. Curvegrid: MultiBaas registers every contract under a policy-hash version and indexes the events the audit screen reads. Dashboard: Next.js clause highlighter mapping every paragraph to what it compiled to.

**Prizes.** 1inch — Build an Aqua App (custom app + custom SwapVM opcodes, on Sepolia against the canonical Aqua). Curvegrid — RWA tokenization (MultiBaas registration + event indexing). Third: TBD.

**Links.** Repo: https://github.com/LegalMirror/mirr0tech · Live: https://legalmirror.github.io/mirr0tech/ · Sepolia contracts and golden-path transactions: README "Sepolia" · Demo video: TBD.
