### Product Overview

**Mirrortech** compiles offering documents directly into executable Uniswap v4 pool configurations. It operates on the thesis that *law is source code and smart contracts are compiled bytecode*—enforcing the terms counsel signed off on, with every rule traceable to a verbatim quote from the source document.

---

### Core Problem

Tokenized Real-World Assets (RWAs) hold billions in primary issuance but trade with negligible secondary volume on public venues. Standard AMMs cannot enforce legal constraints—such as accreditation checks, lockups, daily redemption gates, and ownership caps. Consequently, issuers and legal counsel block secondary liquidity on public AMMs.

---

### Key Capabilities & Features

* **Document-to-Policy Compiler**
Parses offering documents into a structured Abstract Syntax Tree (AST), verifies verbatim source quotes, and binds the configuration to a cryptographic SHA-256 `policyHash`. Counsel attests the AST; the compiler verifies and hashes.


* **Venue-Level Compliance (Uniswap v4 Hook)**
Enforces the observable subset of rules directly at the venue level:


* **Access Control:** Verifies identity attestations passed via `hookData` during swaps and LP deposits.


* **Redemption Quotas:** Enforces daily withdrawal limits (e.g., halting liquidity exits once a 10% daily NAV quota is exhausted).




* **Tamper-Proof Error Provenance**
Reverts illegal transactions using custom errors (`LegalClauseViolation(clauseId, policyHash)`). The clause-to-quote mapping is hash-committed inside the `policyHash`, making the on-chain error and the displayed prospectus quote equally tamper-evident.


* **Dynamic Exit Pricing**
Programmatically increases swap fee tiers as daily exit capacity depletes, pricing remaining exit window capacity for traders.


* **Document-Derived LVR Defense**
Addresses discrete NAV jump risk using the strike schedule written in the prospectus. The hook brief halts continuous flow around strike times to avoid toxic arbitrage, and auctions the first post-strike trade to capture arbitrage value for LPs.


* **Immutable Policy Binding**
Policy cannot be modified under a live pool. A changed document produces a different hash and deploys a distinct pool; existing pools continue enforcing the exact paper originally signed.



---

### The Product: Legal-Risk Price Discovery

RWAs have no secondary venue, so the market has never been able to put a number on gate risk, lockup overhang, or redemption uncertainty. A Mirrortech pool trading at $0.96 against a $1.00 NAV is the first observable price of legal friction.

This price series is a standalone data product—giving issuers clear visibility into what their own legal terms cost them in secondary market liquidity.

---

### The Moat: Venue-Agnostic Policy Layer

Mirrortech is a policy compiler, not a single pool contract. The underlying policy engine compiles rules for Uniswap v4 hooks, lending markets, RFQ venues, OTC desks, and transfer agents. The Uniswap v4 hook is the initial execution channel, not the whole product.

---

### System Boundaries & Honest Architecture

* **Counsel-in-the-Loop:** Unresolved or ambiguous legal terms block compilation. The compiler never executes AI-generated code; legal counsel must attest to the AST.


* **Enforceable Subset vs. Attestation:** The hook enforces only facts observable on-chain (quotas, dynamic fees, timestamps, signed attestation payloads). Off-chain legal facts rely on trusted identity attestors, making the boundary explicit rather than masked.


* **Liquidity Trade-offs:** Dynamic fees and daily quotas protect LPs but deliberately constrain peak trade throughput during high-friction redemption windows.



---

### Stakeholder Value

| Stakeholder | Value Deliverable |
| --- | --- |
| **RWA Issuers** | Unlocks secondary liquidity while enforcing every prospectus term the venue can observe, and seeing exactly what legal friction costs in market discount. | **Liquidity Providers** | Obtains automated protection against jump-risk LVR and earns dynamic fee compensation when providing liquidity through redemption windows.|
| **Auditors & Counsel** | Verifies the venue's rules against the source document, and sees exactly which facts are enforced on-chain versus attested off-chain.|
