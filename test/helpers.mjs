import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { AiOsKernel } from "../src/core/kernel.mjs";
import { ATLAS } from "../src/fixtures/atlas.mjs";

const cliPath = fileURLToPath(new URL("../bin/ai-os.mjs", import.meta.url));
const deferredCleanup = new Set();

process.once("beforeExit", () => {
  for (const root of deferredCleanup) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    } catch (error) {
      if (error.code !== "EPERM" && error.code !== "EBUSY") throw error;
    }
  }
});

export function tempRoot(prefix = "ai-os-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeRoot(root) {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EBUSY") throw error;
    deferredCleanup.add(root);
  }
}

export function runCli(instanceRoot, command, args = [], { expectedStatus = 0 } = {}) {
  const commandArgs = command === "init" && !args.includes("--mode")
    ? [...args, "--mode", "ATLAS_FIXTURE", "--confirm-synthetic"]
    : args;
  const result = spawnSync(process.execPath, ["--no-warnings", cliPath, command, "--instance", instanceRoot, ...commandArgs], {
    encoding: "utf8",
    env: { ...process.env },
  });
  if (result.status !== expectedStatus) {
    throw new Error(`CLI ${command} exited ${result.status}; stdout=${result.stdout}; stderr=${result.stderr}`);
  }
  const output = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  const error = result.stderr.trim().startsWith("{") ? JSON.parse(result.stderr) : null;
  return { ...result, output, error };
}

export async function initializedKernel(root, { capture = true, clock } = {}) {
  const kernel = new AiOsKernel(root, { clock });
  kernel.initializeAtlas();
  if (capture) await kernel.captureAtlasStatement();
  return kernel;
}

export async function approvedKernel(root, options = {}) {
  const kernel = await initializedKernel(root, options);
  const prepared = await kernel.prepareUpdate();
  const grant = kernel.approve({ planHash: prepared.plan.plan_hash });
  return { kernel, prepared, grant };
}

export { ATLAS };
