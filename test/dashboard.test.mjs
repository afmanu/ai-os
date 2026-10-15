import assert from "node:assert/strict";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { AiOsKernel } from "../src/core/kernel.mjs";
import { applicationRegistry } from "../src/capabilities/catalog.mjs";
import { createDashboardServer } from "../src/dashboard/server.mjs";
import {
  answerPersonalOnboarding,
  approvePersonalOnboarding,
  previewPersonalOnboarding,
  startPersonalOnboarding,
} from "../src/onboarding/personal.mjs";
import { removeRoot, tempRoot } from "./helpers.mjs";

function get(url, { host = null, origin = null, method = "GET" } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const headers = {};
    if (host) headers.host = host;
    if (origin) headers.origin = origin;
    const req = request({ hostname: target.hostname, port: target.port, path: target.pathname, method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

function personalInstance(root) {
  const instanceRoot = join(root, "instance");
  const statePath = join(root, "onboarding.json");
  startPersonalOnboarding({ statePath, instanceRoot, registry: applicationRegistry });
  answerPersonalOnboarding({
    statePath,
    registry: applicationRegistry,
    answers: {
      identity: { display_name: "Avery Fiction" },
      activity: "Runs a fictional studio",
      objectives: ["Keep fictional operations evidence-backed"],
      sources: [],
      capabilities: [],
    },
  });
  const preview = previewPersonalOnboarding({ statePath, registry: applicationRegistry });
  const creation = approvePersonalOnboarding({ statePath, previewHash: preview.preview_hash, approved: true, registry: applicationRegistry });
  return { instanceRoot, creation };
}

function capture(kernel, scope, record) {
  return kernel.captureConfirmed({
    ...scope,
    record: { references: [], confirmed: true, occurred_at: "2026-10-15T10:00:00.000Z", ...record },
  });
}

test("dashboard projects authorized kernel state without mutating stores or exposing private paths", async (t) => {
  const root = tempRoot("ai-os-dashboard-fictional-");
  t.after(() => removeRoot(root));
  const { instanceRoot, creation } = personalInstance(root);
  const kernel = new AiOsKernel(instanceRoot, { registry: applicationRegistry });
  t.after(() => kernel.close());
  const scope = { principalId: creation.principal_id, workspaceId: creation.workspace_id };

  capture(kernel, scope, {
    event_id: "EVT-FICTIONAL-PROJECT-01",
    record_type: "PROJECT",
    record_id: "PRJ-FICTIONAL-01",
    name: "Fictional Studio",
    objective: "Ship a fictional evidence-backed service",
    status: "active",
    statement: "The fictional studio project is active.",
  });
  capture(kernel, scope, {
    event_id: "EVT-FICTIONAL-GOAL-01",
    record_type: "OBJECTIVE",
    record_id: "GOAL-FICTIONAL-01",
    project_ref: "PRJ-FICTIONAL-01",
    status: "active",
    statement: "Reach the first fictional customer interview.",
  });
  capture(kernel, scope, {
    event_id: "EVT-FICTIONAL-DECISION-01",
    record_type: "DECISION",
    record_id: "DEC-FICTIONAL-01",
    project_ref: "PRJ-FICTIONAL-01",
    status: "confirmed",
    statement: "Use the fictional prototype for the interview.",
  });
  capture(kernel, scope, {
    event_id: "EVT-FICTIONAL-COMMITMENT-01",
    record_type: "COMMITMENT",
    record_id: "COM-FICTIONAL-01",
    project_ref: "PRJ-FICTIONAL-01",
    status: "open",
    statement: "Prepare the fictional interview brief.",
  });
  capture(kernel, scope, {
    event_id: "EVT-FICTIONAL-BLOCKER-01",
    record_type: "BLOCKER",
    record_id: "BLK-FICTIONAL-01",
    project_ref: "PRJ-FICTIONAL-01",
    status: "open",
    statement: "A fictional dependency remains unavailable.",
  });

  const before = {
    events: kernel.store.tableRows("events").length,
    evidence: kernel.store.tableRows("evidence").length,
    decisions: kernel.store.tableRows("decisions").length,
    plans: kernel.store.tableRows("plans").length,
    results: kernel.store.tableRows("results").length,
  };
  const first = kernel.dashboardProjection(scope);
  const second = kernel.dashboardProjection(scope);
  assert.equal(first.schema, "DashboardGraphProjection@v2");
  assert.equal(first.lineage.persisted, false);
  assert.equal(first.lineage.raw_conversation_included, false);
  assert.deepEqual(first.graph, second.graph);
  assert.equal(first.summary.by_type.WORKSPACE, 1);
  assert.equal(first.summary.by_type.PROJECT, 1);
  assert.equal(first.summary.by_type.BLOCKER, 1);
  assert.equal(first.summary.by_type.COMMITMENT, 1);
  assert.equal(first.summary.by_type.TASK, 0);
  const workspace = first.graph.nodes.find((node) => node.type === "WORKSPACE");
  assert.equal(workspace.id, first.root_node_id);
  assert.equal(workspace.name, "Avery Fiction");
  assert.equal(workspace.state, "PERSONAL");
  assert.ok(workspace.unknowns.includes("company_kpis"));
  assert.ok(first.graph.links.some((link) => link.source === workspace.id && link.target === "PRJ-FICTIONAL-01" && link.type === "CONTAINS_PROJECT"));
  assert.ok(first.graph.links.some((link) => link.source === "PRJ-FICTIONAL-01" && link.target === "DEC-FICTIONAL-01" && link.type === "HAS_DECISION"));
  assert.ok(first.graph.links.some((link) => link.source === "DEC-FICTIONAL-01" && link.type === "SUPPORTED_BY"));
  assert.match(JSON.stringify(first), /Avery Fiction/);
  assert.doesNotMatch(JSON.stringify(first), new RegExp(root.replaceAll("\\", "\\\\"), "i"));
  assert.throws(() => kernel.dashboardProjection({ principalId: creation.principal_id, workspaceId: "WS-FOREIGN-FICTIONAL" }), (error) => error.code === "PERMISSION_DENIED");

  const dashboard = await createDashboardServer({ kernel, ...scope, port: 0 });
  t.after(() => dashboard.close().catch(() => {}));
  assert.equal(dashboard.host, "127.0.0.1");
  const graph = await get(`${dashboard.url}/api/graph`);
  assert.equal(graph.status, 200);
  assert.equal(JSON.parse(graph.body).data.workspace_id, creation.workspace_id);
  assert.equal((await get(`${dashboard.url}/`)).status, 200);
  assert.equal((await get(`${dashboard.url}/styles.css`)).status, 200);
  assert.equal((await get(`${dashboard.url}/dist/app.js`)).status, 200);
  const deniedMutation = await get(`${dashboard.url}/api/graph`, { method: "POST" });
  assert.equal(deniedMutation.status, 405);
  assert.equal(deniedMutation.headers.allow, "GET, HEAD");
  assert.equal((await get(`${dashboard.url}/api/graph`, { host: `example.invalid:${dashboard.port}` })).status, 403);
  assert.equal((await get(`${dashboard.url}/api/graph`, { origin: "https://example.invalid" })).status, 403);
  assert.deepEqual({
    events: kernel.store.tableRows("events").length,
    evidence: kernel.store.tableRows("evidence").length,
    decisions: kernel.store.tableRows("decisions").length,
    plans: kernel.store.tableRows("plans").length,
    results: kernel.store.tableRows("results").length,
  }, before);
});

test("empty PERSONAL instance returns its workspace and real registry state without fabricated projects", () => {
  const root = tempRoot("ai-os-dashboard-empty-");
  try {
    const { instanceRoot, creation } = personalInstance(root);
    const kernel = new AiOsKernel(instanceRoot, { registry: applicationRegistry });
    try {
      const projection = kernel.dashboardProjection({ principalId: creation.principal_id, workspaceId: creation.workspace_id });
      assert.equal(projection.summary.by_type.PROJECT, 0);
      assert.equal(projection.summary.by_type.WORKSPACE, 1);
      assert.equal(projection.summary.confirmed_events, 0);
      assert.ok(projection.graph.nodes.every((node) => ["WORKSPACE", "CAPABILITY"].includes(node.type)));
      assert.ok(projection.graph.links.every((link) => link.source === projection.root_node_id && link.type === "REGISTERS_CAPABILITY"));
    } finally {
      kernel.close();
    }
  } finally {
    removeRoot(root);
  }
});
