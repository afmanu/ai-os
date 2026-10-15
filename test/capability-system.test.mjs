import assert from "node:assert/strict";
import { test } from "node:test";
import { AiOsKernel } from "../src/core/kernel.mjs";
import { CapabilityRegistry, defaultRegistry } from "../src/core/registry.mjs";
import { ATLAS, removeRoot, tempRoot } from "./helpers.mjs";

const inputSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "FixtureInput@v1",
  type: "object",
  additionalProperties: false,
  required: ["workspace_id", "resource_id", "value"],
  properties: {
    workspace_id: { type: "string" },
    resource_id: { type: "string" },
    value: { type: "string" },
  },
};

const outputSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "FixtureOutput@v1",
  type: "object",
  additionalProperties: false,
  required: ["resource_id", "value", "evidence_refs"],
  properties: {
    resource_id: { type: "string" },
    value: { type: "string" },
    evidence_refs: { type: "array", items: { type: "string" }, minItems: 1 },
  },
};

function fixtureManifest(id = "cap.fixture", intent = "fixture_prepare") {
  return {
    schema: "CapabilityManifest@v2",
    manifest_version: 2,
    capability_id: id,
    capability_version: "0.1.0",
    competence: { domain: "fixture", summary: "Validar el mecanismo genérico sin introducir un dominio de producto." },
    triggers: { intents: [intent, "fixture_read"], explicit_invocation: true },
    dependencies: { runtime: ["kernel-record-store"], sources: ["fixture-source"], capabilities: [] },
    operations: [
      {
        operation_id: "fixture.read",
        effect_class: "READ",
        triggers: { intents: ["fixture_read"] },
        input: { schema_id: "FixtureInput@v1", required_context: ["workspace_id", "resource_id", "value"], missing_input_behavior: "REJECT" },
        output: { schema_id: "FixtureOutput@v1", artifact_kind: null, result_references: ["evidence_refs"] },
        permission: "source.read",
        side_effects: { reads: ["fixture-source"], writes: [], write_scope: "none" },
        execution: { entrypoint: "fixture:read", timeout_ms: 1000, failure_contract: ["NOT_FOUND"], idempotency: "scoped_durable" },
        verification: { entrypoint: "fixture:verify", postconditions: ["source_matches"], evidence: ["fixture-record"], read_back: true },
      },
      {
        operation_id: "fixture.prepare",
        effect_class: "PREPARE",
        triggers: { intents: [intent] },
        input: { schema_id: "FixtureInput@v1", required_context: ["workspace_id", "resource_id", "value"], missing_input_behavior: "REJECT" },
        output: { schema_id: "FixtureOutput@v1", artifact_kind: "fixture-draft", result_references: ["evidence_refs"] },
        permission: "fixture.prepare",
        side_effects: { reads: ["fixture-source"], writes: ["kernel-record-store:artifacts"], write_scope: "kernel_instance" },
        execution: { entrypoint: "fixture:prepare", timeout_ms: 1000, failure_contract: ["NOT_FOUND"], idempotency: "scoped_durable" },
        verification: { entrypoint: "fixture:verify", postconditions: ["source_matches"], evidence: ["fixture-record"], read_back: true },
      },
    ],
  };
}

function fixtureModule({ id = "cap.fixture", intent = "fixture_prepare", suffix = "01" } = {}) {
  const evidenceId = `EVD-FIXTURE-${suffix}`;
  const makeAttempt = ({ input, operation }) => {
    const output = { resource_id: input.resource_id, value: input.value, evidence_refs: [evidenceId] };
    return {
      output,
      artifact: operation === "prepare" ? { artifact_id: `ART-FIXTURE-${suffix}`, content: output } : null,
      effects: operation === "prepare"
        ? { reads: ["fixture-source"], writes: ["kernel-record-store:artifacts"] }
        : { reads: ["fixture-source"], writes: [] },
    };
  };
  return {
    manifest: fixtureManifest(id, intent),
    schemas: { "FixtureInput@v1": inputSchema, "FixtureOutput@v1": outputSchema },
    default_enabled: true,
    resolve: ({ input }) => ({ source_id: "SRC-FIXTURE", resource_ref: input.resource_id, source_version: 1 }),
    handlers: {
      "fixture:read": ({ input }) => makeAttempt({ input, operation: "read" }),
      "fixture:prepare": ({ input }) => makeAttempt({ input, operation: "prepare" }),
    },
    verifiers: {
      "fixture:verify": ({ input, output, identity, clock }) => ({
        ok: output.resource_id === input.resource_id && output.value === input.value,
        failures: [],
        checks: { source_matches: true },
        evidence_refs: [evidenceId],
        evidence_records: [{
          evidence_id: evidenceId,
          workspace_id: identity.workspace_id,
          source_id: "SRC-FIXTURE",
          locator: `fixture:${input.resource_id}`,
          claims: [{ subject: input.resource_id, predicate: "value", value: input.value }],
          authority_kind: "external",
          authority_ref: "SRC-FIXTURE",
          observed_at: clock().toISOString(),
          evidence_hash: `sha256:fixture-${suffix}`,
        }],
      }),
    },
  };
}

function registryWith(modules, dependencies = ["kernel-record-store", "task-source", "fixture-source"]) {
  const policyRules = Object.fromEntries(modules.flatMap((module) => module.manifest.operations.map((operation) => [
    `${module.manifest.capability_id}@${module.manifest.capability_version}/${operation.operation_id}`,
    operation.effect_class === "READ" ? "ALLOW_READ" : "ALLOW_PREPARE",
  ])));
  return new CapabilityRegistry({ modules, availableDependencies: dependencies, policyRules });
}

test("registro genérico valida manifest, versión, operación, estado y dependencias", () => {
  const valid = registryWith([fixtureModule()]);
  assert.equal(valid.discovery().find((item) => item.capability_id === "cap.fixture").state, "AVAILABLE");
  assert.throws(() => valid.get("cap.fixture", "9.0.0"), (error) => error.code === "CAPABILITY_NOT_FOUND");
  assert.throws(() => valid.operation("cap.fixture", "0.1.0", "fixture.unknown"), (error) => error.code === "OPERATION_NOT_FOUND");

  const invalidManifest = fixtureManifest("cap.invalid");
  delete invalidManifest.operations[0].permission;
  const invalid = new CapabilityRegistry({ manifests: [], modules: [{ ...fixtureModule({ id: "cap.invalid" }), manifest: invalidManifest }], availableDependencies: ["kernel-record-store", "fixture-source"] });
  assert.equal(invalid.discovery()[0].state, "INVALID_CONTRACT");
  assert.throws(() => invalid.get("cap.invalid", "0.1.0"), (error) => error.code === "INVALID_CONTRACT");

  const missing = registryWith([fixtureModule()], ["kernel-record-store", "task-source"]);
  assert.equal(missing.discovery().find((item) => item.capability_id === "cap.fixture").state, "MISSING_DEPENDENCY");
});

test("routing declarativo selecciona dominios, no depende del orden y aclara empates", async (t) => {
  const root = tempRoot("ai-os-generic-route-");
  t.after(() => removeRoot(root));
  const moduleA = fixtureModule({ id: "cap.fixture-a", intent: "shared_intent", suffix: "A" });
  const moduleB = fixtureModule({ id: "cap.fixture-b", intent: "shared_intent", suffix: "B" });
  const registry = registryWith([moduleB, moduleA]);
  const kernel = new AiOsKernel(root, { registry });
  kernel.initializeAtlas();
  t.after(() => kernel.close());
  const input = { workspace_id: ATLAS.workspaceId, resource_id: "RES-FICTIONAL-01", value: "alpha" };
  assert.throws(() => kernel.routeCapability({ intent: "shared_intent", input }), (error) => {
    assert.equal(error.code, "NEEDS_CLARIFICATION");
    assert.deepEqual(error.details.candidates.map((item) => item.capability_id), ["cap.fixture-a", "cap.fixture-b"]);
    return true;
  });
  assert.deepEqual(defaultRegistry.select("prepare_task_update"), {
    capability_id: "cap.task-record",
    capability_version: "0.1.0",
    operation_id: "task.update.prepare",
  });
  assert.throws(() => kernel.routeCapability({ intent: "no_candidate", input }), (error) => error.code === "NO_ELIGIBLE_CAPABILITY");
});

test("invocación genérica usa policy, execution, verifier, artifact, evidence e idempotencia", async (t) => {
  const root = tempRoot("ai-os-generic-invoke-");
  t.after(() => removeRoot(root));
  const registry = registryWith([fixtureModule()]);
  const kernel = new AiOsKernel(root, { registry });
  kernel.initializeAtlas();
  t.after(() => kernel.close());
  const input = { workspace_id: ATLAS.workspaceId, resource_id: "RES-FICTIONAL-02", value: "beta" };
  const first = await kernel.invokeCapability({
    capabilityId: "cap.fixture",
    capabilityVersion: "0.1.0",
    operationId: "fixture.prepare",
    input,
    idempotencyKey: "KEY-FICTIONAL-CAPABILITY-01",
    executionId: "EXE-FIXTURE-01",
    resultId: "RES-FIXTURE-01",
  });
  assert.equal(first.outcome, "SUCCEEDED");
  assert.equal(first.verified, true);
  assert.equal(kernel.store.getExecution("EXE-FIXTURE-01", ATLAS.workspaceId).grant_id, null);
  const recovered = kernel.capabilityResult({ resultId: "RES-FIXTURE-01" });
  assert.equal(recovered.artifact.content.value, "beta");
  assert.equal(recovered.evidence[0].evidence_id, "EVD-FIXTURE-01");
  const duplicate = await kernel.invokeCapability({
    capabilityId: "cap.fixture",
    capabilityVersion: "0.1.0",
    operationId: "fixture.prepare",
    input,
    idempotencyKey: "KEY-FICTIONAL-CAPABILITY-01",
  });
  assert.equal(duplicate.duplicate_request, true);
  assert.equal(kernel.store.tableRows("artifacts").length, 1);

  kernel.setCapabilityEnabled({ capabilityId: "cap.fixture", capabilityVersion: "0.1.0", enabled: false });
  assert.equal(kernel.capabilities().find((item) => item.capability_id === "cap.fixture").state, "DISABLED");
  await assert.rejects(kernel.invokeCapability({
    capabilityId: "cap.fixture",
    capabilityVersion: "0.1.0",
    operationId: "fixture.read",
    input,
  }), (error) => error.code === "CAPABILITY_DISABLED");
});
