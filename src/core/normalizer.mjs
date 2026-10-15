import { AiOsError } from "./errors.mjs";
import { validateSchema } from "./schema-validator.mjs";

function base(workspaceId, intent, requestedEffect, entities) {
  return {
    schema: "NormalizedRequest@v1",
    intent,
    workspace_id: workspaceId,
    entities: {
      project_ref: entities.projectRef || null,
      project_name: entities.projectName || null,
      task_ref: entities.taskRef || null,
    },
    claims: [],
    missing_fields: [],
    requested_effect: requestedEffect,
  };
}

export class DeterministicInterpreter {
  interpret({ text, workspaceId, projectRef = null, projectName = "Atlas", taskRef = null, intentHint = null }) {
    const normalizedText = text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
    if (intentHint === "prepare_task_update") {
      return base(workspaceId, "prepare_task_update", "PREPARE", { projectRef, projectName, taskRef });
    }
    if (normalizedText.includes("pospuest") && normalizedText.includes("permis")) {
      const output = base(workspaceId, "record_project_event", "INTERNAL_CAPTURE", { projectRef, projectName, taskRef });
      output.claims = [
        { subject: taskRef, predicate: "integration_timing", value: "postponed", epistemic_status: "declared" },
        { subject: taskRef, predicate: "blocker_category", value: "permissions", epistemic_status: "declared" },
        { subject: taskRef, predicate: "required_permission", value: null, epistemic_status: "unknown" },
        { subject: taskRef, predicate: "permission_owner", value: null, epistemic_status: "unknown" },
        { subject: taskRef, predicate: "new_due_at", value: null, epistemic_status: "unknown" },
      ];
      output.missing_fields = ["required_permission", "permission_owner", "new_due_at"];
      return output;
    }
    if (normalizedText.includes("que ocurrio") && normalizedText.includes("actualizacion")) {
      return base(workspaceId, "query_update_result", "READ", { projectRef, projectName, taskRef });
    }
    if (normalizedText.includes("estado") || normalizedText.includes("proxima accion")) {
      return base(workspaceId, "query_project_status", "READ", { projectRef, projectName, taskRef });
    }
    throw new AiOsError("NEEDS_CLARIFICATION", "The deterministic normalizer cannot establish the request intent");
  }
}

export function normalizeRequest(input, { interpreter = new DeterministicInterpreter() } = {}) {
  const output = interpreter.interpret(input);
  return validateSchema("normalizedRequest", output);
}
