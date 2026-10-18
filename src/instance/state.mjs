import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AiOsError, invariant } from "../core/errors.mjs";
import { ATLAS } from "../fixtures/atlas.mjs";
import { instancePaths, resolveInstanceRoot } from "./paths.mjs";

const SELECTION_SCHEMA = "ActiveInstanceSelection@v1";

function localAiOsRoot() {
  const base = process.env.LOCALAPPDATA || join(homedir(), ".local", "share");
  return resolve(base, "ai-os");
}

export function activeInstanceSelectionPath() {
  return join(localAiOsRoot(), "active-instance.json");
}

function storeFile(path) {
  if (!existsSync(path)) return { path, present: false, size_bytes: null };
  const stat = statSync(path);
  return { path, present: stat.isFile(), size_bytes: stat.isFile() ? stat.size : null };
}

function readStore(path, table, query) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    return exists ? db.prepare(query).get() || null : null;
  } finally {
    db.close();
  }
}

export function diagnoseInstance(rootInput) {
  const paths = instancePaths(rootInput);
  const kernel = storeFile(paths.kernelDb);
  const taskSource = storeFile(paths.taskDb);
  const diagnostic = {
    schema: "InstanceDiagnostic@v1",
    state: "ABSENT",
    instance_root: paths.root,
    read_only: true,
    instance_id: null,
    mode: null,
    seed: null,
    runtime: null,
    stores: { kernel, task_source: taskSource },
    problems: [],
  };

  if (!existsSync(paths.root)) {
    diagnostic.problems.push("INSTANCE_DIRECTORY_MISSING");
    return diagnostic;
  }

  diagnostic.state = "PARTIAL";
  if (!kernel.present) diagnostic.problems.push("KERNEL_STORE_MISSING");
  else if (kernel.size_bytes === 0) diagnostic.problems.push("KERNEL_STORE_EMPTY");
  if (!taskSource.present) diagnostic.problems.push("TASK_STORE_MISSING");
  else if (taskSource.size_bytes === 0) diagnostic.problems.push("TASK_STORE_EMPTY");
  if (diagnostic.problems.length) return diagnostic;

  try {
    const kernelMeta = readStore(paths.kernelDb, "instance_meta", "SELECT instance_id FROM instance_meta WHERE singleton=1");
    const profile = readStore(paths.kernelDb, "instance_profiles", "SELECT instance_id, mode, seed, runtime FROM instance_profiles WHERE singleton=1");
    const sourceMeta = readStore(paths.taskDb, "source_meta", "SELECT instance_id FROM source_meta WHERE singleton=1");
    const atlasFixture = kernelMeta?.instance_id === ATLAS.instanceId;
    if (!kernelMeta || (!profile && !atlasFixture)) diagnostic.problems.push("KERNEL_SCHEMA_INCOMPLETE");
    if (!sourceMeta) diagnostic.problems.push("TASK_SCHEMA_INCOMPLETE");
    if (kernelMeta && profile && kernelMeta.instance_id !== profile.instance_id) diagnostic.problems.push("KERNEL_INSTANCE_ID_MISMATCH");
    if (kernelMeta && sourceMeta && kernelMeta.instance_id !== sourceMeta.instance_id) diagnostic.problems.push("STORE_INSTANCE_ID_MISMATCH");
    if (diagnostic.problems.length) return diagnostic;
    diagnostic.state = "READY";
    diagnostic.instance_id = kernelMeta.instance_id;
    diagnostic.mode = profile?.mode || "ATLAS_FIXTURE";
    diagnostic.seed = profile?.seed || "SYNTHETIC";
    diagnostic.runtime = profile?.runtime || "CODEX";
    return diagnostic;
  } catch (error) {
    diagnostic.problems.push("STORE_UNREADABLE");
    diagnostic.store_error = error.message;
    return diagnostic;
  }
}

export function assertReadyInstance(rootInput) {
  const diagnostic = diagnoseInstance(rootInput);
  if (diagnostic.state === "READY") return diagnostic;
  const code = diagnostic.state === "ABSENT" ? "INSTANCE_NOT_INITIALIZED" : "INSTANCE_PARTIAL";
  const message = diagnostic.state === "ABSENT"
    ? "Instance does not exist. Complete onboard start, answer, preview and approve before using operational commands"
    : "Instance is incomplete. Resume its onboarding or select another READY instance";
  throw new AiOsError(code, message, {
    diagnostic,
    next_steps: [
      "Run instance diagnose --instance <path>",
      "Complete onboard start, answer, preview and approve for a new instance",
      "Run instance select --instance <path> only after the instance is READY",
    ],
  });
}

export function activeInstanceStatus() {
  const selectionPath = activeInstanceSelectionPath();
  if (!existsSync(selectionPath)) {
    return {
      schema: SELECTION_SCHEMA,
      selected: false,
      selection_path: selectionPath,
      instance_root: null,
      diagnostic: null,
    };
  }
  let selection;
  try {
    selection = JSON.parse(readFileSync(selectionPath, "utf8"));
  } catch (error) {
    throw new AiOsError("ACTIVE_INSTANCE_SELECTION_INVALID", "Active instance selection is not valid JSON", { selection_path: selectionPath, cause: error.message });
  }
  invariant(selection?.schema === SELECTION_SCHEMA && typeof selection.instance_root === "string", "ACTIVE_INSTANCE_SELECTION_INVALID", "Active instance selection has an unsupported format", { selection_path: selectionPath });
  const instanceRoot = resolveInstanceRoot(selection.instance_root);
  return {
    schema: SELECTION_SCHEMA,
    selected: true,
    selection_path: selectionPath,
    instance_root: instanceRoot,
    selected_at: selection.selected_at || null,
    diagnostic: diagnoseInstance(instanceRoot),
  };
}

export function selectActiveInstance(rootInput, { clock = () => new Date() } = {}) {
  const diagnostic = assertReadyInstance(rootInput);
  const selectionPath = activeInstanceSelectionPath();
  mkdirSync(dirname(selectionPath), { recursive: true });
  const selection = {
    schema: SELECTION_SCHEMA,
    instance_root: diagnostic.instance_root,
    instance_id: diagnostic.instance_id,
    selected_at: clock().toISOString(),
  };
  const temporary = `${selectionPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(selection, null, 2)}\n`, "utf8");
  renameSync(temporary, selectionPath);
  return activeInstanceStatus();
}

export function resolveActiveInstance(explicitRoot = null) {
  if (explicitRoot) return assertReadyInstance(explicitRoot).instance_root;
  const active = activeInstanceStatus();
  if (!active.selected) {
    throw new AiOsError("INSTANCE_SELECTION_REQUIRED", "No active instance is selected. Pass --instance <path> or explicitly select a READY instance", {
      selection_path: active.selection_path,
      next_steps: [
        "Run instance diagnose --instance <path>",
        "Run instance select --instance <path>",
      ],
    });
  }
  if (active.diagnostic.state !== "READY") {
    throw new AiOsError("ACTIVE_INSTANCE_UNAVAILABLE", "The selected instance is not READY", {
      diagnostic: active.diagnostic,
      next_steps: [
        "Run instance diagnose --instance <path>",
        "Select another READY instance explicitly",
      ],
    });
  }
  return active.instance_root;
}
