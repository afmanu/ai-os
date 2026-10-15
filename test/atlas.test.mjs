import assert from "node:assert/strict";
import { test } from "node:test";
import { AiOsKernel } from "../src/core/kernel.mjs";
import { DeterministicInterpreter } from "../src/core/normalizer.mjs";
import { atlasStatement, atlasTask } from "../src/fixtures/atlas.mjs";
import { approvedKernel, ATLAS, initializedKernel, removeRoot, runCli, tempRoot } from "./helpers.mjs";

test("atlas-happy-path", async (t) => {
  const root = tempRoot("ai-os-happy-");
  t.after(() => removeRoot(root));
  assert.equal(runCli(root, "init").output.data.task_version, 7);
  const session1 = runCli(root, "capture").output.data;
  assert.equal(session1.task_mutated, false);
  assert.equal(session1.raw_conversation_captured, false);

  const session2 = runCli(root, "status").output.data;
  assert.equal(session2.statement.postponed, true);
  assert.equal(session2.statement.blocker_category, "permissions");
  assert.deepEqual(session2.situation.unknowns, ["required_permission", "permission_owner", "new_due_at"]);
  assert.equal(session2.situation.source_discrepancies.length, 1);
  assert.equal(session2.situation.factual_contradictions.length, 0);
  const prepared = runCli(root, "prepare").output.data;
  assert.equal(prepared.diff.expected_source_version, 7);
  assert.equal(prepared.diff.patch.length, 4);
  const grant = runCli(root, "approve", ["--plan-hash", prepared.plan.plan_hash]).output.data;
  assert.equal(grant.max_uses, 1);
  const executed = runCli(root, "execute").output.data;
  assert.equal(executed.outcome, "SUCCEEDED");
  assert.equal(executed.source_version, 8);

  const session3 = runCli(root, "result").output.data;
  assert.equal(session3.task.version, 8);
  assert.equal(session3.task.status, "blocked");
  assert.equal(session3.task.assignee, null);
  assert.equal(session3.task.due_at, null);
  assert.equal(session3.claims.permission_resolved, false);
  assert.equal(session3.claims.integration_completed, false);
  assert.equal(session3.claims.version_advanced_exactly_once, true);
  assert.ok(session3.decisions.some((decision) => decision.decision_type === "approve_frozen_plan"));
  assert.ok(session3.evidence.some((evidence) => evidence.evidence_id === ATLAS.evidenceId));
  const metrics = runCli(root, "metrics").output.data;
  assert.equal(metrics.model_calls, 0);
  assert.ok(metrics.phases.every((phase) => phase.min_ms >= 0));
  assert.equal(runCli(root, "validate").output.data.status, "PASS");
});

test("atlas-no-approval", async (t) => {
  const root = tempRoot("ai-os-no-approval-");
  t.after(() => removeRoot(root));
  runCli(root, "init");
  runCli(root, "capture");
  runCli(root, "prepare");
  const denied = runCli(root, "execute", [], { expectedStatus: 1 });
  assert.equal(denied.error.error.code, "GRANT_NOT_FOUND");
  const kernel = new AiOsKernel(root);
  t.after(() => kernel.close());
  assert.equal(kernel.taskSource.readTask(ATLAS.workspaceId, ATLAS.taskId).version, 7);
  assert.equal(kernel.store.tableRows("executions").length, 0);
});

test("atlas-stale-version", async (t) => {
  const root = tempRoot("ai-os-stale-");
  t.after(() => removeRoot(root));
  const { kernel } = await approvedKernel(root);
  t.after(() => kernel.close());
  kernel.taskSource.forceTaskUpdate(ATLAS.workspaceId, ATLAS.taskId, { status: "paused" });
  await assert.rejects(kernel.execute(), (error) => error.code === "VERSION_CONFLICT");
  assert.equal(kernel.store.getExecution(ATLAS.executionId, ATLAS.workspaceId).state, "FAILED");
  assert.equal(kernel.taskSource.readTask(ATLAS.workspaceId, ATLAS.taskId).version, 8);
});

test("atlas-duplicate", async (t) => {
  const root = tempRoot("ai-os-duplicate-");
  t.after(() => removeRoot(root));
  const { kernel } = await approvedKernel(root);
  t.after(() => kernel.close());
  const first = await kernel.execute({ idempotencyKey: "KEY-FICTIONAL-DUPLICATE-01" });
  const second = await kernel.execute({ idempotencyKey: "KEY-FICTIONAL-DUPLICATE-01" });
  assert.equal(first.outcome, "SUCCEEDED");
  assert.equal(second.duplicate_request, true);
  assert.equal(kernel.taskSource.readTask(ATLAS.workspaceId, ATLAS.taskId).version, 8);
  assert.equal(kernel.taskSource.idempotencyRows().length, 1);
});

test("atlas-unknown-effect", async (t) => {
  const root = tempRoot("ai-os-unknown-");
  t.after(() => removeRoot(root));
  const { kernel } = await approvedKernel(root);
  const uncertain = await kernel.execute({ simulateUnknownAfterEffect: true, idempotencyKey: "KEY-FICTIONAL-UNKNOWN-01" });
  assert.equal(uncertain.state, "UNKNOWN_EFFECT");
  assert.equal(kernel.taskSource.readTask(ATLAS.workspaceId, ATLAS.taskId).version, 8);
  kernel.close();

  const restarted = new AiOsKernel(root);
  t.after(() => restarted.close());
  const recovered = await restarted.recover({ executionId: ATLAS.executionId });
  assert.equal(recovered.outcome, "SUCCEEDED");
  assert.equal(recovered.verified, true);
  assert.equal(restarted.taskSource.readTask(ATLAS.workspaceId, ATLAS.taskId).version, 8);
});

test("atlas-verification-mismatch", async (t) => {
  const root = tempRoot("ai-os-mismatch-");
  t.after(() => removeRoot(root));
  const { kernel } = await approvedKernel(root);
  t.after(() => kernel.close());
  const result = await kernel.execute({ tamperUnauthorizedField: true });
  assert.equal(result.outcome, "VERIFICATION_FAILED");
  assert.equal(result.verified, false);
  assert.ok(result.verification.failures.includes("unauthorized_field_changed:assignee"));
});

test("atlas-ambiguous-routing", async (t) => {
  const root = tempRoot("ai-os-ambiguous-");
  t.after(() => removeRoot(root));
  const kernel = await initializedKernel(root);
  t.after(() => kernel.close());
  kernel.taskSource.insertTask({
    ...atlasTask,
    task_id: "TASK-ATLAS-18",
    title: "Revisar integración secundaria",
  });
  await assert.rejects(kernel.status(), (error) => error.code === "NEEDS_CLARIFICATION" && error.details.candidate_count === 2);
  assert.equal(kernel.store.tableRows("plans").length, 0);
});

test("atlas-cross-workspace", async (t) => {
  const root = tempRoot("ai-os-cross-");
  t.after(() => removeRoot(root));
  const kernel = await initializedKernel(root);
  t.after(() => kernel.close());
  await assert.rejects(kernel.status({ workspaceId: "WS-FICTIONAL-OTHER-01" }), (error) => error.code === "PERMISSION_DENIED");
  assert.throws(() => kernel.store.resolveIdentity(ATLAS.principalId, "WS-FICTIONAL-OTHER-01"), (error) => error.code === "PERMISSION_DENIED");
});

test("atlas-rebuild-situation", async (t) => {
  const root = tempRoot("ai-os-rebuild-");
  t.after(() => removeRoot(root));
  const kernel = await initializedKernel(root);
  t.after(() => kernel.close());
  const first = (await kernel.status()).situation;
  assert.equal(kernel.store.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='situation_models'").get().count, 0);
  const second = (await kernel.status()).situation;
  const material = ({ as_of: _asOf, ...value }) => value;
  assert.deepEqual(material(first), material(second));
});

test("atlas-model-invalid-output", async (t) => {
  const root = tempRoot("ai-os-model-invalid-");
  t.after(() => removeRoot(root));
  const kernel = new AiOsKernel(root);
  kernel.initializeAtlas();
  t.after(() => kernel.close());
  const invalidInterpreter = { interpret: () => ({ intent: "invented", raw_permission: "ALLOW_ALL" }) };
  await assert.rejects(kernel.captureAtlasStatement({ text: atlasStatement, interpreter: invalidInterpreter }), (error) => error.code === "SCHEMA_INVALID");
  assert.equal(kernel.store.tableRows("events").length, 0);
  assert.equal(kernel.taskSource.readTask(ATLAS.workspaceId, ATLAS.taskId).version, 7);
});

test("reinicio después de aplicar efecto recupera sin retry mutador", (t) => {
  const root = tempRoot("ai-os-crash-");
  t.after(() => removeRoot(root));
  runCli(root, "init");
  runCli(root, "capture");
  const prepared = runCli(root, "prepare").output.data;
  runCli(root, "approve", ["--plan-hash", prepared.plan.plan_hash]);
  const crashed = runCli(root, "execute", ["--idempotency-key", "KEY-FICTIONAL-CRASH-01", "--simulate-crash-after-effect"], { expectedStatus: 86 });
  assert.match(crashed.stderr, /SIMULATED_CRASH_AFTER_EFFECT/);
  const recovered = runCli(root, "recover", ["--execution-id", ATLAS.executionId]).output.data;
  assert.equal(recovered.outcome, "SUCCEEDED");
  const outcome = runCli(root, "result").output.data;
  assert.equal(outcome.task.version, 8);
  const kernel = new AiOsKernel(root);
  t.after(() => kernel.close());
  assert.equal(kernel.taskSource.idempotencyRows().length, 1);
});
