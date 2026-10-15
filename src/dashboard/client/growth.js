/* @license
 * Adapted from AIS-OS 3D Brain growth.js.
 * Copyright (c) 2026 Nate Herk. MIT License; see ../vendor/NATE-AIS-OS-LICENSE.txt.
 */
export function planConnectivityReplay(nodes, links) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const adjacent = new Map(nodes.map((node) => [node.id, []]));
  const idOf = (value) => typeof value === "object" ? value.id : value;
  for (const link of links) {
    const source = idOf(link.source);
    const target = idOf(link.target);
    if (!byId.has(source) || !byId.has(target)) continue;
    adjacent.get(source).push({ id: target, link });
    adjacent.get(target).push({ id: source, link });
  }
  const rank = (node) => node.type === "WORKSPACE" ? 3 : node.type === "PROJECT" ? 2 : 1;
  const ranked = [...nodes].sort((left, right) => rank(right) - rank(left)
    || (right.degree || 0) - (left.degree || 0)
    || left.id.localeCompare(right.id));
  for (const list of adjacent.values()) list.sort((left, right) => (byId.get(right.id).degree || 0) - (byId.get(left.id).degree || 0) || left.id.localeCompare(right.id));
  const seen = new Set();
  const records = [];
  const byNode = new Map();
  const append = (node, parent = null, link = null) => {
    const record = { node, parent, link, index: records.length, home: { x: node.x, y: node.y, z: node.z }, born: 0, origin: null };
    records.push(record);
    byNode.set(node.id, record);
    seen.add(node.id);
    return record;
  };
  for (const seed of ranked) {
    if (seen.has(seed.id)) continue;
    const queue = [append(seed)];
    for (let index = 0; index < queue.length; index += 1) {
      const parent = queue[index];
      const available = adjacent.get(parent.node.id).filter((item) => !seen.has(item.id));
      for (const next of available.slice(0, 3)) queue.push(append(byId.get(next.id), parent, next.link));
      if (available.length > 3) queue.push(parent);
    }
  }
  records.forEach((record, index) => {
    record.born = index === 0 ? 0 : 0.4 + 8 * Math.pow(index / Math.max(1, records.length - 1), 0.62);
  });
  return { records, byNode, treeLinks: new Set(records.map((record) => record.link).filter(Boolean)), duration: 10 };
}

export function replayPosition(record, time) {
  const age = Math.max(0, time - record.born);
  const progress = Math.min(1, age / 0.9);
  const spring = progress >= 1 ? 1 : 1 - Math.exp(-5 * progress) * Math.cos(7 * progress);
  const origin = record.origin || { x: 0, y: 0, z: 0 };
  return Object.fromEntries(["x", "y", "z"].map((axis) => [axis, origin[axis] + (record.home[axis] - origin[axis]) * spring]));
}
