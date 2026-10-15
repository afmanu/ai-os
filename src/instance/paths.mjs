import { existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AiOsError } from "../core/errors.mjs";

const projectRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

function isInside(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function containingGitRoot(candidate) {
  let current = candidate;
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function defaultInstanceRoot(name = "personal") {
  const base = process.env.LOCALAPPDATA || join(homedir(), ".local", "share");
  return resolve(base, "ai-os", "instances", name);
}

export function resolveInstanceRoot(input) {
  const root = resolve(input || defaultInstanceRoot());
  if (isInside(projectRoot, root)) {
    throw new AiOsError("UNSAFE_INSTANCE_PATH", "Operational state cannot live inside the source repository", { root });
  }
  const segments = root.toLowerCase().split(/[\\/]+/);
  if (segments.includes("onedrive")) {
    throw new AiOsError("UNSAFE_INSTANCE_PATH", "Operational SQLite cannot live in a synchronized OneDrive directory", { root });
  }
  const gitRoot = containingGitRoot(root);
  if (gitRoot) {
    throw new AiOsError("UNSAFE_INSTANCE_PATH", "Private instance data cannot live inside a Git worktree", { root, git_root: gitRoot });
  }
  return root;
}

export function resolvePrivateStatePath(input) {
  if (!input) throw new AiOsError("PRIVATE_STATE_PATH_REQUIRED", "A private onboarding state path is required");
  const path = resolve(input);
  const segments = path.toLowerCase().split(/[\\/]+/);
  if (segments.includes("onedrive")) {
    throw new AiOsError("UNSAFE_PRIVATE_STATE_PATH", "Private onboarding state cannot live in a synchronized OneDrive directory", { path });
  }
  const gitRoot = containingGitRoot(dirname(path));
  if (gitRoot) {
    throw new AiOsError("UNSAFE_PRIVATE_STATE_PATH", "Private onboarding state cannot live inside a Git worktree", { path, git_root: gitRoot });
  }
  return path;
}

export function instancePaths(rootInput) {
  const root = resolveInstanceRoot(rootInput);
  return {
    root,
    kernelDb: join(root, "kernel.sqlite"),
    taskDb: join(root, "task-source.sqlite"),
  };
}

export function ensureInstanceRoot(rootInput) {
  const paths = instancePaths(rootInput);
  mkdirSync(paths.root, { recursive: true });
  return paths;
}

export function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

export function temporaryParent() {
  return join(tmpdir(), "ai-os-tests");
}

export function projectDirectory() {
  return projectRoot;
}

export function ensureParent(path) {
  mkdirSync(dirname(path), { recursive: true });
}
