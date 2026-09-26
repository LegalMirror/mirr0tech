# Onchain implementation

This directory owns chain access and the artifacts used for contract deployment.

| Modules | Responsibility |
| --- | --- |
| `workspace-chain.js`, `runtime-config.js` | Lazy Sepolia connection, chain validation and deployment configuration |
| `signer.js` | Server-side key selection: `DEPLOYER_PRIVATE_KEY`, then `PRIVATE_KEY` |
| `deploy.js`, `hookAddress.js` | Deployment orchestration and CREATE2 hook-address mining |
| `solc.js`, `components.js` | Solidity compiler versions and contract component resolution |
| `policy.js`, `cashier.js`, `programs.js` | Policy/token emission, cashier commitments and SwapVM encoding |
| `chain.js`, `venues.js` | Contract calls, receipts and venue operations |
| `refusal.js`, `cashier-refusal.js`, `audit-events.js` | Revert decoding and gateway audit mapping |

HTTP adapters stay in `src/*-api.js`; document extraction, AST validation and compiler orchestration stay in `src/policy`. Executable commands stay in `scripts/` and import these modules. `contracts/` contains the Solidity source.

Creating the workspace chain adapter does no network I/O. Startup and uploads work without Sepolia; connection occurs when chain status or deployment is requested. No wallet-settings or cloud-signing service is involved.
