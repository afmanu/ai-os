import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { AiOsError, invariant } from "../../core/errors.mjs";
import { canonicalJson, iso, sha256, systemClock } from "../../core/utils.mjs";

export const LOCAL_REPO_CAPABILITY_REF = "cap.local-repo-read@0.1.0";
const LIMITATIONS = Object.freeze([
  "LOCAL_SOURCE_SNAPSHOT_ONLY",
  "SOURCE_TEXT_IS_UNTRUSTED_DATA",
  "GIT_STATUS_DOES_NOT_PROVE_DOCUMENT_CLAIMS",
  "NO_PATH_DISCOVERY_OUTSIDE_EXPLICIT_BINDING",
]);

function pathKey(value) {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function inside(root, target) {
  const value = relative(resolve(root), resolve(target));
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 4000,
  });
  if (result.error || result.status !== 0) {
    throw new AiOsError("GIT_READ_FAILED", "Git metadata could not be read from the configured repository", {
      operation: args[0],
      status: result.status,
      cause: result.error?.message || result.stderr.trim() || null,
    });
  }
  return result.stdout.replace(/\r\n/g, "\n").trimEnd();
}

function repositoryRoot(value) {
  invariant(typeof value === "string" && isAbsolute(value), "ACCESS_DENIED", "Repository root must be an explicitly configured absolute path");
  invariant(existsSync(value), "REPOSITORY_NOT_FOUND", "Configured repository root does not exist");
  const stat = lstatSync(value);
  invariant(stat.isDirectory() && !stat.isSymbolicLink(), "UNSAFE_PATH", "Repository root must be a regular directory, not a link or junction");
  const root = realpathSync.native(value);
  const topLevel = realpathSync.native(git(root, ["rev-parse", "--show-toplevel"]));
  invariant(pathKey(root) === pathKey(topLevel), "ACCESS_DENIED", "Configured repository root must be the exact Git worktree root");
  return root;
}

function locator(value) {
  invariant(typeof value === "string" && value.trim().length > 0 && !value.includes("\0"), "FILE_NOT_ALLOWED", "Document path must be a non-empty relative path");
  invariant(!isAbsolute(value), "PATH_TRAVERSAL", "Absolute document paths are not allowed");
  const normalized = normalize(value.replaceAll(/[\\/]/g, sep));
  invariant(normalized !== "." && normalized !== ".." && !normalized.startsWith(`..${sep}`), "PATH_TRAVERSAL", "Document path escapes the configured repository");
  invariant(normalized.split(sep)[0].toLowerCase() !== ".git", "FILE_NOT_ALLOWED", "Direct .git file access is not allowed");
  return normalized.replaceAll("\\", "/");
}

function scopedDocument(repository, requested) {
  const normalized = locator(requested);
  invariant(repository.documents.includes(normalized), "FILE_NOT_ALLOWED", "Document is not in the explicit repository allow-list", { path: normalized });
  const target = resolve(repository.root, normalized);
  invariant(inside(repository.root, target), "PATH_TRAVERSAL", "Resolved document escapes the configured repository");
  let current = repository.root;
  for (const part of normalized.split("/")) {
    current = resolve(current, part);
    if (!existsSync(current)) break;
    invariant(!lstatSync(current).isSymbolicLink(), "UNSAFE_PATH", "Document path contains a link or junction", { path: normalized });
  }
  return { normalized, target };
}

function readDocument(repository, requested) {
  const scoped = scopedDocument(repository, requested);
  if (!existsSync(scoped.target)) return { path: scoped.normalized, exists: false };
  const real = realpathSync.native(scoped.target);
  invariant(inside(repository.root, real), "UNSAFE_PATH", "Document resolves outside the configured repository");
  const stat = lstatSync(real);
  invariant(stat.isFile() && !stat.isSymbolicLink(), "FILE_NOT_ALLOWED", "Only regular allow-listed files can be read");
  invariant(stat.size <= repository.max_file_bytes, "SOURCE_FILE_TOO_LARGE", "Document exceeds its configured size limit", { size: stat.size, max_bytes: repository.max_file_bytes });
  let descriptor;
  try {
    descriptor = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const before = fstatSync(descriptor);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    invariant(before.size === after.size && before.mtimeMs === after.mtimeMs, "SOURCE_CHANGED", "Document changed while it was being read");
    return {
      path: scoped.normalized,
      exists: true,
      content: bytes.toString("utf8"),
      content_hash: sha256(bytes),
      size_bytes: before.size,
      modified_at: new Date(before.mtimeMs).toISOString(),
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function version(hash) {
  return Number.parseInt(hash.slice(7, 19), 16) || 1;
}

function staleAt(timestamp, observedAt, days) {
  return new Date(observedAt).getTime() - new Date(timestamp).getTime() > days * 86_400_000;
}

function decisionSections(content) {
  return content.split(/\r?\n/).flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    if (!match || !/(decision|decisión|decisiones|decisions)/i.test(match[2])) return [];
    return [{ line: index + 1, heading: match[2].trim() }];
  });
}

function output(repository, kind, locatorValue, payload, observedAt, stateTimestamp = null) {
  const absent = payload === null;
  const stale = !absent && stateTimestamp && staleAt(stateTimestamp, observedAt, repository.stale_after_days);
  const availability = absent ? "ABSENT" : stale ? "STALE" : "AVAILABLE";
  const snapshotHash = sha256(canonicalJson({ kind, repository_id: repository.repository_id, locator: locatorValue, availability, payload }));
  return {
    schema: "LocalRepositoryReadResult@v1",
    kind,
    availability,
    source: {
      source_id: repository.source_id,
      repository_id: repository.repository_id,
      locator: locatorValue,
      snapshot_hash: snapshotHash,
      source_version: version(snapshotHash),
      authority: "EXTERNAL_LOCAL_READ_ONLY",
      freshness: absent ? "ABSENT_AT_READ" : stale ? "STALE_AT_READ" : "SNAPSHOT_AT_READ",
      limitations: [...LIMITATIONS],
    },
    observed_at: observedAt,
    payload,
  };
}

function normalizeRepository(repository) {
  const root = repositoryRoot(repository.root);
  const documents = repository.documents.map(locator);
  invariant(new Set(documents).size === documents.length, "SOURCE_BINDING_INVALID", "Document allow-list contains duplicates");
  return { ...structuredClone(repository), root, documents };
}

export function validateLocalRepoBinding(config) {
  const repositories = config.repositories.map(normalizeRepository);
  invariant(new Set(repositories.map((item) => item.repository_id)).size === repositories.length, "SOURCE_BINDING_INVALID", "repository_id must be unique");
  invariant(new Set(repositories.map((item) => item.source_id)).size === repositories.length, "SOURCE_BINDING_INVALID", "repository source_id must be unique");
  return { ...structuredClone(config), repositories };
}

export class LocalRepoReadAdapter {
  constructor(binding, { clock = systemClock } = {}) {
    this.binding = validateLocalRepoBinding(binding);
    this.clock = clock;
  }

  repository(repositoryId) {
    const repository = this.binding.repositories.find((item) => item.repository_id === repositoryId);
    invariant(repository, "REPOSITORY_NOT_FOUND", "Repository is not explicitly configured in this workspace", { repository_id: repositoryId });
    return repository;
  }

  document(repositoryId, path, { kind = "DOCUMENT", observedAt = iso(this.clock) } = {}) {
    const repository = this.repository(repositoryId);
    const read = readDocument(repository, path);
    const payload = read.exists
      ? {
          path: read.path,
          content: read.content,
          content_hash: read.content_hash,
          size_bytes: read.size_bytes,
          modified_at: read.modified_at,
          ...(kind === "DECISIONS" ? { sections: decisionSections(read.content) } : {}),
        }
      : null;
    return output(repository, kind, `file:${read.path}`, payload, observedAt, read.modified_at || null);
  }

  git(repositoryId, { observedAt = iso(this.clock) } = {}) {
    const repository = this.repository(repositoryId);
    const head = git(repository.root, ["rev-parse", "HEAD"]);
    const branch = git(repository.root, ["branch", "--show-current"]);
    const statusLines = git(repository.root, ["status", "--porcelain=v1", "--untracked-files=all"]).split("\n").filter(Boolean);
    const history = git(repository.root, ["log", `-${repository.history_limit}`, "--format=%H%x1f%aI%x1f%s"]).split("\n").filter(Boolean).map((line) => {
      const [hash, authored_at, subject] = line.split("\x1f");
      return { hash, authored_at, subject };
    });
    const payload = {
      head,
      branch: branch || null,
      dirty: statusLines.length > 0,
      status: statusLines,
      commits: history,
    };
    return output(repository, "GIT", `git:${repository.repository_id}`, payload, observedAt, history[0]?.authored_at || null);
  }

  resolve(operationId, input) {
    const snapshot = operationId === "repository.git.read"
      ? this.git(input.repository_id)
      : this.document(input.repository_id, input.path, { kind: operationId === "repository.decisions.read" ? "DECISIONS" : "DOCUMENT" });
    return {
      source_id: snapshot.source.source_id,
      resource_ref: `${input.repository_id}:${snapshot.source.locator}`,
      source_version: snapshot.source.source_version,
      snapshot_hash: snapshot.source.snapshot_hash,
      snapshot,
      binding: structuredClone(this.binding),
    };
  }
}
