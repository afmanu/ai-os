import assert from "node:assert/strict";
import { test } from "node:test";
import { AiOsKernel } from "../src/core/kernel.mjs";
import { applicationRegistry } from "../src/capabilities/catalog.mjs";
import { CodexNativeRuntime } from "../src/runtime/codex-native.mjs";
import { ATLAS } from "../src/fixtures/atlas.mjs";
import { removeRoot, tempRoot } from "./helpers.mjs";

const timestamp = "2035-04-05T12:00:00.000Z";

async function setup(t, { capture = false } = {}) {
  const root = tempRoot("ai-os-codex-native-");
  const kernel = new AiOsKernel(root, { registry: applicationRegistry });
  kernel.initializeAtlas();
  if (capture) await kernel.captureAtlasStatement();
  t.after(() => {
    kernel.close();
    removeRoot(root);
  });
  return { root, kernel, runtime: new CodexNativeRuntime(kernel, { clock: () => new Date(timestamp) }) };
}

function request(id = "REQ-FICTIONAL-CODEX-01") {
  return {
    requestId: id,
    rawRequestRef: `CODEX-TURN-${id}`,
    inputChannel: "codex-test",
    timestamp,
  };
}

function response(modelRequest, overrides = {}) {
  return {
    schema: "ModelContextResponse@v1",
    request_id: modelRequest.request.request_id,
    candidate_intent: "query_project_status",
    explicit_user_goal: "Consultar los pendientes de Atlas.",
    referenced_entities: [{ entity_type: "PROJECT", entity_ref: ATLAS.projectId, mention: "Atlas", resolution: "RESOLVED" }],
    requested_effect: "READ",
    candidate_operation: { capability_id: "cap.situation", capability_version: "0.1.0", operation_id: "situation.read" },
    unresolved_references: [],
    missing_information: [],
    ambiguities: [],
    evidence_refs: ["REQUEST_TEXT"],
    retrieval_requirement_ids: [],
    disposition: "READY_FOR_ROUTING",
    ...overrides,
  };
}

test("el runtime Codex emite ModelContextRequest@v1 ligado a identidad y capabilities activas", async (t) => {
  const { runtime } = await setup(t);
  const context = runtime.context(request());
  assert.equal(context.runtime, "CODEX_NATIVE");
  assert.deepEqual(context.identity, { actor_id: ATLAS.actorId, workspace_id: ATLAS.workspaceId });
  assert.equal(context.model_request.schema, "ModelContextRequest@v1");
  assert.equal(context.model_request.constraints.never_authorize, true);
  assert.equal(context.model_request.constraints.never_execute, true);
  assert.equal(context.persistence.raw_request_stored, false);
  assert.ok(context.model_request.eligible_operations.some((item) => item.capability_id === "cap.situation" && item.operation_id === "situation.read"));
  assert.ok(context.model_request.eligible_operations.some((item) => item.capability_id === "cap.meeting-brief" && item.operation_id === "meeting.read"));
  assert.ok(!context.model_request.eligible_operations.some((item) => item.capability_id === "cap.content-os-read"));
});

test("la interpretación Codex se valida y pide contexto antes de responder", async (t) => {
  const { kernel, runtime } = await setup(t);
  const options = request("REQ-FICTIONAL-CODEX-READ-01");
  const context = runtime.context(options);
  const before = Object.fromEntries(["events", "plans", "grants", "executions"].map((table) => [table, kernel.store.tableRows(table).length]));
  const assessed = runtime.assess({ ...options, target: "ANSWER", response: response(context.model_request) });
  const after = Object.fromEntries(["events", "plans", "grants", "executions"].map((table) => [table, kernel.store.tableRows(table).length]));
  assert.equal(assessed.interpretation.schema, "ContextInterpretation@v1");
  assert.equal(assessed.interpretation.request.actor_id, ATLAS.actorId);
  assert.equal(assessed.interpretation.request.workspace_id, ATLAS.workspaceId);
  assert.equal(assessed.interpretation.disposition, "NEEDS_CONTEXT");
  assert.ok(assessed.interpretation.retrieval_requirements.some((item) => item.information === "task_state"));
  assert.equal(assessed.sufficiency.execution_permitted, false);
  assert.equal(assessed.execution_attempted, false);
  assert.equal(assessed.grant_created, false);
  assert.deepEqual(after, before);
});

test("el runtime rechaza capability no elegible, evidencia ajena y entidades incoherentes", async (t) => {
  const { runtime } = await setup(t);
  const options = request("REQ-FICTIONAL-CODEX-REJECT-01");
  const context = runtime.context(options);
  const base = response(context.model_request);
  assert.throws(() => runtime.assess({
    ...options,
    target: "ANSWER",
    response: { ...base, candidate_operation: { capability_id: "cap.content-os-read", capability_version: "0.1.0", operation_id: "content.summary.read" } },
  }), (error) => error.code === "MODEL_OPERATION_NOT_ELIGIBLE");
  assert.throws(() => runtime.assess({ ...options, target: "ANSWER", response: { ...base, evidence_refs: ["EVD-FOREIGN-01"] } }), (error) => error.code === "MODEL_EVIDENCE_NOT_AUTHORIZED");
  assert.throws(() => runtime.assess({
    ...options,
    target: "ANSWER",
    response: { ...base, referenced_entities: [{ entity_type: "PROJECT", entity_ref: null, mention: "Atlas", resolution: "RESOLVED" }] },
  }), (error) => error.code === "MODEL_ENTITY_INVALID");
});

test("el formato del modelo no puede incluir grants ni convertir una mutación en autorización", async (t) => {
  const { runtime } = await setup(t);
  const options = request("REQ-FICTIONAL-CODEX-MUTATION-01");
  const context = runtime.context(options);
  const mutation = response(context.model_request, {
    candidate_intent: "execute_task_update",
    explicit_user_goal: "Ejecutar una actualización de tarea.",
    referenced_entities: [{ entity_type: "TASK", entity_ref: ATLAS.taskId, mention: ATLAS.taskId, resolution: "RESOLVED" }],
    requested_effect: "OPERATIONAL_MUTATION",
    candidate_operation: { capability_id: "cap.task-record", capability_version: "0.1.0", operation_id: "task.update.execute" },
  });
  assert.throws(() => runtime.assess({ ...options, target: "EXECUTE_AUTHORIZED_ACTION", response: { ...mutation, grant: { state: "VALID" } } }), (error) => error.code === "SCHEMA_INVALID");
  const assessed = runtime.assess({ ...options, target: "EXECUTE_AUTHORIZED_ACTION", response: mutation });
  assert.equal(assessed.sufficiency.execution_permitted, false);
  assert.equal(assessed.sufficiency.authorization.present, false);
  assert.equal(assessed.sufficiency.allowed_next_action, "REQUEST_EXACT_APPROVAL");
  assert.equal(assessed.interpretation.disposition, "NEEDS_CONTEXT");
});

test("una aclaración innecesaria se corrige y un target incoherente se rechaza", async (t) => {
  const { runtime } = await setup(t);
  const options = request("REQ-FICTIONAL-CODEX-AMBIGUOUS-01");
  const context = runtime.context(options);
  const base = response(context.model_request);
  const corrected = runtime.assess({ ...options, target: "ANSWER", response: { ...base, disposition: "NEEDS_CLARIFICATION" } });
  assert.equal(corrected.interpretation.disposition, "NEEDS_CONTEXT");
  assert.equal(corrected.interpretation.response_mode, "PARTIAL_ANSWER");
  assert.throws(() => runtime.assess({ ...options, target: "PREPARE", response: base }), (error) => error.code === "MODEL_EFFECT_NOT_ALLOWED");
});

test("las decisiones se consultan mediante el kernel y permanecen aisladas por workspace", async (t) => {
  const { kernel } = await setup(t, { capture: true });
  const result = kernel.decisions({ subjectRef: ATLAS.taskId });
  assert.equal(result.identity.workspace_id, ATLAS.workspaceId);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].decision_type, "no_mutation_without_request");
  assert.throws(() => kernel.decisions({ workspaceId: "WS-FICTIONAL-OTHER-02" }), (error) => error.code === "PERMISSION_DENIED");
});
