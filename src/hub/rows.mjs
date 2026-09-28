// Which rows a mark's ink ([[x, y], ...] strokes) means, given where each row sits on the
// rendered page ([top, bottom, row]). The web page decides the same in rowsOf in
// web/review.js; the two have to agree, or a mark's lines differ by where it was drawn.
export function rowsUnderInk(ink, boxes) {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const stroke of ink)
    for (const [x, y] of stroke) {
      b.x0 = Math.min(b.x0, x);
      b.y0 = Math.min(b.y0, y);
      b.x1 = Math.max(b.x1, x);
      b.y1 = Math.max(b.y1, y);
    }
  if (b.y0 === Infinity) return [];
  // A flat stroke is an underline or a strike-through: the row it sits under or on, not the
  // row whose top edge it happens to touch.
  if (b.y1 - b.y0 < 16) {
    const y = (b.y0 + b.y1) / 2 - 10;
    const hit = boxes.filter(([top, bottom]) => top <= y && bottom >= y).pop();
    if (hit) return [hit[2]];
  } else {
    const rows = boxes.filter(([top, bottom]) => bottom >= b.y0 - 4 && top <= b.y1 + 4).map((box) => box[2]);
    if (rows.length) return rows;
  }
  let best = null;
  let bestGap = 30;
  for (const [top, bottom, row] of boxes) {
    const gap = Math.max(top - b.y1, b.y0 - bottom, 0);
    if (gap < bestGap) {
      bestGap = gap;
      best = row;
    }
  }
  return best === null ? [] : [best];
}
