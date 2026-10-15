import { AiOsError, invariant } from "./errors.mjs";
import { canonicalJson, sha256 } from "./utils.mjs";
import { capabilityRef } from "./registry.mjs";

export const EffectClass = Object.freeze({
  INTERNAL_CAPTURE: "INTERNAL_CAPTURE",
  READ: "READ",
  PREPARE: "PREPARE",
  OPERATIONAL_MUTATION: "OPERATIONAL_MUTATION",
  EXTERNAL_HIGH_IMPACT: "EXTERNAL_HIGH_IMPACT",
});

export function policyDecisionForEffect(effectClass) {
  if (effectClass === EffectClass.READ) return "ALLOW_READ";
  if (effectClass === EffectClass.PREPARE) return "ALLOW_PREPARE";
  if (effectClass === EffectClass.OPERATIONAL_MUTATION) return "REQUIRE_EXPLICIT_APPROVAL";
  if (effectClass === EffectClass.INTERNAL_CAPTURE) return "ALLOW_CAPTURE";
  return null;
}

export function assertEffectReport(operation, effectReport) {
  invariant(effectReport && Array.isArray(effectReport.reads) && Array.isArray(effectReport.writes), "EFFECT_REPORT_INVALID", "Capability handler must report observed reads and requested writes");
  const allowedReads = new Set(operation.side_effects.reads);
  const allowedWrites = new Set(operation.side_effects.writes);
  const undeclaredRead = effectReport.reads.find((value) => !allowedReads.has(value));
  const undeclaredWrite = effectReport.writes.find((value) => !allowedWrites.has(value));
  invariant(!undeclaredRead && !undeclaredWrite, "SIDE_EFFECT_SCOPE_VIOLATION", "Capability reported an undeclared side effect", { undeclared_read: undeclaredRead || null, undeclared_write: undeclaredWrite || null });
  if (operation.effect_class === EffectClass.READ) {
    invariant(effectReport.writes.length === 0, "SIDE_EFFECT_SCOPE_VIOLATION", "READ capability cannot request writes");
  }
  if (operation.effect_class === EffectClass.PREPARE) {
    invariant(operation.side_effects.write_scope !== "declared_resource", "SIDE_EFFECT_SCOPE_VIOLATION", "PREPARE capability cannot mutate a source resource");
  }
  invariant(operation.effect_class !== EffectClass.EXTERNAL_HIGH_IMPACT, "PERMISSION_DENIED", "External high impact execution is not available");
}

export function authorizeCapture({ policy, normalized, identity, text, occurredAt }) {
  const capture = policy.internal_capture;
  invariant(capture?.allowed_event_types.includes("project_status_declared"), "CAPTURE_DENIED", "Data policy does not allow this event type");
  invariant(capture.raw_conversation === "DENY", "CAPTURE_POLICY_UNSAFE", "P1 requires raw conversation capture to be denied");
  const candidate = {
    event_type: "project_status_declared",
    actor_id: identity.actor_id,
    workspace_id: identity.workspace_id,
    project_ref: normalized.entities.project_ref,
    task_ref: normalized.entities.task_ref,
    claims: normalized.claims,
    minimal_excerpt: text.trim().slice(0, 160),
    source_hash: sha256(text),
    occurred_at: occurredAt,
  };
  const allowed = new Set(capture.allowed_fields);
  const payload = Object.fromEntries(Object.entries(candidate).filter(([key]) => allowed.has(key)));
  for (const required of ["event_type", "actor_id", "workspace_id", "claims", "source_hash", "occurred_at"]) {
    invariant(required in payload, "CAPTURE_DENIED", `Data policy does not allow required field ${required}`);
  }
  return {
    payload,
    policy_id: policy.policy_id,
    policy_version: policy.version,
    purpose: capture.purpose,
    retention: capture.retention,
    raw_conversation_captured: false,
    canonical_payload: canonicalJson(payload),
  };
}

export function authorizeConfirmedCapture({ policy, identity, record, occurredAt }) {
  const capture = policy.internal_capture;
  invariant(capture?.allowed_event_types.includes("confirmed_record"), "CAPTURE_DENIED", "Data policy does not allow confirmed records");
  invariant(capture.raw_conversation === "DENY", "CAPTURE_POLICY_UNSAFE", "Raw conversation capture must remain denied");
  invariant(capture.allowed_record_types.includes(record.record_type), "CAPTURE_DENIED", "Record type is not allowed by the workspace data policy", { record_type: record.record_type });
  const candidate = {
    event_type: "confirmed_record",
    record_type: record.record_type,
    record_id: record.record_id,
    actor_id: identity.actor_id,
    workspace_id: identity.workspace_id,
    project_ref: record.project_ref || (record.record_type === "PROJECT" ? record.record_id : null),
    statement: record.statement,
    name: record.name || null,
    objective: record.objective || null,
    status: record.status || null,
    references: record.references || [],
    source_hash: sha256(canonicalJson(record)),
    occurred_at: occurredAt,
  };
  const allowed = new Set(capture.allowed_fields);
  const payload = Object.fromEntries(Object.entries(candidate).filter(([key]) => allowed.has(key)));
  for (const required of ["event_type", "record_type", "record_id", "actor_id", "workspace_id", "statement", "source_hash", "occurred_at"]) {
    invariant(required in payload, "CAPTURE_DENIED", `Data policy does not allow required field ${required}`);
  }
  return {
    payload,
    policy_id: policy.policy_id,
    policy_version: policy.version,
    purpose: capture.purpose,
    retention: capture.retention,
    raw_conversation_captured: false,
  };
}

export function authorizeOperation({ policy, capabilityId, capabilityVersion, operationId, expectedDecision }) {
  const key = `${capabilityRef(capabilityId, capabilityVersion)}/${operationId}`;
  const decision = policy.rules[key];
  if (!decision) throw new AiOsError("PERMISSION_DENIED", "Operation is not allowed by the action policy");
  if (expectedDecision && decision !== expectedDecision) {
    throw new AiOsError("PERMISSION_DENIED", "Operation does not have the required policy decision", { expectedDecision, observed: decision });
  }
  return { key, decision, policy_id: policy.policy_id, policy_version: policy.version };
}

export function assertGrantBindings({ grant, plan, identity, now }) {
  const bindings = [
    ["plan_id", grant.plan_id, plan.plan_id],
    ["plan_hash", grant.plan_hash, plan.plan_hash],
    ["executor_actor_id", grant.executor_actor_id, identity.actor_id],
    ["workspace_id", grant.workspace_id, identity.workspace_id],
    ["source_id", grant.source_id, plan.source_id],
    ["resource_ref", grant.resource_ref, plan.resource_ref],
    ["capability_id", grant.capability_id, plan.capability_id],
    ["capability_version", grant.capability_version, plan.capability_version],
    ["operation_id", grant.operation_id, plan.operation_id],
    ["policy_id", grant.policy_id, plan.policy_id],
    ["policy_version", grant.policy_version, plan.policy_version],
  ];
  const mismatch = bindings.find(([, actual, expected]) => actual !== expected);
  invariant(!mismatch, "GRANT_INVALID", "Grant is not bound to the exact frozen plan and execution scope", mismatch ? { field: mismatch[0] } : undefined);
  invariant(grant.max_uses === 1 && grant.use_count === 0, "GRANT_CONSUMED", "Grant is not reusable");
  invariant(new Date(grant.expires_at).getTime() > new Date(now).getTime(), "GRANT_EXPIRED", "Grant has expired");
}
