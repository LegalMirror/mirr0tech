# Uniswap v4 developer feedback — mirr0tech (ETHGlobal Tokyo 2026)

What we built on v4: `contracts/MirrorPolicyHook.sol` — a hook on `beforeAddLiquidity` / `beforeRemoveLiquidity` / `beforeSwap` that enforces a compiled legal agreement (a Securitize/BlackRock transfer-agent agreement) for a permissioned fund token, plus a transient-storage handshake that makes the hook the token's only door into any pool (`contracts/MirrorToken.sol:_update`, `MirrorPolicyHook.consumeApproval`). Tested against the real `PoolManager` on anvil in `test/chain/hook.test.js` and `test/chain/rwa-pool.test.js`; address mining in `src/policy/hookAddress.js`.

## What worked well
- Permission bits in the address are a clean contract: a mis-deployed hook fails at construction, not at first use. Mining took ~140 attempts with the deterministic deployer.
- `hookData` gave us a place to carry the beneficial subject, which a hook needs because `sender` is the router.
- Wrapped hook reverts (`WrappedError`) kept our custom error intact; decoding it client-side was straightforward once we knew to unwrap.

## Friction
- **`sender` is the router, never the person.** Every compliance-style hook has to solve identity out of band. A standard, opt-in way to pass a verified beneficiary (or a canonical "subject" field routers populate) would remove the biggest footgun for this hook category.
- **Singleton custody vs. token-level restrictions.** A restricted token cannot tell which pool a `PoolManager` transfer belongs to. We solved it with a transient approval the hook sets and the token consumes; documenting this pattern (or offering a helper in v4-periphery) would help every RWA hook.
- **Rebasing tokens** are unsupported, which rules out a whole class of yield-bearing fund tokens without a wrapper; a note in the hooks docs would save teams a detour.
- **Compiler pinning.** `PoolManager` pins 0.8.26 exactly; mixed-version builds needed a second compiler bundle.
- **Decoding refusals** required unwrapping `WrappedError` manually; an example in the docs of surfacing a hook's custom error to a front end would be useful.

## What we would want next
- A first-class beneficiary/subject convention for hooks.
- Guidance for "permissioned pool, permissionless creation": a hook as the sole admitted holder path for a restricted token is a pattern the RWA space needs.
