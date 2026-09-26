import { mkdir, unlink, writeFile } from 'node:fs/promises';

// Validate operator configuration before opening an RPC connection or sending a transaction.
export function stackRuntime(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const apiKey = env.API_KEY ?? (production ? '' : 'local-dev-stack-operator-key-only');
  if (apiKey.length < 24 || (production && apiKey === 'local-dev-stack-operator-key-only')) {
    throw new Error('Set API_KEY to a unique operator secret of at least 24 characters');
  }
  const viewerKey = env.VIEWER_KEY || null;
  if (viewerKey && (viewerKey.length < 24 || viewerKey === apiKey)) {
    throw new Error('VIEWER_KEY must have at least 24 characters and differ from API_KEY');
  }
  const rawChain = env.EXPECTED_CHAIN_ID;
  if (rawChain !== undefined && (!/^[1-9][0-9]*$/.test(rawChain) || !Number.isSafeInteger(Number(rawChain)))) {
    throw new Error('EXPECTED_CHAIN_ID must be a positive safe integer');
  }
  if (production && (!env.RPC_URL || !rawChain)) {
    throw new Error('Remote stack requires RPC_URL and EXPECTED_CHAIN_ID; no implicit development-chain fallback');
  }
  return { apiKey, viewerKey, expectedChainId: rawChain ? BigInt(rawChain) : null };
}

// Public-chain deployment is an explicit operator command, never a side effect of serving HTTP.
export function reuseDeployment(chainId, record) {
  if (record) {
    if (record.chainId !== Number(chainId)) throw new Error(`DEPLOYMENT_PATH names chain ${record.chainId}, RPC is ${chainId}; refusing to deploy a replacement`);
    return true;
  }
  if (chainId !== 31337n) throw new Error('Set DEPLOYMENT_PATH to an existing deployment. Public-chain startup never deploys contracts; use deploy:stack explicitly if a new stack is intended.');
  return false;
}

export function assertExpectedChain(chainId, expectedChainId) {
  if (expectedChainId !== null && chainId !== expectedChainId) {
    throw new Error(`RPC chain ${chainId} does not match EXPECTED_CHAIN_ID ${expectedChainId}; no deployment was attempted`);
  }
}

/// The data directory must take writes now, not at the first request: a root-owned volume or a
/// read-only mount would otherwise surface as a 503 on the first upload.
export async function assertWritableDataDir(dataDir) {
  const probe = `${dataDir}/.write-probe-${process.pid}`;
  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(probe, 'ok');
    await unlink(probe);
  } catch (error) {
    const who = typeof process.getuid === 'function' ? ` (uid ${process.getuid()}, gid ${process.getgid()})` : '';
    throw new Error(`DATA_DIR ${dataDir} is not writable${who}: ${error.code ?? error.message}. On Docker the mounted volume must be owned by the runtime user; the API image's entrypoint chowns it when it starts as root.`);
  }
}

/// Public demo quotas from DEMO_LIMITS (a JSON object of the DemoWorkspaces limit names, e.g.
/// {"deploysPerWorkspace":10,"deploysPerInterval":50}); the defaults apply for anything absent.
export function demoLimits(env = process.env) {
  const raw = env.DEMO_LIMITS;
  if (!raw || !raw.trim()) return {};
  let limits;
  try { limits = JSON.parse(raw); } catch { throw new Error('DEMO_LIMITS must be a JSON object'); }
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw new Error('DEMO_LIMITS must be a JSON object');
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`DEMO_LIMITS.${key} must be a positive integer`);
  }
  return limits;
}
