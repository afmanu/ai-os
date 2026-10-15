import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { AiOsKernel } from "../src/core/kernel.mjs";
import { authorizeCapture, assertGrantBindings } from "../src/core/policy.mjs";
import { normalizeRequest } from "../src/core/normalizer.mjs";
import { backupInstance, restoreInstance } from "../src/core/backup.mjs";
import { validateInstance } from "../src/core/validator.mjs";
import { verifyFrozenPlanIntegrity } from "../src/core/approval.mjs";
import { defaultRegistry } from "../src/core/registry.mjs";
import { opaqueKey } from "../src/core/utils.mjs";
import { atlasStatement } from "../src/fixtures/atlas.mjs";
import { approvedKernel, ATLAS, initializedKernel, removeRoot, tempRoot } from "./helpers.mjs";

test("captura interna autorizada y conversación no capturada", async (t) => {
  const root = tempRoot("ai-os-capture-allowed-");
  t.after(() => removeRoot(root));
  const kernel = new AiOsKernel(root);
  kernel.initializeAtlas();
  t.after(() => kernel.close());
  const result = await kernel.captureAtlasStatement();
  assert.equal(result.raw_conversation_captured, false);
  assert.equal(result.task_mutated, false);
  const [event] = kernel.store.tableRows("events");
  const payload = JSON.parse(event.payload_json);
  assert.equal("raw_conversation" in payload, false);
  assert.equal("messages" in payload, false);
  assert.deepEqual(Object.keys(payload).sort(), result.captured_fields.sort());
  assert.equal(kernel.taskSource.readTask(ATLAS.workspaceId, ATLAS.taskId).version, 7);
});

test("captura interna denegada", async (t) => {
  const root = tempRoot("ai-os-capture-denied-");
  t.after(() => removeRoot(root));
  const kernel = new AiOsKernel(root);
  kernel.initializeAtlas();
  t.after(() => kernel.close());
  const identity = kernel.identity();
  const normalized = normalizeRequest({ text: atlasStatement, workspaceId: ATLAS.workspaceId, projectRef: ATLAS.projectId, projectName: "Atlas", taskRef: ATLAS.taskId });
  const deniedPolicy = structuredClone(kernel.policies().data);
  deniedPolicy.internal_capture.allowed_event_types = [];
  assert.throws(() => authorizeCapture({ policy: deniedPolicy, normalized, identity, text: atlasStatement, occurredAt: new Date().toISOString() }), (error) => error.code === "CAPTURE_DENIED");
  assert.equal(kernel.store.tableRows("events").length, 0);
});

test("grant expirado no muta y no crea execution", async (t) => {
  const root = tempRoot("ai-os-expired-");
  t.after(() => removeRoot(root));
  let now = new Date("2026-10-09T10:00:00.000Z");
  const clock = () => new Date(now);
  const { kernel } = await approvedKernel(root, { clock });
  t.after(() => kernel.close());
  now = new Date("2026-10-09T10:16:00.000Z");
  await assert.rejects(kernel.execute(), (error) => error.code === "GRANT_EXPIRED");
  assert.equal(kernel.taskSource.readTask(ATLAS.workspaceId, ATLAS.taskId).version, 7);
  assert.equal(kernel.store.tableRows("executions").length, 0);
});

test("grant de otro actor y workspace no concede ni filtra", async (t) => {
  const root = tempRoot("ai-os-grant-scope-");
  t.after(() => removeRoot(root));
  const { kernel } = await approvedKernel(root);
  t.after(() => kernel.close());
  const now = new Date().toISOString();
  kernel.store.db.prepare("INSERT INTO actors(actor_id, instance_id, principal_id, kind, created_at) VALUES(?, ?, ?, 'local', ?)")
    .run("ACT-FICTIONAL-OTHER-01", ATLAS.instanceId, "PRN-FICTIONAL-OTHER-01", now);
  kernel.store.db.prepare("INSERT INTO actor_workspaces(actor_id, workspace_id, role) VALUES(?, ?, 'owner')")
    .run("ACT-FICTIONAL-OTHER-01", ATLAS.workspaceId);
  await assert.rejects(kernel.execute({ principalId: "PRN-FICTIONAL-OTHER-01" }), (error) => error.code === "GRANT_INVALID");

  kernel.store.db.prepare("INSERT INTO workspaces(workspace_id, instance_id, kind, classification, created_at) VALUES(?, ?, 'personal', 'synthetic', ?)")
    .run("WS-FICTIONAL-OTHER-01", ATLAS.instanceId, now);
  kernel.store.db.prepare("INSERT INTO actor_workspaces(actor_id, workspace_id, role) VALUES(?, ?, 'owner')")
    .run(ATLAS.actorId, "WS-FICTIONAL-OTHER-01");
  kernel.store.db.prepare("INSERT INTO policies(policy_id, policy_version, workspace_id, policy_kind, policy_json) VALUES(?, 1, ?, 'action', ?)")
    .run(ATLAS.actionPolicyId, "WS-FICTIONAL-OTHER-01", JSON.stringify(kernel.policies().action));
  kernel.store.db.prepare("INSERT INTO policies(policy_id, policy_version, workspace_id, policy_kind, policy_json) VALUES(?, 1, ?, 'data', ?)")
    .run(ATLAS.dataPolicyId, "WS-FICTIONAL-OTHER-01", JSON.stringify(kernel.policies().data));
  await assert.rejects(kernel.execute({ workspaceId: "WS-FICTIONAL-OTHER-01" }), (error) => error.code === "GRANT_NOT_FOUND");
  assert.equal(kernel.taskSource.readTask(ATLAS.workspaceId, ATLAS.taskId).version, 7);
});

test("patch alterado y plan hash alterado invalidan aprobación", async (t) => {
  const rootA = tempRoot("ai-os-patch-altered-");
  const rootB = tempRoot("ai-os-hash-altered-");
  t.after(() => { removeRoot(rootA); removeRoot(rootB); });
  const kernelA = await initializedKernel(rootA);
  const preparedA = await kernelA.prepareUpdate();
  const row = kernelA.store.db.prepare("SELECT plan_json FROM plans WHERE plan_id=?").get(ATLAS.planId);
  const altered = JSON.parse(row.plan_json);
  altered.patch[0].value = "done";
  kernelA.store.db.prepare("UPDATE plans SET plan_json=? WHERE plan_id=?").run(JSON.stringify(altered), ATLAS.planId);
  assert.throws(() => kernelA.approve({ planHash: preparedA.plan.plan_hash }), (error) => error.code === "PLAN_HASH_MISMATCH");
  kernelA.close();

  const kernelB = await initializedKernel(rootB);
  await kernelB.prepareUpdate();
  assert.throws(() => kernelB.approve({ planHash: "sha256:" + "0".repeat(64) }), (error) => error.code === "PLAN_HASH_MISMATCH");
  kernelB.close();
});

test("policy version alterada invalida el grant", async (t) => {
  const root = tempRoot("ai-os-policy-binding-");
  t.after(() => removeRoot(root));
  const { kernel, prepared, grant } = await approvedKernel(root);
  t.after(() => kernel.close());
  const altered = { ...grant, policy_version: 2 };
  assert.throws(() => assertGrantBindings({ grant: altered, plan: prepared.plan, identity: kernel.identity(), now: new Date().toISOString() }), (error) => error.code === "GRANT_INVALID");
});

test("resultado existente permanece consultable con grant consumido", async (t) => {
  const root = tempRoot("ai-os-consumed-result-");
  t.after(() => removeRoot(root));
  const { kernel } = await approvedKernel(root);
  t.after(() => kernel.close());
  const first = await kernel.execute();
  const grant = kernel.store.getGrant(ATLAS.grantId, ATLAS.workspaceId);
  assert.equal(grant.use_count, 1);
  const second = await kernel.execute();
  assert.equal(second.result_id, first.result_id);
  assert.equal(second.duplicate_request, true);
  assert.equal(kernel.taskSource.readTask(ATLAS.workspaceId, ATLAS.taskId).version, 8);
});

test("idempotency key no revela resultados entre scopes", async (t) => {
  const root = tempRoot("ai-os-idempotency-scope-");
  t.after(() => removeRoot(root));
  const { kernel } = await approvedKernel(root);
  t.after(() => kernel.close());
  const key = "KEY-FICTIONAL-SCOPE-01";
  await kernel.execute({ idempotencyKey: key });
  const execution = kernel.store.getExecution(ATLAS.executionId, ATLAS.workspaceId);
  const own = kernel.taskSource.lookupIdempotency(execution);
  const otherActor = kernel.taskSource.lookupIdempotency({ ...execution, actor_id: "ACT-FICTIONAL-OTHER-01" });
  const otherWorkspace = kernel.taskSource.lookupIdempotency({ ...execution, workspace_id: "WS-FICTIONAL-OTHER-01" });
  assert.equal(own.after_version, 8);
  assert.equal(otherActor, null);
  assert.equal(otherWorkspace, null);
});

test("effect_not_observed exige nuevo plan y grant", async (t) => {
  const root = tempRoot("ai-os-effect-not-observed-");
  t.after(() => removeRoot(root));
  const { kernel, prepared, grant } = await approvedKernel(root);
  t.after(() => kernel.close());
  const identity = kernel.identity();
  kernel.store.createExecutionCheckpoint({
    executionId: ATLAS.executionId,
    actorId: identity.actor_id,
    plan: prepared.plan,
    grant,
    idempotencyKey: "KEY-FICTIONAL-NO-EFFECT-01",
  });
  const recovered = await kernel.recover({ executionId: ATLAS.executionId });
  assert.equal(recovered.outcome, "EFFECT_NOT_OBSERVED");
  assert.equal(kernel.taskSource.readTask(ATLAS.workspaceId, ATLAS.taskId).version, 7);
  const repeated = await kernel.execute();
  assert.equal(repeated.outcome, "EFFECT_NOT_OBSERVED");
  assert.equal(repeated.duplicate_request, true);
  assert.equal(kernel.taskSource.readTask(ATLAS.workspaceId, ATLAS.taskId).version, 7);
});

test("reconciliación de solo lectura funciona sin permiso de mutación", async (t) => {
  const root = tempRoot("ai-os-read-only-recovery-");
  t.after(() => removeRoot(root));
  const { kernel } = await approvedKernel(root);
  const uncertain = await kernel.execute({ simulateUnknownAfterEffect: true });
  assert.equal(uncertain.state, "UNKNOWN_EFFECT");
  const actionPolicy = kernel.policies().action;
  actionPolicy.rules["cap.task-record@0.1.0/task.update.execute"] = "DENY";
  kernel.store.db.prepare("UPDATE policies SET policy_json=? WHERE workspace_id=? AND policy_id=? AND policy_version=1")
    .run(JSON.stringify(actionPolicy), ATLAS.workspaceId, ATLAS.actionPolicyId);
  kernel.close();
  const restarted = new AiOsKernel(root);
  t.after(() => restarted.close());
  const result = await restarted.recover({ executionId: ATLAS.executionId });
  assert.equal(result.outcome, "SUCCEEDED");
  assert.equal(result.verified, true);
});

test("corrupción del store bloquea apertura", async (t) => {
  const root = tempRoot("ai-os-corrupt-");
  t.after(() => removeRoot(root));
  const kernel = await initializedKernel(root);
  const path = kernel.paths.kernelDb;
  kernel.close();
  writeFileSync(path, Buffer.from("not-a-sqlite-database"));
  assert.throws(() => new AiOsKernel(root), (error) => error.code === "STORE_CORRUPT");
});

test("backup y restore sintético preservan integridad y referencias", async (t) => {
  const root = tempRoot("ai-os-backup-source-");
  const backupRoot = tempRoot("ai-os-backup-destination-");
  const restoredRoot = tempRoot("ai-os-restore-");
  removeRoot(backupRoot);
  removeRoot(restoredRoot);
  t.after(() => { removeRoot(root); removeRoot(backupRoot); removeRoot(restoredRoot); });
  const { kernel } = await approvedKernel(root);
  await kernel.execute();
  kernel.close();
  const manifest = await backupInstance(root, backupRoot);
  assert.deepEqual(manifest.files.kernel.integrity, ["ok"]);
  assert.deepEqual(manifest.files.task_source.integrity, ["ok"]);
  const restored = restoreInstance(backupRoot, restoredRoot);
  assert.deepEqual(restored.integrity.kernel, ["ok"]);
  assert.deepEqual(restored.integrity.task_source, ["ok"]);
  const reopened = new AiOsKernel(restoredRoot);
  t.after(() => reopened.close());
  const outcome = reopened.outcome();
  assert.equal(outcome.result.outcome, "SUCCEEDED");
  assert.equal(outcome.task.version, 8);
  assert.equal(reopened.store.tableRows("events").length, 1);
  assert.equal(reopened.store.tableRows("evidence").length, 1);
  assert.equal(reopened.store.tableRows("plans").length, 1);
  assert.equal(reopened.store.tableRows("grants").length, 1);
  assert.equal(reopened.store.tableRows("executions").length, 1);
  assert.equal(reopened.store.tableRows("results").length, 1);
  assert.equal(reopened.store.tableRows("task_refs").length, 1);
  assert.equal(reopened.taskSource.idempotencyRows().length, 1);
  assert.equal(reopened.taskSource.db.prepare("SELECT COUNT(*) AS count FROM task_history").get().count, 1);
});

test("capability contracts y validator son deterministas", async (t) => {
  const root = tempRoot("ai-os-validator-");
  t.after(() => removeRoot(root));
  const { kernel } = await approvedKernel(root);
  t.after(() => kernel.close());
  await kernel.execute();
  const contracts = defaultRegistry.list();
  assert.deepEqual(contracts.map((item) => `${item.capability_id}@${item.capability_version}`), ["cap.situation@0.1.0", "cap.task-record@0.1.0"]);
  assert.equal(defaultRegistry.operation("cap.task-record", "0.1.0", "task.update.execute").effect_class, "OPERATIONAL_MUTATION");
  assert.equal(validateInstance({ store: kernel.store, taskSource: kernel.taskSource }).status, "PASS");
});
