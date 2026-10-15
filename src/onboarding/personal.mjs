import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { AiOsKernel } from "../core/kernel.mjs";
import { AiOsError, invariant } from "../core/errors.mjs";
import { canonicalJson, iso, sha256, systemClock } from "../core/utils.mjs";
import { ensureDirectory, resolveInstanceRoot, resolvePrivateStatePath } from "../instance/paths.mjs";

const RECORD_TYPES = ["PROJECT", "OBJECTIVE", "DECISION", "BLOCKER", "COMMITMENT", "EVENT", "EVIDENCE"];
const LOCAL_REPO_REF = "cap.local-repo-read@0.1.0";

function token() {
  return randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase();
}

function ids() {
  const value = token();
  return {
    instance_id: `INS-${value}`,
    workspace_id: `WS-${value}`,
    principal_id: `PRN-LOCAL-${value}`,
    actor_id: `ACT-OWNER-${value}`,
    confirmed_source_id: `SRC-CONFIRMED-${value}`,
    task_source_id: `SRC-TASKS-${value}`,
    repository_binding_source_id: `SRC-LOCAL-REPOSITORIES-${value}`,
  };
}

function load(pathInput) {
  const path = resolvePrivateStatePath(pathInput);
  invariant(existsSync(path), "ONBOARDING_NOT_FOUND", "Onboarding draft does not exist", { path });
  try {
    return { path, state: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    throw new AiOsError("ONBOARDING_INVALID", "Onboarding draft is not valid JSON", { path, cause: error.message });
  }
}

function save(path, state) {
  ensureDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
  return structuredClone(state);
}

function merge(left, right) {
  if (!right || typeof right !== "object" || Array.isArray(right)) return structuredClone(right);
  const output = left && typeof left === "object" && !Array.isArray(left) ? structuredClone(left) : {};
  for (const [key, value] of Object.entries(right)) {
    output[key] = value && typeof value === "object" && !Array.isArray(value)
      ? merge(output[key], value)
      : structuredClone(value);
  }
  return output;
}

function missingAnswers(answers) {
  const missing = [];
  if (!answers.identity?.display_name?.trim()) missing.push("identity.display_name");
  if (!answers.activity?.trim()) missing.push("activity");
  if (!Array.isArray(answers.objectives) || !answers.objectives.length) missing.push("objectives");
  if (!Array.isArray(answers.sources)) missing.push("sources");
  if (!Array.isArray(answers.capabilities)) missing.push("capabilities");
  if (answers.permissions?.external_connections !== "DISABLED_BY_DEFAULT") missing.push("permissions.external_connections");
  if (answers.permissions?.source_access !== "EXPLICIT_READ_ONLY") missing.push("permissions.source_access");
  if (answers.permissions?.operational_mutations !== "EXACT_PLAN_APPROVAL") missing.push("permissions.operational_mutations");
  if (answers.capture_policy?.raw_conversation !== "DENY") missing.push("capture_policy.raw_conversation");
  if (!Array.isArray(answers.capture_policy?.allowed_record_types) || !answers.capture_policy.allowed_record_types.length) missing.push("capture_policy.allowed_record_types");
  return missing;
}

function validateSources(answers) {
  const repositoryIds = new Set();
  for (const source of answers.sources) {
    invariant(source?.type === "LOCAL_GIT_REPOSITORY", "ONBOARDING_INVALID", "Only explicitly selected local Git repositories are supported");
    for (const field of ["repository_id", "source_id", "root"]) {
      invariant(typeof source[field] === "string" && source[field].length > 0, "ONBOARDING_INVALID", `Local Git source requires ${field}`);
    }
    invariant(!repositoryIds.has(source.repository_id), "ONBOARDING_INVALID", "repository_id must be unique", { repository_id: source.repository_id });
    repositoryIds.add(source.repository_id);
    invariant(Array.isArray(source.documents), "ONBOARDING_INVALID", "Local Git source requires an explicit documents allow-list");
  }
  if (answers.sources.length) {
    invariant(answers.capabilities.includes(LOCAL_REPO_REF), "ONBOARDING_INVALID", "Local Git sources require explicit selection of cap.local-repo-read@0.1.0");
  }
}

function validateAnswers(answers, registry) {
  const missing = missingAnswers(answers);
  invariant(missing.length === 0, "ONBOARDING_INCOMPLETE", "Onboarding still needs required answers", { missing });
  invariant(answers.objectives.every((value) => typeof value === "string" && value.trim().length > 0), "ONBOARDING_INVALID", "Objectives must be non-empty strings");
  invariant(answers.capture_policy.allowed_record_types.every((value) => RECORD_TYPES.includes(value)), "ONBOARDING_INVALID", "Capture policy includes an unsupported record type");
  invariant(answers.capture_policy.retention === "MINIMAL_LOCAL", "ONBOARDING_INVALID", "Generic onboarding supports only minimal local retention");
  const available = new Set(registry.list().map((manifest) => `${manifest.capability_id}@${manifest.capability_version}`));
  const unavailable = answers.capabilities.filter((ref) => !available.has(ref));
  invariant(unavailable.length === 0, "ONBOARDING_INVALID", "Onboarding selected unavailable capabilities", { unavailable });
  validateSources(answers);
}

function buildConfig(state, registry) {
  validateAnswers(state.answers, registry);
  const allowedFields = [
    "event_type",
    "record_type",
    "record_id",
    "actor_id",
    "workspace_id",
    "project_ref",
    "statement",
    "name",
    "objective",
    "status",
    "references",
    "source_hash",
    "occurred_at",
  ];
  return {
    schema: "PersonalInstanceConfig@v1",
    mode: "PERSONAL",
    seed: "NONE",
    runtime: "CODEX",
    external_model_api: "DISABLED",
    external_connections: "DISABLED_BY_DEFAULT",
    instance_id: state.ids.instance_id,
    workspace_id: state.ids.workspace_id,
    principal_id: state.ids.principal_id,
    actor_id: state.ids.actor_id,
    confirmed_source_id: state.ids.confirmed_source_id,
    task_source_id: state.ids.task_source_id,
    presentation_identity: { display_name: state.answers.identity.display_name.trim() },
    activity: state.answers.activity.trim(),
    objectives: state.answers.objectives.map((value) => value.trim()),
    requested_capabilities: [...state.answers.capabilities],
    requested_sources: structuredClone(state.answers.sources),
    permissions: structuredClone(state.answers.permissions),
    data_policy: {
      policy_id: `POL-DATA-${state.ids.instance_id.slice(4)}`,
      version: 1,
      internal_capture: {
        allowed_event_types: ["confirmed_record"],
        allowed_record_types: [...state.answers.capture_policy.allowed_record_types],
        allowed_fields: allowedFields,
        raw_conversation: "DENY",
        purpose: "personal_continuity",
        retention: "MINIMAL_LOCAL",
      },
    },
    action_policy: {
      policy_id: `POL-ACTION-${state.ids.instance_id.slice(4)}`,
      version: 1,
      rules: {
        "cap.personal-record@0.1.0/records.read": "ALLOW_READ",
      },
      approval_ttl_minutes: 15,
    },
  };
}

function publicStatus(state, registry) {
  const missing = missingAnswers(state.answers);
  return {
    schema: state.schema,
    onboarding_id: state.onboarding_id,
    status: state.status,
    instance_root: state.instance_root,
    mode: "PERSONAL",
    seed: "NONE",
    runtime: "CODEX",
    external_model_api: "DISABLED",
    missing,
    resumable: state.status !== "CREATED",
    creation_requires_explicit_approval: true,
    available_capabilities: registry.list().map((manifest) => ({
      capability_ref: `${manifest.capability_id}@${manifest.capability_version}`,
      summary: manifest.competence.summary,
      selected: Array.isArray(state.answers.capabilities) && state.answers.capabilities.includes(`${manifest.capability_id}@${manifest.capability_version}`),
    })),
    preview_hash: state.preview?.preview_hash || null,
    creation: state.creation || null,
  };
}

export function startPersonalOnboarding({ statePath, instanceRoot, registry, clock = systemClock }) {
  const path = resolvePrivateStatePath(statePath);
  const root = resolveInstanceRoot(instanceRoot);
  if (existsSync(path)) {
    const existing = load(path).state;
    invariant(resolve(existing.instance_root) === root, "ONBOARDING_CONFLICT", "Existing onboarding draft targets another instance root");
    return publicStatus(existing, registry);
  }
  const state = {
    schema: "PersonalOnboardingState@v1",
    onboarding_id: `ONB-${token()}`,
    status: "DRAFT",
    instance_root: root,
    ids: ids(),
    answers: {
      identity: { display_name: "" },
      activity: "",
      objectives: [],
      sources: [],
      permissions: {
        source_access: "EXPLICIT_READ_ONLY",
        external_connections: "DISABLED_BY_DEFAULT",
        operational_mutations: "EXACT_PLAN_APPROVAL",
      },
      capture_policy: {
        allowed_record_types: [...RECORD_TYPES],
        raw_conversation: "DENY",
        retention: "MINIMAL_LOCAL",
      },
      capabilities: [],
    },
    preview: null,
    creation: null,
    created_at: iso(clock),
    updated_at: iso(clock),
  };
  save(path, state);
  return publicStatus(state, registry);
}

export function answerPersonalOnboarding({ statePath, answers, registry, clock = systemClock }) {
  const loaded = load(statePath);
  invariant(loaded.state.status !== "CREATED", "ONBOARDING_ALREADY_CREATED", "Created onboarding state cannot be changed");
  invariant(answers && typeof answers === "object" && !Array.isArray(answers), "ONBOARDING_INVALID", "Answers must be a JSON object");
  const merged = merge(loaded.state.answers, answers);
  const unchanged = canonicalJson(merged) === canonicalJson(loaded.state.answers);
  if (!unchanged) {
    loaded.state.answers = merged;
    loaded.state.status = "DRAFT";
    loaded.state.preview = null;
    loaded.state.updated_at = iso(clock);
    save(loaded.path, loaded.state);
  }
  return publicStatus(loaded.state, registry);
}

export function previewPersonalOnboarding({ statePath, registry, clock = systemClock }) {
  const loaded = load(statePath);
  if (loaded.state.status === "CREATED") return publicStatus(loaded.state, registry);
  const config = buildConfig(loaded.state, registry);
  const preview = {
    schema: "PersonalOnboardingPreview@v1",
    instance_root: loaded.state.instance_root,
    config,
    source_count: config.requested_sources.length,
    project_seed_count: 0,
    external_connections_enabled: 0,
    raw_conversation_capture: false,
  };
  preview.preview_hash = sha256(canonicalJson(preview));
  loaded.state.status = "PREVIEWED";
  loaded.state.preview = preview;
  loaded.state.updated_at = iso(clock);
  save(loaded.path, loaded.state);
  return structuredClone(preview);
}

export function approvePersonalOnboarding({ statePath, previewHash, approved, registry, clock = systemClock }) {
  const loaded = load(statePath);
  if (loaded.state.status === "CREATED") {
    invariant(loaded.state.preview?.preview_hash === previewHash, "APPROVAL_MISMATCH", "Approval does not match the created preview");
    return { ...structuredClone(loaded.state.creation), duplicate_request: true };
  }
  invariant(approved === true, "EXPLICIT_APPROVAL_REQUIRED", "Instance creation requires explicit approval");
  invariant(loaded.state.status === "PREVIEWED" && loaded.state.preview, "PREVIEW_REQUIRED", "Preview the exact onboarding configuration before approval");
  invariant(loaded.state.preview.preview_hash === previewHash, "APPROVAL_MISMATCH", "Approval must bind to the exact preview hash");
  const config = buildConfig(loaded.state, registry);
  invariant(sha256(canonicalJson({ ...loaded.state.preview, preview_hash: undefined })) === previewHash, "PREVIEW_CHANGED", "Onboarding preview changed before creation");
  const kernel = new AiOsKernel(loaded.state.instance_root, { registry, clock });
  let initialized;
  try {
    initialized = kernel.initializePersonal(config);
    const repositories = config.requested_sources.filter((source) => source.type === "LOCAL_GIT_REPOSITORY");
    if (repositories.length) {
      kernel.configureCapability({
        capabilityId: "cap.local-repo-read",
        capabilityVersion: "0.1.0",
        principalId: config.principal_id,
        workspaceId: config.workspace_id,
        config: {
          source_id: loaded.state.ids.repository_binding_source_id,
          repositories: repositories.map((source) => ({
            repository_id: source.repository_id,
            source_id: source.source_id,
            root: source.root,
            documents: source.documents,
            max_file_bytes: source.max_file_bytes || 262144,
            history_limit: source.history_limit || 20,
            stale_after_days: source.stale_after_days || 30,
          })),
        },
      });
    }
  } finally {
    kernel.close();
  }
  const creation = {
    schema: "PersonalInstanceCreation@v1",
    status: "CREATED",
    preview_hash: previewHash,
    instance_root: loaded.state.instance_root,
    instance_id: config.instance_id,
    workspace_id: config.workspace_id,
    principal_id: config.principal_id,
    actor_id: config.actor_id,
    mode: "PERSONAL",
    seed: "NONE",
    runtime: "CODEX",
    configured_sources: config.requested_sources.map((source) => ({ type: source.type, repository_id: source.repository_id, source_id: source.source_id })),
    project_seed_count: initialized.project_count,
    task_seed_count: initialized.task_count,
    created_at: iso(clock),
  };
  loaded.state.status = "CREATED";
  loaded.state.creation = creation;
  loaded.state.updated_at = iso(clock);
  save(loaded.path, loaded.state);
  return { ...structuredClone(creation), duplicate_request: false };
}

export function personalOnboardingStatus({ statePath, registry }) {
  return publicStatus(load(statePath).state, registry);
}
