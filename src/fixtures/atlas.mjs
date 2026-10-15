export const ATLAS = Object.freeze({
  instanceId: "INS-ATLAS-DEMO",
  principalId: "PRN-FICTIONAL-LOCAL-01",
  actorId: "ACT-FICTIONAL-OWNER-01",
  workspaceId: "WS-ATLAS-DEMO",
  objectiveId: "OBJ-ATLAS-01",
  projectId: "PRJ-ATLAS",
  taskId: "TASK-ATLAS-17",
  userSourceId: "SRC-ATLAS-USER",
  projectSourceId: "SRC-ATLAS-PROJECT",
  taskSourceId: "SRC-ATLAS-TASKS",
  dataPolicyId: "POL-ATLAS-DATA",
  actionPolicyId: "POL-ATLAS-ACTIONS",
  policyVersion: 1,
  eventId: "EVT-ATLAS-001",
  evidenceId: "EVD-ATLAS-001",
  planId: "PLAN-ATLAS-001",
  grantId: "GRT-ATLAS-001",
  executionId: "EXE-ATLAS-001",
  resultId: "RES-ATLAS-001",
});

export const atlasProject = Object.freeze({
  project_id: ATLAS.projectId,
  name: "Atlas",
  objective: "Conectar el sistema CRM ficticio con Atlas para sincronizar altas aprobadas.",
  objective_id: ATLAS.objectiveId,
  owner_actor_id: ATLAS.actorId,
  status: "active",
  version: 1,
  classification: "synthetic",
});

export const atlasTask = Object.freeze({
  task_id: ATLAS.taskId,
  workspace_id: ATLAS.workspaceId,
  project_id: ATLAS.projectId,
  title: "Activar integración CRM → Atlas",
  status: "in_progress",
  assignee: null,
  due_at: null,
  blocker: null,
  next_action: null,
  notes: [],
  version: 7,
  updated_at: "2026-10-08T14:00:00.000Z",
  classification: "synthetic",
});

export const atlasDataPolicy = Object.freeze({
  policy_id: ATLAS.dataPolicyId,
  version: 1,
  internal_capture: {
    allowed_event_types: ["project_status_declared", "plan_approval", "execution_audit"],
    allowed_fields: [
      "event_type",
      "actor_id",
      "workspace_id",
      "project_ref",
      "task_ref",
      "claims",
      "minimal_excerpt",
      "source_hash",
      "occurred_at",
    ],
    raw_conversation: "DENY",
    purpose: "atlas_continuity_test",
    retention: "until_acceptance_review_then_purge",
  },
});

export const atlasActionPolicy = Object.freeze({
  policy_id: ATLAS.actionPolicyId,
  version: 1,
  rules: {
    "cap.situation@0.1.0/situation.read": "ALLOW_READ",
    "cap.task-record@0.1.0/task.read": "ALLOW_READ",
    "cap.task-record@0.1.0/task.update.prepare": "ALLOW_PREPARE",
    "cap.task-record@0.1.0/task.update.execute": "REQUIRE_EXPLICIT_APPROVAL",
    "cap.task-record@0.1.0/task.update.verify": "ALLOW_READ",
  },
  approval_ttl_minutes: 15,
});

export const atlasStatement = "En Atlas hemos pospuesto la integración por un problema de permisos.";

export const atlasPatch = Object.freeze([
  { op: "replace", path: "/status", value: "blocked" },
  { op: "replace", path: "/blocker", value: "Permiso requerido aún no especificado" },
  { op: "replace", path: "/next_action", value: "Identificar el permiso exacto y su owner" },
  {
    op: "add",
    path: "/notes/-",
    value: "Integración declarada pospuesta por permisos; faltan scope, owner y nueva fecha. Evidencia: EVD-ATLAS-001.",
  },
]);
