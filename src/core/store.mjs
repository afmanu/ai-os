import { DatabaseSync } from "node:sqlite";
import { AiOsError, invariant } from "./errors.mjs";
import { canonicalJson, iso, parseJson, sha256, systemClock } from "./utils.mjs";
import {
  ATLAS,
  atlasActionPolicy,
  atlasDataPolicy,
  atlasProject,
  atlasTask,
} from "../fixtures/atlas.mjs";

const transitionMap = new Map([
  ["CREATED", new Set(["PLANNED", "RUNNING", "FAILED"])],
  ["PLANNED", new Set(["AWAITING_APPROVAL"])],
  ["AWAITING_APPROVAL", new Set(["READY", "FAILED"])],
  ["READY", new Set(["EFFECT_INTENT_PERSISTED", "FAILED"])],
  ["EFFECT_INTENT_PERSISTED", new Set(["RUNNING", "INTERRUPTED", "UNKNOWN_EFFECT", "RECONCILING_READ_ONLY", "FAILED"])],
  ["RUNNING", new Set(["VERIFYING", "INTERRUPTED", "UNKNOWN_EFFECT", "FAILED"])],
  ["VERIFYING", new Set(["SUCCEEDED", "VERIFICATION_FAILED", "UNKNOWN_EFFECT", "FAILED"])],
  ["UNKNOWN_EFFECT", new Set(["RECONCILING_READ_ONLY"])],
  ["INTERRUPTED", new Set(["RECONCILING_READ_ONLY"])],
  ["RECONCILING_READ_ONLY", new Set(["SUCCEEDED", "VERIFICATION_FAILED", "UNKNOWN_EFFECT", "INTERRUPTED"])],
]);

export const executionTransitions = transitionMap;

function openDatabase(path) {
  try {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA journal_mode = DELETE;");
    return db;
  } catch (error) {
    throw new AiOsError("STORE_CORRUPT", "Kernel store could not be opened", { path, cause: error.message });
  }
}

function rowObject(row) {
  return row ? { ...row } : null;
}

function planFromRow(row) {
  if (!row) return null;
  return { ...parseJson(row.plan_json), state: row.state };
}

function grantFromRow(row) {
  if (!row) return null;
  return {
    schema: "MutationGrant@v1",
    grant_id: row.grant_id,
    plan_id: row.plan_id,
    plan_hash: row.plan_hash,
    approver_actor_id: row.approver_actor_id,
    executor_actor_id: row.executor_actor_id,
    workspace_id: row.workspace_id,
    source_id: row.source_id,
    resource_ref: row.resource_ref,
    capability_id: row.capability_id,
    capability_version: row.capability_version,
    operation_id: row.operation_id,
    policy_id: row.policy_id,
    policy_version: row.policy_version,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    max_uses: row.max_uses,
    use_count: row.use_count,
    consumed_at: row.consumed_at,
    execution_id: row.execution_id,
  };
}

function executionFromRow(row) {
  if (!row) return null;
  return {
    ...rowObject(row),
    input: parseJson(row.input_json),
    receipt: parseJson(row.receipt_json),
    error: parseJson(row.error_json),
  };
}

function resultFromRow(row) {
  if (!row) return null;
  return parseJson(row.result_json);
}

function migrateExecutionsV2(db) {
  const columns = db.prepare("PRAGMA table_info(executions)").all();
  const planId = columns.find((column) => column.name === "plan_id");
  if (!planId || planId.notnull === 0) return;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      DROP INDEX IF EXISTS idx_execution_scope_key;
      ALTER TABLE execution_transitions RENAME TO execution_transitions_p1;
      ALTER TABLE results RENAME TO results_p1;
      ALTER TABLE resource_locks RENAME TO resource_locks_p1;
      ALTER TABLE artifacts RENAME TO artifacts_p1;
      ALTER TABLE executions RENAME TO executions_p1;
      CREATE TABLE executions (
        execution_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
        actor_id TEXT NOT NULL REFERENCES actors(actor_id),
        plan_id TEXT REFERENCES plans(plan_id),
        plan_hash TEXT,
        grant_id TEXT UNIQUE REFERENCES grants(grant_id),
        source_id TEXT NOT NULL,
        resource_ref TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        capability_version TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        effect_class TEXT NOT NULL,
        policy_id TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        expected_source_version INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        input_hash TEXT,
        input_json TEXT,
        state TEXT NOT NULL,
        checkpoint_at TEXT NOT NULL,
        receipt_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO executions(
        execution_id, workspace_id, actor_id, plan_id, plan_hash, grant_id, source_id, resource_ref,
        capability_id, capability_version, operation_id, effect_class, policy_id, policy_version,
        expected_source_version, idempotency_key, input_hash, input_json, state, checkpoint_at,
        receipt_json, error_json, created_at, updated_at
      ) SELECT
        execution_id, workspace_id, actor_id, plan_id, plan_hash, grant_id, source_id, resource_ref,
        capability_id, capability_version, operation_id, 'OPERATIONAL_MUTATION', policy_id, policy_version,
        expected_source_version, idempotency_key, plan_hash, NULL, state, checkpoint_at,
        receipt_json, error_json, created_at, updated_at
      FROM executions_p1;
      CREATE UNIQUE INDEX idx_execution_scope_key ON executions(actor_id, workspace_id, source_id, resource_ref, capability_id, capability_version, operation_id, idempotency_key);
      CREATE TABLE execution_transitions (
        transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT NOT NULL REFERENCES executions(execution_id),
        from_state TEXT,
        to_state TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      INSERT INTO execution_transitions SELECT * FROM execution_transitions_p1;
      CREATE TABLE results (
        result_id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
        resource_ref TEXT NOT NULL,
        outcome TEXT NOT NULL,
        verified INTEGER NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO results SELECT * FROM results_p1;
      CREATE TABLE resource_locks (
        workspace_id TEXT NOT NULL,
        resource_ref TEXT NOT NULL,
        execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
        acquired_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, resource_ref)
      );
      INSERT INTO resource_locks SELECT * FROM resource_locks_p1;
      CREATE TABLE artifacts (
        artifact_id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
        capability_id TEXT NOT NULL,
        capability_version TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        resource_ref TEXT NOT NULL,
        artifact_kind TEXT NOT NULL,
        source_version INTEGER NOT NULL,
        content_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO artifacts SELECT * FROM artifacts_p1;
      DROP TABLE execution_transitions_p1;
      DROP TABLE results_p1;
      DROP TABLE resource_locks_p1;
      DROP TABLE artifacts_p1;
      DROP TABLE executions_p1;
      COMMIT;
    `);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

export class KernelStore {
  constructor(path, { clock = systemClock } = {}) {
    this.path = path;
    this.clock = clock;
    this.db = openDatabase(path);
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  initialize(instanceId = ATLAS.instanceId) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS instance_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        instance_id TEXT NOT NULL UNIQUE,
        schema_version INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS instance_profiles (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        instance_id TEXT NOT NULL UNIQUE,
        mode TEXT NOT NULL,
        seed TEXT NOT NULL,
        runtime TEXT NOT NULL,
        config_json TEXT NOT NULL,
        config_hash TEXT NOT NULL,
        configured_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        classification TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS actors (
        actor_id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        principal_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS actor_workspaces (
        actor_id TEXT NOT NULL REFERENCES actors(actor_id),
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
        role TEXT NOT NULL,
        PRIMARY KEY (actor_id, workspace_id)
      );
      CREATE TABLE IF NOT EXISTS sources (
        source_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
        kind TEXT NOT NULL,
        authority_scope_json TEXT NOT NULL,
        classification TEXT NOT NULL,
        PRIMARY KEY (workspace_id, source_id)
      );
      CREATE TABLE IF NOT EXISTS source_bindings (
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
        capability_ref TEXT NOT NULL,
        source_id TEXT NOT NULL,
        adapter_kind TEXT NOT NULL,
        config_json TEXT NOT NULL,
        config_hash TEXT NOT NULL,
        configured_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, capability_ref),
        FOREIGN KEY (workspace_id, source_id) REFERENCES sources(workspace_id, source_id)
      );
      CREATE TABLE IF NOT EXISTS policies (
        policy_id TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
        policy_kind TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        PRIMARY KEY (workspace_id, policy_id, policy_version)
      );
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
        source_id TEXT NOT NULL,
        name TEXT NOT NULL,
        objective_id TEXT,
        objective TEXT,
        owner_actor_id TEXT REFERENCES actors(actor_id),
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        classification TEXT NOT NULL,
        PRIMARY KEY (workspace_id, project_id)
      );
      CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(workspace_id, name);
      CREATE TABLE IF NOT EXISTS task_refs (
        task_ref TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
        project_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        last_source_version INTEGER,
        last_snapshot_json TEXT,
        observed_at TEXT,
        PRIMARY KEY (workspace_id, task_ref),
        FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, project_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
        actor_id TEXT NOT NULL REFERENCES actors(actor_id),
        event_type TEXT NOT NULL,
        project_ref TEXT,
        task_ref TEXT,
        payload_json TEXT NOT NULL,
        policy_id TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        source_hash TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_scope ON events(workspace_id, project_ref, task_ref, occurred_at);
      CREATE TABLE IF NOT EXISTS evidence (
        evidence_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
        source_id TEXT NOT NULL,
        locator TEXT NOT NULL,
        claims_json TEXT NOT NULL,
        authority_kind TEXT NOT NULL,
        authority_ref TEXT,
        observed_at TEXT NOT NULL,
        evidence_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_evidence_scope ON evidence(workspace_id, source_id, observed_at);
      CREATE TABLE IF NOT EXISTS decisions (
        decision_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
        actor_id TEXT REFERENCES actors(actor_id),
        decision_type TEXT NOT NULL,
        subject_ref TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plans (
        plan_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
        actor_id TEXT NOT NULL REFERENCES actors(actor_id),
        source_id TEXT NOT NULL,
        resource_ref TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        capability_version TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        policy_id TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        expected_source_version INTEGER NOT NULL,
        patch_json TEXT NOT NULL,
        patch_hash TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        plan_hash TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS grants (
        grant_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL UNIQUE REFERENCES plans(plan_id),
        plan_hash TEXT NOT NULL,
        approver_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
        executor_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
        source_id TEXT NOT NULL,
        resource_ref TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        capability_version TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        policy_id TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        max_uses INTEGER NOT NULL CHECK (max_uses = 1),
        use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count BETWEEN 0 AND 1),
        consumed_at TEXT,
        execution_id TEXT
      );
      CREATE TABLE IF NOT EXISTS executions (
        execution_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
        actor_id TEXT NOT NULL REFERENCES actors(actor_id),
        plan_id TEXT REFERENCES plans(plan_id),
        plan_hash TEXT,
        grant_id TEXT UNIQUE REFERENCES grants(grant_id),
        source_id TEXT NOT NULL,
        resource_ref TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        capability_version TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        effect_class TEXT NOT NULL DEFAULT 'OPERATIONAL_MUTATION',
        policy_id TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        expected_source_version INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        input_hash TEXT,
        input_json TEXT,
        state TEXT NOT NULL,
        checkpoint_at TEXT NOT NULL,
        receipt_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_scope_key ON executions(actor_id, workspace_id, source_id, resource_ref, capability_id, capability_version, operation_id, idempotency_key);
      CREATE TABLE IF NOT EXISTS execution_transitions (
        transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT NOT NULL REFERENCES executions(execution_id),
        from_state TEXT,
        to_state TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS results (
        result_id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
        resource_ref TEXT NOT NULL,
        outcome TEXT NOT NULL,
        verified INTEGER NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resource_locks (
        workspace_id TEXT NOT NULL,
        resource_ref TEXT NOT NULL,
        execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
        acquired_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, resource_ref)
      );
      CREATE TABLE IF NOT EXISTS phase_metrics (
        metric_id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT,
        workspace_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        duration_ms REAL NOT NULL,
        model_calls INTEGER NOT NULL DEFAULT 0,
        recorded_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS capability_activations (
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
        capability_ref TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        capability_version TEXT NOT NULL,
        contract_state TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        errors_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, capability_ref)
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
        capability_id TEXT NOT NULL,
        capability_version TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        resource_ref TEXT NOT NULL,
        artifact_kind TEXT NOT NULL,
        source_version INTEGER NOT NULL,
        content_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    migrateExecutionsV2(this.db);
    const now = iso(this.clock);
    this.db.prepare("INSERT OR IGNORE INTO instance_meta(singleton, instance_id, schema_version, created_at) VALUES(1, ?, 4, ?)").run(instanceId, now);
    this.db.prepare("UPDATE instance_meta SET schema_version=4 WHERE singleton=1 AND schema_version<4").run();
    const meta = this.db.prepare("SELECT instance_id FROM instance_meta WHERE singleton=1").get();
    invariant(meta.instance_id === instanceId, "INSTANCE_MISMATCH", "Kernel store belongs to a different instance");
  }

  seedAtlas() {
    const now = iso(this.clock);
    this.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO workspaces(workspace_id, instance_id, kind, classification, created_at) VALUES(?, ?, 'personal', 'synthetic', ?)").run(ATLAS.workspaceId, ATLAS.instanceId, now);
      this.db.prepare("INSERT OR IGNORE INTO actors(actor_id, instance_id, principal_id, kind, created_at) VALUES(?, ?, ?, 'local', ?)").run(ATLAS.actorId, ATLAS.instanceId, ATLAS.principalId, now);
      this.db.prepare("INSERT OR IGNORE INTO actor_workspaces(actor_id, workspace_id, role) VALUES(?, ?, 'owner')").run(ATLAS.actorId, ATLAS.workspaceId);
      const sourceInsert = this.db.prepare("INSERT OR IGNORE INTO sources(source_id, workspace_id, kind, authority_scope_json, classification) VALUES(?, ?, ?, ?, 'synthetic')");
      sourceInsert.run(ATLAS.userSourceId, ATLAS.workspaceId, "human_statement", canonicalJson(["project_status_context", "user_intent"]));
      sourceInsert.run(ATLAS.projectSourceId, ATLAS.workspaceId, "project_fixture", canonicalJson(["project_identity", "objective"]));
      sourceInsert.run(ATLAS.taskSourceId, ATLAS.workspaceId, "task_system", canonicalJson(["task_operational_state"]));
      const policyInsert = this.db.prepare("INSERT OR IGNORE INTO policies(policy_id, policy_version, workspace_id, policy_kind, policy_json) VALUES(?, ?, ?, ?, ?)");
      policyInsert.run(ATLAS.dataPolicyId, 1, ATLAS.workspaceId, "data", canonicalJson(atlasDataPolicy));
      policyInsert.run(ATLAS.actionPolicyId, 1, ATLAS.workspaceId, "action", canonicalJson(atlasActionPolicy));
      this.db.prepare(`INSERT OR IGNORE INTO projects(project_id, workspace_id, source_id, name, objective_id, objective, owner_actor_id, status, version, classification)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(atlasProject.project_id, ATLAS.workspaceId, ATLAS.projectSourceId, atlasProject.name, atlasProject.objective_id, atlasProject.objective, atlasProject.owner_actor_id, atlasProject.status, atlasProject.version, atlasProject.classification);
      this.db.prepare(`INSERT OR IGNORE INTO task_refs(task_ref, workspace_id, project_id, source_id, last_source_version, last_snapshot_json, observed_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)`)
        .run(ATLAS.taskId, ATLAS.workspaceId, ATLAS.projectId, ATLAS.taskSourceId, atlasTask.version, canonicalJson(atlasTask), atlasTask.updated_at);
    });
  }

  seedPersonal(config) {
    const now = iso(this.clock);
    const configJson = canonicalJson(config);
    const configHash = sha256(configJson);
    this.transaction(() => {
      const existing = this.db.prepare("SELECT instance_id, config_hash FROM instance_profiles WHERE singleton=1").get();
      if (existing) {
        invariant(existing.instance_id === config.instance_id && existing.config_hash === configHash, "INSTANCE_CONFIGURATION_MISMATCH", "Existing personal instance was initialized with different configuration");
        return;
      }
      this.db.prepare(`INSERT INTO instance_profiles(singleton, instance_id, mode, seed, runtime, config_json, config_hash, configured_at)
        VALUES(1, ?, ?, ?, ?, ?, ?, ?)`).run(config.instance_id, config.mode, config.seed, config.runtime, configJson, configHash, now);
      this.db.prepare("INSERT INTO workspaces(workspace_id, instance_id, kind, classification, created_at) VALUES(?, ?, 'personal', 'private', ?)")
        .run(config.workspace_id, config.instance_id, now);
      this.db.prepare("INSERT INTO actors(actor_id, instance_id, principal_id, kind, created_at) VALUES(?, ?, ?, 'local', ?)")
        .run(config.actor_id, config.instance_id, config.principal_id, now);
      this.db.prepare("INSERT INTO actor_workspaces(actor_id, workspace_id, role) VALUES(?, ?, 'owner')")
        .run(config.actor_id, config.workspace_id);
      this.db.prepare("INSERT INTO sources(source_id, workspace_id, kind, authority_scope_json, classification) VALUES(?, ?, 'human_confirmation', ?, 'private')")
        .run(config.confirmed_source_id, config.workspace_id, canonicalJson(["confirmed_record", "explicit_reference"]));
      const policyInsert = this.db.prepare("INSERT INTO policies(policy_id, policy_version, workspace_id, policy_kind, policy_json) VALUES(?, 1, ?, ?, ?)");
      policyInsert.run(config.data_policy.policy_id, config.workspace_id, "data", canonicalJson(config.data_policy));
      policyInsert.run(config.action_policy.policy_id, config.workspace_id, "action", canonicalJson(config.action_policy));
    });
    return this.instanceProfile();
  }

  meta() {
    return rowObject(this.db.prepare("SELECT * FROM instance_meta WHERE singleton=1").get());
  }

  instanceProfile() {
    const row = this.db.prepare("SELECT * FROM instance_profiles WHERE singleton=1").get();
    return row ? { ...rowObject(row), config: parseJson(row.config_json) } : null;
  }

  defaultIdentity() {
    const profile = this.instanceProfile()?.config;
    if (profile?.principal_id && profile?.workspace_id) {
      return this.resolveIdentity(profile.principal_id, profile.workspace_id);
    }
    const atlas = this.db.prepare(`SELECT a.actor_id, a.principal_id, aw.workspace_id, aw.role
      FROM actors a JOIN actor_workspaces aw ON aw.actor_id=a.actor_id
      WHERE a.principal_id=? AND aw.workspace_id=?`).get(ATLAS.principalId, ATLAS.workspaceId);
    if (atlas) return rowObject(atlas);
    const rows = this.db.prepare(`SELECT a.actor_id, a.principal_id, aw.workspace_id, aw.role
      FROM actors a JOIN actor_workspaces aw ON aw.actor_id=a.actor_id
      ORDER BY aw.workspace_id, a.actor_id LIMIT 2`).all();
    invariant(rows.length === 1, "IDENTITY_SCOPE_REQUIRED", "Instance does not have exactly one default local identity");
    return rowObject(rows[0]);
  }

  resolveIdentity(principalId, workspaceId) {
    const row = this.db.prepare(`SELECT a.actor_id, a.principal_id, aw.workspace_id, aw.role
      FROM actors a JOIN actor_workspaces aw ON aw.actor_id=a.actor_id
      WHERE a.principal_id=? AND aw.workspace_id=?`).get(principalId, workspaceId);
    if (!row) throw new AiOsError("PERMISSION_DENIED", "Identity or workspace scope is not authorized");
    return rowObject(row);
  }

  getPolicy(workspaceId, policyId, version = 1) {
    const row = this.db.prepare("SELECT policy_json FROM policies WHERE workspace_id=? AND policy_id=? AND policy_version=?").get(workspaceId, policyId, version);
    if (!row) throw new AiOsError("POLICY_NOT_FOUND", "Required policy version is unavailable", { policyId, version });
    return parseJson(row.policy_json);
  }

  getPolicyByKind(workspaceId, policyKind) {
    const rows = this.db.prepare("SELECT policy_json FROM policies WHERE workspace_id=? AND policy_kind=? ORDER BY policy_version DESC").all(workspaceId, policyKind);
    invariant(rows.length === 1, "POLICY_NOT_FOUND", "Workspace must have exactly one active policy of this kind", { workspace_id: workspaceId, policy_kind: policyKind });
    return parseJson(rows[0].policy_json);
  }

  mergePolicyRules(workspaceId, policyId, version, rules) {
    const policy = this.getPolicy(workspaceId, policyId, version);
    const next = { ...policy, rules: { ...policy.rules, ...rules } };
    this.db.prepare("UPDATE policies SET policy_json=? WHERE workspace_id=? AND policy_id=? AND policy_version=?")
      .run(canonicalJson(next), workspaceId, policyId, version);
    return next;
  }

  registerCapability({ workspaceId, capabilityRef, capabilityId, capabilityVersion, contractState, defaultEnabled, errors = [] }) {
    const now = iso(this.clock);
    const existing = this.getCapabilityActivation(workspaceId, capabilityRef);
    if (existing) {
      this.db.prepare("UPDATE capability_activations SET contract_state=?, errors_json=?, updated_at=? WHERE workspace_id=? AND capability_ref=?")
        .run(contractState, canonicalJson(errors), now, workspaceId, capabilityRef);
    } else {
      this.db.prepare(`INSERT INTO capability_activations(workspace_id, capability_ref, capability_id, capability_version, contract_state, enabled, errors_json, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(
        workspaceId,
        capabilityRef,
        capabilityId,
        capabilityVersion,
        contractState,
        defaultEnabled ? 1 : 0,
        canonicalJson(errors),
        now,
      );
    }
    return this.getCapabilityActivation(workspaceId, capabilityRef);
  }

  getCapabilityActivation(workspaceId, capabilityRef) {
    const row = this.db.prepare("SELECT * FROM capability_activations WHERE workspace_id=? AND capability_ref=?")
      .get(workspaceId, capabilityRef);
    return row ? { ...rowObject(row), errors: parseJson(row.errors_json, []) } : null;
  }

  listCapabilityActivations(workspaceId) {
    return this.db.prepare("SELECT * FROM capability_activations WHERE workspace_id=? ORDER BY capability_ref")
      .all(workspaceId)
      .map((row) => ({ ...rowObject(row), errors: parseJson(row.errors_json, []) }));
  }

  setCapabilityEnabled(workspaceId, capabilityRef, enabled) {
    const existing = this.getCapabilityActivation(workspaceId, capabilityRef);
    invariant(existing, "CAPABILITY_NOT_REGISTERED", "Capability is not registered in this workspace", { capability_ref: capabilityRef });
    invariant(existing.contract_state === "AVAILABLE", "CAPABILITY_NOT_AVAILABLE", "Only an available capability can be enabled", { capability_ref: capabilityRef, state: existing.contract_state });
    this.db.prepare("UPDATE capability_activations SET enabled=?, updated_at=? WHERE workspace_id=? AND capability_ref=?")
      .run(enabled ? 1 : 0, iso(this.clock), workspaceId, capabilityRef);
    return this.getCapabilityActivation(workspaceId, capabilityRef);
  }

  findProjects(workspaceId, query) {
    const exact = this.db.prepare("SELECT * FROM projects WHERE workspace_id=? AND lower(name)=lower(?) ORDER BY project_id").all(workspaceId, query);
    if (exact.length) return exact.map(rowObject);
    return this.db.prepare("SELECT * FROM projects WHERE workspace_id=? AND lower(name) LIKE lower(?) ORDER BY project_id").all(workspaceId, `%${query}%`).map(rowObject);
  }

  registerSource({ workspaceId, sourceId, kind, authorityScope, classification = "synthetic" }) {
    this.db.prepare("INSERT OR IGNORE INTO sources(source_id, workspace_id, kind, authority_scope_json, classification) VALUES(?, ?, ?, ?, ?)")
      .run(sourceId, workspaceId, kind, canonicalJson(authorityScope), classification);
    return rowObject(this.db.prepare("SELECT * FROM sources WHERE workspace_id=? AND source_id=?").get(workspaceId, sourceId));
  }

  getSource(workspaceId, sourceId) {
    const row = this.db.prepare("SELECT * FROM sources WHERE workspace_id=? AND source_id=?").get(workspaceId, sourceId);
    return row ? { ...rowObject(row), authority_scope: parseJson(row.authority_scope_json, []) } : null;
  }

  saveSourceBinding({ workspaceId, capabilityRef, sourceId, adapterKind, config }) {
    const now = iso(this.clock);
    const configJson = canonicalJson(config);
    this.db.prepare(`INSERT INTO source_bindings(
      workspace_id, capability_ref, source_id, adapter_kind, config_json, config_hash, configured_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, capability_ref) DO UPDATE SET
      source_id=excluded.source_id,
      adapter_kind=excluded.adapter_kind,
      config_json=excluded.config_json,
      config_hash=excluded.config_hash,
      updated_at=excluded.updated_at`).run(
      workspaceId,
      capabilityRef,
      sourceId,
      adapterKind,
      configJson,
      sha256(configJson),
      now,
      now,
    );
    return this.getSourceBinding(workspaceId, capabilityRef);
  }

  getSourceBinding(workspaceId, capabilityRef) {
    const row = this.db.prepare("SELECT * FROM source_bindings WHERE workspace_id=? AND capability_ref=?")
      .get(workspaceId, capabilityRef);
    return row ? { ...rowObject(row), config: parseJson(row.config_json) } : null;
  }

  listSourceBindings(workspaceId) {
    return this.db.prepare("SELECT * FROM source_bindings WHERE workspace_id=? ORDER BY capability_ref")
      .all(workspaceId)
      .map((row) => ({ ...rowObject(row), config: parseJson(row.config_json) }));
  }

  getProject(workspaceId, projectId) {
    return rowObject(this.db.prepare("SELECT * FROM projects WHERE workspace_id=? AND project_id=?").get(workspaceId, projectId));
  }

  registerProject({ workspaceId, projectId, sourceId, name, objective = null, objectiveId = null, ownerActorId, status = "active", classification = "private" }) {
    const existing = this.getProject(workspaceId, projectId);
    if (existing) {
      invariant(
        existing.source_id === sourceId
          && existing.name === name
          && existing.objective === objective
          && existing.owner_actor_id === ownerActorId,
        "CAPTURE_CONFLICT",
        "Project reference already exists with different confirmed content",
        { project_id: projectId },
      );
      return existing;
    }
    this.db.prepare(`INSERT INTO projects(project_id, workspace_id, source_id, name, objective_id, objective, owner_actor_id, status, version, classification)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(projectId, workspaceId, sourceId, name, objectiveId, objective, ownerActorId, status, classification);
    return this.getProject(workspaceId, projectId);
  }

  listTaskRefs(workspaceId, projectId) {
    return this.db.prepare("SELECT * FROM task_refs WHERE workspace_id=? AND project_id=? ORDER BY task_ref").all(workspaceId, projectId).map((row) => ({ ...rowObject(row), last_snapshot: parseJson(row.last_snapshot_json) }));
  }

  updateTaskSnapshot(workspaceId, task, observedAt = iso(this.clock)) {
    this.db.prepare("UPDATE task_refs SET last_source_version=?, last_snapshot_json=?, observed_at=? WHERE workspace_id=? AND task_ref=?")
      .run(task.version, canonicalJson(task), observedAt, workspaceId, task.task_id);
  }

  captureEvent({ event, evidence }) {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM events WHERE event_id=?").get(event.event_id);
      if (existing) {
        invariant(
          existing.workspace_id === event.workspace_id
            && existing.actor_id === event.actor_id
            && existing.source_hash === event.source_hash,
          "CAPTURE_CONFLICT",
          "Event identifier is already bound to different content",
          { event_id: event.event_id },
        );
        return { duplicate: true, event: { ...rowObject(existing), payload: parseJson(existing.payload_json) } };
      }
      this.db.prepare(`INSERT INTO events(event_id, workspace_id, actor_id, event_type, project_ref, task_ref, payload_json, policy_id, policy_version, source_hash, occurred_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(event.event_id, event.workspace_id, event.actor_id, event.event_type, event.project_ref, event.task_ref, canonicalJson(event.payload), event.policy_id, event.policy_version, event.source_hash, event.occurred_at);
      if (evidence) {
        this.db.prepare(`INSERT INTO evidence(evidence_id, workspace_id, source_id, locator, claims_json, authority_kind, authority_ref, observed_at, evidence_hash)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(evidence.evidence_id, evidence.workspace_id, evidence.source_id, evidence.locator, canonicalJson(evidence.claims), evidence.authority_kind, evidence.authority_ref, evidence.observed_at, evidence.evidence_hash);
      }
      return { duplicate: false, event: { ...event, payload: structuredClone(event.payload) } };
    });
  }

  getEvents(workspaceId, projectRef = null) {
    const rows = projectRef
      ? this.db.prepare("SELECT * FROM events WHERE workspace_id=? AND project_ref=? ORDER BY occurred_at, event_id").all(workspaceId, projectRef)
      : this.db.prepare("SELECT * FROM events WHERE workspace_id=? ORDER BY occurred_at, event_id").all(workspaceId);
    return rows.map((row) => ({ ...rowObject(row), payload: parseJson(row.payload_json) }));
  }

  getEvidence(workspaceId, evidenceIds = null) {
    const rows = this.db.prepare("SELECT * FROM evidence WHERE workspace_id=? ORDER BY observed_at, evidence_id").all(workspaceId);
    return rows.filter((row) => !evidenceIds || evidenceIds.includes(row.evidence_id)).map((row) => ({ ...rowObject(row), claims: parseJson(row.claims_json) }));
  }

  createPlan(plan) {
    this.db.prepare(`INSERT INTO plans(plan_id, workspace_id, actor_id, source_id, resource_ref, capability_id, capability_version, operation_id, policy_id, policy_version, expected_source_version, patch_json, patch_hash, plan_json, plan_hash, state, created_at, expires_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AWAITING_APPROVAL', ?, ?)`)
      .run(plan.plan_id, plan.workspace_id, plan.actor_id, plan.source_id, plan.resource_ref, plan.capability_id, plan.capability_version, plan.operation_id, plan.policy_id, plan.policy_version, plan.expected_source_version, canonicalJson(plan.patch), plan.patch_hash, canonicalJson(plan), plan.plan_hash, plan.created_at, plan.expires_at);
    return this.getPlan(plan.plan_id, plan.workspace_id);
  }

  getPlan(planId, workspaceId) {
    return planFromRow(this.db.prepare("SELECT * FROM plans WHERE plan_id=? AND workspace_id=?").get(planId, workspaceId));
  }

  updatePlanState(planId, state) {
    this.db.prepare("UPDATE plans SET state=? WHERE plan_id=?").run(state, planId);
  }

  createGrant(grant) {
    this.transaction(() => {
      this.db.prepare(`INSERT INTO grants(grant_id, plan_id, plan_hash, approver_actor_id, executor_actor_id, workspace_id, source_id, resource_ref, capability_id, capability_version, operation_id, policy_id, policy_version, issued_at, expires_at, max_uses, use_count)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`)
        .run(grant.grant_id, grant.plan_id, grant.plan_hash, grant.approver_actor_id, grant.executor_actor_id, grant.workspace_id, grant.source_id, grant.resource_ref, grant.capability_id, grant.capability_version, grant.operation_id, grant.policy_id, grant.policy_version, grant.issued_at, grant.expires_at);
      this.db.prepare("UPDATE plans SET state='READY' WHERE plan_id=? AND state='AWAITING_APPROVAL'").run(grant.plan_id);
    });
    return this.getGrant(grant.grant_id, grant.workspace_id);
  }

  getGrant(grantId, workspaceId) {
    return grantFromRow(this.db.prepare("SELECT * FROM grants WHERE grant_id=? AND workspace_id=?").get(grantId, workspaceId));
  }

  recordDecision(decision) {
    this.db.prepare("INSERT INTO decisions(decision_id, workspace_id, actor_id, decision_type, subject_ref, decision_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)")
      .run(decision.decision_id, decision.workspace_id, decision.actor_id, decision.decision_type, decision.subject_ref, canonicalJson(decision), decision.created_at);
  }

  createExecutionCheckpoint({ executionId, actorId, plan, grant, idempotencyKey }) {
    const now = iso(this.clock);
    return this.transaction(() => {
      const consumed = this.db.prepare(`UPDATE grants SET use_count=1, consumed_at=?, execution_id=?
        WHERE grant_id=? AND workspace_id=? AND use_count=0 AND consumed_at IS NULL AND expires_at>?`)
        .run(now, executionId, grant.grant_id, plan.workspace_id, now);
      invariant(consumed.changes === 1, "GRANT_INVALID", "Grant is expired, consumed or outside scope");
      this.db.prepare(`INSERT INTO executions(execution_id, workspace_id, actor_id, plan_id, plan_hash, grant_id, source_id, resource_ref, capability_id, capability_version, operation_id, policy_id, policy_version, expected_source_version, idempotency_key, state, checkpoint_at, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EFFECT_INTENT_PERSISTED', ?, ?, ?)`)
        .run(executionId, plan.workspace_id, actorId, plan.plan_id, plan.plan_hash, grant.grant_id, plan.source_id, plan.resource_ref, plan.capability_id, plan.capability_version, plan.operation_id, plan.policy_id, plan.policy_version, plan.expected_source_version, idempotencyKey, now, now, now);
      const transitions = [[null, "CREATED"], ["CREATED", "PLANNED"], ["PLANNED", "AWAITING_APPROVAL"], ["AWAITING_APPROVAL", "READY"], ["READY", "EFFECT_INTENT_PERSISTED"]];
      const insertTransition = this.db.prepare("INSERT INTO execution_transitions(execution_id, from_state, to_state, occurred_at) VALUES(?, ?, ?, ?)");
      for (const [from, to] of transitions) insertTransition.run(executionId, from, to, now);
      try {
        this.db.prepare("INSERT INTO resource_locks(workspace_id, resource_ref, execution_id, acquired_at) VALUES(?, ?, ?, ?)").run(plan.workspace_id, plan.resource_ref, executionId, now);
      } catch {
        throw new AiOsError("RESOURCE_BUSY", "Another mutation is active for this workspace/resource");
      }
      return this.getExecution(executionId, plan.workspace_id);
    });
  }

  findCapabilityExecution({ actorId, workspaceId, sourceId, resourceRef, capabilityId, capabilityVersion, operationId, idempotencyKey }) {
    return executionFromRow(this.db.prepare(`SELECT * FROM executions
      WHERE actor_id=? AND workspace_id=? AND source_id=? AND resource_ref=? AND capability_id=? AND capability_version=? AND operation_id=? AND idempotency_key=?`)
      .get(actorId, workspaceId, sourceId, resourceRef, capabilityId, capabilityVersion, operationId, idempotencyKey));
  }

  createCapabilityExecution({ executionId, identity, sourceId, resourceRef, capabilityId, capabilityVersion, operationId, effectClass, policy, expectedSourceVersion, idempotencyKey, inputHash, input }) {
    const now = iso(this.clock);
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO executions(
        execution_id, workspace_id, actor_id, plan_id, plan_hash, grant_id, source_id, resource_ref,
        capability_id, capability_version, operation_id, effect_class, policy_id, policy_version,
        expected_source_version, idempotency_key, input_hash, input_json, state, checkpoint_at, created_at, updated_at
      ) VALUES(?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', ?, ?, ?)`)
        .run(
          executionId,
          identity.workspace_id,
          identity.actor_id,
          sourceId,
          resourceRef,
          capabilityId,
          capabilityVersion,
          operationId,
          effectClass,
          policy.policy_id,
          policy.policy_version,
          expectedSourceVersion,
          idempotencyKey,
          inputHash,
          canonicalJson(input),
          now,
          now,
          now,
        );
      this.db.prepare("INSERT INTO execution_transitions(execution_id, from_state, to_state, occurred_at) VALUES(?, NULL, 'CREATED', ?)")
        .run(executionId, now);
      return this.getExecution(executionId, identity.workspace_id);
    });
  }

  getExecution(executionId, workspaceId) {
    return executionFromRow(this.db.prepare("SELECT * FROM executions WHERE execution_id=? AND workspace_id=?").get(executionId, workspaceId));
  }

  getExecutionByGrant(grantId, workspaceId) {
    return executionFromRow(this.db.prepare("SELECT * FROM executions WHERE grant_id=? AND workspace_id=?").get(grantId, workspaceId));
  }

  transitionExecution(executionId, workspaceId, toState, { receipt = undefined, error = undefined } = {}) {
    return this.transaction(() => {
      const current = this.getExecution(executionId, workspaceId);
      invariant(current, "EXECUTION_NOT_FOUND", "Execution does not exist in this scope");
      const allowed = transitionMap.get(current.state);
      invariant(allowed?.has(toState), "INVALID_TRANSITION", `Execution cannot transition from ${current.state} to ${toState}`);
      const now = iso(this.clock);
      const receiptJson = receipt === undefined ? current.receipt_json : canonicalJson(receipt);
      const errorJson = error === undefined ? current.error_json : canonicalJson(error);
      this.db.prepare("UPDATE executions SET state=?, receipt_json=?, error_json=?, updated_at=? WHERE execution_id=? AND workspace_id=?")
        .run(toState, receiptJson, errorJson, now, executionId, workspaceId);
      this.db.prepare("INSERT INTO execution_transitions(execution_id, from_state, to_state, occurred_at) VALUES(?, ?, ?, ?)")
        .run(executionId, current.state, toState, now);
      return this.getExecution(executionId, workspaceId);
    });
  }

  attachReceipt(executionId, workspaceId, receipt) {
    this.db.prepare("UPDATE executions SET receipt_json=?, updated_at=? WHERE execution_id=? AND workspace_id=?")
      .run(canonicalJson(receipt), iso(this.clock), executionId, workspaceId);
  }

  saveResult(result, terminalState) {
    return this.transaction(() => {
      const execution = this.getExecution(result.execution_id, result.workspace_id);
      invariant(execution, "EXECUTION_NOT_FOUND", "Cannot save result for missing execution");
      if (execution.state !== terminalState) {
        invariant(transitionMap.get(execution.state)?.has(terminalState), "INVALID_TRANSITION", `Execution cannot transition from ${execution.state} to ${terminalState}`);
        const now = iso(this.clock);
        this.db.prepare("UPDATE executions SET state=?, updated_at=? WHERE execution_id=? AND workspace_id=?")
          .run(terminalState, now, result.execution_id, result.workspace_id);
        this.db.prepare("INSERT INTO execution_transitions(execution_id, from_state, to_state, occurred_at) VALUES(?, ?, ?, ?)")
          .run(result.execution_id, execution.state, terminalState, now);
      }
      this.db.prepare(`INSERT OR REPLACE INTO results(result_id, execution_id, workspace_id, resource_ref, outcome, verified, result_json, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(result.result_id, result.execution_id, result.workspace_id, result.resource_ref, result.outcome, result.verified ? 1 : 0, canonicalJson(result), result.created_at);
      return result;
    });
  }

  getResultByExecution(executionId, workspaceId) {
    return resultFromRow(this.db.prepare("SELECT result_json FROM results WHERE execution_id=? AND workspace_id=?").get(executionId, workspaceId));
  }

  getResult(resultId, workspaceId) {
    return resultFromRow(this.db.prepare("SELECT result_json FROM results WHERE result_id=? AND workspace_id=?").get(resultId, workspaceId));
  }

  saveEvidenceRecords(records) {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO evidence(evidence_id, workspace_id, source_id, locator, claims_json, authority_kind, authority_ref, observed_at, evidence_hash)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.transaction(() => {
      for (const evidence of records) {
        insert.run(
          evidence.evidence_id,
          evidence.workspace_id,
          evidence.source_id,
          evidence.locator,
          canonicalJson(evidence.claims || []),
          evidence.authority_kind,
          evidence.authority_ref || null,
          evidence.observed_at,
          evidence.evidence_hash,
        );
      }
    });
  }

  saveArtifact(artifact) {
    this.db.prepare(`INSERT OR IGNORE INTO artifacts(
      artifact_id, execution_id, workspace_id, capability_id, capability_version, operation_id,
      resource_ref, artifact_kind, source_version, content_json, content_hash, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      artifact.artifact_id,
      artifact.execution_id,
      artifact.workspace_id,
      artifact.capability_id,
      artifact.capability_version,
      artifact.operation_id,
      artifact.resource_ref,
      artifact.artifact_kind,
      artifact.source_version,
      canonicalJson(artifact.content),
      artifact.content_hash,
      artifact.created_at,
    );
    return this.getArtifact(artifact.artifact_id, artifact.workspace_id);
  }

  getArtifact(artifactId, workspaceId) {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE artifact_id=? AND workspace_id=?").get(artifactId, workspaceId);
    return row ? { ...rowObject(row), content: parseJson(row.content_json) } : null;
  }

  latestResult(workspaceId, resourceRef) {
    return resultFromRow(this.db.prepare("SELECT result_json FROM results WHERE workspace_id=? AND resource_ref=? ORDER BY created_at DESC LIMIT 1").get(workspaceId, resourceRef));
  }

  listRecoverable(workspaceId) {
    return this.db.prepare(`SELECT * FROM executions WHERE workspace_id=? AND state IN ('EFFECT_INTENT_PERSISTED','RUNNING','VERIFYING','INTERRUPTED','UNKNOWN_EFFECT','RECONCILING_READ_ONLY') ORDER BY created_at`)
      .all(workspaceId).map(executionFromRow);
  }

  releaseLock(executionId) {
    this.db.prepare("DELETE FROM resource_locks WHERE execution_id=?").run(executionId);
  }

  recordMetric({ executionId = null, workspaceId, phase, durationMs, modelCalls = 0 }) {
    this.db.prepare("INSERT INTO phase_metrics(execution_id, workspace_id, phase, duration_ms, model_calls, recorded_at) VALUES(?, ?, ?, ?, ?, ?)")
      .run(executionId, workspaceId, phase, durationMs, modelCalls, iso(this.clock));
  }

  metrics(workspaceId) {
    return this.db.prepare(`SELECT phase, COUNT(*) AS samples, ROUND(MIN(duration_ms),3) AS min_ms, ROUND(AVG(duration_ms),3) AS avg_ms, ROUND(MAX(duration_ms),3) AS max_ms, SUM(model_calls) AS model_calls
      FROM phase_metrics WHERE workspace_id=? GROUP BY phase ORDER BY phase`).all(workspaceId).map(rowObject);
  }

  tableRows(table) {
    const allowed = new Set(["instance_profiles", "actors", "workspaces", "sources", "source_bindings", "events", "evidence", "decisions", "plans", "grants", "executions", "execution_transitions", "results", "task_refs", "phase_metrics", "capability_activations", "artifacts"]);
    invariant(allowed.has(table), "INVALID_TABLE", "Table is not inspectable");
    return this.db.prepare(`SELECT * FROM ${table}`).all().map(rowObject);
  }
}
