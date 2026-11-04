// 只移动发生重叠的节点，保留其余位置和尺寸。
function overlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
function separateOverlaps(boxes, direction = 'TB', gap = 24) {
  const placed = [], changed = new Set();
  for (const [index, box] of boxes.entries()) {
    if (placed.some(p => overlaps(box, p))) {
      // 修正后的位置同时避开尚未处理的节点，避免把原本正常的节点挤走。
      const obstacles = placed.concat(boxes.slice(index + 1));
      const candidates = obstacles.flatMap(p => [
        { x: p.x - box.width - gap, y: box.y }, { x: p.x + p.width + gap, y: box.y },
        { x: box.x, y: p.y - box.height - gap }, { x: box.x, y: p.y + p.height + gap },
      ]).filter(c => obstacles.every(p => !overlaps({ ...box, ...c }, p)));
      candidates.sort((a, b) => {
        const score = c => (c.x - box.x) ** 2 * (direction === 'LR' ? 1.4 : 1)
          + (c.y - box.y) ** 2 * (direction === 'TB' ? 1.4 : 1);
        return score(a) - score(b);
      });
      // 至少最外侧候选必然可用。
      Object.assign(box, candidates[0]);
      changed.add(box.id);
    }
    placed.push(box);
  }
  return changed;
}
module.exports = { separateOverlaps };
