// Review page for the Eee Note. Runs in QtWebKit 533 (Safari 5 era): ES5 without
// Function.prototype.bind, no classList, no requestAnimationFrame.
//
// The document scrolls in the upper pane with a rail on its right; a stroke on it starts a
// mark whose note opens beneath, in a pane that can be dragged taller and scrolls without
// end. The pen acts by the tool chosen in the bottom bar: ink, eraser, or hand to scroll.
//
// Inside the eeereview app the pen arrives through window.pen at full rate, and the app keeps
// its mouse echo away from the page; in a plain browser the pen arrives as mouse events.

(function () {
  var TOOLBAR_H = 54, NOTEBAR_H = 54, RAIL_W = 38, MIN_PANE = 120;
  var TAP_MAX = 12, ERASE_RADIUS = 14, SAVE_DELAY = 800;
  // Mirrors PRESSURE_KNOTS in src/render/ink.mjs and native/common/pen.h.
  var KNOTS = [[0, 0.3], [100, 1.1], [200, 1.7], [235, 4.5]];
  var KIND_LABEL = { spec: 'Dokument', diff: 'Diff', file: 'Datei', replies: 'Antworten' };

  var R = window.REVIEW;
  function el(id) { return document.getElementById(id); }
  var docPane = el('docPane'), docLayer = el('docLayer'), docCanvas = el('docCanvas'), rail = el('rail');
  var noteBar = el('noteBar'), notePane = el('notePane'), noteCanvas = el('noteCanvas'), toolBar = el('toolBar');
  var filesView = el('files'), store = el('store');
  var docCtx = docCanvas.getContext('2d'), noteCtx = noteCanvas.getContext('2d'), railCtx = rail.getContext('2d');

  var W, H, docW, docH, noteH = 0, notePaneH = 0;
  var cur = 0, scrolls = [], heights = [], rowBoxes = [];
  var marks = [], openMark = null, tool = 'pen', undoStack = [], active = null;
  var saveTimer = null;

  for (var d = 0; d < R.docs.length; d++) scrolls.push(0);

  function now() { return new Date().getTime(); }
  function newId() { return (now().toString(36) + Math.random().toString(36).substring(2, 8)); }
  function num(mark) { for (var i = 0; i < marks.length; i++) if (marks[i] === mark) return i + 1; return 0; }
  function removeItem(list, item) { for (var i = 0; i < list.length; i++) if (list[i] === item) { list.splice(i, 1); return i; } return -1; }
  function doc() { return R.docs[cur]; }
  function docIndex(id) { for (var i = 0; i < R.docs.length; i++) if (R.docs[i].id === id) return i; return -1; }

  function inkWidth(p) {
    if (p === undefined || p === null) return 2;
    if (p <= KNOTS[0][0]) return KNOTS[0][1];
    for (var i = 1; i < KNOTS.length; i++) {
      if (p <= KNOTS[i][0]) {
        var t = (p - KNOTS[i - 1][0]) / (KNOTS[i][0] - KNOTS[i - 1][0]);
        return KNOTS[i - 1][1] + t * (KNOTS[i][1] - KNOTS[i - 1][1]);
      }
    }
    return KNOTS[KNOTS.length - 1][1];
  }

  // ── Layout ──────────────────────────────────────────────────────────────

  function viewport() {
    W = window.innerWidth || document.documentElement.clientWidth;
    H = window.innerHeight || document.documentElement.clientHeight;
  }

  function place(node, left, top, width, height) {
    node.style.left = left + 'px'; node.style.top = top + 'px';
    node.style.width = width + 'px'; node.style.height = height + 'px';
    node.style.display = height > 0 ? 'block' : 'none';
  }

  function layout() {
    viewport();
    var body = H - TOOLBAR_H;
    if (!noteH) noteH = Math.round(body * 0.42);
    noteH = Math.max(MIN_PANE, Math.min(noteH, body - NOTEBAR_H - MIN_PANE));
    notePaneH = openMark ? noteH : 0;
    docH = openMark ? body - NOTEBAR_H - noteH : body;
    docW = W - RAIL_W;
    place(docPane, 0, 0, docW, docH);
    place(rail, docW, 0, RAIL_W, docH);
    place(noteBar, 0, docH, W, openMark ? NOTEBAR_H : 0);
    place(notePane, 0, docH + NOTEBAR_H, W, notePaneH);
    place(toolBar, 0, H - TOOLBAR_H, W, TOOLBAR_H);
    docCanvas.width = docW; docCanvas.height = docH;
    rail.width = RAIL_W; rail.height = docH;
    noteCanvas.width = W; noteCanvas.height = Math.max(notePaneH, 1);
    if (docLayer.style.width !== docW + 'px') { docLayer.style.width = docW + 'px'; rowBoxes = []; heights = []; measure(); }
    clampScroll();
    redrawDoc(); redrawNote(); redrawRail(); status();
  }

  // The fragment is moved, not copied, so a document keeps its layout between visits.
  function showDocument(index) {
    while (docLayer.firstChild) store.appendChild(docLayer.firstChild);
    cur = index;
    docLayer.appendChild(el('doc-' + cur));
    measure();
  }

  function offset(node) {
    var x = 0, y = 0;
    while (node) { x += node.offsetLeft; y += node.offsetTop; node = node.offsetParent; }
    return { x: x, y: y };
  }

  // Row boxes in document coordinates: [top, bottom, row index, line].
  function measure() {
    if (rowBoxes[cur]) return;
    var boxes = [], base = offset(docLayer), all = docLayer.getElementsByTagName('*'), rowNew = doc().rowNew;
    for (var i = 0; i < all.length; i++) {
      var index = all[i].getAttribute('data-row');
      if (index === null || index === '') continue;
      var o = offset(all[i]);
      boxes.push([o.y - base.y, o.y - base.y + all[i].offsetHeight, Number(index), rowNew[Number(index)] || 0]);
    }
    rowBoxes[cur] = boxes;
    heights[cur] = docLayer.offsetHeight;
  }

  function maxScroll() { return Math.max(0, heights[cur] - docH); }
  function clampScroll() {
    scrolls[cur] = Math.max(0, Math.min(scrolls[cur], maxScroll()));
    docLayer.style.top = -scrolls[cur] + 'px';
  }
  function scrollTo(y) { scrolls[cur] = Math.round(y); clampScroll(); redrawDoc(); redrawRail(); status(); }

  function status(text) {
    var t = doc().title;
    if (t.length > 18) t = t.substring(0, 17) + '&hellip;';
    el('status').innerHTML = text || (t + ' &middot; ' + marks.length + ' Mark.');
    if (openMark) el('noteTitle').innerHTML = 'Notiz ' + num(openMark) + (openMark.asked ? ' &middot; gefragt' : '');
    var stamps = noteBar.getElementsByTagName('button');
    for (var i = 0; i < stamps.length; i++) {
      var s = stamps[i].getAttribute('data-stamp');
      if (s) stamps[i].className = openMark && openMark.stamp === s ? 'on' : '';
    }
    el('toolPen').className = tool === 'pen' ? 'on' : '';
    el('toolEraser').className = tool === 'eraser' ? 'on' : '';
    el('toolHand').className = tool === 'hand' ? 'on' : '';
  }

  // ── Drawing ─────────────────────────────────────────────────────────────

  function docToScreen(p) { return { x: p.x, y: p.y - scrolls[cur] }; }
  function screenToDoc(s) { return { x: Math.round(s.x), y: Math.round(s.y + scrolls[cur]) }; }
  function noteToScreen(p) { return { x: p.x, y: p.y - openMark.noteScroll }; }
  function screenToNote(s) { return { x: Math.round(s.x), y: Math.round(s.y + openMark.noteScroll) }; }

  function pen(ctx) { ctx.strokeStyle = '#000'; ctx.fillStyle = '#000'; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; }

  function segment(ctx, a, b, p, extra) {
    ctx.lineWidth = inkWidth(p) + (extra || 0);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x === a.x && b.y === a.y ? b.x + 0.5 : b.x, b.y); ctx.stroke();
  }

  function drawStroke(ctx, pts, toScreen, extra) {
    if (!pts.length) return;
    var a = toScreen(pts[0]);
    if (pts.length === 1) { segment(ctx, a, a, pts[0].p, extra); return; }
    for (var i = 1; i < pts.length; i++) {
      var b = toScreen(pts[i]);
      segment(ctx, a, b, pts[i].p, extra);
      a = b;
    }
  }

  function bbox(mark) {
    var b = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
    for (var s = 0; s < mark.ink.length; s++) for (var i = 0; i < mark.ink[s].length; i++) {
      var p = mark.ink[s][i];
      if (p.x < b.x0) b.x0 = p.x; if (p.y < b.y0) b.y0 = p.y;
      if (p.x > b.x1) b.x1 = p.x; if (p.y > b.y1) b.y1 = p.y;
    }
    return b;
  }

  function drawStamp(ctx, stamp, x, y) {
    if (!stamp) return;
    ctx.lineWidth = 3; ctx.beginPath();
    if (stamp === 'ok') { ctx.moveTo(x, y + 12); ctx.lineTo(x + 7, y + 20); ctx.lineTo(x + 20, y + 4); }
    else if (stamp === 'no') { ctx.moveTo(x + 3, y + 5); ctx.lineTo(x + 18, y + 20); ctx.moveTo(x + 18, y + 5); ctx.lineTo(x + 3, y + 20); }
    ctx.stroke();
    if (stamp === 'ask') { ctx.font = 'bold 22px sans-serif'; ctx.fillText('?', x + 5, y + 21); }
  }

  function redrawDoc() {
    docCtx.clearRect(0, 0, docCanvas.width, docCanvas.height);
    for (var m = 0; m < marks.length; m++) {
      var mark = marks[m];
      if (mark.doc !== doc().id) continue;
      pen(docCtx);
      for (var s = 0; s < mark.ink.length; s++) drawStroke(docCtx, mark.ink[s], docToScreen, mark === openMark ? 0.8 : 0);
      var b = bbox(mark), tl = docToScreen({ x: b.x0, y: b.y0 });
      var bx = Math.max(0, tl.x - 30), by = tl.y - 30;
      docCtx.fillRect(bx, by, 28, 28);
      docCtx.fillStyle = '#fff'; docCtx.font = 'bold 19px sans-serif';
      docCtx.fillText(String(m + 1), bx + (m + 1 > 9 ? 3 : 8), by + 21);
      pen(docCtx);
      drawStamp(docCtx, mark.stamp, bx + 32, by + 2);
    }
  }

  function redrawNote() {
    if (!openMark) return;
    noteCtx.clearRect(0, 0, noteCanvas.width, noteCanvas.height);
    noteCtx.fillStyle = '#bbb';
    for (var y = 60 - (openMark.noteScroll % 60); y < noteCanvas.height; y += 60) noteCtx.fillRect(0, y, W, 1);
    pen(noteCtx);
    for (var s = 0; s < openMark.note.length; s++) drawStroke(noteCtx, openMark.note[s], noteToScreen, 0);
  }

  // The rail maps the whole document onto the pane's height: the view as a frame, marks as
  // numbered tabs at their place, so earlier marks are one tap away.
  function redrawRail() {
    var h = rail.height, total = Math.max(heights[cur] || 1, 1);
    railCtx.clearRect(0, 0, RAIL_W, h);
    railCtx.fillStyle = '#ccc';
    railCtx.fillRect(3, Math.round(scrolls[cur] / total * h), RAIL_W - 6, Math.max(8, Math.round(docH / total * h)));
    for (var m = 0; m < marks.length; m++) {
      if (marks[m].doc !== doc().id) continue;
      var y = Math.round(bbox(marks[m]).y0 / total * h);
      railCtx.fillStyle = '#000';
      railCtx.fillRect(4, y, RAIL_W - 8, 20);
      railCtx.fillStyle = '#fff'; railCtx.font = 'bold 15px sans-serif';
      railCtx.fillText(String(m + 1), m + 1 > 9 ? 8 : 13, y + 16);
    }
  }

  // ── Marks and notes ─────────────────────────────────────────────────────

  function openNote(mark) {
    openMark = mark;
    layout();
    var b = bbox(mark);
    if (b.y0 < scrolls[cur] || b.y1 > scrolls[cur] + docH) scrollTo(b.y0 - docH * 0.25);
  }

  function closeNote() {
    openMark = null;
    layout();
    scheduleSave();
  }

  function hitMark(p) {
    for (var m = marks.length - 1; m >= 0; m--) {
      if (marks[m].doc !== doc().id) continue;
      var b = bbox(marks[m]);
      if (p.x >= b.x0 - 40 && p.x <= b.x1 + 40 && p.y >= b.y0 - 40 && p.y <= b.y1 + 40) return marks[m];
    }
    return null;
  }

  // A flat stroke is an underline or a strike-through: it means the row it sits under or on,
  // not the row whose top edge it happens to touch. Ink that lands in the gap between blocks
  // means the nearest one.
  function rowsOf(mark) {
    var b = bbox(mark), boxes = rowBoxes[docIndex(mark.doc)] || [], out = [], i;
    if (b.y1 - b.y0 < 16) {
      var y = (b.y0 + b.y1) / 2 - 10, hit = null;
      for (i = 0; i < boxes.length; i++) if (boxes[i][0] <= y && boxes[i][1] >= y) hit = boxes[i][2];
      if (hit !== null) out.push(hit);
    } else {
      for (i = 0; i < boxes.length; i++) if (boxes[i][1] >= b.y0 - 4 && boxes[i][0] <= b.y1 + 4) out.push(boxes[i][2]);
    }
    if (out.length) return out;
    var best = null, bestGap = 30;
    for (i = 0; i < boxes.length; i++) {
      var gap = Math.max(boxes[i][0] - b.y1, b.y0 - boxes[i][1], 0);
      if (gap < bestGap) { bestGap = gap; best = boxes[i][2]; }
    }
    return best === null ? [] : [best];
  }

  function segmentDistance(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
    var t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
    var x = a.x + t * dx - p.x, y = a.y + t * dy - p.y;
    return Math.sqrt(x * x + y * y);
  }

  function strokeHit(pts, p) {
    if (pts.length === 1) return segmentDistance(p, pts[0], pts[0]) < ERASE_RADIUS;
    for (var i = 1; i < pts.length; i++) if (segmentDistance(p, pts[i - 1], pts[i]) < ERASE_RADIUS) return true;
    return false;
  }

  function eraseNote(p) {
    var list = openMark.note;
    for (var i = list.length - 1; i >= 0; i--) {
      if (!strokeHit(list[i], p)) continue;
      pushUndo(restoreStroke(list, list.splice(i, 1)[0], i, redrawNote));
      redrawNote(); scheduleSave();
      return;
    }
  }

  function restoreStroke(list, stroke, at, redraw) {
    return function () { list.splice(at, 0, stroke); redraw(); };
  }

  function restoreMarkStroke(mark, stroke, at, markAt) {
    return function () {
      mark.ink.splice(at, 0, stroke);
      if (num(mark) === 0) marks.splice(markAt, 0, mark);
      redrawDoc(); redrawRail(); status();
    };
  }

  function eraseDoc(p) {
    for (var m = marks.length - 1; m >= 0; m--) {
      var mark = marks[m];
      if (mark.doc !== doc().id) continue;
      for (var i = mark.ink.length - 1; i >= 0; i--) {
        if (!strokeHit(mark.ink[i], p)) continue;
        var undo = restoreMarkStroke(mark, mark.ink.splice(i, 1)[0], i, m);
        if (!mark.ink.length) {
          marks.splice(m, 1);
          if (openMark === mark) { openMark = null; layout(); }
        }
        pushUndo(undo);
        redrawDoc(); redrawRail(); status(); scheduleSave();
        return;
      }
    }
  }

  function pushUndo(fn) { undoStack.push(fn); }
  function undo() {
    if (!undoStack.length) return;
    undoStack.pop()();
    scheduleSave();
  }

  // ── Gestures ────────────────────────────────────────────────────────────
  // A gesture starts on a target (doc, note, rail, grip) and does what the tool and target
  // call for. Points come in viewport coordinates, from the mouse or from window.pen.

  function targetAt(x, y) {
    var hit = document.elementFromPoint(x, y);
    if (!hit || filesView.style.display === 'block') return null;
    if (hit === docCanvas) return 'doc';
    if (hit === noteCanvas && openMark) return 'note';
    if (hit === rail) return 'rail';
    if (hit.tagName !== 'BUTTON' && (hit === noteBar || hit.parentNode === noteBar)) return 'grip';
    return null;
  }

  function local(target, x, y) {
    if (target === 'note') return { x: x, y: y - (docH + NOTEBAR_H) };
    return { x: x, y: y };
  }

  function begin(x, y, p, eraser) {
    var target = targetAt(x, y);
    if (!target) return '';
    if (active) end();
    var s = local(target, x, y);
    var action = target === 'rail' || target === 'grip' ? target : tool === 'hand' ? 'hand' : eraser || tool === 'eraser' ? 'erase' : 'ink';
    active = { target: target, action: action, pts: [], last: s, startY: y, moved: 0, startScroll: target === 'note' ? openMark.noteScroll : scrolls[cur], startNoteH: noteH };
    if (action === 'ink') active.pts.push(point(target, s, p));
    else extend(x, y, p);
    return action === 'ink' ? 'ink' : 'stream';
  }

  function point(target, s, p) {
    var q = target === 'doc' ? screenToDoc(s) : screenToNote(s);
    if (p !== undefined && p !== null) q.p = p;
    return q;
  }

  function extend(x, y, p) {
    if (!active) return;
    var s = local(active.target, x, y), dy = y - active.startY;
    active.moved = Math.max(active.moved, Math.abs(dy));
    if (active.action === 'ink') {
      var q = point(active.target, s, p);
      var ctx = active.target === 'doc' ? docCtx : noteCtx;
      pen(ctx);
      segment(ctx, active.last, s, q.p, 0);
      active.pts.push(q);
      active.last = s;
    } else if (active.action === 'erase') {
      if (active.target === 'doc') eraseDoc(screenToDoc(s)); else eraseNote(screenToNote(s));
    } else if (active.action === 'hand') {
      if (active.target === 'doc') scrollTo(active.startScroll - dy);
      else { openMark.noteScroll = Math.max(0, Math.round(active.startScroll - dy)); redrawNote(); }
    } else if (active.action === 'rail') {
      scrollTo(Math.max(0, Math.min(1, y / docH)) * (heights[cur] || 0) - docH / 2);
    } else if (active.action === 'grip') {
      noteH = active.startNoteH - dy;
      layout();
    }
  }

  function pathLength(pts) {
    var len = 0;
    for (var i = 1; i < pts.length; i++) len += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
    return len;
  }

  function end() {
    var g = active;
    active = null;
    if (g && g.action === 'hand' && g.target === 'doc' && g.moved < TAP_MAX) {
      var tapped = hitMark(screenToDoc(g.last));
      if (tapped && tapped !== openMark) openNote(tapped);
      return;
    }
    if (!g || g.action !== 'ink') return;
    if (g.target === 'note') {
      var list = openMark.note, stroke = g.pts;
      list.push(stroke);
      pushUndo(function () { removeItem(list, stroke); redrawNote(); });
      scheduleSave();
      return;
    }
    if (pathLength(g.pts) < TAP_MAX) {
      var hit = hitMark(g.pts[0]);
      if (hit && hit !== openMark) openNote(hit); else redrawDoc();
      return;
    }
    if (openMark) {
      var ink = openMark.ink, s2 = g.pts;
      ink.push(s2);
      pushUndo(function () { removeItem(ink, s2); redrawDoc(); redrawRail(); });
      redrawDoc(); redrawRail(); scheduleSave();
      return;
    }
    var mark = { id: newId(), doc: doc().id, ink: [g.pts], note: [], noteScroll: 0, stamp: null };
    marks.push(mark);
    pushUndo(function () { removeItem(marks, mark); if (openMark === mark) openMark = null; layout(); });
    openNote(mark);
    scheduleSave();
  }

  // The eeereview app reads the pen natively. down answers whether the page takes the
  // gesture and how: 'ink' means the app draws the stroke itself and hands it over whole
  // through stroke when the pen lifts; 'stream' means it forwards moves as they come, for
  // erasing, scrolling and dragging, which have to act under the pen.
  window.pen = {
    over: function (x, y) { return !!targetAt(x, y); },
    down: function (x, y, p) { return begin(x, y, p, false); },
    move: function (points) { for (var i = 0; i < points.length; i++) extend(points[i][0], points[i][1], points[i][2]); },
    stroke: function (points) { this.move(points); end(); },
    up: function () { end(); }
  };

  var mouseDown = false;
  docPane.parentNode.addEventListener('mousedown', function (e) {
    if (begin(e.clientX, e.clientY, undefined, e.button === 2)) { mouseDown = true; e.preventDefault(); }
  }, false);
  document.addEventListener('mousemove', function (e) {
    if (mouseDown) { extend(e.clientX, e.clientY, undefined); e.preventDefault(); }
  }, false);
  document.addEventListener('mouseup', function () { if (mouseDown) { mouseDown = false; end(); } }, false);
  document.oncontextmenu = function () { return false; };

  // ── Saving ──────────────────────────────────────────────────────────────

  function packStroke(pts) {
    var out = [];
    for (var i = 0; i < pts.length; i++) out.push(pts[i].p === undefined ? [pts[i].x, pts[i].y] : [pts[i].x, pts[i].y, pts[i].p]);
    return out;
  }
  function packStrokes(list) { var out = []; for (var i = 0; i < list.length; i++) out.push(packStroke(list[i])); return out; }
  function packMark(m) {
    var rows = rowBoxes[docIndex(m.doc)] ? rowsOf(m) : m.rows || [];
    return { id: m.id, doc: m.doc, ink: packStrokes(m.ink), note: packStrokes(m.note), noteScroll: m.noteScroll, rows: rows, stamp: m.stamp, asked: !!m.asked };
  }
  function packMarks() { var out = []; for (var i = 0; i < marks.length; i++) out.push(packMark(marks[i])); return out; }

  function unpackStrokes(list) {
    var out = [];
    for (var s = 0; s < (list || []).length; s++) {
      var pts = [];
      for (var i = 0; i < list[s].length; i++) {
        var q = { x: list[s][i][0], y: list[s][i][1] };
        if (list[s][i].length > 2 && list[s][i][2] !== null) q.p = list[s][i][2];
        pts.push(q);
      }
      out.push(pts);
    }
    return out;
  }

  function post(url, body, done) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onreadystatechange = function () { if (xhr.readyState === 4 && done) done(xhr.status === 200); };
    xhr.send(JSON.stringify(body));
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      post('/api/r/' + R.id + '/draft', { marks: packMarks() }, function (ok) {
        if (!ok) status('Speichern fehlgeschlagen');
      });
    }, SAVE_DELAY);
  }

  function submit() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    status('Sende &hellip;');
    post('/api/r/' + R.id + '/submit', { marks: packMarks() }, function (ok) {
      if (ok) window.location.href = '/';
      else status('Senden fehlgeschlagen');
    });
  }

  function ask() {
    if (!openMark) return;
    var mark = openMark;
    post('/api/r/' + R.id + '/request', { mark: packMark(mark) }, function (ok) {
      if (ok) { mark.asked = true; scheduleSave(); }
      status(ok ? 'Frage an den Agenten gesendet' : 'Frage nicht gesendet');
    });
  }

  // ── Document list ───────────────────────────────────────────────────────

  function counterpart(kind) {
    for (var i = 0; i < R.docs.length; i++) if (doc().path && R.docs[i].path === doc().path && R.docs[i].kind === kind) return i;
    return -1;
  }

  function lineAtView() {
    var y = scrolls[cur] + docH / 3, boxes = rowBoxes[cur], best = null;
    for (var i = 0; i < boxes.length; i++) {
      if (!boxes[i][3]) continue;
      if (!best || Math.abs((boxes[i][0] + boxes[i][1]) / 2 - y) < Math.abs((best[0] + best[1]) / 2 - y)) best = boxes[i];
    }
    return best ? best[3] : null;
  }

  function go(index, line) {
    filesView.style.display = 'none';
    openMark = null;
    showDocument(index);
    layout();
    if (line) {
      var boxes = rowBoxes[cur];
      for (var i = 0; i < boxes.length; i++) if (boxes[i][3] >= line) { scrollTo(boxes[i][0] - docH / 3); return; }
    }
    scrollTo(scrolls[cur]);
  }

  function marksIn(id) { var n = 0; for (var i = 0; i < marks.length; i++) if (marks[i].doc === id) n++; return n; }

  function button(label, attrs, cls) {
    return '<button type="button" ' + attrs + (cls ? ' class="' + cls + '"' : '') + '>' + label + '</button>';
  }

  function docButton(i, label) {
    var n = marksIn(R.docs[i].id);
    return button(label + (n ? ' <span class="count">&middot; ' + n + '</span>' : ''), 'data-doc="' + i + '"', i === cur ? 'cur' : '');
  }

  function openFiles() {
    var html = '<div id="filesInner"><h2>' + R.title + '</h2><p class="meta">Runde ' + R.round + ' &middot; ' + marks.length + ' Markierungen</p>';
    var toFile = doc().kind === 'diff' ? counterpart('file') : -1, toDiff = doc().kind === 'file' ? counterpart('diff') : -1;
    if (toFile >= 0) html += button('Ganze Datei an dieser Stelle &rarr;', 'data-jump="' + toFile + '"', 'wide jump');
    if (toDiff >= 0) html += button('Zum Diff an dieser Stelle &rarr;', 'data-jump="' + toDiff + '"', 'wide jump');
    var lastDir = null, seen = {};
    for (var i = 0; i < R.docs.length; i++) {
      var dd = R.docs[i];
      if (seen[i]) continue;
      if (!dd.path) { html += '<div class="row">' + docButton(i, dd.title) + '</div>'; continue; }
      var dir = dd.path.indexOf('/') >= 0 ? dd.path.substring(0, dd.path.lastIndexOf('/')) : '';
      if (dir !== lastDir) { if (dir || lastDir !== null) html += '<div class="dir">' + (dir || '/') + '</div>'; lastDir = dir; }
      var row = docButton(i, dd.title + (dd.added ? ' (nachgeliefert)' : '') + (dd.kind !== 'spec' ? ' &middot; ' + KIND_LABEL[dd.kind] : ''));
      for (var j = i + 1; j < R.docs.length; j++) {
        if (R.docs[j].path === dd.path) { row += docButton(j, KIND_LABEL[R.docs[j].kind]); seen[j] = true; }
      }
      html += '<div class="row">' + row + '</div>';
    }
    html += button('An den Agenten senden (' + marks.length + ')', 'data-act="send"', 'wide send');
    html += button('Zur&uuml;ck', 'data-act="back"', 'wide');
    html += button('Alle Reviews', 'data-act="inbox"', 'wide');
    filesView.innerHTML = html + '</div>';
    place(filesView, 0, 0, W, H - TOOLBAR_H);
    filesView.style.overflowY = 'auto';
    var buttons = filesView.getElementsByTagName('button');
    for (var b = 0; b < buttons.length; b++) buttons[b].onclick = onFileButton;
  }

  function onFileButton() {
    var act = this.getAttribute('data-act'), jump = this.getAttribute('data-jump'), to = this.getAttribute('data-doc');
    if (act === 'send') return submit();
    if (act === 'inbox') { window.location.href = '/'; return; }
    if (act === 'back') { filesView.style.display = 'none'; return; }
    if (jump !== null) { go(Number(jump), lineAtView()); return; }
    go(Number(to));
  }

  // ── Wiring ──────────────────────────────────────────────────────────────

  function setTool(t) { tool = t; status(); }
  el('toolPen').onclick = function () { setTool('pen'); };
  el('toolEraser').onclick = function () { setTool('eraser'); };
  el('toolHand').onclick = function () { setTool('hand'); };
  el('undo').onclick = undo;
  el('filesBtn').onclick = function () { if (filesView.style.display === 'block') filesView.style.display = 'none'; else openFiles(); };
  el('noteClose').onclick = closeNote;
  el('askAgent').onclick = ask;
  var stampButtons = noteBar.getElementsByTagName('button');
  for (var sb = 0; sb < stampButtons.length; sb++) {
    if (!stampButtons[sb].getAttribute('data-stamp')) continue;
    stampButtons[sb].onclick = function () {
      if (!openMark) return;
      var s = this.getAttribute('data-stamp');
      openMark.stamp = openMark.stamp === s ? null : s;
      redrawDoc(); status(); scheduleSave();
    };
  }
  document.onkeydown = function (e) {
    e = e || window.event;
    if (e.keyCode === 38 || e.keyCode === 33 || e.keyCode === 37) { scrollTo(scrolls[cur] - docH * 0.75); return false; }
    if (e.keyCode === 40 || e.keyCode === 34 || e.keyCode === 39) { scrollTo(scrolls[cur] + docH * 0.75); return false; }
  };
  window.onresize = layout;

  for (var k = 0; k < (R.marks || []).length; k++) {
    var saved = R.marks[k];
    if (docIndex(saved.doc) < 0) continue;
    marks.push({ id: saved.id, doc: saved.doc, ink: unpackStrokes(saved.ink), note: unpackStrokes(saved.note), noteScroll: saved.noteScroll || 0, rows: saved.rows, stamp: saved.stamp || null, asked: !!saved.asked });
  }

  viewport();
  docLayer.style.width = (W - RAIL_W) + 'px';
  showDocument(0);
  layout();
})();
