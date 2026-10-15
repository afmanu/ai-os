import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createApplicationRegistry } from "../src/capabilities/catalog.mjs";
import { meetingBriefModule } from "../src/capabilities/meeting-brief/module.mjs";
import { buildMeetingBrief } from "../src/capabilities/meeting-brief/handler.mjs";
import { meetingIntegration, meetingOperations } from "../src/capabilities/meeting-brief/fixtures.mjs";
import { MeetingSource, meetingSourcePath } from "../src/capabilities/meeting-brief/meeting-source.mjs";
import { verifyMeetingBrief } from "../src/capabilities/meeting-brief/verifier.mjs";
import { AiOsKernel } from "../src/core/kernel.mjs";
import { defaultRegistry } from "../src/core/registry.mjs";
import { validateInstance } from "../src/core/validator.mjs";
import { ATLAS, removeRoot, tempRoot } from "./helpers.mjs";

const cliPath = fileURLToPath(new URL("../bin/ai-os.mjs", import.meta.url));

function capabilityCli(root, subcommand, args = [], expectedStatus = 0) {
  const processResult = spawnSync(process.execPath, ["--no-warnings", cliPath, "capability", subcommand, "--instance", root, ...args], { encoding: "utf8" });
  if (processResult.status !== expectedStatus) {
    throw new Error(`capability ${subcommand} exited ${processResult.status}; stdout=${processResult.stdout}; stderr=${processResult.stderr}`);
  }
  return {
    status: processResult.status,
    output: processResult.stdout.trim() ? JSON.parse(processResult.stdout) : null,
    error: processResult.stderr.trim().startsWith("{") ? JSON.parse(processResult.stderr) : null,
  };
}

function meetingKernel(root, { registry = createApplicationRegistry() } = {}) {
  const kernel = new AiOsKernel(root, { registry });
  kernel.initializeAtlas();
  return kernel;
}

async function prepareBrief(kernel, meeting, suffix) {
  return kernel.invokeCapability({
    capabilityId: "cap.meeting-brief",
    capabilityVersion: "0.1.0",
    operationId: "meeting.brief.prepare",
    input: { workspace_id: ATLAS.workspaceId, meeting_id: meeting.meeting_id },
    idempotencyKey: `KEY-MEETING-${suffix}`,
    executionId: `EXE-MEETING-${suffix}`,
    resultId: `RES-MEETING-${suffix}`,
  });
}

test("Meeting Brief se descubre, inspecciona, desactiva y retira sin romper Atlas", async (t) => {
  const root = tempRoot("ai-os-meeting-discovery-");
  t.after(() => removeRoot(root));
  let kernel = meetingKernel(root);
  const status = kernel.capabilities().find((item) => item.capability_id === "cap.meeting-brief");
  assert.equal(status.state, "AVAILABLE");
  assert.deepEqual(status.operations, ["meeting.read", "meeting.brief.prepare"]);
  assert.equal(kernel.capability({ capabilityId: "cap.meeting-brief", capabilityVersion: "0.1.0" }).manifest.competence.domain, "meetings-and-decisions");
  kernel.setCapabilityEnabled({ capabilityId: "cap.meeting-brief", capabilityVersion: "0.1.0", enabled: false });
  assert.equal(kernel.capabilities().find((item) => item.capability_id === "cap.meeting-brief").state, "DISABLED");
  const atlasWhileDisabled = await kernel.status();
  assert.equal(atlasWhileDisabled.route.capability_id, "cap.situation");
  kernel.close();

  kernel = new AiOsKernel(root, { registry: defaultRegistry });
  t.after(() => kernel.close());
  const atlasWithoutModule = await kernel.status();
  assert.equal(atlasWithoutModule.task.task_id, ATLAS.taskId);
});

test("routing selecciona Meeting Brief y Task Management sin nombres de dominio en Core", (t) => {
  const root = tempRoot("ai-os-meeting-routing-");
  t.after(() => removeRoot(root));
  const kernel = meetingKernel(root);
  t.after(() => kernel.close());
  const meetingRoute = kernel.routeCapability({
    intent: "meeting_brief_prepare",
    input: { workspace_id: ATLAS.workspaceId, meeting_id: meetingIntegration.meeting_id },
  });
  assert.deepEqual(meetingRoute, {
    capability_id: "cap.meeting-brief",
    capability_version: "0.1.0",
    operation_id: "meeting.brief.prepare",
  });
  assert.deepEqual(defaultRegistry.select("prepare_task_update"), {
    capability_id: "cap.task-record",
    capability_version: "0.1.0",
    operation_id: "task.update.prepare",
  });
});

test("READ y PREPARE autorizados producen dos briefings distintos sin inventar datos", async (t) => {
  const root = tempRoot("ai-os-meeting-output-");
  t.after(() => removeRoot(root));
  const kernel = meetingKernel(root);
  t.after(() => kernel.close());
  const read = await kernel.invokeCapability({
    capabilityId: "cap.meeting-brief",
    capabilityVersion: "0.1.0",
    operationId: "meeting.read",
    input: { workspace_id: ATLAS.workspaceId, meeting_id: meetingIntegration.meeting_id },
    idempotencyKey: "KEY-MEETING-READ-01",
    executionId: "EXE-MEETING-READ-01",
    resultId: "RES-MEETING-READ-01",
  });
  assert.equal(read.output.meeting_id, meetingIntegration.meeting_id);
  const software = await prepareBrief(kernel, meetingIntegration, "SOFTWARE-01");
  const operations = await prepareBrief(kernel, meetingOperations, "OPERATIONS-02");
  assert.equal(software.outcome, "SUCCEEDED");
  assert.equal(operations.outcome, "SUCCEEDED");
  assert.notEqual(software.output.readable_markdown, operations.output.readable_markdown);
  assert.equal(software.output.decisions[0].text, meetingIntegration.decisions[0].text);
  assert.equal(software.output.decisions.some((item) => item.text === meetingIntegration.statements[0].text), false);
  assert.deepEqual(software.output.unknowns.map((item) => item.field), ["owner_ref", "due_at"]);
  assert.equal(operations.output.commitments[0].owner_ref, "ROLE-FICTIONAL-OPS-LEAD");
  assert.equal(operations.output.unknowns.length, 0);
  assert.equal(operations.output.conflicts[0].epistemic_status, "CONFLICTING");
  assert.match(software.output.readable_markdown, /## Decisiones documentadas/);
});

test("cambiar un fixture cambia el briefing sin modificar Core", async (t) => {
  const root = tempRoot("ai-os-meeting-fixture-change-");
  t.after(() => removeRoot(root));
  const kernel = meetingKernel(root);
  t.after(() => kernel.close());
  const source = new MeetingSource(root);
  const modified = {
    ...structuredClone(meetingIntegration),
    meeting_id: "MTG-FICTIONAL-SOFTWARE-CHANGED",
    title: "Revisión de integración Nebula revisada",
    decisions: [{ ...meetingIntegration.decisions[0], record_id: "MDEC-SOFTWARE-CHANGED", text: "Usar dos entornos sandbox independientes.", evidence_ref: "MEV-SOFTWARE-DECISION-CHANGED" }],
    provenance_refs: [...meetingIntegration.provenance_refs.filter((ref) => ref !== "MEV-SOFTWARE-DECISION-01"), "MEV-SOFTWARE-DECISION-CHANGED"],
    version: 4,
  };
  source.seed([modified]);
  source.close();
  const result = await prepareBrief(kernel, modified, "CHANGED");
  assert.equal(result.output.title, modified.title);
  assert.equal(result.output.decisions[0].text, "Usar dos entornos sandbox independientes.");
  assert.equal(result.source_version, 4);
});

test("el verifier rechaza afirmación, evidencia, versión y artifact alterados", (t) => {
  const root = tempRoot("ai-os-meeting-verifier-");
  t.after(() => removeRoot(root));
  const kernel = meetingKernel(root);
  t.after(() => kernel.close());
  const identity = kernel.identity();
  const resource = { source_id: "SRC-MEETINGS-SYNTHETIC", resource_ref: meetingIntegration.meeting_id, source_version: meetingIntegration.version };
  const base = buildMeetingBrief(meetingIntegration);
  const verify = (output, artifact = { artifact_id: output.artifact_id, content: output }, resourceOverride = resource) => verifyMeetingBrief({
    input: { workspace_id: ATLAS.workspaceId, meeting_id: meetingIntegration.meeting_id },
    output,
    artifact,
    identity,
    instanceRoot: root,
    resource: resourceOverride,
  });
  assert.equal(verify(base).ok, true);
  const invented = structuredClone(base);
  invented.decisions.push({ ref: "MDEC-INVENTED", text: "Enviar un correo externo.", epistemic_status: "SOURCE_FACT", evidence_refs: [meetingIntegration.decisions[0].evidence_ref] });
  assert.ok(verify(invented).failures.includes("unsupported_or_missing_decision"));
  const missingEvidence = structuredClone(base);
  missingEvidence.decisions[0].evidence_refs = ["MEV-NOT-FOUND"];
  assert.ok(verify(missingEvidence).failures.includes("evidence_reference_missing"));
  assert.ok(verify(base, { artifact_id: base.artifact_id, content: { ...base, title: "Alterado" } }).failures.includes("artifact_integrity_mismatch"));
  assert.ok(verify(base, { artifact_id: base.artifact_id, content: base }, { ...resource, source_version: 2 }).failures.includes("source_version_mismatch"));
});

test("policy deniega READ, PREPARE, mutación declarada y acceso cruzado", async (t) => {
  const rootRead = tempRoot("ai-os-meeting-deny-read-");
  const rootPrepare = tempRoot("ai-os-meeting-deny-prepare-");
  const rootMutation = tempRoot("ai-os-meeting-deny-mutation-");
  t.after(() => { removeRoot(rootRead); removeRoot(rootPrepare); removeRoot(rootMutation); });

  const deny = async (root, operationId, decision) => {
    const kernel = meetingKernel(root);
    const policy = kernel.policies().action;
    policy.rules[`cap.meeting-brief@0.1.0/${operationId}`] = decision;
    kernel.store.db.prepare("UPDATE policies SET policy_json=? WHERE workspace_id=? AND policy_id=? AND policy_version=1")
      .run(JSON.stringify(policy), ATLAS.workspaceId, ATLAS.actionPolicyId);
    return kernel;
  };
  const readDenied = await deny(rootRead, "meeting.read", "DENY");
  await assert.rejects(readDenied.invokeCapability({ capabilityId: "cap.meeting-brief", capabilityVersion: "0.1.0", operationId: "meeting.read", input: { workspace_id: ATLAS.workspaceId, meeting_id: meetingIntegration.meeting_id } }), (error) => error.code === "PERMISSION_DENIED");
  await assert.rejects(readDenied.invokeCapability({ capabilityId: "cap.meeting-brief", capabilityVersion: "0.1.0", operationId: "meeting.read", workspaceId: "WS-FICTIONAL-OTHER-01", input: { workspace_id: "WS-FICTIONAL-OTHER-01", meeting_id: meetingIntegration.meeting_id } }), (error) => error.code === "PERMISSION_DENIED");
  readDenied.close();

  const prepareDenied = await deny(rootPrepare, "meeting.brief.prepare", "DENY");
  await assert.rejects(prepareBrief(prepareDenied, meetingIntegration, "DENIED"), (error) => error.code === "PERMISSION_DENIED");
  prepareDenied.close();

  const mutatingModule = {
    ...meetingBriefModule,
    handlers: {
      ...meetingBriefModule.handlers,
      "meeting:brief.prepare": async (context) => {
        const attempt = await meetingBriefModule.handlers["meeting:brief.prepare"](context);
        attempt.effects.writes = ["meeting-source"];
        return attempt;
      },
    },
  };
  const mutationKernel = meetingKernel(rootMutation, { registry: createApplicationRegistry({ modules: [mutatingModule] }) });
  await assert.rejects(prepareBrief(mutationKernel, meetingIntegration, "MUTATION"), (error) => error.code === "SIDE_EFFECT_SCOPE_VIOLATION");
  assert.equal(mutationKernel.store.tableRows("results").length, 0);
  mutationKernel.close();
});

test("resultado y evidencia persisten entre procesos y repetición es idempotente", (t) => {
  const root = tempRoot("ai-os-meeting-processes-");
  t.after(() => removeRoot(root));
  const initialized = spawnSync(process.execPath, ["--no-warnings", cliPath, "init", "--instance", root, "--mode", "ATLAS_FIXTURE", "--confirm-synthetic"], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  const input = JSON.stringify({ workspace_id: ATLAS.workspaceId, meeting_id: meetingIntegration.meeting_id });
  const args = [
    "--id", "cap.meeting-brief",
    "--version", "0.1.0",
    "--operation", "meeting.brief.prepare",
    "--input", input,
    "--idempotency-key", "KEY-MEETING-PROCESS-01",
    "--execution-id", "EXE-MEETING-PROCESS-01",
    "--result-id", "RES-MEETING-PROCESS-01",
  ];
  const first = capabilityCli(root, "invoke", args).output.data;
  assert.equal(first.outcome, "SUCCEEDED");
  const duplicate = capabilityCli(root, "invoke", args).output.data;
  assert.equal(duplicate.duplicate_request, true);
  const recovered = capabilityCli(root, "result", ["--result-id", "RES-MEETING-PROCESS-01"]).output.data;
  assert.equal(recovered.artifact.content.meeting_id, meetingIntegration.meeting_id);
  assert.ok(recovered.evidence.length >= 4);
  const kernel = new AiOsKernel(root, { registry: createApplicationRegistry() });
  t.after(() => kernel.close());
  assert.equal(kernel.store.tableRows("artifacts").length, 1);
  assert.equal(kernel.store.tableRows("executions").filter((row) => row.capability_id === "cap.meeting-brief").length, 1);
  assert.equal(validateInstance({ store: kernel.store, taskSource: kernel.taskSource, registry: kernel.registry, instanceRoot: root }).status, "PASS");
});

test("adapter corrupto bloquea ejecución y artifact almacenado alterado no se recupera como válido", async (t) => {
  const rootCorrupt = tempRoot("ai-os-meeting-corrupt-");
  const rootArtifact = tempRoot("ai-os-meeting-artifact-");
  t.after(() => { removeRoot(rootCorrupt); removeRoot(rootArtifact); });

  let kernel = meetingKernel(rootCorrupt);
  kernel.close();
  writeFileSync(meetingSourcePath(rootCorrupt), Buffer.from("not-a-sqlite-database"));
  kernel = new AiOsKernel(rootCorrupt, { registry: createApplicationRegistry() });
  await assert.rejects(prepareBrief(kernel, meetingIntegration, "CORRUPT"), (error) => error.code === "SOURCE_STORE_CORRUPT");
  kernel.close();

  kernel = meetingKernel(rootArtifact);
  const result = await prepareBrief(kernel, meetingIntegration, "ARTIFACT");
  kernel.store.db.prepare("UPDATE artifacts SET content_json=? WHERE artifact_id=?")
    .run(JSON.stringify({ altered: true }), result.artifact_ref);
  assert.throws(() => kernel.capabilityResult({ resultId: result.result_id }), (error) => error.code === "ARTIFACT_INTEGRITY_FAILED");
  assert.equal(validateInstance({ store: kernel.store, taskSource: kernel.taskSource, registry: kernel.registry, instanceRoot: rootArtifact }).status, "FAIL");
  kernel.close();
});
