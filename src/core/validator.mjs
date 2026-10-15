import { checkSchema } from "./schema-validator.mjs";
import { defaultRegistry } from "./registry.mjs";
import { executionTransitions } from "./store.mjs";
import { verifyFrozenPlanIntegrity } from "./approval.mjs";
import { canonicalJson, sha256 } from "./utils.mjs";

function check(id, ok, details = {}) {
  return { id, status: ok ? "PASS" : "FAIL", details };
}

export function validateInstance({ store, taskSource, registry = defaultRegistry, instanceRoot = null }) {
  const checks = [];
  try {
    const kernelIntegrity = store.db.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]);
    checks.push(check("kernel-sqlite-integrity", kernelIntegrity.every((value) => value === "ok"), { values: kernelIntegrity }));
  } catch (error) {
    checks.push(check("kernel-sqlite-integrity", false, { error: error.message }));
  }
  try {
    const sourceIntegrity = taskSource.integrityCheck();
    checks.push(check("task-source-sqlite-integrity", sourceIntegrity.every((value) => value === "ok"), { values: sourceIntegrity }));
  } catch (error) {
    checks.push(check("task-source-sqlite-integrity", false, { error: error.message }));
  }

  const foreignKeys = store.db.prepare("PRAGMA foreign_key_check").all();
  checks.push(check("kernel-referential-integrity", foreignKeys.length === 0, { violations: foreignKeys }));

  const profileFailures = store.tableRows("instance_profiles").flatMap((row) => {
    const failures = [];
    let config;
    try {
      config = JSON.parse(row.config_json);
    } catch {
      failures.push("config_json_invalid");
    }
    if (config && sha256(canonicalJson(config)) !== row.config_hash) failures.push("config_hash_mismatch");
    if (config && (row.mode !== "PERSONAL" || row.seed !== "NONE" || row.runtime !== "CODEX")) failures.push("generic_profile_boundary_invalid");
    return failures.length ? [{ instance_id: row.instance_id, failures }] : [];
  });
  checks.push(check("instance-profile-integrity", profileFailures.length === 0, { failures: profileFailures }));

  const forbiddenCaptureFields = new Set(["raw_conversation", "conversation", "messages", "history", "transcript"]);
  const captureFailures = store.tableRows("events").flatMap((row) => {
    try {
      const payload = JSON.parse(row.payload_json);
      const forbidden = Object.keys(payload).filter((key) => forbiddenCaptureFields.has(key));
      return forbidden.length ? [{ event_id: row.event_id, forbidden }] : [];
    } catch {
      return [{ event_id: row.event_id, forbidden: ["invalid_payload_json"] }];
    }
  });
  checks.push(check("minimal-capture-boundary", captureFailures.length === 0, { failures: captureFailures }));

  const capabilityFailures = registry.list().flatMap((entry) => {
    const result = checkSchema("capability", entry);
    return result.ok ? [] : [{ capability_id: entry.capability_id, errors: result.errors }];
  });
  checks.push(check("capability-schemas", capabilityFailures.length === 0, { failures: capabilityFailures }));

  const workspaceRows = store.tableRows("workspaces");
  const activationFailures = [];
  for (const workspace of workspaceRows) {
    const discovery = new Map(registry.discovery({ store, workspaceId: workspace.workspace_id }).map((entry) => [entry.capability_ref, entry]));
    for (const activation of store.listCapabilityActivations(workspace.workspace_id)) {
      const expected = discovery.get(activation.capability_ref);
      if (!expected || activation.contract_state !== (expected.state === "DISABLED" ? "AVAILABLE" : expected.state)) {
        activationFailures.push({ workspace_id: workspace.workspace_id, capability_ref: activation.capability_ref });
      }
    }
  }
  checks.push(check("capability-registrations", activationFailures.length === 0, { failures: activationFailures }));

  const sourceBindingFailures = store.tableRows("source_bindings").flatMap((row) => {
    const failures = [];
    let config;
    try {
      config = JSON.parse(row.config_json);
    } catch {
      failures.push("config_json_invalid");
    }
    if (config && sha256(canonicalJson(config)) !== row.config_hash) failures.push("config_hash_mismatch");
    const source = store.db.prepare("SELECT 1 FROM sources WHERE workspace_id=? AND source_id=?").get(row.workspace_id, row.source_id);
    if (!source) failures.push("source_missing");
    const activation = store.getCapabilityActivation(row.workspace_id, row.capability_ref);
    if (!activation) failures.push("capability_activation_missing");
    return failures.length ? [{ workspace_id: row.workspace_id, capability_ref: row.capability_ref, failures }] : [];
  });
  checks.push(check("source-binding-integrity", sourceBindingFailures.length === 0, { failures: sourceBindingFailures }));

  const planFailures = [];
  for (const row of store.tableRows("plans")) {
    try {
      verifyFrozenPlanIntegrity({ ...JSON.parse(row.plan_json), state: row.state });
    } catch (error) {
      planFailures.push({ plan_id: row.plan_id, code: error.code, message: error.message });
    }
  }
  checks.push(check("plan-schema-and-hashes", planFailures.length === 0, { failures: planFailures }));

  const bindingFailures = store.db.prepare(`SELECT g.grant_id FROM grants g JOIN plans p ON p.plan_id=g.plan_id
    WHERE g.plan_hash<>p.plan_hash OR g.workspace_id<>p.workspace_id OR g.source_id<>p.source_id OR g.resource_ref<>p.resource_ref
      OR g.capability_id<>p.capability_id OR g.capability_version<>p.capability_version OR g.operation_id<>p.operation_id
      OR g.policy_id<>p.policy_id OR g.policy_version<>p.policy_version OR g.max_uses<>1 OR g.use_count NOT BETWEEN 0 AND 1`).all();
  const grantSchemaFailures = store.tableRows("grants").flatMap((row) => {
    const value = {
      schema: "MutationGrant@v1",
      grant_id: row.grant_id,
      plan_id: row.plan_id,
      plan_hash: row.plan_hash,
      approver_actor_id: row.approver_actor_id,
      executor_actor_id: row.executor_actor_id,
      workspace_id: row.workspace_id,
      source_id: row.source_id,
      resource_ref: row.resource_ref,
      capability_id: row.capability_id,
      capability_version: row.capability_version,
      operation_id: row.operation_id,
      policy_id: row.policy_id,
      policy_version: row.policy_version,
      issued_at: row.issued_at,
      expires_at: row.expires_at,
      max_uses: row.max_uses,
      use_count: row.use_count,
      consumed_at: row.consumed_at,
      execution_id: row.execution_id,
    };
    const result = checkSchema("grant", value);
    return result.ok ? [] : [{ grant_id: row.grant_id, errors: result.errors }];
  });
  checks.push(check("plan-grant-binding", bindingFailures.length === 0 && grantSchemaFailures.length === 0, { binding_failures: bindingFailures, schema_failures: grantSchemaFailures }));

  const transitionFailures = [];
  for (const row of store.tableRows("execution_transitions")) {
    if (row.from_state === null && row.to_state === "CREATED") continue;
    if (!executionTransitions.get(row.from_state)?.has(row.to_state)) transitionFailures.push(row);
  }
  checks.push(check("execution-transitions", transitionFailures.length === 0, { failures: transitionFailures }));

  const orphanResults = store.db.prepare("SELECT r.result_id FROM results r LEFT JOIN executions e ON e.execution_id=r.execution_id WHERE e.execution_id IS NULL").all();
  checks.push(check("no-orphan-results", orphanResults.length === 0, { orphans: orphanResults }));

  const artifactFailures = store.tableRows("artifacts").filter((row) => sha256(canonicalJson(JSON.parse(row.content_json))) !== row.content_hash);
  checks.push(check("artifact-integrity", artifactFailures.length === 0, { failures: artifactFailures.map((row) => row.artifact_id) }));

  const capabilityResultFailures = [];
  for (const row of store.tableRows("results")) {
    const result = JSON.parse(row.result_json);
    if (result.schema !== "CapabilityResult@v1") continue;
    const schemaResult = checkSchema("capabilityResult", result);
    if (!schemaResult.ok) capabilityResultFailures.push({ result_id: result.result_id, errors: schemaResult.errors });
    try {
      registry.validateOutput(result.capability_id, result.capability_version, result.operation_id, result.output);
    } catch (error) {
      capabilityResultFailures.push({ result_id: result.result_id, code: error.code, message: error.message });
    }
    if (result.artifact_ref && !store.getArtifact(result.artifact_ref, result.workspace_id)) {
      capabilityResultFailures.push({ result_id: result.result_id, code: "ARTIFACT_NOT_FOUND" });
    }
    const evidenceIds = new Set(store.getEvidence(result.workspace_id).map((item) => item.evidence_id));
    const missingEvidence = result.evidence_refs.filter((ref) => !evidenceIds.has(ref));
    if (missingEvidence.length) capabilityResultFailures.push({ result_id: result.result_id, missing_evidence: missingEvidence });
  }
  checks.push(check("capability-results", capabilityResultFailures.length === 0, { failures: capabilityResultFailures }));

  const boundaryFailures = store.db.prepare(`SELECT e.execution_id FROM executions e
    LEFT JOIN actor_workspaces aw ON aw.actor_id=e.actor_id AND aw.workspace_id=e.workspace_id
    WHERE aw.actor_id IS NULL`).all();
  checks.push(check("instance-and-workspace-boundaries", boundaryFailures.length === 0, { failures: boundaryFailures }));

  const sourceRows = taskSource.idempotencyRows();
  const sourceFailures = sourceRows.filter((row) => row.after_version !== row.before_version + 1 || row.receipt.plan_hash !== row.plan_hash);
  checks.push(check("source-idempotency-invariants", sourceFailures.length === 0, { failures: sourceFailures.map((row) => row.idempotency_key) }));

  const versionFailures = store.db.prepare(`SELECT r.result_id, p.expected_source_version, json_extract(r.result_json, '$.source_version') AS source_version
    FROM results r JOIN executions e ON e.execution_id=r.execution_id JOIN plans p ON p.plan_id=e.plan_id
    WHERE r.outcome='SUCCEEDED' AND json_extract(r.result_json, '$.source_version')<>p.expected_source_version+1`).all();
  checks.push(check("verified-result-versions", versionFailures.length === 0, { failures: versionFailures }));

  const dependencyChecks = registry.validateDependencies({ store, workspaceId: workspaceRows[0]?.workspace_id || null, instanceRoot });
  checks.push(check("capability-dependencies", dependencyChecks.every((item) => item.ok), { results: dependencyChecks }));

  return {
    status: checks.every((item) => item.status === "PASS") ? "PASS" : "FAIL",
    checks,
    audit_implemented: false,
    audit_boundary: "Validator reports deterministic invariants only; it does not repair or create audit findings.",
  };
}
