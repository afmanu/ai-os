import { ATLAS, atlasPatch } from "../fixtures/atlas.mjs";
import { AiOsError, invariant } from "./errors.mjs";
import { authorizeOperation } from "./policy.mjs";
import { validateSchema } from "./schema-validator.mjs";
import { addMinutes, canonicalJson, iso, opaqueId, sha256, systemClock } from "./utils.mjs";

export function frozenPlanData(storedPlan) {
  const { state: _state, ...plan } = storedPlan;
  return plan;
}

export function verifyFrozenPlanIntegrity(storedPlan) {
  const plan = frozenPlanData(storedPlan);
  const observedPatchHash = sha256(canonicalJson(plan.patch));
  invariant(observedPatchHash === plan.patch_hash, "PLAN_HASH_MISMATCH", "Canonical patch no longer matches its hash");
  const { plan_hash: _hash, ...hashablePlan } = plan;
  const observedPlanHash = sha256(canonicalJson(hashablePlan));
  invariant(observedPlanHash === plan.plan_hash, "PLAN_HASH_MISMATCH", "Frozen plan no longer matches its hash");
  return validateSchema("frozenPlan", plan);
}

export function prepareAtlasPlan({ store, task, identity, actionPolicy, registry, clock = systemClock, planId = ATLAS.planId }) {
  registry.operation("cap.task-record", "0.1.0", "task.update.prepare");
  authorizeOperation({
    policy: actionPolicy,
    capabilityId: "cap.task-record",
    capabilityVersion: "0.1.0",
    operationId: "task.update.prepare",
    expectedDecision: "ALLOW_PREPARE",
  });
  const existing = store.getPlan(planId, identity.workspace_id);
  if (existing) return verifyFrozenPlanIntegrity(existing);
  const createdAt = iso(clock);
  const patch = structuredClone(atlasPatch);
  const patchHash = sha256(canonicalJson(patch));
  const hashablePlan = {
    schema: "FrozenPlan@v1",
    plan_id: planId,
    actor_id: identity.actor_id,
    workspace_id: identity.workspace_id,
    capability_id: "cap.task-record",
    capability_version: "0.1.0",
    operation_id: "task.update.execute",
    policy_id: actionPolicy.policy_id,
    policy_version: actionPolicy.version,
    source_id: ATLAS.taskSourceId,
    resource_ref: task.task_id,
    expected_source_version: task.version,
    patch,
    patch_hash: patchHash,
    created_at: createdAt,
    expires_at: addMinutes(createdAt, actionPolicy.approval_ttl_minutes),
    postconditions: ["approved_fields_equal", "untouched_fields_equal", `source_version=${task.version + 1}`],
  };
  const plan = { ...hashablePlan, plan_hash: sha256(canonicalJson(hashablePlan)) };
  validateSchema("frozenPlan", plan);
  store.createPlan(plan);
  return plan;
}

export function approvePlan({ store, planId, planHash, identity, actionPolicy, clock = systemClock, grantId = ATLAS.grantId }) {
  const stored = store.getPlan(planId, identity.workspace_id);
  invariant(stored, "PLAN_NOT_FOUND", "Frozen plan does not exist in this workspace");
  const plan = verifyFrozenPlanIntegrity(stored);
  invariant(stored.state === "AWAITING_APPROVAL", "PLAN_NOT_APPROVABLE", "Plan is not awaiting approval", { state: stored.state });
  invariant(plan.plan_hash === planHash, "PLAN_HASH_MISMATCH", "Approval does not name the exact frozen plan hash");
  const issuedAt = iso(clock);
  invariant(new Date(plan.expires_at).getTime() > new Date(issuedAt).getTime(), "PLAN_EXPIRED", "Frozen plan has expired");
  authorizeOperation({
    policy: actionPolicy,
    capabilityId: plan.capability_id,
    capabilityVersion: plan.capability_version,
    operationId: plan.operation_id,
    expectedDecision: "REQUIRE_EXPLICIT_APPROVAL",
  });
  const grant = {
    schema: "MutationGrant@v1",
    grant_id: grantId || opaqueId("GRT"),
    plan_id: plan.plan_id,
    plan_hash: plan.plan_hash,
    approver_actor_id: identity.actor_id,
    executor_actor_id: identity.actor_id,
    workspace_id: identity.workspace_id,
    source_id: plan.source_id,
    resource_ref: plan.resource_ref,
    capability_id: plan.capability_id,
    capability_version: plan.capability_version,
    operation_id: plan.operation_id,
    policy_id: plan.policy_id,
    policy_version: plan.policy_version,
    issued_at: issuedAt,
    expires_at: addMinutes(issuedAt, actionPolicy.approval_ttl_minutes),
    max_uses: 1,
    use_count: 0,
    consumed_at: null,
    execution_id: null,
  };
  validateSchema("grant", grant);
  const storedGrant = store.createGrant(grant);
  store.recordDecision({
    decision_id: `DEC-${plan.plan_id}`,
    workspace_id: identity.workspace_id,
    actor_id: identity.actor_id,
    decision_type: "approve_frozen_plan",
    subject_ref: plan.plan_id,
    plan_hash: plan.plan_hash,
    alternatives: ["reject", "let_expire", "prepare_new_plan"],
    created_at: issuedAt,
  });
  return storedGrant;
}

export function rejectPlan({ store, planId, identity, clock = systemClock }) {
  const plan = store.getPlan(planId, identity.workspace_id);
  invariant(plan, "PLAN_NOT_FOUND", "Frozen plan does not exist in this workspace");
  invariant(plan.state === "AWAITING_APPROVAL", "PLAN_NOT_REJECTABLE", "Plan is not awaiting approval");
  store.updatePlanState(planId, "REJECTED");
  store.recordDecision({
    decision_id: `DEC-REJECT-${planId}`,
    workspace_id: identity.workspace_id,
    actor_id: identity.actor_id,
    decision_type: "reject_frozen_plan",
    subject_ref: planId,
    created_at: iso(clock),
  });
  return { plan_id: planId, state: "REJECTED" };
}

export function planDiff(plan) {
  const frozen = verifyFrozenPlanIntegrity(plan);
  return {
    plan_id: frozen.plan_id,
    plan_hash: frozen.plan_hash,
    patch_hash: frozen.patch_hash,
    resource_ref: frozen.resource_ref,
    expected_source_version: frozen.expected_source_version,
    patch: frozen.patch,
    expires_at: frozen.expires_at,
  };
}
