/* @license
 * AI OS Company Holographic Blueprint client.
 * Interaction patterns and selected rendering techniques are adapted from
 * AIS-OS 3D Brain at commit ce9cb93a1145da5daba84ea37208ec35fd03606e.
 * Copyright (c) 2026 Nate Herk. MIT License; see ../vendor/NATE-AIS-OS-LICENSE.txt.
 * AI OS adaptations copyright 2026 under Apache-2.0.
 */
import ForceGraph3D from "3d-force-graph";
import * as THREE from "three";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { composeMissionControl, makeHolographicStage } from "./layout.js";
import { planConnectivityReplay, replayPosition } from "./growth.js";

const $ = (id) => document.getElementById(id);
const COLORS = {
  WORKSPACE: "#F88E0B",
  PROJECT: "#FBC92E",
  GOAL: "#FFD96A",
  DECISION: "#F4B83F",
  COMMITMENT: "#E9D7A6",
  TASK: "#A8A59B",
  BLOCKER: "#FF6B5F",
  EVENT: "#D9A968",
  EVIDENCE: "#61C796",
  SOURCE: "#8B9597",
  CAPABILITY: "#EF8E2F",
};
const TYPE_ORDER = Object.keys(COLORS);
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let projection;
let graph;
let holographicStage;
let bloomPass;
let nodesById = new Map();
let linksByNode = new Map();
let neighborsByNode = new Map();
let activeTypes = new Set(TYPE_ORDER);
let activeSources = new Set();
let selected = null;
let hovered = null;
let focusHistory = [];
let motion = !reducedMotion.matches;
let cinematic = false;
let stateFilter = "";
let searchResults = [];
let searchActive = -1;
let replay = null;
let replayStarted = 0;
let resizeTimer;

function preferencesKey() {
  return `ai-os-dashboard:${projection.workspace_id}:preferences:v4`;
}

function loadPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(preferencesKey()) || "null");
    if (!saved || saved.version !== 4) return;
    if (Array.isArray(saved.visible_types)) activeTypes = new Set(saved.visible_types.filter((type) => TYPE_ORDER.includes(type)));
    if (Array.isArray(saved.visible_sources)) activeSources = new Set(saved.visible_sources);
    if (typeof saved.state_filter === "string") stateFilter = saved.state_filter;
    if (typeof saved.motion === "boolean") motion = saved.motion && !reducedMotion.matches;
  } catch {
    localStorage.removeItem(preferencesKey());
  }
}

function savePreferences() {
  try {
    localStorage.setItem(preferencesKey(), JSON.stringify({
      version: 4,
      visible_types: [...activeTypes],
      visible_sources: [...activeSources],
      state_filter: stateFilter,
      motion,
    }));
  } catch {
    // The dashboard remains functional when browser storage is unavailable.
  }
}

function create(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function colorOf(node) {
  return COLORS[node.type] || "#ffffff";
}

function endNode(value) {
  return typeof value === "object" && value ? value : nodesById.get(value);
}

function relationEnds(link) {
  return [endNode(link.source), endNode(link.target)];
}

function fmtDate(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function notify(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { toast.hidden = true; }, 2200);
}

function sourceVisible(node) {
  if (node.type === "WORKSPACE") return true;
  if (!activeSources.size) return true;
  if (node.type === "SOURCE" && activeSources.has(node.id)) return true;
  if (activeSources.has(node.source)) return true;
  return node.reference_source_ids?.some((sourceId) => activeSources.has(sourceId));
}

function nodeVisible(node) {
  if (!activeTypes.has(node.type) || !sourceVisible(node)) return false;
  if (stateFilter && String(node.state || "UNKNOWN") !== stateFilter) return false;
  if (replay && !replay.complete) return (replay.byNode.get(node.id)?.born ?? Infinity) <= replay.time;
  return true;
}

function linkVisible(link) {
  const [source, target] = relationEnds(link);
  if (!source || !target || !nodeVisible(source) || !nodeVisible(target)) return false;
  if (replay && !replay.complete) return replay.treeLinks.has(link);
  return true;
}

function neighborhood(node) {
  if (!node) return new Set();
  if (node.type === "PROJECT") return new Set(projection.graph.nodes.filter((item) => item.id === node.id || item.cluster_id === node.id).map((item) => item.id));
  return new Set([node.id, ...(neighborsByNode.get(node.id) || [])]);
}

function cardSpec(node) {
  if (node.type === "WORKSPACE") return { width: 560, height: 144, scale: 0.3 };
  if (node.type === "PROJECT") return { width: 480, height: 148, scale: 0.3 };
  return { width: 380, height: 116, scale: 0.27 };
}

function roundedRect(context, x, y, width, height, radius) {
  const resolved = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + resolved, y);
  context.arcTo(x + width, y, x + width, y + height, resolved);
  context.arcTo(x + width, y + height, x, y + height, resolved);
  context.arcTo(x, y + height, x, y, resolved);
  context.arcTo(x, y, x + width, y, resolved);
  context.closePath();
}

function fittedText(context, value, maxWidth) {
  const original = String(value || "Untitled");
  if (context.measureText(original).width <= maxWidth) return original;
  let output = original;
  while (output.length > 4 && context.measureText(`${output}…`).width > maxWidth) output = output.slice(0, -1);
  return `${output.trim()}…`;
}

function makeCardTexture(node, outline = false) {
  const spec = cardSpec(node);
  const canvas = document.createElement("canvas");
  canvas.width = spec.width;
  canvas.height = spec.height;
  const context = canvas.getContext("2d");
  const workspace = node.type === "WORKSPACE";
  const project = node.type === "PROJECT";
  const margin = outline ? 7 : 5;
  const radius = workspace ? 10 : project ? 9 : 7;

  if (outline) {
    roundedRect(context, margin, margin, spec.width - margin * 2, spec.height - margin * 2, radius);
    context.strokeStyle = "#FBC92E";
    context.shadowColor = "rgba(251, 201, 46, 0.9)";
    context.shadowBlur = 18;
    context.lineWidth = 6;
    context.stroke();
  } else {
    const gradient = context.createLinearGradient(18, 12, spec.width - 18, spec.height - 12);
    gradient.addColorStop(0, workspace ? "rgba(61, 37, 8, 0.94)" : "rgba(22, 23, 21, 0.94)");
    gradient.addColorStop(1, workspace ? "rgba(22, 18, 9, 0.9)" : "rgba(9, 11, 11, 0.9)");
    context.shadowColor = workspace ? "rgba(248, 142, 11, 0.42)" : "rgba(0, 0, 0, 0.46)";
    context.shadowBlur = 20;
    roundedRect(context, 14, 10, spec.width - 28, spec.height - 20, radius);
    context.fillStyle = gradient;
    context.fill();
    context.shadowColor = "transparent";
    context.strokeStyle = workspace ? "rgba(251, 201, 46, 0.9)" : project ? "rgba(251, 201, 46, 0.6)" : `${colorOf(node)}A8`;
    context.lineWidth = workspace ? 3 : 2;
    context.stroke();

    context.fillStyle = colorOf(node);
    context.fillRect(14, 10, workspace ? 7 : 5, spec.height - 20);
    context.fillRect(30, 24, project ? 56 : 38, 2);

    context.strokeStyle = workspace ? "rgba(251, 201, 46, 0.12)" : "rgba(255, 255, 255, 0.055)";
    context.lineWidth = 1;
    for (let y = 34; y < spec.height - 14; y += 12) {
      context.beginPath();
      context.moveTo(22, y);
      context.lineTo(spec.width - 22, y);
      context.stroke();
    }

    const left = 38;
    const foreground = "#F5F0E5";
    context.fillStyle = colorOf(node);
    context.font = `700 ${workspace ? 16 : project ? 15 : 13}px Inter, system-ui, sans-serif`;
    context.fillText(workspace ? "COMPANY CORE" : node.type, left, workspace ? 39 : project ? 38 : 33);

    context.fillStyle = foreground;
    context.font = `700 ${workspace ? 34 : project ? 30 : 23}px "Space Grotesk", Inter, system-ui, sans-serif`;
    context.fillText(fittedText(context, node.name, spec.width - left - 34), left, workspace ? 83 : project ? 84 : 70);

    const state = String(node.state || "STATE UNKNOWN").replaceAll("_", " ");
    context.fillStyle = "rgba(232, 224, 205, 0.66)";
    context.font = `600 ${workspace ? 13 : project ? 13 : 11}px Inter, system-ui, sans-serif`;
    context.fillText(fittedText(context, `${state}  ·  ${node.degree || 0} LINKS`, spec.width - left - 34), left, spec.height - 24);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  return texture;
}

function makeNodeObject(node) {
  const spec = cardSpec(node);
  const group = new THREE.Group();
  const outline = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeCardTexture(node, true), transparent: true, opacity: 0, depthWrite: false }));
  outline.scale.set(spec.width * spec.scale * 1.045, spec.height * spec.scale * 1.045, 1);
  outline.position.z = -2;
  outline.renderOrder = 4;
  group.add(outline);

  const card = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeCardTexture(node), transparent: true, opacity: 1, depthWrite: false }));
  card.scale.set(spec.width * spec.scale, spec.height * spec.scale, 1);
  card.renderOrder = 5;
  group.add(card);

  const glowParts = [];
  const rotatingParts = [];
  if (node.type === "WORKSPACE") {
    card.position.y = 126;
    outline.position.y = 126;

    const core = new THREE.Mesh(
      new THREE.OctahedronGeometry(34, 0),
      new THREE.MeshBasicMaterial({ color: 0xf88e0b, transparent: true, opacity: 0.48, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    group.add(core);
    glowParts.push({ object: core, opacity: 0.48 });

    const shell = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(72, 1), 12),
      new THREE.LineBasicMaterial({ color: 0xfbc92e, transparent: true, opacity: 0.78, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    group.add(shell);
    glowParts.push({ object: shell, opacity: 0.78 });
    rotatingParts.push({ object: shell, base: shell.rotation.clone(), x: 0.08, y: 0.12, z: 0.04 });

    [[0, 0, 0], [Math.PI / 2, 0, 0], [0, Math.PI / 2, 0]].forEach((rotation, index) => {
      const orbit = new THREE.Mesh(
        new THREE.TorusGeometry(91 + index * 7, 0.85, 6, 96),
        new THREE.MeshBasicMaterial({ color: index === 0 ? 0xfbc92e : 0xf88e0b, transparent: true, opacity: 0.42 - index * 0.07, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      orbit.rotation.set(...rotation);
      group.add(orbit);
      glowParts.push({ object: orbit, opacity: 0.42 - index * 0.07 });
      rotatingParts.push({ object: orbit, base: orbit.rotation.clone(), x: index === 1 ? 0.12 : 0.035, y: index === 2 ? -0.1 : 0.055, z: index === 0 ? 0.08 : -0.025 });
    });

    const verticalGuide = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -106, 0), new THREE.Vector3(0, 102, 0)]),
      new THREE.LineBasicMaterial({ color: 0xfbc92e, transparent: true, opacity: 0.28, depthWrite: false }),
    );
    group.add(verticalGuide);
    glowParts.push({ object: verticalGuide, opacity: 0.28 });
  } else {
    const width = spec.width * spec.scale;
    const height = spec.height * spec.scale;
    const frame = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(width + 5, height + 5, node.type === "PROJECT" ? 12 : 8)),
      new THREE.LineBasicMaterial({ color: colorOf(node), transparent: true, opacity: node.type === "PROJECT" ? 0.4 : 0.24, depthWrite: false }),
    );
    frame.position.z = -4;
    group.add(frame);
    glowParts.push({ object: frame, opacity: node.type === "PROJECT" ? 0.4 : 0.24 });

    const anchor = new THREE.Mesh(
      new THREE.OctahedronGeometry(node.type === "PROJECT" ? 8 : 5, 0),
      new THREE.MeshBasicMaterial({ color: colorOf(node), transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    anchor.position.set(-width / 2 - 13, 0, 0);
    group.add(anchor);
    glowParts.push({ object: anchor, opacity: 0.9 });
    rotatingParts.push({ object: anchor, base: anchor.rotation.clone(), x: 0.12, y: 0.18, z: 0.08 });
  }

  group.userData.card = card;
  group.userData.outline = outline;
  group.userData.glowParts = glowParts;
  group.userData.rotatingParts = rotatingParts;
  group.userData.node = node;
  node.__object = group;
  return group;
}

function linkColor(link) {
  const [source, target] = relationEnds(link);
  if (!source || !target) return "rgba(251,201,46,0.08)";
  const near = selected && (source.id === selected.id || target.id === selected.id);
  if (near && selected?.type === "WORKSPACE") return link.type === "CONTAINS_PROJECT" ? "#FBC92E" : "rgba(248,142,11,0.74)";
  if (near) return colorOf(source.id === selected.id ? target : source);
  if (link.type === "CONTAINS_PROJECT") return "rgba(251,201,46,0.68)";
  if (source.type === "WORKSPACE" || target.type === "WORKSPACE") return "rgba(248,142,11,0.38)";
  return "rgba(232,215,174,0.28)";
}

function linkWidth(link) {
  const [source, target] = relationEnds(link);
  if (selected && (source?.id === selected.id || target?.id === selected.id)) {
    if (selected.type === "WORKSPACE") return link.type === "CONTAINS_PROJECT" ? 1.4 : 0.72;
    return 1.05;
  }
  if (link.type === "CONTAINS_PROJECT") return 1.1;
  return source?.type === "WORKSPACE" || target?.type === "WORKSPACE" ? 0.58 : 0.46;
}

function particleCount(link) {
  const [source, target] = relationEnds(link);
  if (!source || !target) return 0;
  if (selected && (source.id === selected.id || target.id === selected.id)) return 2;
  return link.type === "CONTAINS_PROJECT" ? 1 : 0;
}

function refreshGraph() {
  if (!graph) return;
  graph
    .nodeVisibility(nodeVisible)
    .linkVisibility(linkVisible)
    .linkColor(linkColor)
    .linkWidth(linkWidth)
    .linkDirectionalParticles(particleCount);
  updateNodeAppearance();
}

function updateNodeAppearance() {
  const focus = neighborhood(selected);
  for (const node of projection.graph.nodes) {
    const object = node.__object;
    if (!object) continue;
    object.visible = nodeVisible(node);
    const active = !selected || focus.has(node.id);
    const over = hovered?.id === node.id;
    const selectedHere = selected?.id === node.id;
    object.userData.card.material.opacity = active ? 1 : 0.17;
    object.userData.outline.material.opacity = selectedHere ? 1 : over ? 0.58 : 0;
    for (const part of object.userData.glowParts || []) {
      part.object.material.opacity = part.opacity * (active ? selectedHere || over ? 1.22 : 1 : 0.16);
    }
    object.scale.setScalar(selectedHere ? 1.08 : over ? 1.045 : 1);
  }
}

function graphBounds() {
  const xs = projection.graph.nodes.map((node) => node.x || 0);
  const ys = projection.graph.nodes.map((node) => node.y || 0);
  const zs = projection.graph.nodes.map((node) => node.z || 0);
  const minX = Math.min(...xs, -250);
  const maxX = Math.max(...xs, 250);
  const minY = Math.min(...ys, -180);
  const maxY = Math.max(...ys, 180);
  const minZ = Math.min(...zs, -250);
  const maxZ = Math.max(...zs, 250);
  return {
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 },
    width: maxX - minX,
    height: maxY - minY,
    depth: maxZ - minZ,
  };
}

function resetCamera(duration = reducedMotion.matches ? 0 : 1050) {
  const bounds = graphBounds();
  const aspect = Math.max(0.35, innerWidth / innerHeight);
  const compactViewport = innerWidth <= 680 || aspect < 0.75;
  const span = Math.max(bounds.width, bounds.height * 1.35, bounds.depth, 680);
  const distance = Math.min(3200, Math.max(780, span * (compactViewport ? 1.55 : 0.94) * Math.max(1, 0.72 / aspect)));
  const target = { x: bounds.center.x, y: bounds.center.y - 12, z: bounds.center.z };
  graph.cameraPosition(
    { x: target.x + distance * 0.68, y: target.y + distance * 0.46, z: target.z + distance * 0.78 },
    target,
    duration,
  );
}

function flyTo(node) {
  if (!node) return;
  if (node.type === "PROJECT") {
    const members = projection.graph.nodes.filter((item) => item.id === node.id || item.cluster_id === node.id);
    const center = members.reduce((output, item) => output.add(new THREE.Vector3(item.x, item.y, item.z)), new THREE.Vector3()).multiplyScalar(1 / members.length);
    const radius = Math.max(...members.map((item) => center.distanceTo(new THREE.Vector3(item.x, item.y, item.z))), 280);
    const direction = new THREE.Vector3(0.68, 0.44, 0.82).normalize();
    const distance = Math.max(680, radius * 1.75);
    graph.cameraPosition(
      { x: center.x + direction.x * distance, y: center.y + direction.y * distance, z: center.z + direction.z * distance },
      center,
      reducedMotion.matches ? 0 : 950,
    );
    return;
  }
  const distance = node.type === "WORKSPACE" ? 520 : 330;
  const direction = new THREE.Vector3(node.x, Math.max(100, node.y + 70), node.z);
  if (direction.lengthSq() < 1) direction.set(1, 0.55, 1);
  direction.normalize();
  graph.cameraPosition(
    { x: node.x + direction.x * distance, y: node.y + direction.y * distance, z: node.z + direction.z * distance },
    { x: node.x, y: node.y, z: node.z },
    reducedMotion.matches ? 0 : 950,
  );
}

function relationsFor(node) {
  return (linksByNode.get(node.id) || []).map((link) => {
    const [source, target] = relationEnds(link);
    return { link, other: source?.id === node.id ? target : source };
  }).filter((item) => item.other);
}

function fact(label, value) {
  const item = create("div", "fact");
  item.append(create("span", null, label), create("strong", null, value || "Unknown"));
  return item;
}

function renderListSection(container, title, items, renderer) {
  container.replaceChildren();
  const heading = create("h2", null, title);
  container.append(heading);
  if (!items.length) {
    container.append(create("p", "detail-description", "No verified data available."));
    return;
  }
  items.forEach((item) => container.append(renderer(item)));
}

function renderDetail(node) {
  const panel = $("detail");
  panel.hidden = false;
  panel.style.setProperty("--selected-color", colorOf(node));
  $("detail-type").textContent = node.type;
  $("detail-name").textContent = node.name;
  $("detail-state").textContent = node.state || "STATE UNKNOWN";
  $("detail-description").textContent = node.description || "No confirmed description is available.";
  $("btn-detail-focus").textContent = node.type === "WORKSPACE" ? "Focus company" : node.type === "PROJECT" ? "Focus project" : "Focus node";
  const relations = relationsFor(node);
  $("detail-facts").replaceChildren(
    fact("SOURCE", node.source),
    fact("LAST OBSERVED", fmtDate(node.timestamps?.observed_at)),
    fact("FRESHNESS", node.freshness?.status),
    fact("RELATIONS", String(relations.length)),
  );

  const related = node.type === "PROJECT"
    ? [
        ...relations.filter((relation) => relation.other.type === "WORKSPACE"),
        ...projection.graph.nodes.filter((item) => item.cluster_id === node.id && item.id !== node.id).map((other) => ({ other, link: relations.find((relation) => relation.other.id === other.id)?.link })),
      ]
    : relations;
  const relationsTitle = node.type === "WORKSPACE" ? "COMPANY KNOWLEDGE MAP" : node.type === "PROJECT" ? "PROJECT CONTEXT" : "VERIFIED RELATIONS";
  renderListSection($("detail-relations"), relationsTitle, related, ({ other, link }) => {
    const button = create("button", "relation-button");
    button.type = "button";
    button.style.setProperty("--node-color", colorOf(other));
    button.append(create("i"), create("span", null, other.name), create("small", null, link?.type || other.type));
    button.addEventListener("click", () => selectNode(other));
    return button;
  });

  const evidence = [...new Set([...(node.evidence_refs || []), ...relations.flatMap(({ link }) => link.evidence_refs || [])])];
  renderListSection($("detail-evidence"), "EVIDENCE", evidence, (reference) => create("code", null, reference));
  renderListSection($("detail-unknowns"), "UNKNOWN / NOT REPRESENTED", node.unknowns || [], (value) => {
    const list = create("ul");
    list.append(create("li", null, value.replaceAll("_", " ")));
    return list;
  });
}

function selectNode(node, { remember = true, moveCamera = true } = {}) {
  if (!node) return;
  if (remember && selected && selected.id !== node.id) focusHistory.push(selected.id);
  selected = node;
  $("btn-back").disabled = !focusHistory.length;
  $("btn-focus").disabled = false;
  renderDetail(node);
  if (moveCamera) flyTo(node);
  refreshGraph();
}

function clearSelection({ clearHistory = false } = {}) {
  selected = null;
  if (clearHistory) focusHistory = [];
  $("detail").hidden = true;
  $("btn-back").disabled = !focusHistory.length;
  $("btn-focus").disabled = true;
  refreshGraph();
}

function copyContext() {
  if (!selected) return;
  const relations = relationsFor(selected);
  const text = [
    "AI OS Dashboard context (read-only)",
    `Workspace: ${projection.workspace_id}`,
    `Node: ${selected.name}`,
    `ID: ${selected.id}`,
    `Type: ${selected.type}`,
    `State: ${selected.state || "unknown"}`,
    `Description: ${selected.description || "unknown"}`,
    `Observed: ${selected.timestamps?.observed_at || "unknown"}`,
    `Relations: ${relations.map(({ link, other }) => `${link.type} ${other.id}`).join("; ") || "none"}`,
    `Evidence: ${(selected.evidence_refs || []).join(", ") || "none"}`,
    `Unknown: ${(selected.unknowns || []).join(", ") || "none"}`,
  ].join("\n");
  navigator.clipboard.writeText(text).then(() => notify("Context copied for Codex"), () => notify("Clipboard access was not available"));
}

function renderFilters() {
  const typeContainer = $("type-filters");
  typeContainer.replaceChildren();
  TYPE_ORDER.filter((type) => projection.summary.by_type[type] > 0).forEach((type) => {
    const button = create("button", "filter-chip");
    button.type = "button";
    button.dataset.type = type;
    button.setAttribute("aria-pressed", String(activeTypes.has(type)));
    button.style.setProperty("--node-color", COLORS[type]);
    button.append(create("i"), create("span", null, type), create("b", null, String(projection.summary.by_type[type])));
    button.addEventListener("click", () => {
      activeTypes.has(type) ? activeTypes.delete(type) : activeTypes.add(type);
      button.setAttribute("aria-pressed", String(activeTypes.has(type)));
      savePreferences();
      refreshGraph();
    });
    typeContainer.append(button);
  });

  const states = [...new Set(projection.graph.nodes.map((node) => node.state || "UNKNOWN"))].sort();
  const stateSelect = $("state-filter");
  stateSelect.replaceChildren(new Option("All states", ""), ...states.map((state) => new Option(state, state)));
  if (states.includes(stateFilter)) stateSelect.value = stateFilter;
  else stateFilter = "";
  stateSelect.addEventListener("change", () => { stateFilter = stateSelect.value; savePreferences(); refreshGraph(); });

  const sources = projection.graph.nodes.filter((node) => node.type === "SOURCE");
  const sourceContainer = $("source-filters");
  sourceContainer.replaceChildren();
  sources.forEach((source) => {
    const button = create("button", "source-filter", source.name);
    button.type = "button";
    button.setAttribute("aria-pressed", String(!activeSources.size || activeSources.has(source.id)));
    button.addEventListener("click", () => {
      if (!activeSources.size) sources.forEach((item) => activeSources.add(item.id));
      activeSources.has(source.id) ? activeSources.delete(source.id) : activeSources.add(source.id);
      if (activeSources.size === sources.length) activeSources.clear();
      sources.forEach((item) => sourceContainer.querySelector(`[data-source="${CSS.escape(item.id)}"]`)?.setAttribute("aria-pressed", String(!activeSources.size || activeSources.has(item.id))));
      savePreferences();
      refreshGraph();
    });
    button.dataset.source = source.id;
    sourceContainer.append(button);
  });
  sourceContainer.parentElement.hidden = sources.length === 0;
}

function renderSummary() {
  $("workspace-name").textContent = `${projection.presentation_name} · ${projection.workspace_id}`;
  $("count-projects").textContent = projection.summary.by_type.PROJECT;
  $("count-blockers").textContent = projection.summary.unresolved_blockers;
  $("count-commitments").textContent = projection.summary.open_commitments;
  $("count-evidence").textContent = projection.summary.by_type.EVIDENCE;
  $("count-relations").textContent = `${projection.summary.relations} verified relations`;
  $("updated-at").textContent = `Projected ${fmtDate(projection.generated_at)}`;
}

function search(query) {
  const value = query.trim().toLowerCase();
  if (!value) return [];
  return projection.graph.nodes.map((node) => {
    const haystack = `${node.name} ${node.id} ${node.type} ${node.state || ""} ${node.description || ""}`.toLowerCase();
    const index = haystack.indexOf(value);
    return { node, score: index < 0 ? Infinity : index + (node.name.toLowerCase().startsWith(value) ? -20 : 0) };
  }).filter((item) => Number.isFinite(item.score)).sort((left, right) => left.score - right.score || left.node.name.localeCompare(right.node.name)).slice(0, 10).map((item) => item.node);
}

function renderSearch() {
  const container = $("search-results");
  container.replaceChildren();
  container.hidden = searchResults.length === 0;
  searchResults.forEach((node, index) => {
    const button = create("button", `search-result${index === searchActive ? " active" : ""}`);
    button.type = "button";
    button.style.setProperty("--node-color", colorOf(node));
    const label = create("div");
    label.append(create("strong", null, node.name), create("span", null, `${node.type} · ${node.state || "state unknown"}`));
    button.append(create("i"), label, create("span", null, node.id));
    button.addEventListener("click", () => {
      selectNode(node);
      container.hidden = true;
      $("search-input").blur();
    });
    container.append(button);
  });
}

function startReplay() {
  if (!projection.graph.nodes.length || replay && !replay.complete) return;
  if (reducedMotion.matches) {
    notify("Reduced motion is active; connectivity replay was not animated");
    return;
  }
  clearSelection({ clearHistory: true });
  replay = planConnectivityReplay(projection.graph.nodes, projection.graph.links);
  replay.time = 0;
  replay.complete = false;
  replayStarted = performance.now();
  for (const record of replay.records) {
    record.origin = record.parent ? record.parent.home : { x: 0, y: 0, z: 0 };
    record.node.x = record.node.fx = record.origin.x;
    record.node.y = record.node.fy = record.origin.y;
    record.node.z = record.node.fz = record.origin.z;
  }
  $("replay-status").hidden = false;
  $("replay-progress").style.width = "0%";
  resetCamera(0);
  refreshGraph();
}

function updateReplay(now) {
  if (!replay || replay.complete) return;
  replay.time = Math.min(replay.duration, (now - replayStarted) / 1000);
  for (const record of replay.records) {
    const position = replayPosition(record, replay.time);
    record.node.x = record.node.fx = position.x;
    record.node.y = record.node.fy = position.y;
    record.node.z = record.node.fz = position.z;
  }
  $("replay-progress").style.width = `${Math.round(replay.time / replay.duration * 100)}%`;
  updateNodeAppearance();
  if (replay.time >= replay.duration) {
    replay.complete = true;
    for (const record of replay.records) {
      record.node.x = record.node.fx = record.home.x;
      record.node.y = record.node.fy = record.home.y;
      record.node.z = record.node.fz = record.home.z;
    }
    $("replay-status").hidden = true;
    notify("Connectivity replay complete — no historical sequence was implied");
    refreshGraph();
  }
}

function wireUi() {
  $("btn-close-detail").addEventListener("click", () => clearSelection());
  $("btn-detail-focus").addEventListener("click", () => flyTo(selected));
  $("btn-copy-context").addEventListener("click", copyContext);
  $("btn-focus").addEventListener("click", () => flyTo(selected));
  $("btn-reset").addEventListener("click", () => resetCamera());
  $("btn-overview").addEventListener("click", () => { clearSelection({ clearHistory: true }); resetCamera(); });
  $("btn-back").addEventListener("click", () => {
    const previous = nodesById.get(focusHistory.pop());
    if (previous) selectNode(previous, { remember: false });
    $("btn-back").disabled = !focusHistory.length;
  });
  $("btn-motion").addEventListener("click", () => {
    motion = !motion;
    $("btn-motion").setAttribute("aria-pressed", String(motion));
    $("btn-motion").textContent = motion ? "Pause scan" : "Resume scan";
    savePreferences();
  });
  $("btn-cinema").addEventListener("click", () => {
    cinematic = !cinematic;
    document.body.classList.toggle("cinema", cinematic);
    $("btn-cinema").setAttribute("aria-pressed", String(cinematic));
    $("btn-cinema").textContent = cinematic ? "Exit immersive" : "Immersive";
  });
  $("btn-replay").addEventListener("click", startReplay);
  $("btn-clear-filters").addEventListener("click", () => {
    activeTypes = new Set(TYPE_ORDER);
    activeSources.clear();
    stateFilter = "";
    $("state-filter").value = "";
    document.querySelectorAll(".filter-chip,.source-filter").forEach((button) => button.setAttribute("aria-pressed", "true"));
    savePreferences();
    refreshGraph();
  });

  const input = $("search-input");
  input.addEventListener("input", () => { searchActive = -1; searchResults = search(input.value); renderSearch(); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); searchActive = Math.min(searchResults.length - 1, searchActive + 1); renderSearch(); }
    if (event.key === "ArrowUp") { event.preventDefault(); searchActive = Math.max(0, searchActive - 1); renderSearch(); }
    if (event.key === "Enter" && searchResults[Math.max(0, searchActive)]) { selectNode(searchResults[Math.max(0, searchActive)]); $("search-results").hidden = true; input.blur(); }
    if (event.key === "Escape") { $("search-results").hidden = true; input.blur(); }
  });
  document.addEventListener("keydown", (event) => {
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
    if (event.key === "/" && !typing) { event.preventDefault(); input.focus(); }
    if (event.key === "Escape" && !typing) cinematic ? $("btn-cinema").click() : clearSelection();
  });
  document.addEventListener("click", (event) => { if (!event.target.closest(".search")) $("search-results").hidden = true; });
}

function initGraph() {
  composeMissionControl(projection.graph.nodes, projection.graph.links);
  nodesById = new Map(projection.graph.nodes.map((node) => [node.id, node]));
  linksByNode = new Map(projection.graph.nodes.map((node) => [node.id, []]));
  neighborsByNode = new Map(projection.graph.nodes.map((node) => [node.id, new Set()]));
  for (const link of projection.graph.links) {
    linksByNode.get(link.source)?.push(link);
    linksByNode.get(link.target)?.push(link);
    neighborsByNode.get(link.source)?.add(link.target);
    neighborsByNode.get(link.target)?.add(link.source);
  }

  graph = new ForceGraph3D($("graph"), {
    controlType: "orbit",
    rendererConfig: { antialias: true, alpha: false, powerPreference: "high-performance" },
  });
  graph
    .width(innerWidth)
    .height(innerHeight)
    .backgroundColor("#080909")
    .showNavInfo(false)
    .nodeLabel(() => "")
    .nodeThreeObject(makeNodeObject)
    .nodeVisibility(nodeVisible)
    .linkVisibility(linkVisible)
    .linkColor(linkColor)
    .linkOpacity(1)
    .linkWidth(linkWidth)
    .linkDirectionalArrowLength((link) => link.type === "CONTAINS_PROJECT" ? 5.5 : 0)
    .linkDirectionalArrowRelPos(0.82)
    .linkDirectionalArrowColor(linkColor)
    .linkDirectionalParticles(particleCount)
    .linkDirectionalParticleColor(linkColor)
    .linkDirectionalParticleWidth(1.35)
    .linkDirectionalParticleSpeed(0.0025)
    .onNodeClick((node) => selectNode(node))
    .onNodeHover((node) => { hovered = node; updateNodeAppearance(); document.body.style.cursor = node ? "pointer" : "default"; })
    .onBackgroundClick(() => clearSelection())
    .enableNodeDrag(false)
    .warmupTicks(0)
    .cooldownTicks(0);
  graph.d3Force("charge", null);
  graph.d3Force("center", null);
  graph.d3Force("link").strength(0);
  graph.graphData(projection.graph);

  const scene = graph.scene();
  scene.fog = new THREE.FogExp2(0x080909, 0.00024);
  holographicStage = makeHolographicStage(scene, projection.graph.nodes);
  bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.26, 0.36, 0.8);
  graph.postProcessingComposer().addPass(bloomPass);
  graph.renderer().setPixelRatio(Math.min(devicePixelRatio, 1.6));
  graph.renderer().outputColorSpace = THREE.SRGBColorSpace;
  const controls = graph.controls();
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = false;
  controls.minDistance = 120;
  controls.maxDistance = 3800;
  resetCamera(0);
  window.addEventListener("resize", () => {
    graph.width(innerWidth).height(innerHeight);
    bloomPass.setSize(innerWidth, innerHeight);
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!selected) resetCamera(0);
    }, 120);
  });
  window.__aiOsDashboard = { graph, projection, select: (id) => selectNode(nodesById.get(id)), overview: () => $("btn-overview").click() };

  const start = performance.now();
  const frame = (now) => {
    const time = (now - start) / 1000;
    holographicStage.update(time, Boolean(selected || hovered), motion);
    if (motion) {
      for (const node of projection.graph.nodes) {
        for (const part of node.__object?.userData.rotatingParts || []) {
          part.object.rotation.set(
            part.base.x + time * part.x,
            part.base.y + time * part.y,
            part.base.z + time * part.z,
          );
        }
      }
    }
    updateReplay(now);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

async function main() {
  const response = await fetch("/api/graph", { headers: { accept: "application/json" } });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error?.message || "Could not read the authorized dashboard projection");
  projection = body.data;
  loadPreferences();
  renderSummary();
  renderFilters();
  initGraph();
  wireUi();
  $("btn-motion").setAttribute("aria-pressed", String(motion));
  $("btn-motion").textContent = motion ? "Pause scan" : "Resume scan";
  $("empty-state").hidden = projection.summary.by_type.PROJECT > 0 || projection.summary.confirmed_events > 0;
  $("loading").classList.add("done");
  setTimeout(() => $("loading").remove(), 600);
  $("app").setAttribute("aria-busy", "false");
}

main().catch((error) => {
  $("loading").replaceChildren(create("strong", null, "DASHBOARD COULD NOT START"), create("span", null, error.message));
  $("app").setAttribute("aria-busy", "false");
  console.error(error);
});
