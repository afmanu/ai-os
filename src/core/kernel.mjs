import { ensureInstanceRoot } from "../instance/paths.mjs";
import { TaskSource } from "../adapters/task-source.mjs";
import { ATLAS, atlasStatement } from "../fixtures/atlas.mjs";
import { approvePlan, planDiff, prepareAtlasPlan, rejectPlan } from "./approval.mjs";
import { retrieveAtlasContext } from "./context.mjs";
import { executeApprovedPlan, invokeRegisteredCapability, recoverAll, recoverExecution } from "./execution.mjs";
import { AiOsError, invariant } from "./errors.mjs";
import { normalizeRequest } from "./normalizer.mjs";
import { authorizeCapture, authorizeConfirmedCapture, authorizeOperation } from "./policy.mjs";
import { defaultRegistry } from "./registry.mjs";
import { buildSituation } from "./situation.mjs";
import { KernelStore } from "./store.mjs";
import { canonicalJson, iso, measure, sha256, systemClock } from "./utils.mjs";
import { authorizedDashboardReadModel } from "../dashboard/read-model.mjs";
import { buildDashboardProjection } from "../dashboard/projection.mjs";

const PERSONAL_RECORD_TYPES = new Set(["PROJECT", "OBJECTIVE", "DECISION", "BLOCKER", "COMMITMENT", "EVENT", "EVIDENCE"]);
const PERSONAL_RECORD_FIELDS = new Set(["event_id", "record_type", "record_id", "project_ref", "statement", "name", "objective", "status", "references", "confirmed", "occurred_at"]);
const REFERENCE_FIELDS = new Set(["source_id", "locator", "content_hash", "observed_at"]);

function validateConfirmedRecord(record) {
  invariant(record && typeof record === "object" && !Array.isArray(record), "CAPTURE_INVALID", "Confirmed capture requires one structured record");
  const unknown = Object.keys(record).filter((key) => !PERSONAL_RECORD_FIELDS.has(key));
  invariant(unknown.length === 0, "CAPTURE_INVALID", "Confirmed capture contains fields outside the minimal contract", { fields: unknown });
  invariant(record.confirmed === true, "CAPTURE_DENIED", "Capture requires explicit confirmation");
  invariant(typeof record.event_id === "string" && /^[A-Z][A-Z0-9-]{2,}$/.test(record.event_id), "CAPTURE_INVALID", "event_id must be an explicit stable identifier");
  invariant(PERSONAL_RECORD_TYPES.has(record.record_type), "CAPTURE_INVALID", "record_type is unsupported");
  invariant(typeof record.record_id === "string" && /^[A-Z][A-Z0-9-]{2,}$/.test(record.record_id), "CAPTURE_INVALID", "record_id must be a stable identifier");
  invariant(typeof record.statement === "string" && record.statement.trim().length > 0 && record.statement.length <= 1000, "CAPTURE_INVALID", "statement must contain a concise confirmed record");
  if (record.project_ref != null) invariant(typeof record.project_ref === "string" && record.project_ref.length > 0, "CAPTURE_INVALID", "project_ref must be a stable reference");
  if (record.record_type === "PROJECT") invariant(typeof record.name === "string" && record.name.trim().length > 0, "CAPTURE_INVALID", "PROJECT capture requires name");
  invariant(record.references === undefined || Array.isArray(record.references), "CAPTURE_INVALID", "references must be an array");
  for (const reference of record.references || []) {
    invariant(reference && typeof reference === "object" && !Array.isArray(reference), "CAPTURE_INVALID", "Each reference must be an object");
    const unknownReference = Object.keys(reference).filter((key) => !REFERENCE_FIELDS.has(key));
    invariant(unknownReference.length === 0, "CAPTURE_INVALID", "Reference contains fields outside the provenance contract", { fields: unknownReference });
    invariant(typeof reference.source_id === "string" && typeof reference.locator === "string" && reference.locator.length > 0, "CAPTURE_INVALID", "Reference requires source_id and locator");
  }
  return structuredClone(record);
}

export class AiOsKernel {
  constructor(instanceRoot, { clock = systemClock, registry = defaultRegistry } = {}) {
    this.paths = ensureInstanceRoot(instanceRoot);
    this.clock = clock;
    this.registry = registry;
    this.store = new KernelStore(this.paths.kernelDb, { clock });
    this.taskSource = new TaskSource(this.paths.taskDb, { clock });
  }

  close() {
    this.taskSource.close();
    this.store.close();
  }

  initializeAtlas() {
    this.store.initialize(ATLAS.instanceId);
    this.taskSource.initialize(ATLAS.instanceId);
    this.store.seedAtlas();
    this.taskSource.seedAtlas();
    const identity = this.identity();
    const capabilities = this.registry.initializeInstance({
      store: this.store,
      workspaceId: ATLAS.workspaceId,
      instanceRoot: this.paths.root,
      identity,
      actionPolicyId: ATLAS.actionPolicyId,
      actionPolicyVersion: 1,
    });
    return {
      instance_id: ATLAS.instanceId,
      workspace_id: ATLAS.workspaceId,
      actor_id: ATLAS.actorId,
      kernel_store: this.paths.kernelDb,
      task_source: this.paths.taskDb,
      task_version: this.taskSource.readTask(ATLAS.workspaceId, ATLAS.taskId).version,
      capabilities,
      synthetic_only: true,
    };
  }

  initializePersonal(config) {
    invariant(config?.mode === "PERSONAL" && config?.seed === "NONE", "INSTANCE_CONFIGURATION_INVALID", "Generic initialization requires mode PERSONAL and seed NONE");
    invariant(config.runtime === "CODEX" && config.external_model_api === "DISABLED", "INSTANCE_CONFIGURATION_INVALID", "Personal initialization supports Codex without an external model API");
    invariant(config.external_connections === "DISABLED_BY_DEFAULT", "INSTANCE_CONFIGURATION_INVALID", "External connections must start disabled");
    for (const field of ["instance_id", "workspace_id", "principal_id", "actor_id", "confirmed_source_id", "task_source_id"]) {
      invariant(typeof config[field] === "string" && config[field].length > 0, "INSTANCE_CONFIGURATION_INVALID", `Missing ${field}`);
    }
    this.store.initialize(config.instance_id);
    this.taskSource.initialize(config.instance_id, config.task_source_id);
    const profile = this.store.seedPersonal(config);
    const identity = this.identity(config.principal_id, config.workspace_id);
    this.registry.syncInstance(this.store, config.workspace_id);
    for (const activation of this.store.listCapabilityActivations(config.workspace_id)) {
      if (activation.enabled) this.store.setCapabilityEnabled(config.workspace_id, activation.capability_ref, false);
    }
    this.registry.applyPolicyRules(this.store, config.workspace_id, config.action_policy.policy_id, config.action_policy.version);
    return {
      instance_id: config.instance_id,
      workspace_id: config.workspace_id,
      actor_id: identity.actor_id,
      mode: profile.mode,
      seed: profile.seed,
      runtime: profile.runtime,
      kernel_store: this.paths.kernelDb,
      task_source: this.paths.taskDb,
      capabilities: this.registry.discovery({ store: this.store, workspaceId: config.workspace_id }),
      project_count: this.store.findProjects(config.workspace_id, "").length,
      task_count: this.taskSource.db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count,
      external_connections: config.external_connections,
    };
  }

  identity(principalId = null, workspaceId = null) {
    if (principalId && workspaceId) return this.store.resolveIdentity(principalId, workspaceId);
    const fallback = this.store.defaultIdentity();
    return this.store.resolveIdentity(principalId || fallback.principal_id, workspaceId || fallback.workspace_id);
  }

  policies(workspaceId = null) {
    const resolvedWorkspace = workspaceId || this.store.defaultIdentity().workspace_id;
    return {
      data: this.store.getPolicyByKind(resolvedWorkspace, "data"),
      action: this.store.getPolicyByKind(resolvedWorkspace, "action"),
    };
  }

  captureConfirmed({ record, principalId = null, workspaceId = null } = {}) {
    const identity = this.identity(principalId, workspaceId);
    const value = validateConfirmedRecord(record);
    for (const reference of value.references || []) {
      invariant(this.store.getSource(identity.workspace_id, reference.source_id), "SOURCE_NOT_AUTHORIZED", "Reference source is not registered in this workspace", { source_id: reference.source_id });
    }
    const occurredAt = value.occurred_at || iso(this.clock);
    invariant(!Number.isNaN(Date.parse(occurredAt)), "CAPTURE_INVALID", "occurred_at must be an ISO timestamp");
    const capture = authorizeConfirmedCapture({
      policy: this.policies(identity.workspace_id).data,
      identity,
      record: value,
      occurredAt,
    });
    const profile = this.store.instanceProfile()?.config;
    invariant(profile?.confirmed_source_id, "INSTANCE_CONFIGURATION_INVALID", "Personal instance profile is unavailable");
    if (value.record_type === "PROJECT") {
      this.store.registerProject({
        workspaceId: identity.workspace_id,
        projectId: value.record_id,
        sourceId: profile.confirmed_source_id,
        name: value.name.trim(),
        objective: value.objective || null,
        objectiveId: value.objective ? `OBJ-${value.record_id}` : null,
        ownerActorId: identity.actor_id,
        status: value.status || "active",
      });
    }
    const evidenceId = `EVD-CONFIRMED-${sha256(`${identity.workspace_id}:${value.event_id}`).slice(7, 23).toUpperCase()}`;
    const stored = this.store.captureEvent({
      event: {
        event_id: value.event_id,
        workspace_id: identity.workspace_id,
        actor_id: identity.actor_id,
        event_type: "confirmed_record",
        project_ref: capture.payload.project_ref,
        task_ref: null,
        payload: capture.payload,
        policy_id: capture.policy_id,
        policy_version: capture.policy_version,
        source_hash: capture.payload.source_hash,
        occurred_at: occurredAt,
      },
      evidence: {
        evidence_id: evidenceId,
        workspace_id: identity.workspace_id,
        source_id: profile.confirmed_source_id,
        locator: `confirmed:${value.event_id}`,
        claims: [{
          subject: value.record_id,
          predicate: `confirmed_${value.record_type.toLowerCase()}`,
          value: { statement: value.statement, status: value.status || null, references: value.references || [] },
        }],
        authority_kind: "human",
        authority_ref: identity.actor_id,
        observed_at: occurredAt,
        evidence_hash: sha256(canonicalJson(capture.payload)),
      },
    });
    return {
      event_id: value.event_id,
      evidence_id: evidenceId,
      duplicate_request: stored.duplicate,
      policy_ref: `${capture.policy_id}@${capture.policy_version}`,
      record_type: value.record_type,
      record_id: value.record_id,
      raw_conversation_captured: false,
      operational_source_mutated: false,
    };
  }

  confirmedRecords({ projectRef = null, recordTypes = null, principalId = null, workspaceId = null } = {}) {
    const identity = this.identity(principalId, workspaceId);
    authorizeOperation({
      policy: this.policies(identity.workspace_id).action,
      capabilityId: "cap.personal-record",
      capabilityVersion: "0.1.0",
      operationId: "records.read",
      expectedDecision: "ALLOW_READ",
    });
    const allowedTypes = recordTypes ? new Set(recordTypes) : null;
    const records = this.store.getEvents(identity.workspace_id, projectRef)
      .filter((event) => event.event_type === "confirmed_record" && (!allowedTypes || allowedTypes.has(event.payload.record_type)))
      .map((event) => ({
        event_id: event.event_id,
        record_type: event.payload.record_type,
        record_id: event.payload.record_id,
        project_ref: event.project_ref,
        statement: event.payload.statement,
        name: event.payload.name,
        objective: event.payload.objective,
        status: event.payload.status,
        references: event.payload.references,
        occurred_at: event.occurred_at,
      }));
    return {
      workspace_id: identity.workspace_id,
      project_ref: projectRef,
      records,
      raw_conversation_included: false,
    };
  }

  dashboardProjection({ principalId = null, workspaceId = null } = {}) {
    const identity = this.identity(principalId, workspaceId);
    const readModel = authorizedDashboardReadModel({
      store: this.store,
      registry: this.registry,
      identity,
      actionPolicy: this.policies(identity.workspace_id).action,
    });
    return buildDashboardProjection(readModel, { clock: this.clock });
  }

  async captureAtlasStatement({
    text = atlasStatement,
    principalId = ATLAS.principalId,
    workspaceId = ATLAS.workspaceId,
    interpreter,
  } = {}) {
    const identity = this.identity(principalId, workspaceId);
    const context = retrieveAtlasContext({ store: this.store, taskSource: this.taskSource, workspaceId, projectName: "Atlas" });
    const normalizedMetric = await measure(async () => normalizeRequest({
      text,
      workspaceId,
      projectRef: context.project.project_id,
      projectName: context.project.name,
      taskRef: context.task.task_id,
    }, { interpreter }));
    this.store.recordMetric({ workspaceId, phase: "normalization", durationMs: normalizedMetric.duration_ms, modelCalls: 0 });
    const normalized = normalizedMetric.value;
    invariant(normalized.requested_effect === "INTERNAL_CAPTURE", "CAPTURE_DENIED", "Request is not an internal capture operation");
    const policy = this.policies(workspaceId).data;
    const occurredAt = iso(this.clock);
    const policyMetric = await measure(async () => authorizeCapture({ policy, normalized, identity, text, occurredAt }));
    this.store.recordMetric({ workspaceId, phase: "capture-policy", durationMs: policyMetric.duration_ms, modelCalls: 0 });
    const capture = policyMetric.value;
    const beforeTask = this.taskSource.readTask(workspaceId, context.task.task_id);
    this.store.captureEvent({
      event: {
        event_id: ATLAS.eventId,
        workspace_id: workspaceId,
        actor_id: identity.actor_id,
        event_type: capture.payload.event_type,
        project_ref: context.project.project_id,
        task_ref: context.task.task_id,
        payload: capture.payload,
        policy_id: capture.policy_id,
        policy_version: capture.policy_version,
        source_hash: capture.payload.source_hash,
        occurred_at: occurredAt,
      },
      evidence: {
        evidence_id: ATLAS.evidenceId,
        workspace_id: workspaceId,
        source_id: ATLAS.userSourceId,
        locator: `event:${ATLAS.eventId}`,
        claims: normalized.claims,
        authority_kind: "human",
        authority_ref: identity.actor_id,
        observed_at: occurredAt,
        evidence_hash: sha256(canonicalJson(capture.payload)),
      },
    });
    this.store.recordDecision({
      decision_id: "DEC-ATLAS-NO-MUTATION-001",
      workspace_id: workspaceId,
      actor_id: identity.actor_id,
      decision_type: "no_mutation_without_request",
      subject_ref: ATLAS.taskId,
      created_at: occurredAt,
    });
    const afterTask = this.taskSource.readTask(workspaceId, context.task.task_id);
    invariant(canonicalJson(beforeTask) === canonicalJson(afterTask), "UNAUTHORIZED_MUTATION", "Internal capture changed the operational source");
    return {
      event_id: ATLAS.eventId,
      evidence_id: ATLAS.evidenceId,
      policy_ref: `${capture.policy_id}@${capture.policy_version}`,
      captured_fields: Object.keys(capture.payload),
      raw_conversation_captured: false,
      task_version: afterTask.version,
      task_mutated: false,
      normalized,
    };
  }

  async status({
    text = "¿Cuál es el estado de Atlas y cuál es la próxima acción?",
    principalId = ATLAS.principalId,
    workspaceId = ATLAS.workspaceId,
    projectName = "Atlas",
    interpreter,
  } = {}) {
    const identity = this.identity(principalId, workspaceId);
    const normalizedMetric = await measure(async () => normalizeRequest({ text, workspaceId, projectName }, { interpreter }));
    this.store.recordMetric({ workspaceId, phase: "normalization", durationMs: normalizedMetric.duration_ms, modelCalls: 0 });
    const normalized = normalizedMetric.value;
    const route = this.registry.select(normalized.intent);
    this.registry.operation(route.capability_id, route.capability_version, route.operation_id);
    const actionPolicy = this.policies(workspaceId).action;
    const policyMetric = await measure(async () => authorizeOperation({
      policy: actionPolicy,
      capabilityId: route.capability_id,
      capabilityVersion: route.capability_version,
      operationId: route.operation_id,
      expectedDecision: "ALLOW_READ",
    }));
    this.store.recordMetric({ workspaceId, phase: "action-policy", durationMs: policyMetric.duration_ms, modelCalls: 0 });
    const retrievalMetric = await measure(async () => retrieveAtlasContext({ store: this.store, taskSource: this.taskSource, workspaceId, projectName }));
    this.store.recordMetric({ workspaceId, phase: "retrieval", durationMs: retrievalMetric.duration_ms, modelCalls: 0 });
    const situationMetric = await measure(async () => buildSituation(retrievalMetric.value, { clock: this.clock }));
    this.store.recordMetric({ workspaceId, phase: "situation", durationMs: situationMetric.duration_ms, modelCalls: 0 });
    return {
      route,
      situation: situationMetric.value,
      task: retrievalMetric.value.task,
      statement: {
        postponed: situationMetric.value.claims.some((claim) => claim.predicate === "integration_timing" && claim.value === "postponed"),
        blocker_category: situationMetric.value.claims.find((claim) => claim.predicate === "blocker_category")?.value || null,
      },
      identity: { actor_id: identity.actor_id, workspace_id: identity.workspace_id },
    };
  }

  async prepareUpdate({ principalId = ATLAS.principalId, workspaceId = ATLAS.workspaceId, projectName = "Atlas", planId = ATLAS.planId } = {}) {
    const identity = this.identity(principalId, workspaceId);
    const normalized = normalizeRequest({ text: "Preparar actualización Atlas", workspaceId, projectName, intentHint: "prepare_task_update" });
    const route = this.registry.select(normalized.intent);
    const actionPolicy = this.policies(workspaceId).action;
    const retrievalMetric = await measure(async () => retrieveAtlasContext({ store: this.store, taskSource: this.taskSource, workspaceId, projectName }));
    this.store.recordMetric({ workspaceId, phase: "retrieval", durationMs: retrievalMetric.duration_ms, modelCalls: 0 });
    const planMetric = await measure(async () => prepareAtlasPlan({
      store: this.store,
      task: retrievalMetric.value.task,
      identity,
      actionPolicy,
      registry: this.registry,
      clock: this.clock,
      planId,
    }));
    this.store.recordMetric({ workspaceId, phase: "prepare", durationMs: planMetric.duration_ms, modelCalls: 0 });
    return { route, plan: planMetric.value, diff: planDiff(planMetric.value) };
  }

  getPlan({ planId = ATLAS.planId, principalId = ATLAS.principalId, workspaceId = ATLAS.workspaceId } = {}) {
    this.identity(principalId, workspaceId);
    const plan = this.store.getPlan(planId, workspaceId);
    invariant(plan, "PLAN_NOT_FOUND", "Plan does not exist in this workspace");
    return { plan, diff: planDiff(plan) };
  }

  approve({ planId = ATLAS.planId, planHash, principalId = ATLAS.principalId, workspaceId = ATLAS.workspaceId, grantId = ATLAS.grantId } = {}) {
    const identity = this.identity(principalId, workspaceId);
    const actionPolicy = this.policies(workspaceId).action;
    return approvePlan({ store: this.store, planId, planHash, identity, actionPolicy, clock: this.clock, grantId });
  }

  reject({ planId = ATLAS.planId, principalId = ATLAS.principalId, workspaceId = ATLAS.workspaceId } = {}) {
    const identity = this.identity(principalId, workspaceId);
    return rejectPlan({ store: this.store, planId, identity, clock: this.clock });
  }

  async execute(options = {}) {
    const principalId = options.principalId || ATLAS.principalId;
    const workspaceId = options.workspaceId || ATLAS.workspaceId;
    const identity = this.identity(principalId, workspaceId);
    const actionPolicy = this.policies(workspaceId).action;
    return executeApprovedPlan({
      store: this.store,
      taskSource: this.taskSource,
      registry: this.registry,
      identity,
      actionPolicy,
      grantId: options.grantId || ATLAS.grantId,
      clock: this.clock,
      executionId: options.executionId || ATLAS.executionId,
      resultId: options.resultId || ATLAS.resultId,
      idempotencyKey: options.idempotencyKey,
      tamperUnauthorizedField: options.tamperUnauthorizedField,
      simulateUnknownAfterEffect: options.simulateUnknownAfterEffect,
      afterSourceEffect: options.afterSourceEffect,
    });
  }

  async recover({ executionId = null, principalId = ATLAS.principalId, workspaceId = ATLAS.workspaceId } = {}) {
    const identity = this.identity(principalId, workspaceId);
    const actionPolicy = this.policies(workspaceId).action;
    if (executionId) {
      return recoverExecution({ store: this.store, taskSource: this.taskSource, registry: this.registry, identity, actionPolicy, executionId, clock: this.clock });
    }
    return recoverAll({ store: this.store, taskSource: this.taskSource, registry: this.registry, identity, actionPolicy, clock: this.clock });
  }

  outcome({ resultId = ATLAS.resultId, principalId = ATLAS.principalId, workspaceId = ATLAS.workspaceId } = {}) {
    const identity = this.identity(principalId, workspaceId);
    const actionPolicy = this.policies(workspaceId).action;
    authorizeOperation({
      policy: actionPolicy,
      capabilityId: "cap.task-record",
      capabilityVersion: "0.1.0",
      operationId: "task.read",
      expectedDecision: "ALLOW_READ",
    });
    const result = this.store.getResult(resultId, workspaceId);
    invariant(result, "RESULT_NOT_FOUND", "Verified result does not exist in this workspace");
    const execution = this.store.getExecution(result.execution_id, workspaceId);
    const grant = this.store.getGrant(execution.grant_id, workspaceId);
    const plan = this.store.getPlan(execution.plan_id, workspaceId);
    const task = this.taskSource.readTask(workspaceId, execution.resource_ref);
    const decisions = this.store.tableRows("decisions")
      .filter((decision) => decision.workspace_id === workspaceId && [plan.plan_id, task.task_id].includes(decision.subject_ref))
      .map((decision) => JSON.parse(decision.decision_json));
    const evidence = this.store.getEvidence(workspaceId);
    return {
      result,
      execution,
      grant,
      plan,
      task,
      decisions,
      evidence,
      identity: { actor_id: identity.actor_id, workspace_id: identity.workspace_id },
      claims: {
        permission_resolved: false,
        integration_completed: false,
        version_advanced_exactly_once: task.version === plan.expected_source_version + 1,
      },
    };
  }

  metrics({ principalId = null, workspaceId = null } = {}) {
    const identity = this.identity(principalId, workspaceId);
    return { workspace_id: identity.workspace_id, phases: this.store.metrics(identity.workspace_id), model_calls: 0 };
  }

  capabilities({ principalId = null, workspaceId = null } = {}) {
    const identity = this.identity(principalId, workspaceId);
    return this.registry.discovery({ store: this.store, workspaceId: identity.workspace_id });
  }

  capability({ capabilityId, capabilityVersion, principalId = null, workspaceId = null }) {
    const identity = this.identity(principalId, workspaceId);
    const manifest = this.registry.get(capabilityId, capabilityVersion);
    const status = this.registry.discovery({ store: this.store, workspaceId: identity.workspace_id })
      .find((entry) => entry.capability_id === capabilityId && entry.capability_version === capabilityVersion);
    return { manifest, status };
  }

  configureCapability({ capabilityId, capabilityVersion, config, principalId = null, workspaceId = null }) {
    const identity = this.identity(principalId, workspaceId);
    const binding = this.registry.configure({
      capabilityId,
      capabilityVersion,
      store: this.store,
      identity,
      instanceRoot: this.paths.root,
      config,
    });
    this.store.setCapabilityEnabled(identity.workspace_id, `${capabilityId}@${capabilityVersion}`, true);
    return {
      binding,
      activation: this.registry.discovery({ store: this.store, workspaceId: identity.workspace_id })
        .find((entry) => entry.capability_id === capabilityId && entry.capability_version === capabilityVersion),
    };
  }

  setCapabilityEnabled({ capabilityId, capabilityVersion, enabled, principalId = null, workspaceId = null }) {
    const identity = this.identity(principalId, workspaceId);
    this.registry.get(capabilityId, capabilityVersion);
    return this.store.setCapabilityEnabled(identity.workspace_id, `${capabilityId}@${capabilityVersion}`, enabled);
  }

  routeCapability({ intent, capabilityId = null, capabilityVersion = null, operationId = null, input = {}, principalId = null, workspaceId = null }) {
    const identity = this.identity(principalId, workspaceId);
    return this.registry.route({
      intent,
      capabilityId,
      capabilityVersion,
      operationId,
      input,
      context: { workspace_id: identity.workspace_id, actor_id: identity.actor_id },
      policy: this.policies(identity.workspace_id).action,
      store: this.store,
      workspaceId: identity.workspace_id,
    });
  }

  async invokeCapability({ capabilityId, capabilityVersion, operationId, input, idempotencyKey, executionId, resultId, principalId = null, workspaceId = null }) {
    const identity = this.identity(principalId, workspaceId);
    return invokeRegisteredCapability({
      store: this.store,
      registry: this.registry,
      identity,
      actionPolicy: this.policies(identity.workspace_id).action,
      instanceRoot: this.paths.root,
      capabilityId,
      capabilityVersion,
      operationId,
      input,
      idempotencyKey,
      executionId,
      resultId,
      clock: this.clock,
    });
  }

  capabilityResult({ resultId, principalId = null, workspaceId = null }) {
    const identity = this.identity(principalId, workspaceId);
    const result = this.store.getResult(resultId, identity.workspace_id);
    invariant(result?.schema === "CapabilityResult@v1", "RESULT_NOT_FOUND", "Capability result does not exist in this workspace");
    const manifest = this.registry.get(result.capability_id, result.capability_version);
    const readOperation = manifest.operations.find((operation) => operation.effect_class === "READ");
    invariant(readOperation, "PERMISSION_DENIED", "Capability does not declare a result read boundary");
    authorizeOperation({
      policy: this.policies(identity.workspace_id).action,
      capabilityId: result.capability_id,
      capabilityVersion: result.capability_version,
      operationId: readOperation.operation_id,
      expectedDecision: "ALLOW_READ",
    });
    const artifact = result.artifact_ref ? this.store.getArtifact(result.artifact_ref, identity.workspace_id) : null;
    if (artifact) invariant(artifact.content_hash === sha256(canonicalJson(artifact.content)), "ARTIFACT_INTEGRITY_FAILED", "Stored artifact hash does not match its content");
    const evidence = this.store.getEvidence(identity.workspace_id, result.evidence_refs);
    return { result, artifact, evidence, identity: { actor_id: identity.actor_id, workspace_id: identity.workspace_id } };
  }

  decisions({ subjectRef = null, principalId = null, workspaceId = null } = {}) {
    const identity = this.identity(principalId, workspaceId);
    authorizeOperation({
      policy: this.policies(identity.workspace_id).action,
      capabilityId: "cap.situation",
      capabilityVersion: "0.1.0",
      operationId: "situation.read",
      expectedDecision: "ALLOW_READ",
    });
    const decisions = this.store.tableRows("decisions")
      .filter((decision) => decision.workspace_id === identity.workspace_id && (!subjectRef || decision.subject_ref === subjectRef))
      .map((decision) => JSON.parse(decision.decision_json));
    return {
      identity: { actor_id: identity.actor_id, workspace_id: identity.workspace_id },
      subject_ref: subjectRef,
      decisions,
    };
  }
}
