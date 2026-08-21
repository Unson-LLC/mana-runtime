export function buildWranglerDeployArgs({ configPath, containersRollout }) {
  if (containersRollout !== undefined && containersRollout !== "none") {
    throw new Error("tenant_runtime_container_rollout_invalid");
  }
  return [
    "exec",
    "wrangler",
    "deploy",
    "--config",
    configPath,
    ...(containersRollout === "none" ? ["--containers-rollout=none"] : []),
  ];
}
