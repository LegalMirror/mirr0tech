// Deployment credentials are server-side only. The deployment-specific key wins when both are set.
export function deploymentPrivateKey(env = process.env) {
  return env.DEPLOYER_PRIVATE_KEY?.trim() || env.PRIVATE_KEY?.trim() || null;
}
