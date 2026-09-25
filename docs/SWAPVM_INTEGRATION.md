# 1inch SwapVM integration — specification

Appendix to [PRD.md](PRD.md) §7.4. Status: **built and tested on anvil** (`test/chain/swapvm.test.js`). Sources: `contracts/swapvm/`, `src/policy/programs.js`.

## 1. What we are building

A SwapVM **instruction** that evaluates the compiled agreement, a **router** that dispatches it, and a **program template** the compiler fills from the buyback addendum. The result: a borrower signs one order from a cold wallet; any admitted lender can fill it; any unadmitted wallet is refused at quote time with the clause that refused them.

```
Deadline(addendum.expiry)
PolicyGuard(policyHash, ACTION_TRANSFER)        ← the MLA, as an opcode
FixedRateBalances(position, cap, USDC, cap×price) ← the price is a term, not a curve
LimitSwap(positionToken → USDC)                 ← lender pays its position, borrower pays USDC
InvalidateTokenIn                               ← cumulative fill cap, partial fills allowed
```

Two instructions are ours, appended after the official `LimitOpcodes` set so every existing opcode keeps its number: `PolicyGuard` (opcode = size of the official set) and `FixedRateBalances` (the next one). The official `StaticBalances` refuses to run over balances Aqua has preloaded, and with Aqua balances alone `LimitSwap` would reprice after every fill; the addendum promises "not less than 0.96", so the rate is pinned from the program and the Aqua balances serve as the settlement allowance and cap.

**Mode: Aqua (P0).** The 1inch track is "Build an Aqua App", so the borrower *ships* the strategy to Aqua (`useAquaInsteadOfSignature: true`) rather than signing an order. Balances come from Aqua's virtual balances, so the program drops `StaticBalances`; settlement goes through `aqua.pull`/`push`. Signature mode (EIP-712, no registry) is the P1 fallback and uses the same bytecode with `StaticBalances` added.

Why SwapVM and not a bespoke `AquaApp`: the guard runs *inside the program*, so `quote()` — a static call — refuses before any transaction; an app-level check only fires at settlement. SwapVM's router is itself an Aqua app, and the strategy hash already commits to the program bytes.

## 2. `PolicyGuard` instruction

Library shape follows every SwapVM instruction: `opcode`, `build(...)`, `parse(...)`, `exec(ctx, args)`.

```solidity
library PolicyGuard {
    // ⚠️ pick an opcode number not present in OpcodeList.sol; guards live in the 0x20 bank.
    uint8 internal constant OPCODE = 0x3f;

    function build(bytes32 policyHash, uint8 action) internal pure returns (bytes memory) {
        return abi.encodePacked(OPCODE, uint8(33), policyHash, action);
    }

    function exec(Context memory ctx, bytes calldata args, IPolicyOracle oracle) internal view {
        (bytes32 policyHash, uint8 action) = parse(args);
        if (policyHash != CompiledPolicy.POLICY_HASH) revert PolicyMismatch(policyHash);
        _check(ctx.query.maker, action, oracle);
        _check(ctx.query.taker, action, oracle);
    }

    function _check(address subject, uint8 action, IPolicyOracle oracle) private view {
        (uint256 known, uint256 value) = oracle.facts(subject, CompiledPolicy.POLICY_HASH); // attestor ∪ observable
        (bool allowed, uint16 clauseId) = PolicyEval.decide(CompiledPolicy.program(action), known, value);
        if (!allowed) revert LegalClauseViolation(clauseId, CompiledPolicy.POLICY_HASH);
    }
}
```

Decisions:

- **Both parties, every time.** Maker at fill time matters: a borrower whose own screening lapsed has an order that stops filling. Taker is who MLA §12 actually restricts.
- **`ctx.query.taker`, not `msg.sender`.** ⚠️ Spike: confirm in the router source that `query.taker` is the beneficiary from `takerData` and how `to` (custom recipient) interacts. If a custom recipient is allowed in signature mode, check `to` as well; in Aqua mode custom receivers are disallowed by SwapVM.
- **View-only.** No storage writes, so it is legal in `isStaticContext` and `quote()` runs it.
- **Policy bound at compile time.** The guard checks the embedded `policyHash` equals the router's `CompiledPolicy.POLICY_HASH`. One router per policy is acceptable for the hackathon; multi-policy routers would look the attestor up by hash instead.
- **Fact assembly.** `IPolicyOracle.facts()` returns the attestor's words OR observable bits (sanctions oracle). Implement as a small view contract so the same assembly is used by the role provider and the guard.

## 2b. Sizes and instruction set

`MirrortechRouter is Simulator, SwapVM, LimitOpcodes, PolicyGuard, FixedRateBalances` — the full `Opcodes` set with our additions compiles to ~27.5 KB, over EIP-170; `LimitOpcodes` (deadline, static balances, limit swap, Dutch auction, invalidators, min-rate, fees, extruction) lands at ~23.0 KB. The decision itself lives in `PolicyOracle.decide(subject, action)` so the router carries neither the compiled programs nor the evaluator. Opcode numbers in JavaScript are parsed from the vendored `LimitOpcodes.sol` (`loadOpcodes()`), never hard-coded, and the router reports its appended opcodes (`policyGuardOpcode()`, `fixedRateBalancesOpcode()`).

## 3. `MirrortechRouter`

```solidity
contract MirrortechRouter is SwapVM, Opcodes {
    IPolicyOracle public immutable policyOracle;

    constructor(address aqua, address weth, address owner, IPolicyOracle oracle)
        SwapVM(aqua, weth, owner, "MirrortechRouter", "1") { policyOracle = oracle; }

    function _dispatch(Context memory ctx, uint256 opcode, bytes calldata args) internal override {
        if (opcode == PolicyGuard.OPCODE) return PolicyGuard.exec(ctx, args, policyOracle);
        _runOpcode(ctx, opcode, args);
    }
}
```

- `aqua` = the Aqua registry, redeployed **unmodified** from `@1inch/aqua` on Sepolia (and on anvil for tests); pass its address. The 1inch rules require official contracts and explicitly allow a modified SwapVM redeploy; say both in the README.
- Deploy a `*Debug` variant locally for `Print*`; never on Sepolia.
- The canonical router `0x111111338c5091E8440b67B168bAe16a668AC0De` does not know this opcode and is not on Sepolia. Our router is required either way.

## 4. Program templates

Templates are fixed instruction sequences with parameter slots. The compiler fills slots from `terms[]`; it never reorders or adds instructions.

**`BuybackFixedPrice` (P0)**

| Slot | Term | Source |
| --- | --- | --- |
| `Deadline.timestamp` | `buybackDeadline` | addendum |
| `StaticBalances.balanceA/B` | `buybackCap`, `buybackPrice` | addendum |
| `LimitSwap.tokenIn/tokenOut` | USDC, position token | Term Sheet (asset), market |
| `PolicyGuard.policyHash/action` | compile output, `ACTION_TRANSFER` | — |

Token ordering: SwapVM requires `tokenA < tokenB` by address; the template resolves direction at build time.

**`BuybackDutchAuction` (P2)** — replaces `StaticBalances` with `DutchAuctionBalanceIn`: price improves over time until filled. Corporate tender-offer shape.

Each template ships with its **clause template** — the sentence the borrower adds to the agreement so the compiler can quote it (PRD §7.1 addendum).

## 5. Order lifecycle

**Maker (borrower treasury)**

1. Gateway builds `program` from the compiled terms, then `Order { maker, traits, data }` via `MakerTraitsLib.build` with `useAquaInsteadOfSignature: false`, `usePermit2: false`.
2. Treasury wallet signs `router.hash(order)` (EIP-712) — offline is fine.
3. Treasury approves the router for USDC (`tokenOut`) — the only on-chain step; no capital moves.
4. Gateway stores the order + signature; optionally `registerOrder` for indexers.

**Taker (lender)**

1. Dashboard calls `router.asView().quote(order, amount, takerData)`. Refusal → `LegalClauseViolation` decoded and rendered. Nothing sent.
2. Fill: `router.swap(order, amount, takerData)` with `isExactIn`, `isAToB` set so the lender pays position tokens and receives USDC. Lender approves the router for position tokens.
3. Wildcat's own transfer hook fires on the position-token transfer; the taker (borrower) must be a Known Lender on that market. Our role provider is what makes that true. Two gates, aligned — show both in the UI.

**Revocation.** The borrower cancels with `ValidateSeriesEpoch` (bump epoch) or by letting `Deadline` pass. The compliance side needs nothing: a revoked or expired attestation makes the order unfillable by itself.

**Aqua mode (P0 — the demo path).** Borrower: `usdc.approve(aqua, max)` once; `aqua.ship(router, abi.encode(order), [usdc, position], [cap, 0])` — records virtual balances, nothing moves. Order built with `useAquaInsteadOfSignature: true`, `usePermit2: false`, no custom receiver (disallowed in Aqua mode). Taker fills with empty `signature`; `useTransferFromAndAquaPush` chooses transferFrom vs pre-push. `aqua.dock(router, strategyHash, tokens)` withdraws the bid. The signed-order flow above is P1.

## 6. Errors and decoding

The router may wrap instruction reverts. Decode order: try `LegalClauseViolation(uint16,bytes32)` directly; if the data is a wrapper error, unwrap `reason` and retry. Then `clauseId → clause-table.json` after verifying `keccak/sha256(table) == CLAUSE_TABLE_HASH` read from the router's `CompiledPolicy`.

## 7. Tests (anvil, `test/chain/swapvm.test.js`)

1. Router deploys; `hash(order)` matches the gateway's EIP-712 digest.
2. Admitted maker + admitted taker: `quote` returns amounts; `swap` moves USDC → lender, position tokens → borrower; `InvalidateTokenIn` caps cumulative fills.
3. Unadmitted taker: `quote` reverts `LegalClauseViolation`; `clauseId` maps to a `transfer` rule.
4. Admitted taker, then `revokeFacts(sanctionsClear)`: same order, `quote` now reverts; clause is the sanctions rule.
5. Attestation expiry (`evm_increaseTime`): same order stops filling with no transaction.
6. Maker's screening revoked: order unfillable for everyone.
7. Wrong `policyHash` in the program: `PolicyMismatch`.
8. `Deadline` passed: SwapVM's own revert.

## 8. Spike checklist (first 90 minutes, Eng A)

- [ ] `npm i @1inch/swap-vm` at a pinned version; note the `swap` ABI it ships (`main` vs v1.0.x differ).
- [ ] Locate `OpcodeList.sol`; choose an unused opcode; confirm `_dispatch` override pattern compiles with `Opcodes`.
- [ ] Read `Context` / `TakerTraitsLib`: confirm `query.taker` semantics and whether `to` can differ from taker in signature mode.
- [ ] `npm i @1inch/aqua`; deploy `Aqua.sol` on anvil; `ship` a trivial strategy and read `safeBalances` back.
- [ ] Add a `solc-swapvm` (0.8.30) bundle to `scripts/build-contracts.js`.
- [ ] Minimal `LimitSwap` order fills on anvil **without** the guard; then add the guard.

## 9. Open questions

1. ~~Track requirement~~ — resolved: "Build an Aqua App". Aqua mode is P0.
2. `query.taker` vs `to` for policy subject. In Aqua mode custom receivers are disallowed, which simplifies this. (Eng A, spike)
4. Confirm at the booth that the unmodified registry redeploy counts as official; confirm `ship()` accepts an arbitrary app address in the spike.
3. License: source-available; a custom router is a derivative — fine for the hackathon, review before product. (Lam, later)
