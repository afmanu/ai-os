import { authorizeOperation } from "../core/policy.mjs";
import { sha256 } from "../core/utils.mjs";

function canRead(policy, capabilityId, capabilityVersion, operationId) {
  try {
    authorizeOperation({ policy, capabilityId, capabilityVersion, operationId, expectedDecision: "ALLOW_READ" });
    return true;
  } catch {
    return false;
  }
}

function safeReference(reference) {
  return {
    source_id: reference.source_id,
    content_hash: reference.content_hash || null,
    observed_at: reference.observed_at || null,
  };
}

function safeDecision(decision) {
  return {
    decision_id: decision.decision_id,
    decision_type: decision.decision_type || null,
    subject_ref: decision.subject_ref || null,
    statement: decision.statement || null,
    summary: decision.summary || null,
    evidence_refs: Array.isArray(decision.evidence_refs) ? [...decision.evidence_refs] : [],
    created_at: decision.created_at || null,
  };
}

export function authorizedDashboardReadModel({ store, registry, identity, actionPolicy }) {
  authorizeOperation({
    policy: actionPolicy,
    capabilityId: "cap.personal-record",
    capabilityVersion: "0.1.0",
    operationId: "records.read",
    expectedDecision: "ALLOW_READ",
  });

  const workspaceId = identity.workspace_id;
  const instanceProfile = store.instanceProfile();
  const profile = instanceProfile?.config;
  const projects = store.findProjects(workspaceId, "").map((project) => ({
    project_id: project.project_id,
    source_id: project.source_id,
    name: project.name,
    objective_id: project.objective_id,
    objective: project.objective,
    status: project.status,
    version: project.version,
  }));
  const records = store.getEvents(workspaceId)
    .filter((event) => event.event_type === "confirmed_record")
    .map((event) => ({
      event_id: event.event_id,
      evidence_ref: `EVD-CONFIRMED-${sha256(`${workspaceId}:${event.event_id}`).slice(7, 23).toUpperCase()}`,
      record_type: event.payload.record_type,
      record_id: event.payload.record_id,
      project_ref: event.project_ref,
      statement: event.payload.statement,
      name: event.payload.name,
      objective: event.payload.objective,
      status: event.payload.status,
      references: (event.payload.references || []).map(safeReference),
      occurred_at: event.occurred_at,
    }));

  const confirmedEvidenceIds = records.map((record) => record.evidence_ref);
  const evidence = store.getEvidence(workspaceId, confirmedEvidenceIds).map((item) => ({
    evidence_id: item.evidence_id,
    source_id: item.source_id,
    claims: (item.claims || []).map((claim) => ({ subject: claim.subject || null, predicate: claim.predicate || null })),
    authority_kind: item.authority_kind,
    authority_ref: item.authority_ref,
    observed_at: item.observed_at,
  }));
  const sourceBindings = store.listSourceBindings(workspaceId).map((binding) => ({
    capability_ref: binding.capability_ref,
    source_id: binding.source_id,
    adapter_kind: binding.adapter_kind,
    configured_at: binding.configured_at,
    updated_at: binding.updated_at,
    freshness_available: Boolean(binding.config?.stale_after_days || binding.config?.repositories?.some((item) => item.stale_after_days)),
  }));
  const sourceIds = new Set([
    ...projects.map((project) => project.source_id),
    ...records.flatMap((record) => record.references.map((reference) => reference.source_id)),
    ...evidence.map((item) => item.source_id),
    ...sourceBindings.map((binding) => binding.source_id),
  ].filter(Boolean));
  const sources = [...sourceIds].map((sourceId) => {
    const source = store.getSource(workspaceId, sourceId);
    const binding = sourceBindings.find((item) => item.source_id === sourceId);
    return {
      source_id: sourceId,
      kind: source?.kind || binding?.adapter_kind || "unknown",
      authority_scope: source?.authority_scope || [],
      classification: source?.classification || null,
      adapter_kind: binding?.adapter_kind || null,
      binding_state: binding ? "BOUND" : "REGISTERED",
      configured_at: binding?.configured_at || null,
      updated_at: binding?.updated_at || null,
      freshness_available: binding?.freshness_available || false,
    };
  }).sort((left, right) => left.source_id.localeCompare(right.source_id));

  const limitations = [];
  const taskReadAllowed = canRead(actionPolicy, "cap.task-record", "0.1.0", "task.read");
  const tasks = taskReadAllowed
    ? projects.flatMap((project) => store.listTaskRefs(workspaceId, project.project_id).map((task) => ({
        task_ref: task.task_ref,
        project_id: task.project_id,
        source_id: task.source_id,
        last_source_version: task.last_source_version,
        last_snapshot: task.last_snapshot ? {
          title: task.last_snapshot.title || null,
          name: task.last_snapshot.name || null,
          status: task.last_snapshot.status || null,
          description: task.last_snapshot.description || null,
        } : null,
        observed_at: task.observed_at,
      })))
    : [];
  if (!taskReadAllowed) limitations.push("TASK nodes are omitted because task.read is not authorized for this workspace.");

  const decisionReadAllowed = canRead(actionPolicy, "cap.situation", "0.1.0", "situation.read");
  const decisions = decisionReadAllowed
    ? store.tableRows("decisions")
        .filter((decision) => decision.workspace_id === workspaceId)
        .map((decision) => safeDecision(JSON.parse(decision.decision_json)))
    : [];
  if (!decisionReadAllowed) limitations.push("Kernel decision records are omitted because situation.read is not authorized for this workspace.");

  const capabilities = registry.discovery({ store, workspaceId }).map((item) => ({
    capability_id: item.capability_id,
    capability_version: item.capability_version,
    state: item.state,
    operations: [...item.operations],
    updated_at: item.updated_at || null,
  }));

  return {
    schema: "AuthorizedDashboardReadModel@v1",
    workspace_id: workspaceId,
    presentation_name: profile?.presentation_identity?.display_name || "Personal Instance",
    instance_mode: instanceProfile?.mode || profile?.mode || "PERSONAL",
    workspace_configured_at: instanceProfile?.configured_at || null,
    projects,
    records,
    tasks,
    decisions,
    evidence,
    sources,
    source_bindings: sourceBindings,
    capabilities,
    limitations,
  };
}
