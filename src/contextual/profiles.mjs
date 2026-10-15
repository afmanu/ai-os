const profiles = Object.freeze({
  "internal.capture/project_status": [
    ["workspace_identity", "identity", "runtime_identity", "identity.bind", "AS_OF_REQUEST", ["ANSWER", "PREPARE", "EXACT_APPROVAL_REQUEST", "EXECUTE_AUTHORIZED_ACTION"]],
    ["project_record", "project_record", "project_authority", "project.read", "CURRENT", ["ANSWER", "PREPARE"]],
  ],
  "cap.situation@0.1.0/situation.read": [
    ["workspace_identity", "identity", "runtime_identity", "identity.bind", "AS_OF_REQUEST", ["ANSWER"]],
    ["project_record", "project_record", "project_authority", "project.read", "CURRENT", ["ANSWER"]],
    ["task_state", "task_system", "task_authority", "task.read", "CURRENT", ["ANSWER"]],
    ["supporting_evidence", "kernel_evidence", "evidence_authority", "evidence.read", "HISTORICAL_ALLOWED", ["ANSWER"]],
  ],
  "cap.task-record@0.1.0/task.read": [
    ["workspace_identity", "identity", "runtime_identity", "identity.bind", "AS_OF_REQUEST", ["ANSWER"]],
    ["task_state", "task_system", "task_authority", "task.read", "CURRENT", ["ANSWER"]],
  ],
  "cap.task-record@0.1.0/task.update.prepare": [
    ["workspace_identity", "identity", "runtime_identity", "identity.bind", "AS_OF_REQUEST", ["PREPARE", "EXACT_APPROVAL_REQUEST"]],
    ["task_state", "task_system", "task_authority", "task.read", "CURRENT", ["PREPARE", "EXACT_APPROVAL_REQUEST"]],
    ["requested_patch", "human_request", "requesting_actor", "request.read", "AS_OF_REQUEST", ["PREPARE", "EXACT_APPROVAL_REQUEST"]],
    ["action_policy", "policy", "policy_authority", "policy.read", "CURRENT", ["PREPARE", "EXACT_APPROVAL_REQUEST"]],
  ],
  "cap.task-record@0.1.0/task.update.execute": [
    ["workspace_identity", "identity", "runtime_identity", "identity.bind", "AS_OF_REQUEST", ["EXECUTE_AUTHORIZED_ACTION"]],
    ["task_state", "task_system", "task_authority", "task.read", "CURRENT", ["EXECUTE_AUTHORIZED_ACTION"]],
    ["frozen_plan", "kernel_plan", "kernel_store", "plan.read", "CURRENT", ["EXECUTE_AUTHORIZED_ACTION"]],
    ["exact_grant", "kernel_grant", "approval_service", "grant.read", "CURRENT", ["EXECUTE_AUTHORIZED_ACTION"]],
  ],
  "cap.meeting-brief@0.1.0/meeting.read": [
    ["workspace_identity", "identity", "runtime_identity", "identity.bind", "AS_OF_REQUEST", ["ANSWER"]],
    ["meeting_record", "meeting_record", "meeting_authority", "meeting.read", "CURRENT", ["ANSWER"]],
    ["meeting_evidence", "meeting_evidence", "meeting_authority", "meeting.read", "HISTORICAL_ALLOWED", ["ANSWER"]],
  ],
  "cap.meeting-brief@0.1.0/meeting.brief.prepare": [
    ["workspace_identity", "identity", "runtime_identity", "identity.bind", "AS_OF_REQUEST", ["PREPARE"]],
    ["meeting_record", "meeting_record", "meeting_authority", "meeting.read", "CURRENT", ["PREPARE"]],
    ["meeting_evidence", "meeting_evidence", "meeting_authority", "meeting.read", "HISTORICAL_ALLOWED", ["PREPARE"]],
  ],
  "cap.content-os-read@0.1.0/content.summary.read": [
    ["workspace_identity", "identity", "runtime_identity", "identity.bind", "AS_OF_REQUEST", ["ANSWER"]],
    ["content_index", "content_os_state", "content_os", "content-os.read", "CURRENT", ["ANSWER"]],
  ],
  "cap.content-os-read@0.1.0/content.item.read": [
    ["workspace_identity", "identity", "runtime_identity", "identity.bind", "AS_OF_REQUEST", ["ANSWER"]],
    ["content_record", "content_os_state", "content_os", "content-os.read", "CURRENT", ["ANSWER"]],
    ["content_evidence", "content_os_artifact", "content_os", "content-os.read", "HISTORICAL_ALLOWED", ["ANSWER"]],
  ],
  "cap.content-os-read@0.1.0/content.output.read": [
    ["workspace_identity", "identity", "runtime_identity", "identity.bind", "AS_OF_REQUEST", ["ANSWER"]],
    ["output_record", "content_os_state", "content_os", "content-os.read", "CURRENT", ["ANSWER"]],
    ["output_provenance", "content_os_state", "content_os", "content-os.read", "CURRENT", ["ANSWER"]],
  ],
});

export function operationRef(operation) {
  if (!operation) return null;
  return `${operation.capability_id}@${operation.capability_version}/${operation.operation_id}`;
}

export function requirementsForOperation(operation, workspaceId, entityRefs = []) {
  const ref = typeof operation === "string" ? operation : operationRef(operation);
  return (profiles[ref] || []).map(([information, sourceType, authority, permission, freshness, criticalFor], index) => ({
    requirement_id: `REQ-${index + 1}-${information.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "-")}`,
    information,
    reason: `Required by ${ref} for an evidence-backed ${criticalFor.join("/")} decision`,
    eligible_source_types: [sourceType],
    authority_needed: authority,
    read_permission: permission,
    freshness_requirement: freshness,
    retrieval_scope: { workspace_id: workspaceId, entity_refs: [...new Set(entityRefs.filter(Boolean))] },
    source_limitations: ["workspace_scoped", "authorized_sources_only", "no_scope_expansion"],
    critical_for: [...criticalFor],
  }));
}

export function knownContextProfileRefs() {
  return Object.keys(profiles).sort();
}
