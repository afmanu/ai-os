import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createApplicationRegistry } from "../src/capabilities/catalog.mjs";
import { contentOsReadModule } from "../src/capabilities/content-os-read/module.mjs";
import { meetingBriefModule } from "../src/capabilities/meeting-brief/module.mjs";
import { AiOsKernel } from "../src/core/kernel.mjs";
import { validateInstance } from "../src/core/validator.mjs";
import { ATLAS, removeRoot, tempRoot } from "./helpers.mjs";
import { createSyntheticContentOsFixture, sourceInventory, syntheticContentOsState } from "./content-os-fixture.mjs";

const cliPath = fileURLToPath(new URL("../bin/ai-os.mjs", import.meta.url));

function contentKernel(root, fixture, { registry = createApplicationRegistry() } = {}) {
  const kernel = new AiOsKernel(root, { registry });
  kernel.initializeAtlas();
  if (fixture) kernel.configureCapability({ capabilityId: "cap.content-os-read", capabilityVersion: "0.1.0", config: fixture.binding });
  return kernel;
}

function invoke(kernel, operationId, input, suffix) {
  return kernel.invokeCapability({
    capabilityId: "cap.content-os-read",
    capabilityVersion: "0.1.0",
    operationId,
    input: { workspace_id: ATLAS.workspaceId, ...input },
    idempotencyKey: `KEY-CONTENT-OS-${suffix}`,
    executionId: `EXE-CONTENT-OS-${suffix}`,
    resultId: `RES-CONTENT-OS-${suffix}`,
  });
}

function runCapabilityCli(root, subcommand, args = [], expectedStatus = 0) {
  const result = spawnSync(process.execPath, ["--no-warnings", cliPath, "capability", subcommand, "--instance", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, expectedStatus, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  return {
    output: result.stdout.trim() ? JSON.parse(result.stdout) : null,
    error: result.stderr.trim().startsWith("{") ? JSON.parse(result.stderr) : null,
  };
}

function rewriteState(fixture, transform) {
  const state = JSON.parse(readFileSync(fixture.statePath, "utf8"));
  transform(state);
  writeFileSync(fixture.statePath, `${JSON.stringify(state, null, 2)}\n`);
}

test("Content OS se registra desde manifest y permanece desactivado hasta un binding explícito", async (t) => {
  const root = tempRoot("ai-os-content-discovery-");
  t.after(() => removeRoot(root));
  const kernel = contentKernel(root, null);
  t.after(() => kernel.close());
  const status = kernel.capabilities().find((item) => item.capability_id === "cap.content-os-read");
  assert.equal(status.state, "DISABLED");
  assert.deepEqual(status.operations, ["content.summary.read", "content.item.read", "content.output.read"]);
  kernel.setCapabilityEnabled({ capabilityId: "cap.content-os-read", capabilityVersion: "0.1.0", enabled: true });
  await assert.rejects(invoke(kernel, "content.summary.read", {}, "NOT-CONFIGURED"), (error) => error.code === "NOT_CONFIGURED");
});

test("binding por workspace, routing y tres operaciones READ conservan CONTENT, OUTPUT y procedencia", async (t) => {
  const root = tempRoot("ai-os-content-read-");
  const source = tempRoot("content-os-source-");
  t.after(() => { removeRoot(root); removeRoot(source); });
  const fixture = createSyntheticContentOsFixture(source);
  const kernel = contentKernel(root, fixture);
  t.after(() => kernel.close());
  assert.equal(kernel.capabilities().find((item) => item.capability_id === "cap.content-os-read").state, "AVAILABLE");
  assert.equal(kernel.routeCapability({ intent: "content_os_item_read", input: { workspace_id: ATLAS.workspaceId, content_id: "CONTENT-9901" } }).operation_id, "content.item.read");

  const summary = await invoke(kernel, "content.summary.read", {}, "SUMMARY-01");
  assert.equal(summary.output.summary.content_count, 2);
  assert.equal(summary.output.summary.output_count, 2);
  assert.equal(summary.output.source.freshness, "SNAPSHOT_AT_READ");
  const content = await invoke(kernel, "content.item.read", { content_id: "CONTENT-9901", include_artifacts: true }, "ITEM-01");
  assert.equal(content.output.content.schema, "ExternalContentReference@v1");
  assert.deepEqual(content.output.related_outputs.map((item) => item.output_id), ["OUTPUT-9901", "OUTPUT-9902"]);
  assert.equal(content.output.content.artifacts.find((item) => item.key === "evidence").availability, "READ");
  assert.equal(content.output.content.artifacts.find((item) => item.key === "absent_reference").availability, "MISSING");
  assert.equal(content.output.content.evidence.find((item) => item.evidence_id === "EVIDENCE-FICTIONAL-MISSING").availability, "MISSING");

  const output = await invoke(kernel, "content.output.read", { output_id: "OUTPUT-9902", include_artifact: true }, "OUTPUT-02");
  assert.equal(output.output.output.origin, "REPURPOSED");
  assert.equal(output.output.output.source_output_id, "OUTPUT-9901");
  assert.deepEqual(output.output.provenance_chain, ["OUTPUT-9902", "OUTPUT-9901"]);
  assert.equal(output.output.output.artifact.availability, "READ");
  assert.equal(output.output.output.status_basis, "SOURCE_DECLARED_NOT_EXTERNALLY_VERIFIED");
});

test("evidencia ausente no se fabrica y los resultados solo conservan lecturas autorizadas", async (t) => {
  const root = tempRoot("ai-os-content-evidence-");
  const source = tempRoot("content-os-evidence-");
  t.after(() => { removeRoot(root); removeRoot(source); });
  const fixture = createSyntheticContentOsFixture(source);
  const kernel = contentKernel(root, fixture);
  t.after(() => kernel.close());
  const result = await invoke(kernel, "content.item.read", { content_id: "CONTENT-9901", include_artifacts: true }, "EVIDENCE-01");
  const recovered = kernel.capabilityResult({ resultId: result.result_id });
  assert.equal(recovered.result.verified, true);
  assert.ok(recovered.evidence.some((item) => item.locator.endsWith("state/pieces.json")));
  assert.ok(recovered.evidence.some((item) => item.locator.endsWith("research/CONTENT-9901/EVIDENCE.md")));
  assert.equal(recovered.evidence.some((item) => item.locator.includes("ABSENT.md")), false);
  assert.equal(recovered.result.output.content.evidence.find((item) => item.evidence_id === "EVIDENCE-FICTIONAL-MISSING").content_read, false);
});

test("policy, activation, operación inexistente y workspace ajeno deniegan sin leer resultados cruzados", async (t) => {
  const roots = [tempRoot("ai-os-content-policy-"), tempRoot("ai-os-content-disabled-")];
  const source = tempRoot("content-os-policy-");
  t.after(() => { roots.forEach(removeRoot); removeRoot(source); });
  const fixture = createSyntheticContentOsFixture(source);

  const denied = contentKernel(roots[0], fixture);
  const policy = denied.policies().action;
  policy.rules["cap.content-os-read@0.1.0/content.item.read"] = "DENY";
  denied.store.db.prepare("UPDATE policies SET policy_json=? WHERE workspace_id=? AND policy_id=? AND policy_version=1").run(JSON.stringify(policy), ATLAS.workspaceId, ATLAS.actionPolicyId);
  await assert.rejects(invoke(denied, "content.item.read", { content_id: "CONTENT-9901" }, "DENIED"), (error) => error.code === "PERMISSION_DENIED");
  await assert.rejects(denied.invokeCapability({ capabilityId: "cap.content-os-read", capabilityVersion: "0.1.0", operationId: "content.item.mutate", input: { workspace_id: ATLAS.workspaceId, content_id: "CONTENT-9901" } }), (error) => error.code === "OPERATION_NOT_FOUND");
  await assert.rejects(denied.invokeCapability({ capabilityId: "cap.content-os-read", capabilityVersion: "0.1.0", operationId: "content.summary.read", workspaceId: "WS-FICTIONAL-OTHER-02", input: { workspace_id: "WS-FICTIONAL-OTHER-02" } }), (error) => error.code === "PERMISSION_DENIED");
  denied.close();

  const disabled = contentKernel(roots[1], fixture);
  disabled.setCapabilityEnabled({ capabilityId: "cap.content-os-read", capabilityVersion: "0.1.0", enabled: false });
  await assert.rejects(invoke(disabled, "content.summary.read", {}, "DISABLED"), (error) => error.code === "CAPABILITY_DISABLED");
  disabled.close();
});

test("configuración rechaza fuente inexistente, core incompatible y binding alterado", async (t) => {
  const roots = [tempRoot("ai-os-content-missing-"), tempRoot("ai-os-content-version-"), tempRoot("ai-os-content-binding-")];
  const sources = [tempRoot("content-os-missing-"), tempRoot("content-os-version-"), tempRoot("content-os-binding-")];
  t.after(() => { roots.forEach(removeRoot); sources.forEach(removeRoot); });

  let fixture = createSyntheticContentOsFixture(sources[0]);
  let kernel = contentKernel(roots[0], null);
  assert.throws(() => kernel.configureCapability({ capabilityId: "cap.content-os-read", capabilityVersion: "0.1.0", config: { ...fixture.binding, instance_root: join(sources[0], "absent") } }), (error) => error.code === "SOURCE_NOT_FOUND");
  kernel.close();

  fixture = createSyntheticContentOsFixture(sources[1]);
  writeFileSync(join(fixture.coreRoot, "VERSION"), "9.9.9\n");
  kernel = contentKernel(roots[1], null);
  assert.throws(() => kernel.configureCapability({ capabilityId: "cap.content-os-read", capabilityVersion: "0.1.0", config: fixture.binding }), (error) => error.code === "UNSUPPORTED_SCHEMA");
  kernel.close();

  fixture = createSyntheticContentOsFixture(sources[2]);
  kernel = contentKernel(roots[2], fixture);
  kernel.store.db.prepare("UPDATE source_bindings SET config_json=? WHERE workspace_id=? AND capability_ref=?").run("{}", ATLAS.workspaceId, "cap.content-os-read@0.1.0");
  await assert.rejects(invoke(kernel, "content.summary.read", {}, "BINDING-TAMPER"), (error) => error.code === "SOURCE_BINDING_INVALID");
  kernel.close();
});

test("JSON inválido, schema incompatible, IDs ausentes y relaciones inválidas fallan sin resultado", async (t) => {
  const cases = ["json", "schema", "content", "output", "content-relation", "repurposed"];
  for (const name of cases) {
    await t.test(name, async (st) => {
      const root = tempRoot(`ai-os-content-${name}-`);
      const source = tempRoot(`content-os-${name}-`);
      st.after(() => { removeRoot(root); removeRoot(source); });
      const fixture = createSyntheticContentOsFixture(source);
      const kernel = contentKernel(root, fixture);
      st.after(() => kernel.close());
      if (name === "json") writeFileSync(fixture.statePath, "{invalid");
      if (name === "schema") rewriteState(fixture, (state) => { state.schema_version = 99; });
      if (name === "content-relation") rewriteState(fixture, (state) => { state.outputs[0].content_id = "CONTENT-9999"; });
      if (name === "repurposed") rewriteState(fixture, (state) => { state.outputs[1].source_output_id = "OUTPUT-9999"; });
      const operation = name === "output" ? "content.output.read" : "content.item.read";
      const input = name === "output" ? { output_id: "OUTPUT-9999" } : { content_id: name === "content" ? "CONTENT-9999" : "CONTENT-9901" };
      const expected = { json: "INVALID_SOURCE_JSON", schema: "UNSUPPORTED_SCHEMA", content: "CONTENT_NOT_FOUND", output: "OUTPUT_NOT_FOUND", "content-relation": "INVALID_RELATIONSHIP", repurposed: "INVALID_RELATIONSHIP" }[name];
      await assert.rejects(invoke(kernel, operation, input, `NEG-${name}`), (error) => error.code === expected);
      assert.equal(kernel.store.tableRows("results").length, 0);
    });
  }
});

test("traversal, tipo no permitido y junction fuera de scope son rechazados", async (t) => {
  const cases = ["traversal", "type", "junction"];
  for (const name of cases) {
    await t.test(name, async (st) => {
      const root = tempRoot(`ai-os-content-path-${name}-`);
      const source = tempRoot(`content-os-path-${name}-`);
      st.after(() => { removeRoot(root); removeRoot(source); });
      const fixture = createSyntheticContentOsFixture(source);
      if (name === "traversal") rewriteState(fixture, (state) => { state.pieces[0].artifacts.idea = "../outside.md"; });
      if (name === "type") {
        writeFileSync(join(fixture.instanceRoot, "ideas", "payload.exe"), "not executable; synthetic");
        rewriteState(fixture, (state) => { state.pieces[0].artifacts.idea = "ideas/payload.exe"; });
      }
      if (name === "junction") {
        const outside = join(source, "outside");
        mkdirSync(outside, { recursive: true });
        writeFileSync(join(outside, "SECRET.md"), "synthetic outside file");
        symlinkSync(outside, join(fixture.instanceRoot, "research", "escape"), "junction");
        rewriteState(fixture, (state) => { state.pieces[0].artifacts.evidence = "research/escape/SECRET.md"; });
      }
      const kernel = contentKernel(root, fixture);
      st.after(() => kernel.close());
      const expected = name === "traversal" ? "PATH_TRAVERSAL" : name === "type" ? "FILE_NOT_ALLOWED" : "UNSAFE_PATH";
      await assert.rejects(invoke(kernel, "content.item.read", { content_id: "CONTENT-9901", include_artifacts: true }, `PATH-${name}`), (error) => error.code === expected);
    });
  }
});

test("fuente ausente y cambio entre handler y verifier no se presentan como lectura verificada", async (t) => {
  const missingRoot = tempRoot("ai-os-content-unavailable-");
  const changedRoot = tempRoot("ai-os-content-changed-");
  const sourceA = tempRoot("content-os-unavailable-");
  const sourceB = tempRoot("content-os-changed-");
  t.after(() => { [missingRoot, changedRoot, sourceA, sourceB].forEach(removeRoot); });

  let fixture = createSyntheticContentOsFixture(sourceA);
  let kernel = contentKernel(missingRoot, fixture);
  renameSync(fixture.statePath, `${fixture.statePath}.offline`);
  await assert.rejects(invoke(kernel, "content.summary.read", {}, "UNAVAILABLE"), (error) => error.code === "SOURCE_UNAVAILABLE");
  kernel.close();

  fixture = createSyntheticContentOsFixture(sourceB);
  const baseHandler = contentOsReadModule.handlers["content-os:item.read"];
  const changingModule = {
    ...contentOsReadModule,
    handlers: {
      ...contentOsReadModule.handlers,
      "content-os:item.read": (context) => {
        const attempt = baseHandler(context);
        rewriteState(fixture, (state) => { state.updated_at = "2035-04-05T10:01:00.000Z"; });
        return attempt;
      },
    },
  };
  const registry = createApplicationRegistry({ modules: [meetingBriefModule, changingModule] });
  kernel = contentKernel(changedRoot, fixture, { registry });
  await assert.rejects(invoke(kernel, "content.item.read", { content_id: "CONTENT-9901" }, "CHANGED"), (error) => error.code === "SOURCE_CHANGED");
  assert.equal(kernel.store.tableRows("results").length, 0);
  kernel.close();
});

test("consultas no escriben Content OS y el validator de AI OS comprueba el binding", async (t) => {
  const root = tempRoot("ai-os-content-readonly-");
  const source = tempRoot("content-os-readonly-");
  t.after(() => { removeRoot(root); removeRoot(source); });
  const fixture = createSyntheticContentOsFixture(source);
  const coreBefore = sourceInventory(fixture.coreRoot);
  const instanceBefore = sourceInventory(fixture.instanceRoot);
  const kernel = contentKernel(root, fixture);
  t.after(() => kernel.close());
  await invoke(kernel, "content.summary.read", {}, "READONLY-SUMMARY");
  await invoke(kernel, "content.item.read", { content_id: "CONTENT-9901", include_artifacts: true }, "READONLY-CONTENT");
  await invoke(kernel, "content.output.read", { output_id: "OUTPUT-9902", include_artifact: true }, "READONLY-OUTPUT");
  assert.deepEqual(sourceInventory(fixture.coreRoot), coreBefore);
  assert.deepEqual(sourceInventory(fixture.instanceRoot), instanceBefore);
  const validation = validateInstance({ store: kernel.store, taskSource: kernel.taskSource, registry: kernel.registry, instanceRoot: root });
  assert.equal(validation.status, "PASS");
  assert.equal(validation.checks.find((item) => item.id === "source-binding-integrity").status, "PASS");
});

test("resultado persiste entre procesos, queda etiquetado como snapshot y una nueva lectura detecta freshness", async (t) => {
  const root = tempRoot("ai-os-content-process-");
  const source = tempRoot("content-os-process-");
  t.after(() => { removeRoot(root); removeRoot(source); });
  const fixture = createSyntheticContentOsFixture(source);
  const initialized = spawnSync(process.execPath, ["--no-warnings", cliPath, "init", "--instance", root, "--mode", "ATLAS_FIXTURE", "--confirm-synthetic"], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  runCapabilityCli(root, "configure", ["--id", "cap.content-os-read", "--version", "0.1.0", "--config", JSON.stringify(fixture.binding)]);
  const input = JSON.stringify({ workspace_id: ATLAS.workspaceId, output_id: "OUTPUT-9902", include_artifact: true });
  const args = ["--id", "cap.content-os-read", "--version", "0.1.0", "--operation", "content.output.read", "--input", input, "--idempotency-key", "KEY-CONTENT-OS-PROCESS-01", "--execution-id", "EXE-CONTENT-OS-PROCESS-01", "--result-id", "RES-CONTENT-OS-PROCESS-01"];
  const first = runCapabilityCli(root, "invoke", args).output.data;
  const recovered = runCapabilityCli(root, "result", ["--result-id", "RES-CONTENT-OS-PROCESS-01"]).output.data;
  assert.equal(recovered.result.output.source.freshness, "SNAPSHOT_AT_READ");
  assert.equal(recovered.result.output.source.snapshot_hash, first.output.source.snapshot_hash);
  rewriteState(fixture, (state) => { state.updated_at = "2035-04-05T11:00:00.000Z"; state.outputs[1].status = "ready_for_review"; });
  const secondArgs = [...args];
  secondArgs[secondArgs.indexOf("KEY-CONTENT-OS-PROCESS-01")] = "KEY-CONTENT-OS-PROCESS-02";
  secondArgs[secondArgs.indexOf("EXE-CONTENT-OS-PROCESS-01")] = "EXE-CONTENT-OS-PROCESS-02";
  secondArgs[secondArgs.indexOf("RES-CONTENT-OS-PROCESS-01")] = "RES-CONTENT-OS-PROCESS-02";
  const refreshed = runCapabilityCli(root, "invoke", secondArgs).output.data;
  assert.notEqual(refreshed.output.source.snapshot_hash, first.output.source.snapshot_hash);
  assert.equal(refreshed.output.output.status, "ready_for_review");
});

test("retirar Content OS del catálogo no rompe Atlas ni Meeting Brief", async (t) => {
  const root = tempRoot("ai-os-content-remove-");
  const source = tempRoot("content-os-remove-");
  t.after(() => { removeRoot(root); removeRoot(source); });
  const fixture = createSyntheticContentOsFixture(source);
  let kernel = contentKernel(root, fixture);
  kernel.close();
  kernel = new AiOsKernel(root, { registry: createApplicationRegistry({ modules: [meetingBriefModule] }) });
  t.after(() => kernel.close());
  kernel.initializeAtlas();
  const atlas = await kernel.status();
  assert.equal(atlas.route.capability_id, "cap.situation");
  const meeting = await kernel.invokeCapability({
    capabilityId: "cap.meeting-brief",
    capabilityVersion: "0.1.0",
    operationId: "meeting.read",
    input: { workspace_id: ATLAS.workspaceId, meeting_id: "MTG-FICTIONAL-SOFTWARE-01" },
  });
  assert.equal(meeting.outcome, "SUCCEEDED");
});
