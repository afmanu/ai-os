/* @license
 * Adapted from AIS-OS 3D Brain constellation.js.
 * Copyright (c) 2026 Nate Herk. MIT License; see ../vendor/NATE-AIS-OS-LICENSE.txt.
 */
import * as THREE from "three";

function hash(value) {
  let output = 2166136261;
  for (const character of value) {
    output ^= character.codePointAt(0);
    output = Math.imul(output, 16777619);
  }
  return output >>> 0;
}

const TYPE_ORDER = ["GOAL", "DECISION", "COMMITMENT", "BLOCKER", "TASK", "EVENT", "EVIDENCE", "SOURCE", "CAPABILITY"];

function typeRank(type) {
  const index = TYPE_ORDER.indexOf(type);
  return index < 0 ? TYPE_ORDER.length : index;
}

function planeFor(type) {
  return {
    GOAL: 116,
    DECISION: 54,
    COMMITMENT: 2,
    BLOCKER: -96,
    TASK: -46,
    EVENT: 74,
    EVIDENCE: -128,
    SOURCE: -168,
    CAPABILITY: -210,
  }[type] ?? 0;
}

export function composeMissionControl(nodes, links) {
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const workspace = nodes.find((item) => item.type === "WORKSPACE");
  const projects = nodes.filter((item) => item.type === "PROJECT").sort((left, right) => left.id.localeCompare(right.id));
  const adjacency = new Map(nodes.map((item) => [item.id, []]));
  for (const link of links) {
    adjacency.get(link.source)?.push(link.target);
    adjacency.get(link.target)?.push(link.source);
  }
  for (const neighbors of adjacency.values()) neighbors.sort();

  const clusterOf = new Map(projects.map((project) => [project.id, project.id]));
  for (const start of nodes.map((item) => item.id).sort()) {
    if (clusterOf.has(start)) continue;
    const visited = new Set([start]);
    const queue = [start];
    let projectId = null;
    while (queue.length && !projectId) {
      const current = queue.shift();
      for (const neighbor of adjacency.get(current) || []) {
        if (visited.has(neighbor)) continue;
        if (byId.get(neighbor)?.type === "PROJECT") {
          projectId = neighbor;
          break;
        }
        if (byId.get(neighbor)?.type === "WORKSPACE") continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
    if (projectId) clusterOf.set(start, projectId);
  }

  const grouped = new Map(projects.map((project) => [project.id, []]));
  const unscoped = [];
  for (const item of nodes) {
    if (item.type === "WORKSPACE" || item.type === "PROJECT") continue;
    const projectId = clusterOf.get(item.id);
    if (projectId) grouped.get(projectId).push(item);
    else unscoped.push(item);
  }

  for (const children of grouped.values()) {
    children.sort((left, right) => typeRank(left.type) - typeRank(right.type) || left.id.localeCompare(right.id));
  }

  if (workspace) Object.assign(workspace, { x: 0, y: 44, z: 0, fx: 0, fy: 44, fz: 0, cluster_id: workspace.id });
  projects.forEach((project, projectIndex) => {
    const angle = projects.length === 1
      ? 0
      : -Math.PI * 0.14 + projectIndex / projects.length * Math.PI * 2;
    const radial = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    const tangent = new THREE.Vector3(-Math.sin(angle), 0, Math.cos(angle));
    const center = {
      x: radial.x * 330,
      y: 38 + (projectIndex % 2 === 0 ? 48 : -28),
      z: radial.z * 250,
    };
    Object.assign(project, center, { fx: center.x, fy: center.y, fz: center.z, cluster_id: project.id });

    const children = grouped.get(project.id);
    children.forEach((child, index) => {
      const layer = Math.floor(index / 3);
      const slot = index % 3;
      const outward = 155 + layer * 135;
      const tangentOffset = (slot - 1) * 110 + (hash(child.id) % 13 - 6);
      const position = {
        x: center.x + radial.x * outward + tangent.x * tangentOffset,
        y: center.y + planeFor(child.type) + (layer % 2 === 0 ? 0 : -28),
        z: center.z + radial.z * outward + tangent.z * tangentOffset,
      };
      Object.assign(child, position, { fx: position.x, fy: position.y, fz: position.z, cluster_id: project.id });
    });
  });

  const infrastructure = unscoped.sort((left, right) => typeRank(left.type) - typeRank(right.type) || left.id.localeCompare(right.id));
  infrastructure.forEach((item, index) => {
    const angle = -Math.PI * 0.62 + index * Math.PI * 0.24;
    const radius = projects.length ? 250 + Math.floor(index / 5) * 105 : 210 + Math.floor(index / 5) * 105;
    const position = {
      x: Math.cos(angle) * radius,
      y: -236 - Math.floor(index / 5) * 72,
      z: Math.sin(angle) * radius,
    };
    Object.assign(item, position, { fx: position.x, fy: position.y, fz: position.z, cluster_id: null });
  });
}

function ring(radius, y, opacity) {
  const points = [];
  for (let index = 0; index <= 128; index += 1) {
    const angle = index / 128 * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius));
  }
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color: 0xfbc92e, transparent: true, opacity, depthWrite: false }),
  );
}

export function makeHolographicStage(scene, nodes) {
  const group = new THREE.Group();
  scene.add(group);

  const grid = new THREE.GridHelper(1800, 20, 0xf88e0b, 0x40351d);
  grid.position.y = -310;
  grid.material.transparent = true;
  grid.material.opacity = 0.24;
  grid.material.depthWrite = false;
  group.add(grid);

  const structuralRings = [ring(205, -286, 0.2), ring(410, -294, 0.14), ring(640, -302, 0.1)];
  structuralRings.forEach((item) => group.add(item));

  const projectGuides = nodes.filter((node) => node.type === "PROJECT").map((project) => {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, -284, 0),
        new THREE.Vector3(project.x, -284, project.z),
      ]),
      new THREE.LineDashedMaterial({ color: 0xf88e0b, transparent: true, opacity: 0.22, dashSize: 15, gapSize: 11, depthWrite: false }),
    );
    line.computeLineDistances();
    group.add(line);
    return line;
  });

  const axis = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -310, 0), new THREE.Vector3(0, 330, 0)]),
    new THREE.LineBasicMaterial({ color: 0xfbc92e, transparent: true, opacity: 0.18, depthWrite: false }),
  );
  group.add(axis);

  const scan = new THREE.Mesh(
    new THREE.RingGeometry(386, 390, 128),
    new THREE.MeshBasicMaterial({ color: 0xfbc92e, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  scan.rotation.x = Math.PI / 2;
  scan.position.y = -250;
  group.add(scan);

  return {
    update(time, focused, motion) {
      grid.material.opacity = focused ? 0.14 : 0.24;
      structuralRings.forEach((item, index) => { item.material.opacity = (focused ? 0.08 : 0.14) - index * 0.02; });
      projectGuides.forEach((line) => { line.material.opacity = focused ? 0.12 : 0.22; });
      scan.visible = motion;
      if (motion) {
        const phase = (time * 0.12) % 1;
        scan.position.y = -250 + phase * 500;
        scan.material.opacity = 0.055 + Math.sin(phase * Math.PI) * 0.09;
        scan.rotation.z = time * 0.035;
      }
    },
  };
}
