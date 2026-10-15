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
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { AiOsError, invariant } from "../../core/errors.mjs";
import { canonicalJson, sha256, systemClock } from "../../core/utils.mjs";

export const CONTENT_OS_CORE_VERSION = "0.1.0-alpha.1";
export const CONTENT_OS_STATE_SCHEMA_VERSION = 1;
export const CONTENT_OS_CAPABILITY_REF = "cap.content-os-read@0.1.0";

const CONTENT_ID = /^CONTENT-\d{3,}$/;
const OUTPUT_ID = /^OUTPUT-\d{3,}$/;
const ALLOWED_EXTENSIONS = new Set([".md", ".txt", ".json"]);
const REQUIRED_CORE_FILES = ["VERSION", "docs/PRODUCT-BOUNDARY.md", "scripts/validate-content-os.mjs", "templates/instance/state/pieces.json"];
const SOURCE_LIMITS = Object.freeze([
  "SOURCE_STATUS_IS_DECLARED_NOT_INDEPENDENT_EXTERNAL_PROOF",
  "ARTIFACT_EXISTENCE_DOES_NOT_PROVE_DOCUMENT_CLAIMS",
  "SNAPSHOT_IS_HISTORICAL_AFTER_READ_UNLESS_SOURCE_IS_READ_AGAIN",
]);

function pathKey(value) {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function inside(root, target) {
  const value = relative(resolve(root), resolve(target));
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function rootPath(value, label, missingCode = "SOURCE_NOT_FOUND") {
  invariant(typeof value === "string" && value.length > 0 && isAbsolute(value), "ACCESS_DENIED", `${label} must be an explicitly configured absolute path`);
  if (!existsSync(value)) throw new AiOsError(missingCode, `${label} does not exist`);
  const stat = lstatSync(value);
  invariant(stat.isDirectory(), "SOURCE_NOT_FOUND", `${label} is not a directory`);
  invariant(!stat.isSymbolicLink(), "UNSAFE_PATH", `${label} cannot be a symlink, junction or reparse-point alias`);
  return realpathSync.native(value);
}

function normalizedLocator(locator) {
  invariant(typeof locator === "string" && locator.trim().length > 0 && !locator.includes("\0"), "FILE_NOT_ALLOWED", "Artifact locator must be a non-empty relative path");
  invariant(!isAbsolute(locator), "PATH_TRAVERSAL", "Absolute artifact locators are not allowed", { locator });
  const value = normalize(locator.replaceAll(/[\\/]/g, sep));
  invariant(value !== "." && !value.startsWith(`..${sep}`) && value !== "..", "PATH_TRAVERSAL", "Artifact locator escapes INSTANCE_ROOT", { locator });
  return value;
}

function assertNoLinks(root, locator) {
  let current = root;
  for (const part of locator.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) return;
    const stat = lstatSync(current);
    invariant(!stat.isSymbolicLink(), "UNSAFE_PATH", "Symlink, junction or reparse-point aliases are not allowed in source paths", { locator });
  }
}

function scopedPath(root, locator, { allowedRoots = null, allowedFiles = null } = {}) {
  const normalized = normalizedLocator(locator);
  const target = resolve(root, normalized);
  invariant(inside(root, target), "PATH_TRAVERSAL", "Resolved path escapes the configured source root", { locator });
  if (allowedFiles) invariant(allowedFiles.includes(normalized.replaceAll("\\", "/")), "FILE_NOT_ALLOWED", "File is not part of the declared Content OS contract", { locator });
  if (allowedRoots) {
    const first = normalized.split(sep)[0];
    invariant(allowedRoots.includes(first), "FILE_NOT_ALLOWED", "Artifact root is outside the configured read scope", { locator, root: first });
    invariant(ALLOWED_EXTENSIONS.has(extname(normalized).toLowerCase()), "FILE_NOT_ALLOWED", "Artifact type is outside the configured read scope", { locator });
  }
  assertNoLinks(root, normalized);
  return { normalized: normalized.replaceAll("\\", "/"), target };
}

function inspectFile(root, locator, options = {}) {
  const resolved = scopedPath(root, locator, options);
  if (!existsSync(resolved.target)) return { ...resolved, exists: false };
  const realTarget = realpathSync.native(resolved.target);
  const realRoot = realpathSync.native(root);
  invariant(inside(realRoot, realTarget), "UNSAFE_PATH", "Artifact resolves outside INSTANCE_ROOT", { locator });
  const stat = lstatSync(resolved.target);
  invariant(stat.isFile() && !stat.isSymbolicLink(), "FILE_NOT_ALLOWED", "Only regular source files may be read", { locator });
  return { ...resolved, target: realTarget, exists: true, stat };
}

function readFileBounded(root, locator, { maxBytes, missingCode = "SOURCE_UNAVAILABLE", ...scope }) {
  const inspected = inspectFile(root, locator, scope);
  if (!inspected.exists) throw new AiOsError(missingCode, "Required source file is unavailable", { locator: inspected.normalized });
  invariant(inspected.stat.size <= maxBytes, "SOURCE_FILE_TOO_LARGE", "Source file exceeds its configured size limit", { locator: inspected.normalized, size: inspected.stat.size, max_bytes: maxBytes });
  let descriptor;
  try {
    descriptor = openSync(inspected.target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const before = fstatSync(descriptor);
    invariant(before.isFile() && before.size <= maxBytes, "FILE_NOT_ALLOWED", "Source path is not a permitted regular file", { locator: inspected.normalized });
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    invariant(before.size === after.size && before.mtimeMs === after.mtimeMs, "SOURCE_CHANGED", "Source file changed while it was being read", { locator: inspected.normalized });
    invariant(pathKey(realpathSync.native(inspected.target)) === pathKey(inspected.target), "SOURCE_CHANGED", "Source path changed while it was being read", { locator: inspected.normalized });
    return { locator: inspected.normalized, content, content_hash: sha256(content) };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseJsonFile(file, code = "INVALID_SOURCE_JSON") {
  try {
    return JSON.parse(file.content.toString("utf8"));
  } catch (error) {
    throw new AiOsError(code, "Content OS source contains invalid JSON", { locator: file.locator, cause: error.message });
  }
}

function validateRelationships(state) {
  invariant(Array.isArray(state.pieces) && Array.isArray(state.outputs), "INVALID_SOURCE_JSON", "Content OS state must contain pieces and outputs arrays");
  const content = new Map();
  for (const piece of state.pieces) {
    invariant(piece && typeof piece === "object" && CONTENT_ID.test(piece.id || "") && !content.has(piece.id), "INVALID_RELATIONSHIP", "CONTENT identity is invalid or duplicated");
    content.set(piece.id, piece);
  }
  const outputs = new Map();
  for (const output of state.outputs) {
    invariant(output && typeof output === "object" && OUTPUT_ID.test(output.output_id || "") && !outputs.has(output.output_id), "INVALID_RELATIONSHIP", "OUTPUT identity is invalid or duplicated");
    invariant(content.has(output.content_id), "INVALID_RELATIONSHIP", "OUTPUT references an unknown CONTENT", { output_id: output.output_id, content_id: output.content_id });
    invariant(["DIRECT", "REPURPOSED"].includes(output.origin), "INVALID_RELATIONSHIP", "OUTPUT origin is invalid", { output_id: output.output_id });
    invariant(output.origin !== "DIRECT" || output.source_output_id == null, "INVALID_RELATIONSHIP", "DIRECT OUTPUT cannot reference a source OUTPUT", { output_id: output.output_id });
    invariant(output.origin !== "REPURPOSED" || typeof output.source_output_id === "string", "INVALID_RELATIONSHIP", "REPURPOSED OUTPUT requires source_output_id", { output_id: output.output_id });
    outputs.set(output.output_id, output);
  }
  for (const output of outputs.values()) {
    if (output.origin !== "REPURPOSED") continue;
    const source = outputs.get(output.source_output_id);
    invariant(source && source.content_id === output.content_id, "INVALID_RELATIONSHIP", "REPURPOSED provenance must reference an OUTPUT of the same CONTENT", { output_id: output.output_id });
    const visited = new Set([output.output_id]);
    let current = output;
    while (current?.source_output_id) {
      invariant(!visited.has(current.source_output_id), "INVALID_RELATIONSHIP", "OUTPUT provenance contains a cycle", { output_id: output.output_id });
      visited.add(current.source_output_id);
      current = outputs.get(current.source_output_id);
      invariant(current, "INVALID_RELATIONSHIP", "OUTPUT provenance references an unknown source", { output_id: output.output_id });
    }
  }
  return { content, outputs };
}

function snapshotVersion(hash) {
  const value = Number.parseInt(hash.slice("sha256:".length, "sha256:".length + 12), 16);
  return value || 1;
}

function sourceMetadata(binding, snapshot, readAsOf) {
  return {
    system: "content-os",
    source_id: binding.source_id,
    source_instance_id: binding.source_instance_id,
    core_version: binding.core_version,
    state_schema_version: binding.state_schema_version,
    snapshot_hash: snapshot.hash,
    source_version: snapshot.version,
    read_as_of: readAsOf,
    freshness: "SNAPSHOT_AT_READ",
    authority: "EXTERNAL",
    limitations: [...SOURCE_LIMITS],
  };
}

function evidenceSourceValue(value, index) {
  if (typeof value === "string") return { evidence_id: `SOURCE-EVIDENCE-${index + 1}`, locator: value, supports: [] };
  if (!value || typeof value !== "object") return { evidence_id: `SOURCE-EVIDENCE-${index + 1}`, locator: "", supports: [] };
  return {
    evidence_id: typeof value.evidence_id === "string" ? value.evidence_id : `SOURCE-EVIDENCE-${index + 1}`,
    locator: typeof value.locator === "string" ? value.locator : "",
    supports: Array.isArray(value.supports) ? value.supports.filter((item) => typeof item === "string") : [],
  };
}

export class ContentOsReadAdapter {
  constructor(binding, { clock = systemClock } = {}) {
    this.binding = structuredClone(binding);
    this.clock = clock;
    this.coreRoot = rootPath(binding.core_root, "CORE_ROOT");
    this.instanceRoot = rootPath(binding.instance_root, "INSTANCE_ROOT");
    invariant(pathKey(this.coreRoot) !== pathKey(this.instanceRoot) && !inside(this.coreRoot, this.instanceRoot), "ACCESS_DENIED", "INSTANCE_ROOT must remain outside CORE_ROOT");
  }

  assertCompatible() {
    for (const locator of REQUIRED_CORE_FILES) {
      const file = inspectFile(this.coreRoot, locator, { allowedFiles: REQUIRED_CORE_FILES });
      if (!file.exists) throw new AiOsError("SOURCE_NOT_FOUND", "Configured CORE_ROOT is not a compatible Content OS installation", { missing: locator });
    }
    const version = readFileBounded(this.coreRoot, "VERSION", { maxBytes: 128, allowedFiles: REQUIRED_CORE_FILES, missingCode: "SOURCE_NOT_FOUND" }).content.toString("utf8").trim();
    invariant(version === this.binding.core_version && version === CONTENT_OS_CORE_VERSION, "UNSUPPORTED_SCHEMA", "Content OS core version is unsupported", { observed: version, supported: CONTENT_OS_CORE_VERSION });
    return version;
  }

  loadSnapshot() {
    this.assertCompatible();
    const file = readFileBounded(this.instanceRoot, "state/pieces.json", {
      maxBytes: this.binding.scope.max_state_bytes,
      allowedFiles: ["state/pieces.json"],
      missingCode: "SOURCE_UNAVAILABLE",
    });
    const state = parseJsonFile(file);
    invariant(state?.schema_version === this.binding.state_schema_version && state.schema_version === CONTENT_OS_STATE_SCHEMA_VERSION, "UNSUPPORTED_SCHEMA", "Content OS state schema is unsupported", { observed: state?.schema_version, supported: CONTENT_OS_STATE_SCHEMA_VERSION });
    invariant(typeof state.updated_at === "string" && !Number.isNaN(Date.parse(state.updated_at)), "INVALID_SOURCE_JSON", "Content OS state updated_at is invalid");
    const indexes = validateRelationships(state);
    return { state, indexes, hash: file.content_hash, version: snapshotVersion(file.content_hash) };
  }

  assertSnapshot(hash) {
    const current = this.loadSnapshot();
    invariant(current.hash === hash, "SOURCE_CHANGED", "Content OS state changed during the read", { expected_snapshot: hash, observed_snapshot: current.hash });
    return current;
  }

  artifact(locator, key, includeContent) {
    const normalized = normalizedLocator(locator);
    const first = normalized.split(sep)[0];
    if (!this.binding.scope.allowed_artifact_roots.includes(first)) {
      return { key, locator: normalized.replaceAll("\\", "/"), availability: "NOT_AUTHORIZED", authorized: false, content_read: false, content_hash: null, content: null };
    }
    const inspected = inspectFile(this.instanceRoot, normalized, { allowedRoots: this.binding.scope.allowed_artifact_roots });
    if (!inspected.exists) {
      return { key, locator: inspected.normalized, availability: "MISSING", authorized: true, content_read: false, content_hash: null, content: null };
    }
    if (!includeContent) {
      return { key, locator: inspected.normalized, availability: "AVAILABLE", authorized: true, content_read: false, content_hash: null, content: null };
    }
    const file = readFileBounded(this.instanceRoot, normalized, { maxBytes: this.binding.scope.max_artifact_bytes, allowedRoots: this.binding.scope.allowed_artifact_roots, missingCode: "ARTIFACT_NOT_FOUND" });
    return { key, locator: file.locator, availability: "READ", authorized: true, content_read: true, content_hash: file.content_hash, content: file.content.toString("utf8") };
  }

  contentReference(piece, snapshot, readAsOf, includeArtifacts = false) {
    const artifacts = Object.entries(piece.artifacts || {}).map(([key, locator]) => this.artifact(locator, key, includeArtifacts));
    const evidence = (piece.state_evidence || []).map(evidenceSourceValue).map((item) => {
      if (!item.locator) return { ...item, availability: "MISSING", content_read: false, content_hash: null };
      const artifact = this.artifact(item.locator, `evidence:${item.evidence_id}`, includeArtifacts);
      return { evidence_id: item.evidence_id, locator: artifact.locator, supports: item.supports, availability: artifact.availability, content_read: artifact.content_read, content_hash: artifact.content_hash };
    });
    return {
      schema: "ExternalContentReference@v1",
      source_system: "content-os",
      source_instance_id: this.binding.source_instance_id,
      content_id: piece.id,
      title: typeof piece.working_title === "string" ? piece.working_title : null,
      editorial_question: typeof piece.editorial_question === "string" ? piece.editorial_question : null,
      stage: typeof piece.stage === "string" ? piece.stage : null,
      status: typeof piece.status === "string" ? piece.status : null,
      status_basis: "SOURCE_DECLARED_NOT_EXTERNALLY_VERIFIED",
      evidence,
      artifacts,
      snapshot_hash: snapshot.hash,
      read_as_of: readAsOf,
      limitations: [...SOURCE_LIMITS],
    };
  }

  outputReference(output, snapshot, readAsOf, includeArtifact = false) {
    const artifact = typeof output.artifact === "string" ? this.artifact(output.artifact, "output", includeArtifact) : null;
    return {
      schema: "ExternalOutputReference@v1",
      source_system: "content-os",
      source_instance_id: this.binding.source_instance_id,
      output_id: output.output_id,
      content_id: output.content_id,
      channel: typeof output.channel === "string" ? output.channel : null,
      format: typeof output.format === "string" ? output.format : null,
      origin: output.origin,
      source_output_id: output.source_output_id ?? null,
      status: typeof output.status === "string" ? output.status : null,
      status_basis: "SOURCE_DECLARED_NOT_EXTERNALLY_VERIFIED",
      artifact,
      snapshot_hash: snapshot.hash,
      read_as_of: readAsOf,
      limitations: [...SOURCE_LIMITS],
    };
  }

  resolve(operationId, input) {
    const snapshot = this.loadSnapshot();
    let resourceRef = `${this.binding.source_instance_id}:summary`;
    if (operationId === "content.item.read") {
      invariant(snapshot.indexes.content.has(input.content_id), "CONTENT_NOT_FOUND", "CONTENT does not exist in the configured source scope", { content_id: input.content_id });
      resourceRef = `${this.binding.source_instance_id}:content:${input.content_id}`;
    } else if (operationId === "content.output.read") {
      invariant(snapshot.indexes.outputs.has(input.output_id), "OUTPUT_NOT_FOUND", "OUTPUT does not exist in the configured source scope", { output_id: input.output_id });
      resourceRef = `${this.binding.source_instance_id}:output:${input.output_id}`;
    }
    this.assertSnapshot(snapshot.hash);
    return { source_id: this.binding.source_id, resource_ref: resourceRef, source_version: snapshot.version, snapshot_hash: snapshot.hash, binding: structuredClone(this.binding) };
  }

  readSummary({ readAsOf = this.clock().toISOString(), expectedSnapshot = null } = {}) {
    const snapshot = this.loadSnapshot();
    if (expectedSnapshot) invariant(snapshot.hash === expectedSnapshot, "SOURCE_CHANGED", "Content OS state changed before the handler read", { expected_snapshot: expectedSnapshot, observed_snapshot: snapshot.hash });
    const content = [...snapshot.indexes.content.values()].map((piece) => this.contentReference(piece, snapshot, readAsOf, false));
    const outputs = [...snapshot.indexes.outputs.values()].map((output) => this.outputReference(output, snapshot, readAsOf, false));
    this.assertSnapshot(snapshot.hash);
    return {
      schema: "ContentOsReadResult@v1",
      kind: "SUMMARY",
      source: sourceMetadata(this.binding, snapshot, readAsOf),
      summary: { content_count: content.length, output_count: outputs.length, content, outputs },
      content: null,
      output: null,
      related_outputs: [],
      provenance_chain: [],
    };
  }

  readContent(contentId, { includeArtifacts = false, readAsOf = this.clock().toISOString(), expectedSnapshot = null } = {}) {
    invariant(this.binding.scope.records.includes("CONTENT"), "ACCESS_DENIED", "Binding scope does not permit CONTENT records");
    const snapshot = this.loadSnapshot();
    if (expectedSnapshot) invariant(snapshot.hash === expectedSnapshot, "SOURCE_CHANGED", "Content OS state changed before the handler read", { expected_snapshot: expectedSnapshot, observed_snapshot: snapshot.hash });
    const piece = snapshot.indexes.content.get(contentId);
    invariant(piece, "CONTENT_NOT_FOUND", "CONTENT does not exist in the configured source scope", { content_id: contentId });
    const content = this.contentReference(piece, snapshot, readAsOf, includeArtifacts);
    const relatedOutputs = [...snapshot.indexes.outputs.values()].filter((output) => output.content_id === contentId).map((output) => this.outputReference(output, snapshot, readAsOf, false));
    this.assertSnapshot(snapshot.hash);
    return {
      schema: "ContentOsReadResult@v1",
      kind: "CONTENT",
      source: sourceMetadata(this.binding, snapshot, readAsOf),
      summary: null,
      content,
      output: null,
      related_outputs: relatedOutputs,
      provenance_chain: [],
    };
  }

  readOutput(outputId, { includeArtifact = false, readAsOf = this.clock().toISOString(), expectedSnapshot = null } = {}) {
    invariant(this.binding.scope.records.includes("OUTPUT"), "ACCESS_DENIED", "Binding scope does not permit OUTPUT records");
    const snapshot = this.loadSnapshot();
    if (expectedSnapshot) invariant(snapshot.hash === expectedSnapshot, "SOURCE_CHANGED", "Content OS state changed before the handler read", { expected_snapshot: expectedSnapshot, observed_snapshot: snapshot.hash });
    const outputValue = snapshot.indexes.outputs.get(outputId);
    invariant(outputValue, "OUTPUT_NOT_FOUND", "OUTPUT does not exist in the configured source scope", { output_id: outputId });
    const piece = snapshot.indexes.content.get(outputValue.content_id);
    invariant(piece, "INVALID_RELATIONSHIP", "OUTPUT references an unknown CONTENT", { output_id: outputId });
    const chain = [];
    let current = outputValue;
    while (current) {
      chain.push(current.output_id);
      current = current.source_output_id ? snapshot.indexes.outputs.get(current.source_output_id) : null;
    }
    const output = this.outputReference(outputValue, snapshot, readAsOf, includeArtifact);
    const content = this.contentReference(piece, snapshot, readAsOf, false);
    this.assertSnapshot(snapshot.hash);
    return {
      schema: "ContentOsReadResult@v1",
      kind: "OUTPUT",
      source: sourceMetadata(this.binding, snapshot, readAsOf),
      summary: null,
      content,
      output,
      related_outputs: [],
      provenance_chain: chain,
    };
  }
}

export function validateContentOsBinding(config) {
  const adapter = new ContentOsReadAdapter(config);
  const snapshot = adapter.loadSnapshot();
  adapter.assertSnapshot(snapshot.hash);
  return {
    config: {
      ...structuredClone(config),
      core_root: adapter.coreRoot,
      instance_root: adapter.instanceRoot,
    },
    snapshot_hash: snapshot.hash,
    source_version: snapshot.version,
    content_count: snapshot.state.pieces.length,
    output_count: snapshot.state.outputs.length,
  };
}

export function resultFingerprint(result) {
  return sha256(canonicalJson(result));
}
