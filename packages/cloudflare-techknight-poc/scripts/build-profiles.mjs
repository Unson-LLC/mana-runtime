import { spawnSync } from "node:child_process";

const profiles = ["build", "build:unson-business"];

for (const profile of profiles) {
  const result = spawnSync("pnpm", ["run", profile], {
    cwd: new URL("..", import.meta.url),
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
