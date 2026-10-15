import { ATLAS } from "../fixtures/atlas.mjs";
import { canonicalJson, iso, systemClock } from "./utils.mjs";
import { validateSchema } from "./schema-validator.mjs";

const mutableFields = new Map([
  ["/status", "status"],
  ["/blocker", "blocker"],
  ["/next_action", "next_action"],
  ["/notes/-", "notes"],
]);

export function verifyTaskUpdate({ plan, receipt, task }) {
  const failures = [];
  if (!receipt) failures.push("receipt_missing");
  if (receipt?.plan_hash !== plan.plan_hash) failures.push("receipt_plan_hash_mismatch");
  if (receipt?.before_version !== plan.expected_source_version) failures.push("before_version_mismatch");
  if (receipt?.after_version !== plan.expected_source_version + 1) failures.push("source_version_not_advanced_once");
  if (task?.version !== plan.expected_source_version + 1) failures.push("read_back_version_mismatch");
  if (receipt && canonicalJson(receipt.patch) !== canonicalJson(plan.patch)) failures.push("applied_patch_mismatch");

  const approvedFields = new Set();
  for (const operation of plan.patch) {
    const field = mutableFields.get(operation.path);
    if (!field) {
      failures.push(`unsupported_path:${operation.path}`);
      continue;
    }
    approvedFields.add(field);
    if (field === "notes") {
      if (!task?.notes?.includes(operation.value)) failures.push("approved_notes_value_missing");
    } else if (task?.[field] !== operation.value) {
      failures.push(`approved_field_mismatch:${field}`);
    }
  }

  if (receipt?.before_task && task) {
    for (const field of ["task_id", "workspace_id", "project_id", "title", "status", "assignee", "due_at", "blocker", "next_action", "classification"]) {
      if (!approvedFields.has(field) && task[field] !== receipt.before_task[field]) failures.push(`unauthorized_field_changed:${field}`);
    }
  }
  if (receipt?.after_task && task && canonicalJson(receipt.after_task) !== canonicalJson(task)) failures.push("receipt_read_back_mismatch");
  return {
    ok: failures.length === 0,
    failures,
    checks: {
      approved_fields_equal: !failures.some((item) => item.startsWith("approved_")),
      untouched_fields_equal: !failures.some((item) => item.startsWith("unauthorized_")),
      source_version_advanced_once: !failures.some((item) => item.includes("version")),
      receipt_matches_read_back: !failures.includes("receipt_read_back_mismatch"),
    },
  };
}

export function buildExecutionResult({ execution, plan, receipt, task, verification, clock = systemClock, resultId = ATLAS.resultId, outcome = null }) {
  const resolvedOutcome = outcome || (verification.ok ? "SUCCEEDED" : "VERIFICATION_FAILED");
  const result = {
    schema: "ExecutionResult@v1",
    result_id: resultId,
    execution_id: execution.execution_id,
    workspace_id: execution.workspace_id,
    resource_ref: execution.resource_ref,
    outcome: resolvedOutcome,
    verified: resolvedOutcome === "SUCCEEDED" && verification.ok,
    source_version: task?.version ?? null,
    receipt: receipt || null,
    verification,
    evidence_refs: [ATLAS.evidenceId, receipt?.receipt_id, task ? `${task.task_id}@v${task.version}` : null].filter(Boolean),
    created_at: iso(clock),
  };
  return validateSchema("executionResult", result);
}
