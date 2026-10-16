import { DatabaseSync } from "node:sqlite";
import { AiOsError, invariant } from "../core/errors.mjs";
import { canonicalJson, deepClone, iso, parseJson, systemClock } from "../core/utils.mjs";
import { ATLAS, atlasTask } from "../fixtures/atlas.mjs";

function taskFromRow(row) {
  if (!row) return null;
  return {
    task_id: row.task_id,
    workspace_id: row.workspace_id,
    project_id: row.project_id,
    title: row.title,
    status: row.status,
    assignee: row.assignee,
    due_at: row.due_at,
    blocker: row.blocker,
    next_action: row.next_action,
    notes: parseJson(row.notes_json, []),
    version: row.version,
    updated_at: row.updated_at,
    classification: row.classification,
  };
}

function applyPatch(task, patch) {
  const next = deepClone(task);
  for (const operation of patch) {
    if (operation.op === "replace" && operation.path === "/status") next.status = operation.value;
    else if (operation.op === "replace" && operation.path === "/blocker") next.blocker = operation.value;
    else if (operation.op === "replace" && operation.path === "/next_action") next.next_action = operation.value;
    else if (operation.op === "add" && operation.path === "/notes/-") next.notes.push(operation.value);
    else throw new AiOsError("PATCH_NOT_ALLOWED", "Patch contains an unsupported operation", { operation });
  }
  return next;
}

export class TaskSource {
  constructor(path, { clock = systemClock } = {}) {
    this.path = path;
    this.clock = clock;
    try {
      this.db = new DatabaseSync(path);
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA journal_mode = DELETE;");
    } catch (error) {
      try {
        this.db?.close();
      } catch {}
      throw new AiOsError("SOURCE_STORE_CORRUPT", "Task source could not be opened", { path, cause: error.message });
    }
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

  initialize(instanceId = ATLAS.instanceId, sourceId = ATLAS.taskSourceId) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS source_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        instance_id TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        workspace_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        assignee TEXT,
        due_at TEXT,
        blocker TEXT,
        next_action TEXT,
        notes_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        classification TEXT NOT NULL,
        PRIMARY KEY (workspace_id, task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_source_tasks_project ON tasks(workspace_id, project_id, title);
      CREATE TABLE IF NOT EXISTS idempotency_records (
        actor_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        resource_ref TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        capability_version TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        before_version INTEGER NOT NULL,
        after_version INTEGER NOT NULL,
        patch_json TEXT NOT NULL,
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (actor_id, workspace_id, source_id, resource_ref, capability_id, capability_version, operation_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS task_history (
        history_id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        before_version INTEGER NOT NULL,
        after_version INTEGER NOT NULL,
        plan_hash TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        changed_at TEXT NOT NULL
      );
    `);
    const now = iso(this.clock);
    this.db.prepare("INSERT OR IGNORE INTO source_meta(singleton, instance_id, source_id, schema_version, created_at) VALUES(1, ?, ?, 1, ?)").run(instanceId, sourceId, now);
    const meta = this.db.prepare("SELECT instance_id, source_id FROM source_meta WHERE singleton=1").get();
    invariant(meta.instance_id === instanceId && meta.source_id === sourceId, "INSTANCE_MISMATCH", "Task source belongs to a different instance");
  }

  seedAtlas() {
    this.insertTask(atlasTask, { ignore: true });
  }

  insertTask(task, { ignore = false } = {}) {
    const verb = ignore ? "INSERT OR IGNORE" : "INSERT";
    this.db.prepare(`${verb} INTO tasks(workspace_id, task_id, project_id, title, status, assignee, due_at, blocker, next_action, notes_json, version, updated_at, classification)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(task.workspace_id, task.task_id, task.project_id, task.title, task.status, task.assignee, task.due_at, task.blocker, task.next_action, canonicalJson(task.notes || []), task.version, task.updated_at, task.classification || "synthetic");
  }

  readTask(workspaceId, taskId) {
    return taskFromRow(this.db.prepare("SELECT * FROM tasks WHERE workspace_id=? AND task_id=?").get(workspaceId, taskId));
  }

  listTasks(workspaceId, projectId, query = null) {
    if (query) {
      return this.db.prepare("SELECT * FROM tasks WHERE workspace_id=? AND project_id=? AND lower(title) LIKE lower(?) ORDER BY task_id")
        .all(workspaceId, projectId, `%${query}%`).map(taskFromRow);
    }
    return this.db.prepare("SELECT * FROM tasks WHERE workspace_id=? AND project_id=? ORDER BY task_id")
      .all(workspaceId, projectId).map(taskFromRow);
  }

  lookupIdempotency(scope) {
    const row = this.db.prepare(`SELECT receipt_json FROM idempotency_records
      WHERE actor_id=? AND workspace_id=? AND source_id=? AND resource_ref=? AND capability_id=? AND capability_version=? AND operation_id=? AND idempotency_key=?`)
      .get(scope.actor_id, scope.workspace_id, scope.source_id, scope.resource_ref, scope.capability_id, scope.capability_version, scope.operation_id, scope.idempotency_key);
    return row ? parseJson(row.receipt_json) : null;
  }

  applyUpdate(command, { tamperUnauthorizedField = false } = {}) {
    return this.transaction(() => {
      const prior = this.lookupIdempotency(command);
      if (prior) {
        invariant(prior.plan_hash === command.plan_hash, "IDEMPOTENCY_CONFLICT", "Idempotency key is already bound to another plan");
        return { ...prior, duplicate: true };
      }
      const before = this.readTask(command.workspace_id, command.resource_ref);
      invariant(before, "TASK_NOT_FOUND", "Task does not exist in this workspace");
      invariant(before.version === command.expected_source_version, "VERSION_CONFLICT", "Task version changed before execution", {
        expected: command.expected_source_version,
        observed: before.version,
      });
      const after = applyPatch(before, command.patch);
      after.version = before.version + 1;
      after.updated_at = iso(this.clock);
      if (tamperUnauthorizedField) after.assignee = "ACT-FICTIONAL-UNAUTHORIZED-01";
      const update = this.db.prepare(`UPDATE tasks SET status=?, assignee=?, due_at=?, blocker=?, next_action=?, notes_json=?, version=?, updated_at=?
        WHERE workspace_id=? AND task_id=? AND version=?`)
        .run(after.status, after.assignee, after.due_at, after.blocker, after.next_action, canonicalJson(after.notes), after.version, after.updated_at, command.workspace_id, command.resource_ref, before.version);
      invariant(update.changes === 1, "VERSION_CONFLICT", "Task version changed during execution");
      const receipt = {
        receipt_id: `RCP-${command.execution_id}`,
        execution_id: command.execution_id,
        plan_hash: command.plan_hash,
        actor_id: command.actor_id,
        workspace_id: command.workspace_id,
        source_id: command.source_id,
        resource_ref: command.resource_ref,
        capability_id: command.capability_id,
        capability_version: command.capability_version,
        operation_id: command.operation_id,
        idempotency_key: command.idempotency_key,
        before_version: before.version,
        after_version: after.version,
        patch: command.patch,
        before_task: before,
        after_task: after,
        applied_at: after.updated_at,
        plan_hash_verified: true,
      };
      this.db.prepare(`INSERT INTO idempotency_records(actor_id, workspace_id, source_id, resource_ref, capability_id, capability_version, operation_id, idempotency_key, plan_hash, before_version, after_version, patch_json, before_json, after_json, receipt_json, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(command.actor_id, command.workspace_id, command.source_id, command.resource_ref, command.capability_id, command.capability_version, command.operation_id, command.idempotency_key, command.plan_hash, before.version, after.version, canonicalJson(command.patch), canonicalJson(before), canonicalJson(after), canonicalJson(receipt), after.updated_at);
      this.db.prepare("INSERT INTO task_history(workspace_id, task_id, before_version, after_version, plan_hash, snapshot_json, changed_at) VALUES(?, ?, ?, ?, ?, ?, ?)")
        .run(command.workspace_id, command.resource_ref, before.version, after.version, command.plan_hash, canonicalJson(after), after.updated_at);
      return receipt;
    });
  }

  forceTaskUpdate(workspaceId, taskId, changes) {
    const task = this.readTask(workspaceId, taskId);
    invariant(task, "TASK_NOT_FOUND", "Task does not exist");
    const next = { ...task, ...changes, version: task.version + 1, updated_at: iso(this.clock) };
    this.db.prepare(`UPDATE tasks SET status=?, assignee=?, due_at=?, blocker=?, next_action=?, notes_json=?, version=?, updated_at=? WHERE workspace_id=? AND task_id=?`)
      .run(next.status, next.assignee, next.due_at, next.blocker, next.next_action, canonicalJson(next.notes), next.version, next.updated_at, workspaceId, taskId);
    return next;
  }

  idempotencyRows() {
    return this.db.prepare("SELECT * FROM idempotency_records ORDER BY created_at").all().map((row) => ({ ...row, receipt: parseJson(row.receipt_json) }));
  }

  integrityCheck() {
    return this.db.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]);
  }
}
