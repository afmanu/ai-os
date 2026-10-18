import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { removeRoot, tempRoot } from "./helpers.mjs";

const cliPath = fileURLToPath(new URL("../bin/ai-os.mjs", import.meta.url));

function command(args, { expectedStatus = 0, localAppData } = {}) {
  const result = spawnSync(process.execPath, ["--no-warnings", cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, LOCALAPPDATA: localAppData },
  });
  assert.equal(result.status, expectedStatus, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  return {
    output: result.stdout.trim() ? JSON.parse(result.stdout).data : null,
    error: result.stderr.trim().startsWith("{") ? JSON.parse(result.stderr).error : null,
  };
}

function hash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function createReadyInstance({ instanceRoot, statePath, displayName, localAppData }) {
  command(["onboard", "start", "--state", statePath, "--instance", instanceRoot], { localAppData });
  command(["onboard", "answer", "--state", statePath, "--answers", JSON.stringify({
    identity: { display_name: displayName },
    activity: "Maintains fictional local projects",
    objectives: ["Preserve fictional continuity"],
    sources: [],
    capabilities: [],
  })], { localAppData });
  const preview = command(["onboard", "preview", "--state", statePath], { localAppData }).output;
  const created = command(["onboard", "approve", "--state", statePath, "--preview-hash", preview.preview_hash, "--approve"], { localAppData }).output;
  assert.equal(created.status, "CREATED");
  return command(["instance", "diagnose", "--instance", instanceRoot], { localAppData }).output;
}

test("help, comandos inválidos y rutas ausentes no crean estado", (t) => {
  const root = tempRoot("ai-os-first-use-empty-");
  const localAppData = join(root, "local-app-data");
  const absent = join(root, "instances", "absent");
  t.after(() => removeRoot(root));

  for (const args of [[], ["help"], ["-h"], ["--help"], ["records", "--help"]]) {
    assert.ok(command(args, { localAppData }).output.commands.length > 0);
    assert.equal(existsSync(localAppData), false);
  }

  const invalid = command(["not-a-command", "--instance", absent], { expectedStatus: 1, localAppData });
  assert.equal(invalid.error.code, "CLI_USAGE");
  assert.equal(existsSync(absent), false);

  const invalidSubcommand = command(["records", "unknown", "--instance", absent], { expectedStatus: 1, localAppData });
  assert.equal(invalidSubcommand.error.code, "CLI_USAGE");
  const incomplete = command(["capture", "confirmed", "--instance", absent], { expectedStatus: 1, localAppData });
  assert.equal(incomplete.error.code, "CLI_USAGE");
  assert.equal(existsSync(absent), false);

  const missing = command(["records", "list", "--instance", absent], { expectedStatus: 1, localAppData });
  assert.equal(missing.error.code, "INSTANCE_NOT_INITIALIZED");
  assert.equal(existsSync(absent), false);

  const diagnosed = command(["instance", "diagnose", "--instance", absent], { localAppData }).output;
  assert.equal(diagnosed.state, "ABSENT");
  assert.equal(diagnosed.read_only, true);
  assert.equal(existsSync(absent), false);

  const current = command(["instance", "current"], { localAppData }).output;
  assert.equal(current.selected, false);
  assert.equal(existsSync(localAppData), false);
});

test("una instancia parcial se diagnostica sin modificar sus stores", (t) => {
  const root = tempRoot("ai-os-first-use-partial-");
  const localAppData = join(root, "local-app-data");
  const instanceRoot = join(root, "instances", "partial");
  const kernelPath = join(instanceRoot, "kernel.sqlite");
  const taskPath = join(instanceRoot, "task-source.sqlite");
  t.after(() => removeRoot(root));

  mkdirSync(instanceRoot, { recursive: true });
  writeFileSync(kernelPath, "");
  writeFileSync(taskPath, "");
  const before = [statSync(kernelPath).size, statSync(taskPath).size];

  const diagnosed = command(["instance", "diagnose", "--instance", instanceRoot], { localAppData }).output;
  assert.equal(diagnosed.state, "PARTIAL");
  assert.deepEqual(diagnosed.problems, ["KERNEL_STORE_EMPTY", "TASK_STORE_EMPTY"]);

  const denied = command(["records", "list", "--instance", instanceRoot], { expectedStatus: 1, localAppData });
  assert.equal(denied.error.code, "INSTANCE_PARTIAL");
  const selectionDenied = command(["instance", "select", "--instance", instanceRoot], { expectedStatus: 1, localAppData });
  assert.equal(selectionDenied.error.code, "INSTANCE_PARTIAL");
  assert.equal(existsSync(localAppData), false);
  assert.deepEqual([statSync(kernelPath).size, statSync(taskPath).size], before);
});

test("una instancia READY se selecciona explícitamente y persiste entre procesos", (t) => {
  const root = tempRoot("ai-os-first-use-ready-");
  const localAppData = join(root, "local-app-data");
  const instanceRoot = join(root, "instances", "fictional-personal");
  const statePath = join(root, "onboarding", "fictional-personal.json");
  t.after(() => removeRoot(root));

  command(["onboard", "start", "--state", statePath, "--instance", instanceRoot], { localAppData });
  const answers = {
    identity: { display_name: "Avery Fiction" },
    activity: "Maintains fictional local projects",
    objectives: ["Preserve fictional continuity"],
    sources: [],
    capabilities: [],
  };
  command(["onboard", "answer", "--state", statePath, "--answers", JSON.stringify(answers)], { localAppData });
  const preview = command(["onboard", "preview", "--state", statePath], { localAppData }).output;
  const created = command(["onboard", "approve", "--state", statePath, "--preview-hash", preview.preview_hash, "--approve"], { localAppData }).output;
  assert.equal(created.status, "CREATED");

  const unselected = command(["records", "list"], { expectedStatus: 1, localAppData });
  assert.equal(unselected.error.code, "INSTANCE_SELECTION_REQUIRED");
  assert.equal(existsSync(join(localAppData, "ai-os", "active-instance.json")), false);

  const selected = command(["onboard", "approve", "--state", statePath, "--preview-hash", preview.preview_hash, "--approve", "--select"], { localAppData }).output;
  assert.equal(selected.duplicate_request, true);
  assert.equal(selected.active_instance.selected, true);
  assert.equal(selected.active_instance.diagnostic.state, "READY");

  const kernelPath = join(instanceRoot, "kernel.sqlite");
  const taskPath = join(instanceRoot, "task-source.sqlite");
  const beforeDiagnosis = [hash(kernelPath), hash(taskPath)];
  const diagnosed = command(["instance", "diagnose", "--instance", instanceRoot], { localAppData }).output;
  assert.equal(diagnosed.state, "READY");
  assert.deepEqual([hash(kernelPath), hash(taskPath)], beforeDiagnosis);

  const record = {
    event_id: "EVT-FIRST-USE-FICTIONAL-01",
    record_type: "PROJECT",
    record_id: "PRJ-FIRST-USE-FICTIONAL-01",
    name: "Fictional First Use",
    statement: "The user confirmed this fictional project.",
    references: [],
    confirmed: true,
  };
  command(["capture", "confirmed", "--record", JSON.stringify(record)], { localAppData });

  const current = command(["instance", "current"], { localAppData }).output;
  assert.equal(current.instance_root, instanceRoot);
  assert.equal(current.diagnostic.state, "READY");
  const recovered = command(["records", "list", "--project-ref", record.record_id], { localAppData }).output;
  assert.equal(recovered.records.length, 1);
  assert.equal(recovered.records[0].record_id, record.record_id);
  assert.equal(recovered.raw_conversation_included, false);
});

test("una selección activa no acepta la identidad de otra instancia READY", (t) => {
  const root = tempRoot("ai-os-first-use-identity-");
  const localAppData = join(root, "local-app-data");
  const firstRoot = join(root, "instances", "fictional-first");
  const secondRoot = join(root, "instances", "fictional-second");
  t.after(() => removeRoot(root));

  const first = createReadyInstance({
    instanceRoot: firstRoot,
    statePath: join(root, "onboarding", "fictional-first.json"),
    displayName: "Avery First",
    localAppData,
  });
  const second = createReadyInstance({
    instanceRoot: secondRoot,
    statePath: join(root, "onboarding", "fictional-second.json"),
    displayName: "Avery Second",
    localAppData,
  });
  assert.equal(first.state, "READY");
  assert.equal(second.state, "READY");
  assert.notEqual(first.instance_id, second.instance_id);

  command(["instance", "select", "--instance", firstRoot], { localAppData });
  const selectionPath = join(localAppData, "ai-os", "active-instance.json");
  const selection = JSON.parse(readFileSync(selectionPath, "utf8"));
  assert.equal(selection.instance_id, first.instance_id);
  selection.instance_root = secondRoot;
  writeFileSync(selectionPath, `${JSON.stringify(selection, null, 2)}\n`, "utf8");

  const storePaths = [
    join(firstRoot, "kernel.sqlite"),
    join(firstRoot, "task-source.sqlite"),
    join(secondRoot, "kernel.sqlite"),
    join(secondRoot, "task-source.sqlite"),
  ];
  const before = storePaths.map(hash);

  const current = command(["instance", "current"], { expectedStatus: 1, localAppData });
  assert.equal(current.error.code, "ACTIVE_INSTANCE_IDENTITY_MISMATCH");
  const denied = command(["records", "list"], { expectedStatus: 1, localAppData });
  assert.equal(denied.error.code, "ACTIVE_INSTANCE_IDENTITY_MISMATCH");
  assert.deepEqual(storePaths.map(hash), before);
});
