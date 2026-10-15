import { ATLAS } from "../fixtures/atlas.mjs";
import { AiOsError, invariant } from "./errors.mjs";
import { frozenPlanData, verifyFrozenPlanIntegrity } from "./approval.mjs";
import { assertEffectReport, assertGrantBindings, authorizeOperation, EffectClass, policyDecisionForEffect } from "./policy.mjs";
import { validateSchema } from "./schema-validator.mjs";
import { buildExecutionResult, verifyTaskUpdate } from "./verifier.mjs";
import { canonicalJson, iso, measure, opaqueId, opaqueKey, sha256, systemClock } from "./utils.mjs";

function commandFor(execution, plan) {
  return {
    execution_id: execution.execution_id,
    actor_id: execution.actor_id,
    workspace_id: execution.workspace_id,
    source_id: execution.source_id,
    resource_ref: execution.resource_ref,
    capability_id: execution.capability_id,
    capability_version: execution.capability_version,
    operation_id: execution.operation_id,
    idempotency_key: execution.idempotency_key,
    plan_hash: execution.plan_hash,
    expected_source_version: execution.expected_source_version,
    patch: plan.patch,
  };
}

export async function verifyAndPersist({ store, taskSource, execution, plan, receipt, clock = systemClock, resultId = ATLAS.resultId }) {
  const measured = await measure(async () => {
    const task = taskSource.readTask(execution.workspace_id, execution.resource_ref);
    invariant(task, "TASK_NOT_FOUND", "Read-back could not find the task");
    const verification = verifyTaskUpdate({ plan, receipt, task });
    const result = buildExecutionResult({ execution, plan, receipt, task, verification, clock, resultId });
    const terminal = verification.ok ? "SUCCEEDED" : "VERIFICATION_FAILED";
    store.saveResult(result, terminal);
    store.updateTaskSnapshot(execution.workspace_id, task);
    store.releaseLock(execution.execution_id);
    return result;
  });
  store.recordMetric({ executionId: execution.execution_id, workspaceId: execution.workspace_id, phase: "verification", durationMs: measured.duration_ms, modelCalls: 0 });
  return measured.value;
}

export async function executeApprovedPlan({
  store,
  taskSource,
  registry,
  identity,
  actionPolicy,
  grantId,
  clock = systemClock,
  executionId = ATLAS.executionId,
  resultId = ATLAS.resultId,
  idempotencyKey = opaqueKey(),
  tamperUnauthorizedField = false,
  simulateUnknownAfterEffect = false,
  afterSourceEffect = null,
}) {
  const grant = store.getGrant(grantId, identity.workspace_id);
  invariant(grant, "GRANT_NOT_FOUND", "Grant does not exist in this workspace");
  const existingExecution = store.getExecutionByGrant(grantId, identity.workspace_id);
  if (existingExecution) {
    const prior = store.getResultByExecution(existingExecution.execution_id, identity.workspace_id);
    if (prior) return { ...prior, duplicate_request: true };
    return recoverExecution({ store, taskSource, registry, identity, actionPolicy, executionId: existingExecution.execution_id, clock, resultId });
  }
  const storedPlan = store.getPlan(grant.plan_id, identity.workspace_id);
  invariant(storedPlan, "PLAN_NOT_FOUND", "Approved plan does not exist in this workspace");
  const plan = verifyFrozenPlanIntegrity(storedPlan);
  invariant(storedPlan.state === "READY", "PLAN_NOT_EXECUTABLE", "Plan is not ready for execution", { state: storedPlan.state });
  registry.operation(plan.capability_id, plan.capability_version, plan.operation_id);
  authorizeOperation({
    policy: actionPolicy,
    capabilityId: plan.capability_id,
    capabilityVersion: plan.capability_version,
    operationId: plan.operation_id,
    expectedDecision: "REQUIRE_EXPLICIT_APPROVAL",
  });
  assertGrantBindings({ grant, plan, identity, now: iso(clock) });
  validateSchema("grant", grant);
  const checkpoint = store.createExecutionCheckpoint({ executionId, actorId: identity.actor_id, plan, grant, idempotencyKey });
  let running = store.transitionExecution(checkpoint.execution_id, identity.workspace_id, "RUNNING");
  const measured = await measure(async () => {
    try {
      const receipt = taskSource.applyUpdate(commandFor(running, plan), { tamperUnauthorizedField });
      if (simulateUnknownAfterEffect) {
        throw new AiOsError("SOURCE_RESPONSE_LOST", "The source may have applied the effect, but the response was lost");
      }
      if (afterSourceEffect) await afterSourceEffect(receipt);
      store.attachReceipt(running.execution_id, identity.workspace_id, receipt);
      running = store.transitionExecution(running.execution_id, identity.workspace_id, "VERIFYING");
      return verifyAndPersist({ store, taskSource, execution: running, plan, receipt, clock, resultId });
    } catch (error) {
      if (error.code === "SOURCE_RESPONSE_LOST") {
        store.transitionExecution(running.execution_id, identity.workspace_id, "UNKNOWN_EFFECT", { error: { code: error.code, message: error.message } });
        return { execution_id: running.execution_id, state: "UNKNOWN_EFFECT", verified: false };
      }
      if (error.code === "VERSION_CONFLICT") {
        store.transitionExecution(running.execution_id, identity.workspace_id, "FAILED", { error: { code: error.code, message: error.message, details: error.details } });
        store.releaseLock(running.execution_id);
      }
      throw error;
    }
  });
  store.recordMetric({ executionId: running.execution_id, workspaceId: identity.workspace_id, phase: "execution", durationMs: measured.duration_ms, modelCalls: 0 });
  return measured.value;
}

function enterReadOnlyReconciliation(store, execution) {
  let current = execution;
  if (current.state === "RUNNING" || current.state === "VERIFYING") {
    current = store.transitionExecution(current.execution_id, current.workspace_id, "UNKNOWN_EFFECT");
  }
  if (["EFFECT_INTENT_PERSISTED", "UNKNOWN_EFFECT", "INTERRUPTED"].includes(current.state)) {
    current = store.transitionExecution(current.execution_id, current.workspace_id, "RECONCILING_READ_ONLY");
  }
  invariant(current.state === "RECONCILING_READ_ONLY", "RECOVERY_BLOCKED", "Execution is not recoverable through safe reads", { state: current.state });
  return current;
}

export async function recoverExecution({ store, taskSource, registry, identity, actionPolicy, executionId, clock = systemClock, resultId = ATLAS.resultId }) {
  let execution = store.getExecution(executionId, identity.workspace_id);
  invariant(execution, "EXECUTION_NOT_FOUND", "Execution does not exist in this workspace");
  const prior = store.getResultByExecution(executionId, identity.workspace_id);
  if (prior) return prior;
  registry.operation("cap.task-record", "0.1.0", "task.update.verify");
  authorizeOperation({
    policy: actionPolicy,
    capabilityId: "cap.task-record",
    capabilityVersion: "0.1.0",
    operationId: "task.update.verify",
    expectedDecision: "ALLOW_READ",
  });
  const storedPlan = store.getPlan(execution.plan_id, identity.workspace_id);
  invariant(storedPlan, "PLAN_NOT_FOUND", "Recovery requires the original frozen plan");
  const plan = verifyFrozenPlanIntegrity(storedPlan);
  execution = enterReadOnlyReconciliation(store, execution);
  const measured = await measure(async () => {
    const receipt = taskSource.lookupIdempotency(commandFor(execution, plan));
    const task = taskSource.readTask(identity.workspace_id, execution.resource_ref);
    if (receipt) {
      store.attachReceipt(execution.execution_id, identity.workspace_id, receipt);
      return verifyAndPersist({ store, taskSource, execution, plan, receipt, clock, resultId });
    }
    if (task && task.version === plan.expected_source_version) {
      const verification = { ok: false, failures: ["effect_not_observed"], checks: { read_back_safe: true } };
      const result = buildExecutionResult({ execution, plan, receipt: null, task, verification, clock, resultId, outcome: "EFFECT_NOT_OBSERVED" });
      store.saveResult(result, "INTERRUPTED");
      store.releaseLock(execution.execution_id);
      return result;
    }
    store.transitionExecution(execution.execution_id, identity.workspace_id, "UNKNOWN_EFFECT", {
      error: { code: "UNKNOWN_EFFECT", message: "Safe reads cannot establish whether the approved effect occurred" },
    });
    return { execution_id: execution.execution_id, state: "UNKNOWN_EFFECT", verified: false };
  });
  store.recordMetric({ executionId, workspaceId: identity.workspace_id, phase: "reconciliation", durationMs: measured.duration_ms, modelCalls: 0 });
  return measured.value;
}

export async function recoverAll({ store, taskSource, registry, identity, actionPolicy, clock = systemClock }) {
  const executions = store.listRecoverable(identity.workspace_id);
  const results = [];
  for (const execution of executions) {
    results.push(await recoverExecution({ store, taskSource, registry, identity, actionPolicy, executionId: execution.execution_id, clock }));
  }
  return results;
}

async function withTimeout(fn, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new AiOsError("CAPABILITY_TIMEOUT", "Capability operation exceeded its declared timeout", { timeout_ms: timeoutMs })), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function invokeRegisteredCapability({
  store,
  registry,
  identity,
  actionPolicy,
  instanceRoot,
  capabilityId,
  capabilityVersion,
  operationId,
  input,
  clock = systemClock,
  executionId = opaqueId("EXE"),
  resultId = opaqueId("RES"),
  idempotencyKey = opaqueKey(),
}) {
  const route = registry.route({
    capabilityId,
    capabilityVersion,
    operationId,
    input,
    context: { workspace_id: identity.workspace_id, actor_id: identity.actor_id },
    policy: actionPolicy,
    store,
    workspaceId: identity.workspace_id,
  });
  const runtime = registry.runtime(route.capability_id, route.capability_version, route.operation_id, { store, workspaceId: identity.workspace_id });
  const operation = runtime.operation;
  invariant([EffectClass.READ, EffectClass.PREPARE].includes(operation.effect_class), "APPROVAL_REQUIRED", "Generic P2A invocation only admits READ and PREPARE; mutations keep the P1 frozen-plan grant boundary");
  const expectedDecision = policyDecisionForEffect(operation.effect_class);
  const policy = authorizeOperation({
    policy: actionPolicy,
    capabilityId: route.capability_id,
    capabilityVersion: route.capability_version,
    operationId: route.operation_id,
    expectedDecision,
  });
  registry.validateInput(route.capability_id, route.capability_version, route.operation_id, input);
  const resource = await runtime.resolve({ input, identity, instanceRoot, operation, store });
  invariant(resource?.source_id && resource?.resource_ref && Number.isInteger(resource?.source_version), "CAPABILITY_RESOURCE_INVALID", "Capability resolver did not return a durable source reference and version");
  const inputHash = sha256(canonicalJson(input));
  const prior = store.findCapabilityExecution({
    actorId: identity.actor_id,
    workspaceId: identity.workspace_id,
    sourceId: resource.source_id,
    resourceRef: resource.resource_ref,
    capabilityId: route.capability_id,
    capabilityVersion: route.capability_version,
    operationId: route.operation_id,
    idempotencyKey,
  });
  if (prior) {
    invariant(prior.input_hash === inputHash, "IDEMPOTENCY_CONFLICT", "Idempotency key is already bound to different capability input");
    const previousResult = store.getResultByExecution(prior.execution_id, identity.workspace_id);
    invariant(previousResult, "EXECUTION_IN_PROGRESS", "A matching capability execution exists without a terminal result");
    return { ...previousResult, duplicate_request: true };
  }

  let execution = store.createCapabilityExecution({
    executionId,
    identity,
    sourceId: resource.source_id,
    resourceRef: resource.resource_ref,
    capabilityId: route.capability_id,
    capabilityVersion: route.capability_version,
    operationId: route.operation_id,
    effectClass: operation.effect_class,
    policy,
    expectedSourceVersion: resource.source_version,
    idempotencyKey,
    inputHash,
    input,
  });
  execution = store.transitionExecution(execution.execution_id, identity.workspace_id, "RUNNING");
  try {
    const executionMetric = await measure(async () => withTimeout(
      () => runtime.handler({ input: structuredClone(input), identity: structuredClone(identity), instanceRoot, resource: structuredClone(resource), clock }),
      operation.execution.timeout_ms,
    ));
    store.recordMetric({ executionId, workspaceId: identity.workspace_id, phase: "capability-execution", durationMs: executionMetric.duration_ms, modelCalls: 0 });
    const attempt = executionMetric.value;
    invariant(attempt && typeof attempt === "object", "CAPABILITY_OUTPUT_INVALID", "Capability handler returned no attempt record");
    assertEffectReport(operation, attempt.effects);
    registry.validateOutput(route.capability_id, route.capability_version, route.operation_id, attempt.output);
    execution = store.transitionExecution(execution.execution_id, identity.workspace_id, "VERIFYING");

    const verificationMetric = await measure(async () => withTimeout(
      () => runtime.verifier({ input: structuredClone(input), output: structuredClone(attempt.output), artifact: structuredClone(attempt.artifact || null), identity: structuredClone(identity), instanceRoot, resource: structuredClone(resource), clock }),
      operation.execution.timeout_ms,
    ));
    store.recordMetric({ executionId, workspaceId: identity.workspace_id, phase: "capability-verification", durationMs: verificationMetric.duration_ms, modelCalls: 0 });
    const verification = verificationMetric.value;
    invariant(verification && typeof verification.ok === "boolean" && Array.isArray(verification.failures) && verification.checks, "VERIFICATION_INVALID", "Capability verifier returned an invalid result");

    let artifactRef = null;
    if (verification.ok && operation.output.artifact_kind) {
      invariant(attempt.artifact?.content && attempt.artifact?.artifact_id, "ARTIFACT_MISSING", "Capability operation declared an artifact but did not produce one");
      const contentHash = sha256(canonicalJson(attempt.artifact.content));
      invariant(!attempt.artifact.content_hash || attempt.artifact.content_hash === contentHash, "ARTIFACT_INTEGRITY_FAILED", "Artifact content does not match its declared hash");
      const storedArtifact = store.saveArtifact({
        artifact_id: attempt.artifact.artifact_id,
        execution_id: execution.execution_id,
        workspace_id: identity.workspace_id,
        capability_id: route.capability_id,
        capability_version: route.capability_version,
        operation_id: route.operation_id,
        resource_ref: resource.resource_ref,
        artifact_kind: operation.output.artifact_kind,
        source_version: resource.source_version,
        content: attempt.artifact.content,
        content_hash: contentHash,
        created_at: iso(clock),
      });
      artifactRef = storedArtifact.artifact_id;
    }
    const evidenceRecords = verification.ok ? (verification.evidence_records || []) : [];
    if (evidenceRecords.length) store.saveEvidenceRecords(evidenceRecords);
    const result = validateSchema("capabilityResult", {
      schema: "CapabilityResult@v1",
      result_id: resultId,
      execution_id: execution.execution_id,
      workspace_id: identity.workspace_id,
      resource_ref: resource.resource_ref,
      capability_id: route.capability_id,
      capability_version: route.capability_version,
      operation_id: route.operation_id,
      outcome: verification.ok ? "SUCCEEDED" : "VERIFICATION_FAILED",
      verified: verification.ok,
      source_version: resource.source_version,
      artifact_ref: artifactRef,
      output: attempt.output,
      verification: { ok: verification.ok, failures: verification.failures, checks: verification.checks },
      evidence_refs: [...new Set(verification.evidence_refs || [])],
      created_at: iso(clock),
    });
    store.saveResult(result, result.outcome);
    return result;
  } catch (error) {
    const current = store.getExecution(execution.execution_id, identity.workspace_id);
    if (current && ["CREATED", "RUNNING", "VERIFYING"].includes(current.state)) {
      store.transitionExecution(current.execution_id, current.workspace_id, "FAILED", { error: { code: error.code || "CAPABILITY_FAILED", message: error.message } });
    }
    throw error;
  }
}
