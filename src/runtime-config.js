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

// Public deployments and credential attestations share one issuer signer in this process.
export function createWriteQueue() {
  let tail = Promise.resolve();
  return (operation) => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
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
