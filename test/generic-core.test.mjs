import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AiOsKernel } from "../src/core/kernel.mjs";
import { applicationRegistry } from "../src/capabilities/catalog.mjs";
import { ATLAS, removeRoot, tempRoot } from "./helpers.mjs";

const cliPath = fileURLToPath(new URL("../bin/ai-os.mjs", import.meta.url));

function command(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, ["--no-warnings", cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.equal(result.status, expectedStatus, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  return {
    output: result.stdout.trim() ? JSON.parse(result.stdout).data : null,
    error: result.stderr.trim().startsWith("{") ? JSON.parse(result.stderr) : null,
  };
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function files(root) {
  const rows = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        const bytes = readFileSync(path);
        rows.push({
          path: relative(root, path).replaceAll("\\", "/"),
          hash: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  };
  walk(root);
  return rows.sort((left, right) => left.path.localeCompare(right.path));
}

test("instalación PERSONAL limpia, onboarding aprobado y fuente Git read-only sobreviven procesos", async (t) => {
  const privateRoot = tempRoot("ai-os-generic-private-");
  const instanceRoot = join(privateRoot, "instance");
  const statePath = join(privateRoot, "onboarding.json");
  const repositoryRoot = tempRoot("ai-os-fictional-repository-");
  t.after(() => {
    removeRoot(privateRoot);
    removeRoot(repositoryRoot);
  });

  git(repositoryRoot, ["init"]);
  git(repositoryRoot, ["config", "user.name", "Fictional Example"]);
  git(repositoryRoot, ["config", "user.email", "fictional@example.invalid"]);
  mkdirSync(join(repositoryRoot, "docs"));
  writeFileSync(join(repositoryRoot, "README.md"), "# Nebula Notes\n\nRepositorio completamente ficticio.\n");
  writeFileSync(join(repositoryRoot, "docs", "DECISIONS.md"), "# Decisions\n\n## Decision: keep source authority\n\nThe repository remains authoritative.\n");
  writeFileSync(join(repositoryRoot, "private.txt"), "not allow-listed\n");
  git(repositoryRoot, ["add", "README.md", "docs/DECISIONS.md", "private.txt"]);
  git(repositoryRoot, ["commit", "-m", "fictional initial state"]);
  const before = { files: files(repositoryRoot), head: git(repositoryRoot, ["rev-parse", "HEAD"]), status: git(repositoryRoot, ["status", "--porcelain=v1"]) };

  const started = command(["onboard", "start", "--state", statePath, "--instance", instanceRoot]).output;
  assert.equal(started.status, "DRAFT");
  assert.equal(started.seed, "NONE");
  assert.equal(existsSync(join(instanceRoot, "kernel.sqlite")), false);
  const accidentalAtlas = command(["init", "--instance", join(privateRoot, "accidental-default")], 1);
  assert.equal(accidentalAtlas.error.error.code, "ONBOARDING_REQUIRED");
  assert.equal(existsSync(join(privateRoot, "accidental-default", "kernel.sqlite")), false);

  const answers = {
    identity: { display_name: "Avery Fiction" },
    activity: "Maintains fictional local software projects",
    objectives: ["Preserve evidence-backed continuity"],
    sources: [{
      type: "LOCAL_GIT_REPOSITORY",
      repository_id: "REPO-NEBULA-FICTIONAL",
      source_id: "SRC-NEBULA-FICTIONAL",
      root: repositoryRoot,
      documents: ["README.md", "docs/DECISIONS.md"],
      max_file_bytes: 131072,
      history_limit: 10,
      stale_after_days: 3650
    }],
    capabilities: ["cap.local-repo-read@0.1.0"],
  };
  const answered = command(["onboard", "answer", "--state", statePath, "--answers", JSON.stringify(answers)]).output;
  assert.deepEqual(answered.missing, []);
  assert.equal(existsSync(join(instanceRoot, "kernel.sqlite")), false);

  const preview = command(["onboard", "preview", "--state", statePath]).output;
  assert.equal(preview.project_seed_count, 0);
  assert.equal(preview.external_connections_enabled, 0);
  assert.equal(preview.raw_conversation_capture, false);
  const deniedCreation = command(["onboard", "approve", "--state", statePath, "--preview-hash", preview.preview_hash], 1);
  assert.equal(deniedCreation.error.error.code, "EXPLICIT_APPROVAL_REQUIRED");
  assert.equal(existsSync(join(instanceRoot, "kernel.sqlite")), false);

  const created = command(["onboard", "approve", "--state", statePath, "--preview-hash", preview.preview_hash, "--approve"]).output;
  assert.equal(created.status, "CREATED");
  assert.equal(created.mode, "PERSONAL");
  assert.equal(created.seed, "NONE");
  assert.equal(created.project_seed_count, 0);
  assert.equal(created.task_seed_count, 0);
  const repeated = command(["onboard", "approve", "--state", statePath, "--preview-hash", preview.preview_hash, "--approve"]).output;
  assert.equal(repeated.duplicate_request, true);

  let kernel = new AiOsKernel(instanceRoot, { registry: applicationRegistry });
  const profile = kernel.store.instanceProfile();
  assert.equal(profile.mode, "PERSONAL");
  assert.equal(profile.seed, "NONE");
  assert.equal(kernel.store.findProjects(created.workspace_id, "Atlas").length, 0);
  assert.equal(kernel.taskSource.db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 0);
  assert.equal(kernel.store.getSource(created.workspace_id, ATLAS.projectSourceId), null);
  const capabilities = kernel.capabilities();
  assert.equal(capabilities.find((item) => item.capability_id === "cap.local-repo-read").state, "AVAILABLE");
  assert.equal(capabilities.find((item) => item.capability_id === "cap.meeting-brief").state, "DISABLED");
  assert.equal(capabilities.find((item) => item.capability_id === "cap.content-os-read").state, "DISABLED");
  kernel.close();

  const scope = ["--instance", instanceRoot, "--principal", created.principal_id, "--workspace", created.workspace_id];
  const documentInput = JSON.stringify({ workspace_id: created.workspace_id, repository_id: "REPO-NEBULA-FICTIONAL", path: "README.md" });
  const document = command(["capability", "invoke", ...scope, "--id", "cap.local-repo-read", "--version", "0.1.0", "--operation", "repository.document.read", "--input", documentInput, "--idempotency-key", "KEY-FICTIONAL-DOCUMENT-01", "--execution-id", "EXE-FICTIONAL-DOCUMENT-01", "--result-id", "RES-FICTIONAL-DOCUMENT-01"]).output;
  assert.equal(document.verified, true);
  assert.match(document.output.payload.content, /Nebula Notes/);

  const decisionsInput = JSON.stringify({ workspace_id: created.workspace_id, repository_id: "REPO-NEBULA-FICTIONAL", path: "docs/DECISIONS.md" });
  const decisions = command(["capability", "invoke", ...scope, "--id", "cap.local-repo-read", "--version", "0.1.0", "--operation", "repository.decisions.read", "--input", decisionsInput, "--idempotency-key", "KEY-FICTIONAL-DECISIONS-01", "--execution-id", "EXE-FICTIONAL-DECISIONS-01", "--result-id", "RES-FICTIONAL-DECISIONS-01"]).output;
  assert.equal(decisions.output.payload.sections[0].heading, "Decisions");

  const gitInput = JSON.stringify({ workspace_id: created.workspace_id, repository_id: "REPO-NEBULA-FICTIONAL" });
  const gitResult = command(["capability", "invoke", ...scope, "--id", "cap.local-repo-read", "--version", "0.1.0", "--operation", "repository.git.read", "--input", gitInput, "--idempotency-key", "KEY-FICTIONAL-GIT-01", "--execution-id", "EXE-FICTIONAL-GIT-01", "--result-id", "RES-FICTIONAL-GIT-01"]).output;
  assert.equal(gitResult.output.payload.head, before.head);
  assert.equal(gitResult.output.payload.dirty, false);

  const recovered = command(["capability", "result", ...scope, "--result-id", "RES-FICTIONAL-DOCUMENT-01"]).output;
  assert.equal(recovered.result.output.source.snapshot_hash, document.output.source.snapshot_hash);
  assert.ok(recovered.evidence.length > 0);

  const projectRecord = {
    event_id: "EVT-FICTIONAL-PROJECT-01",
    record_type: "PROJECT",
    record_id: "PRJ-NEBULA-FICTIONAL",
    name: "Nebula",
    objective: "Preserve fictional continuity",
    statement: "Nebula is an explicitly confirmed fictional project.",
    status: "active",
    references: [{ source_id: "SRC-NEBULA-FICTIONAL", locator: "README.md", content_hash: document.output.payload.content_hash }],
    confirmed: true,
  };
  const captured = command(["capture", "confirmed", ...scope, "--record", JSON.stringify(projectRecord)]).output;
  assert.equal(captured.operational_source_mutated, false);
  assert.equal(captured.raw_conversation_captured, false);
  const duplicate = command(["capture", "confirmed", ...scope, "--record", JSON.stringify(projectRecord)]).output;
  assert.equal(duplicate.duplicate_request, true);

  const blockerRecord = {
    event_id: "EVT-FICTIONAL-BLOCKER-01",
    record_type: "BLOCKER",
    record_id: "BLK-NEBULA-FICTIONAL-01",
    project_ref: "PRJ-NEBULA-FICTIONAL",
    statement: "A fictional dependency is pending.",
    references: [],
    confirmed: true,
  };
  command(["capture", "confirmed", ...scope, "--record", JSON.stringify(blockerRecord)]);
  const records = command(["records", "list", ...scope, "--project-ref", "PRJ-NEBULA-FICTIONAL"]).output;
  assert.deepEqual(records.records.map((item) => item.record_type), ["PROJECT", "BLOCKER"]);
  assert.equal(records.raw_conversation_included, false);

  const deniedPath = command(["capability", "invoke", ...scope, "--id", "cap.local-repo-read", "--version", "0.1.0", "--operation", "repository.document.read", "--input", JSON.stringify({ workspace_id: created.workspace_id, repository_id: "REPO-NEBULA-FICTIONAL", path: "private.txt" })], 1);
  assert.equal(deniedPath.error.error.code, "FILE_NOT_ALLOWED");
  const deniedWorkspace = command(["records", "list", "--instance", instanceRoot, "--principal", created.principal_id, "--workspace", "WS-FOREIGN-FICTIONAL"], 1);
  assert.equal(deniedWorkspace.error.error.code, "PERMISSION_DENIED");

  const validation = command(["validate", ...scope]).output;
  assert.equal(validation.status, "PASS", JSON.stringify(validation, null, 2));
  assert.equal(validation.checks.length, 18);
  assert.ok(validation.checks.every((item) => item.status === "PASS"));
  const after = { files: files(repositoryRoot), head: git(repositoryRoot, ["rev-parse", "HEAD"]), status: git(repositoryRoot, ["status", "--porcelain=v1"]) };
  assert.deepEqual(after, before);
});
