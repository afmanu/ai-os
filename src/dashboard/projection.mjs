import { iso, systemClock } from "../core/utils.mjs";

const GRAPH_TYPES = new Set(["WORKSPACE", "PROJECT", "GOAL", "DECISION", "COMMITMENT", "TASK", "BLOCKER", "EVENT", "EVIDENCE", "SOURCE", "CAPABILITY"]);

function latestRecords(records) {
  const byRecord = new Map();
  for (const record of records) {
    const key = `${record.record_type}:${record.record_id}`;
    const current = byRecord.get(key);
    if (!current || `${record.occurred_at}:${record.event_id}` > `${current.occurred_at}:${current.event_id}`) byRecord.set(key, record);
  }
  return [...byRecord.values()].sort((left, right) => `${left.record_type}:${left.record_id}`.localeCompare(`${right.record_type}:${right.record_id}`));
}

function node({ id, type, name, workspaceId, state = null, source = null, observedAt = null, description = null, context = null, evidenceRefs = [], referenceSourceIds = [], unknowns = [] }) {
  return {
    id,
    type,
    name,
    workspace_id: workspaceId,
    state,
    source,
    timestamps: { observed_at: observedAt },
    freshness: { status: observedAt ? "OBSERVED_AT_KNOWN" : "UNKNOWN", observed_at: observedAt },
    description,
    context,
    evidence_refs: [...new Set(evidenceRefs)].sort(),
    reference_source_ids: [...new Set(referenceSourceIds)].sort(),
    unknowns: [...new Set(unknowns)],
  };
}

function edge(source, target, type, evidenceRefs = []) {
  return {
    id: `EDGE:${type}:${source}:${target}`,
    source,
    target,
    type,
    evidence_refs: [...new Set(evidenceRefs)].sort(),
  };
}

function recordType(value) {
  return value === "OBJECTIVE" ? "GOAL" : value;
}

function recordName(record) {
  return record.name || record.objective || record.statement || record.record_id;
}

function safeDecisionName(decision) {
  return decision.statement || decision.summary || decision.decision_type || decision.decision_id;
}

function graphFromReadModel(readModel) {
  const nodes = new Map();
  const edges = new Map();
  const addNode = (value) => {
    if (GRAPH_TYPES.has(value.type) && !nodes.has(value.id)) nodes.set(value.id, value);
  };
  const addEdge = (value) => {
    if (nodes.has(value.source) && nodes.has(value.target) && value.source !== value.target) edges.set(value.id, value);
  };

  const workspaceNodeId = `WORKSPACE:${readModel.workspace_id}`;
  addNode(node({
    id: workspaceNodeId,
    type: "WORKSPACE",
    name: readModel.presentation_name,
    workspaceId: readModel.workspace_id,
    state: readModel.instance_mode,
    source: "instance_profile",
    observedAt: readModel.workspace_configured_at,
    description: "Authorized knowledge boundary for this AI OS workspace.",
    context: { workspace_id: readModel.workspace_id, instance_mode: readModel.instance_mode },
    unknowns: ["organizational_identity", "organizational_roles", "company_kpis"],
  }));

  for (const project of readModel.projects) {
    addNode(node({
      id: project.project_id,
      type: "PROJECT",
      name: project.name,
      workspaceId: readModel.workspace_id,
      state: project.status,
      source: project.source_id,
      description: project.objective,
      context: { objective_id: project.objective_id, version: project.version },
      unknowns: [
        ...(!project.objective ? ["objective"] : []),
        "progress",
        "priority",
      ],
    }));
    if (project.objective && project.objective_id) {
      addNode(node({
        id: project.objective_id,
        type: "GOAL",
        name: project.objective,
        workspaceId: readModel.workspace_id,
        source: project.source_id,
        description: project.objective,
        context: { project_ref: project.project_id },
        unknowns: ["state", "target_date"],
      }));
      addEdge(edge(project.project_id, project.objective_id, "HAS_GOAL"));
    }
  }

  const current = latestRecords(readModel.records);
  for (const record of current) {
    const type = recordType(record.record_type);
    const evidenceRefs = record.evidence_ref ? [record.evidence_ref] : [];
    const referenceSourceIds = (record.references || []).map((reference) => reference.source_id);
    const existing = nodes.get(record.record_id);
    if (!existing) {
      addNode(node({
        id: record.record_id,
        type,
        name: recordName(record),
        workspaceId: readModel.workspace_id,
        state: record.status,
        source: "confirmed_record",
        observedAt: record.occurred_at,
        description: record.statement,
        context: { project_ref: record.project_ref, event_id: record.event_id },
        evidenceRefs,
        referenceSourceIds,
        unknowns: [
          ...(!record.status ? ["state"] : []),
          ...(!record.project_ref && type !== "PROJECT" ? ["project_relation"] : []),
        ],
      }));
    } else {
      existing.state = record.status || existing.state;
      existing.timestamps.observed_at = record.occurred_at || existing.timestamps.observed_at;
      existing.freshness = { status: record.occurred_at ? "OBSERVED_AT_KNOWN" : existing.freshness.status, observed_at: record.occurred_at || existing.freshness.observed_at };
      existing.description = record.statement || existing.description;
      existing.context = { ...existing.context, project_ref: record.project_ref, event_id: record.event_id };
      existing.evidence_refs = [...new Set([...existing.evidence_refs, ...evidenceRefs])].sort();
      existing.reference_source_ids = [...new Set([...existing.reference_source_ids, ...referenceSourceIds])].sort();
      existing.unknowns = existing.unknowns.filter((value) => value !== "state" || !record.status);
    }
    if (record.project_ref && record.project_ref !== record.record_id) addEdge(edge(record.project_ref, record.record_id, `HAS_${type}`, evidenceRefs));
  }

  for (const task of readModel.tasks) {
    addNode(node({
      id: task.task_ref,
      type: "TASK",
      name: task.last_snapshot?.title || task.last_snapshot?.name || task.task_ref,
      workspaceId: readModel.workspace_id,
      state: task.last_snapshot?.status || null,
      source: task.source_id,
      observedAt: task.observed_at,
      description: task.last_snapshot?.description || null,
      context: { project_ref: task.project_id, source_version: task.last_source_version },
      unknowns: [
        ...(!task.last_snapshot?.status ? ["state"] : []),
        ...(!task.last_snapshot?.description ? ["description"] : []),
      ],
    }));
    addEdge(edge(task.project_id, task.task_ref, "HAS_TASK"));
  }

  for (const decision of readModel.decisions) {
    addNode(node({
      id: decision.decision_id,
      type: "DECISION",
      name: safeDecisionName(decision),
      workspaceId: readModel.workspace_id,
      state: "CONFIRMED",
      source: "kernel_decision",
      observedAt: decision.created_at,
      description: decision.statement || decision.summary || null,
      context: { subject_ref: decision.subject_ref, decision_type: decision.decision_type },
      evidenceRefs: decision.evidence_refs || [],
      unknowns: decision.created_at ? [] : ["decision_time"],
    }));
    if (decision.subject_ref) addEdge(edge(decision.subject_ref, decision.decision_id, "HAS_DECISION", decision.evidence_refs || []));
  }

  for (const evidence of readModel.evidence) {
    addNode(node({
      id: evidence.evidence_id,
      type: "EVIDENCE",
      name: evidence.evidence_id,
      workspaceId: readModel.workspace_id,
      state: "CONFIRMED",
      source: evidence.source_id,
      observedAt: evidence.observed_at,
      description: `Evidence from ${evidence.source_id}`,
      context: { authority_kind: evidence.authority_kind, authority_ref: evidence.authority_ref },
      unknowns: [],
    }));
  }

  for (const source of readModel.sources) {
    addNode(node({
      id: source.source_id,
      type: "SOURCE",
      name: source.source_id,
      workspaceId: readModel.workspace_id,
      state: source.binding_state,
      source: source.kind,
      observedAt: source.updated_at || source.configured_at,
      description: source.kind,
      context: { authority_scope: source.authority_scope, adapter_kind: source.adapter_kind },
      unknowns: source.freshness_available ? [] : ["freshness_threshold"],
    }));
  }

  for (const capability of readModel.capabilities) {
    const id = `${capability.capability_id}@${capability.capability_version}`;
    addNode(node({
      id,
      type: "CAPABILITY",
      name: capability.capability_id,
      workspaceId: readModel.workspace_id,
      state: capability.state,
      source: "capability_registry",
      observedAt: capability.updated_at,
      description: null,
      context: { version: capability.capability_version, operations: capability.operations },
      unknowns: [],
    }));
  }

  for (const project of readModel.projects) addEdge(edge(workspaceNodeId, project.project_id, "CONTAINS_PROJECT"));
  for (const source of readModel.sources) addEdge(edge(workspaceNodeId, source.source_id, "HAS_SOURCE"));
  for (const capability of readModel.capabilities) addEdge(edge(workspaceNodeId, `${capability.capability_id}@${capability.capability_version}`, "REGISTERS_CAPABILITY"));

  for (const record of current) {
    const referenceSourceIds = (record.references || []).map((reference) => reference.source_id);
    for (const sourceId of referenceSourceIds) addEdge(edge(record.record_id, sourceId, "REFERENCES_SOURCE", record.evidence_ref ? [record.evidence_ref] : []));
    if (record.evidence_ref) addEdge(edge(record.record_id, record.evidence_ref, "SUPPORTED_BY", [record.evidence_ref]));
  }

  for (const evidence of readModel.evidence) {
    for (const claim of evidence.claims || []) {
      if (claim.subject) addEdge(edge(claim.subject, evidence.evidence_id, "SUPPORTED_BY", [evidence.evidence_id]));
    }
    addEdge(edge(evidence.evidence_id, evidence.source_id, "ORIGINATES_FROM", [evidence.evidence_id]));
  }

  for (const binding of readModel.source_bindings) addEdge(edge(binding.capability_ref, binding.source_id, "BOUND_TO_SOURCE"));

  const finalEdges = [...edges.values()].filter((value) => nodes.has(value.source) && nodes.has(value.target));
  const degree = new Map([...nodes.keys()].map((id) => [id, 0]));
  for (const relation of finalEdges) {
    degree.set(relation.source, degree.get(relation.source) + 1);
    degree.set(relation.target, degree.get(relation.target) + 1);
  }
  return {
    nodes: [...nodes.values()].map((value) => ({ ...value, degree: degree.get(value.id) })).sort((left, right) => left.id.localeCompare(right.id)),
    links: finalEdges.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function buildDashboardProjection(readModel, { clock = systemClock } = {}) {
  const graph = graphFromReadModel(readModel);
  const byType = Object.fromEntries([...GRAPH_TYPES].sort().map((type) => [type, graph.nodes.filter((item) => item.type === type).length]));
  const projectIds = new Set(graph.nodes.filter((item) => item.type === "PROJECT").map((item) => item.id));
  const unscoped = graph.nodes.filter((item) => !["WORKSPACE", "PROJECT", "SOURCE", "CAPABILITY", "EVIDENCE"].includes(item.type)
    && !graph.links.some((link) => link.target === item.id && projectIds.has(link.source))).map((item) => item.id);
  return {
    schema: "DashboardGraphProjection@v2",
    dashboard: { name: "AI OS Dashboard", mode: "EXECUTIVE_MISSION_CONTROL", read_only: true },
    workspace_id: readModel.workspace_id,
    root_node_id: `WORKSPACE:${readModel.workspace_id}`,
    presentation_name: readModel.presentation_name,
    generated_at: iso(clock),
    lineage: {
      source: "AUTHORIZED_KERNEL_READ_MODEL",
      persisted: false,
      raw_conversation_included: false,
      projection_version: 2,
    },
    summary: {
      nodes: graph.nodes.length,
      relations: graph.links.length,
      confirmed_events: readModel.records.length,
      by_type: byType,
      unresolved_blockers: graph.nodes.filter((item) => item.type === "BLOCKER" && !["resolved", "closed", "done", "dismissed", "cancelled"].includes(String(item.state || "").toLowerCase())).length,
      open_commitments: graph.nodes.filter((item) => item.type === "COMMITMENT" && !["resolved", "closed", "done", "completed", "cancelled"].includes(String(item.state || "").toLowerCase())).length,
    },
    graph,
    unscoped_node_ids: unscoped,
    limitations: [...new Set(readModel.limitations)],
  };
}
