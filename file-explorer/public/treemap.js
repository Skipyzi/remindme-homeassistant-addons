function worstRatio(row, side) {
  if (!row.length || side <= 0) return Number.POSITIVE_INFINITY;
  const total = row.reduce((sum, item) => sum + item.area, 0);
  const largest = Math.max(...row.map((item) => item.area));
  const smallest = Math.min(...row.map((item) => item.area));
  const sideSquared = side * side;
  const totalSquared = total * total;
  return Math.max((sideSquared * largest) / totalSquared, totalSquared / (sideSquared * smallest));
}

function layoutRow(row, remaining, rectangles) {
  const area = row.reduce((sum, item) => sum + item.area, 0);
  if (remaining.width >= remaining.height) {
    const rowWidth = remaining.height > 0 ? area / remaining.height : 0;
    let y = remaining.y;
    for (const item of row) {
      const height = rowWidth > 0 ? item.area / rowWidth : 0;
      rectangles.push({ node: item.node, x: remaining.x, y, width: rowWidth, height });
      y += height;
    }
    return {
      x: remaining.x + rowWidth,
      y: remaining.y,
      width: Math.max(0, remaining.width - rowWidth),
      height: remaining.height,
    };
  }

  const rowHeight = remaining.width > 0 ? area / remaining.width : 0;
  let x = remaining.x;
  for (const item of row) {
    const width = rowHeight > 0 ? item.area / rowHeight : 0;
    rectangles.push({ node: item.node, x, y: remaining.y, width, height: rowHeight });
    x += width;
  }
  return {
    x: remaining.x,
    y: remaining.y + rowHeight,
    width: remaining.width,
    height: Math.max(0, remaining.height - rowHeight),
  };
}

export function layoutTreemap(nodes, width, height) {
  if (!(width > 0) || !(height > 0)) return [];
  const valid = nodes
    .filter((node) => Number.isFinite(node.size) && node.size > 0)
    .sort((left, right) => right.size - left.size || String(left.id).localeCompare(String(right.id)));
  const total = valid.reduce((sum, node) => sum + node.size, 0);
  if (!(total > 0)) return [];

  const scale = (width * height) / total;
  const pending = valid.map((node) => ({ node, area: node.size * scale }));
  const rectangles = [];
  let remaining = { x: 0, y: 0, width, height };
  let row = [];

  while (pending.length > 0) {
    const candidate = pending[0];
    const side = Math.min(remaining.width, remaining.height);
    if (row.length === 0 || worstRatio([...row, candidate], side) <= worstRatio(row, side)) {
      row.push(pending.shift());
    } else {
      remaining = layoutRow(row, remaining, rectangles);
      row = [];
    }
  }
  if (row.length > 0) layoutRow(row, remaining, rectangles);
  return rectangles;
}
