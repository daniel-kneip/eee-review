// Review page for the Eee Note. Runs in QtWebKit 533 (Safari 5 era): ES5 without
// Function.prototype.bind, no classList, no requestAnimationFrame.
//
// The document scrolls in the upper pane with a rail on its right; a stroke on it starts a
// mark whose note opens beneath, in a pane that can be dragged taller and scrolls without
// end. The pen inks or erases, by the tool chosen in the bottom bar; the tablet's arrow
// buttons scroll whichever pane the pen last worked in.
//
// Inside the eeereview app the pen arrives through window.pen at full rate, and the app keeps
// its mouse echo away from the page; in a plain browser the pen arrives as mouse events.
//
// Ink lives on canvas tiles inside the document and the note, which scroll with them. Each
// stroke is drawn once, when it is made; scrolling and opening or closing a note draw nothing.
// The tablet rasterises canvas paths with software floating point, so redrawing ink on every
// scroll took it seconds. Tiles are only redrawn after erasing or undoing.

(function () {
  var TOOLBAR_H = 54, NOTEBAR_H = 54, RAIL_W = 38, MIN_PANE = 120, TILE = 512, RULE = 60;
  var TAP_MAX = 12, ERASE_RADIUS = 14, SAVE_DELAY = 800;
  // Matches INK_WIDTH in native/eeereview/main.cpp, so a stroke keeps its look when the page
  // takes it over from the app.
  var INK_WIDTH = 2;
  var KIND_LABEL = { spec: 'Dokument', diff: 'Diff', file: 'Datei', replies: 'Antworten' };

  var R = window.REVIEW;
  function el(id) { return document.getElementById(id); }
  var docPane = el('docPane'), docLayer = el('docLayer'), rail = el('rail');
  var noteBar = el('noteBar'), notePane = el('notePane'), noteLayer = el('noteLayer'), toolBar = el('toolBar');
  var filesView = el('files'), store = el('store');
  var railCtx = rail.getContext('2d');

  var W, H, docW, docH, noteH = 0, notePaneH = 0;
  var cur = 0, scrolls = [], heights = [], rowBoxes = [], docTiles = [];
  var marks = [], openMark = null, tool = 'pen', pane = 'doc', undoStack = [], active = null;
  var noteTiles = [], noteShown = null;
  var saveTimer = null;

  for (var d = 0; d < R.docs.length; d++) {
    scrolls.push(0);
    el('doc-' + d).style.position = 'relative';
  }

  function now() { return new Date().getTime(); }
  function newId() { return (now().toString(36) + Math.random().toString(36).substring(2, 8)); }
  function num(mark) { for (var i = 0; i < marks.length; i++) if (marks[i] === mark) return i + 1; return 0; }
  function removeItem(list, item) { for (var i = 0; i < list.length; i++) if (list[i] === item) { list.splice(i, 1); return i; } return -1; }
  function doc() { return R.docs[cur]; }
  function docIndex(id) { for (var i = 0; i < R.docs.length; i++) if (R.docs[i].id === id) return i; return -1; }
  function inside(node, parent) { while (node) { if (node === parent) return true; node = node.parentNode; } return false; }

  function timed(name, fn) {
    var t = now();
    fn();
    var ms = now() - t;
    if (ms > 150 && window.console) console.log(name + ' took ' + ms + ' ms');
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
    if (rail.width !== RAIL_W) rail.width = RAIL_W;
    if (rail.height !== docH) rail.height = docH;
    if (docLayer.style.width !== docW + 'px') { docLayer.style.width = docW + 'px'; rowBoxes = []; heights = []; measure(); }
    clampScroll();
    if (openMark) showNote();
    redrawRail();
    status();
  }

  // The fragment is moved, not copied, so a document keeps its layout, and its ink tiles,
  // between visits.
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
  function scrollTo(y) { scrolls[cur] = Math.round(y); clampScroll(); redrawRail(); }

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
  }

  // ── Ink tiles ───────────────────────────────────────────────────────────

  function pen(ctx) { ctx.strokeStyle = '#000'; ctx.fillStyle = '#000'; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = INK_WIDTH; }

  function tileCanvas(parent, index, width) {
    var c = document.createElement('canvas');
    c.width = width; c.height = TILE;
    c.style.position = 'absolute'; c.style.left = '0px'; c.style.top = (index * TILE) + 'px';
    parent.appendChild(c);
    return c.getContext('2d');
  }

  // Calls draw(ctx) in document (or note) coordinates on every tile the band y0..y1 touches,
  // creating tiles on demand; make(index) creates one.
  function onTiles(tiles, make, y0, y1, draw) {
    for (var t = Math.max(0, Math.floor(y0 / TILE)); t <= Math.floor(Math.max(y0, y1) / TILE); t++) {
      if (!tiles[t]) tiles[t] = make(t);
      var ctx = tiles[t];
      ctx.save();
      ctx.translate(0, -t * TILE);
      pen(ctx);
      draw(ctx);
      ctx.restore();
    }
  }

  function onDoc(di, y0, y1, draw) {
    if (!docTiles[di]) docTiles[di] = [];
    onTiles(docTiles[di], function (t) { return tileCanvas(el('doc-' + di), t, docW); }, y0, y1, draw);
  }

  // A new note tile gets its ruled lines and whatever ink of the open note falls on it.
  function makeNoteTile(t) {
    var ctx = tileCanvas(noteLayer, t, W);
    ctx.fillStyle = '#bbb';
    for (var y = (RULE - (t * TILE) % RULE) % RULE; y < TILE; y += RULE) ctx.fillRect(0, y, W, 1);
    ctx.save();
    ctx.translate(0, -t * TILE);
    pen(ctx);
    for (var s = 0; s < openMark.note.length; s++) {
      var b = boundsOf(openMark.note[s]);
      if (b.y1 >= t * TILE - 6 && b.y0 <= (t + 1) * TILE + 6) drawStroke(ctx, openMark.note[s]);
    }
    ctx.restore();
    return ctx;
  }

  function onNote(y0, y1, draw) { onTiles(noteTiles, makeNoteTile, y0, y1, draw); }

  function segment(ctx, a, b) {
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x === a.x && b.y === a.y ? b.x + 0.5 : b.x, b.y); ctx.stroke();
  }

  function drawStroke(ctx, pts) {
    if (!pts.length) return;
    if (pts.length === 1) { segment(ctx, pts[0], pts[0]); return; }
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }

  function boundsOf(pts) {
    var b = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (p.x < b.x0) b.x0 = p.x; if (p.y < b.y0) b.y0 = p.y;
      if (p.x > b.x1) b.x1 = p.x; if (p.y > b.y1) b.y1 = p.y;
    }
    return b;
  }

  function bbox(mark) {
    var b = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
    for (var s = 0; s < mark.ink.length; s++) {
      var o = boundsOf(mark.ink[s]);
      b.x0 = Math.min(b.x0, o.x0); b.y0 = Math.min(b.y0, o.y0); b.x1 = Math.max(b.x1, o.x1); b.y1 = Math.max(b.y1, o.y1);
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

  // The number badge and stamp sit above a mark's top-left corner.
  function drawBadge(mark) {
    var b = bbox(mark), n = num(mark), bx = Math.max(0, b.x0 - 30), by = b.y0 - 30;
    onDoc(docIndex(mark.doc), by, by + 28, function (ctx) {
      ctx.clearRect(bx, by, 60, 28);
      ctx.fillRect(bx, by, 28, 28);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 19px sans-serif';
      ctx.fillText(String(n), bx + (n > 9 ? 3 : 8), by + 21);
      pen(ctx);
      drawStamp(ctx, mark.stamp, bx + 32, by + 2);
    });
  }

  function drawMarkInk(mark, stroke) {
    var b = boundsOf(stroke);
    onDoc(docIndex(mark.doc), b.y0 - 6, b.y1 + 6, function (ctx) { drawStroke(ctx, stroke); });
  }

  function redrawDocInk(di) {
    var tiles = docTiles[di] || [];
    for (var t = 0; t < tiles.length; t++) if (tiles[t]) tiles[t].clearRect(0, 0, docW, TILE);
    for (var m = 0; m < marks.length; m++) {
      if (docIndex(marks[m].doc) !== di) continue;
      for (var s = 0; s < marks[m].ink.length; s++) drawMarkInk(marks[m], marks[m].ink[s]);
      drawBadge(marks[m]);
    }
  }

  // Numbers shift when a mark goes or comes back, in every document that has ink.
  function redrawAllInk() {
    timed('redraw ink', function () { for (var di = 0; di < R.docs.length; di++) if (docTiles[di]) redrawDocInk(di); });
    redrawRail();
    status();
  }

  // Builds the note's tiles for the open mark, or only the ones newly scrolled into view.
  function showNote() {
    if (noteShown !== openMark) {
      noteLayer.innerHTML = '';
      noteTiles = [];
      noteShown = openMark;
    }
    noteLayer.style.top = -openMark.noteScroll + 'px';
    noteLayer.style.width = W + 'px';
    for (var t = Math.floor(openMark.noteScroll / TILE); t <= Math.floor((openMark.noteScroll + notePaneH) / TILE); t++) {
      if (!noteTiles[t]) noteTiles[t] = makeNoteTile(t);
    }
  }

  function redrawNote() {
    noteShown = null;
    if (openMark) timed('redraw note', showNote);
  }

  // The rail maps the whole document onto the pane's height: the view as a frame, marks as
  // numbered tabs at their place, so earlier marks are one tap away.
  function redrawRail() {
    var h = docH, total = Math.max(heights[cur] || 1, 1);
    railCtx.clearRect(0, 0, RAIL_W, rail.height);
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
    timed('open note', layout);
    var b = bbox(mark);
    if (b.y0 < scrolls[cur] || b.y1 > scrolls[cur] + docH) scrollTo(b.y0 - docH * 0.25);
  }

  function closeNote() {
    openMark = null;
    pane = 'doc';
    timed('close note', layout);
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
      pushUndo(restoreNoteStroke(openMark, list.splice(i, 1)[0], i));
      redrawNote(); scheduleSave();
      return;
    }
  }

  function restoreNoteStroke(mark, stroke, at) {
    return function () { mark.note.splice(at, 0, stroke); if (openMark === mark) redrawNote(); };
  }

  function restoreMarkStroke(mark, stroke, at, markAt) {
    return function () {
      mark.ink.splice(at, 0, stroke);
      if (num(mark) === 0) marks.splice(markAt, 0, mark);
      redrawAllInk();
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
        redrawAllInk(); scheduleSave();
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
    if (hit === rail) return 'rail';
    if (inside(hit, docPane)) return 'doc';
    if (openMark && inside(hit, notePane)) return 'note';
    if (hit.tagName !== 'BUTTON' && (hit === noteBar || hit.parentNode === noteBar)) return 'grip';
    return null;
  }

  // Document or note coordinates of a viewport point.
  function toInk(target, x, y) {
    if (target === 'note') return { x: Math.round(x), y: Math.round(y - (docH + NOTEBAR_H) + openMark.noteScroll) };
    return { x: Math.round(x), y: Math.round(y + scrolls[cur]) };
  }

  function begin(x, y, eraser) {
    var target = targetAt(x, y);
    if (!target) return '';
    if (active) end();
    if (target === 'doc' || target === 'note') pane = target;
    var action = target === 'rail' || target === 'grip' ? target : eraser || tool === 'eraser' ? 'erase' : 'ink';
    active = { target: target, action: action, pts: [], drawn: false, lastY: y, startY: y, moved: 0, startScroll: target === 'note' ? openMark.noteScroll : scrolls[cur], startNoteH: noteH };
    if (action === 'ink') active.pts.push(toInk(target, x, y));
    else extend(x, y);
    return action === 'ink' ? 'ink' : 'stream';
  }

  function extend(x, y, quiet) {
    if (!active) return;
    var dy = y - active.startY;
    active.moved = Math.max(active.moved, Math.abs(dy));
    if (active.action === 'ink') {
      var q = toInk(active.target, x, y), last = active.pts[active.pts.length - 1];
      active.pts.push(q);
      if (quiet) return;
      active.drawn = true;
      var draw = function (ctx) { segment(ctx, last, q); };
      if (active.target === 'doc') onDoc(cur, Math.min(last.y, q.y) - 6, Math.max(last.y, q.y) + 6, draw);
      else onNote(Math.min(last.y, q.y) - 6, Math.max(last.y, q.y) + 6, draw);
    } else if (active.action === 'erase') {
      var e = toInk(active.target, x, y);
      if (active.target === 'doc') eraseDoc(e); else eraseNote(e);
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
    if (!g || g.action !== 'ink') return;
    var stroke = g.pts;
    if (g.target === 'note') {
      var mark = openMark;
      if (!g.drawn) { var nb = boundsOf(stroke); onNote(nb.y0 - 6, nb.y1 + 6, function (ctx) { drawStroke(ctx, stroke); }); }
      mark.note.push(stroke);
      pushUndo(function () { removeItem(mark.note, stroke); if (openMark === mark) redrawNote(); });
      scheduleSave();
      return;
    }
    if (pathLength(stroke) < TAP_MAX) {
      if (g.drawn) redrawDocInk(cur);
      var hit = hitMark(stroke[0]);
      if (hit && hit !== openMark) openNote(hit);
      return;
    }
    if (openMark) {
      var target = openMark;
      target.ink.push(stroke);
      if (!g.drawn) drawMarkInk(target, stroke);
      drawBadge(target);
      pushUndo(function () { removeItem(target.ink, stroke); redrawAllInk(); });
      redrawRail(); scheduleSave();
      return;
    }
    var created = { id: newId(), doc: doc().id, ink: [stroke], note: [], noteScroll: 0, stamp: null };
    marks.push(created);
    if (!g.drawn) drawMarkInk(created, stroke);
    drawBadge(created);
    pushUndo(function () { removeItem(marks, created); if (openMark === created) openMark = null; redrawAllInk(); layout(); });
    openNote(created);
    scheduleSave();
  }

  // The eeereview app reads the pen natively. down answers whether the page takes the
  // gesture and how: 'ink' means the app draws the stroke itself and hands it over whole
  // through stroke when the pen lifts; 'stream' means it forwards moves as they come, for
  // erasing, scrolling and dragging, which have to act under the pen.
  window.pen = {
    over: function (x, y) { return !!targetAt(x, y); },
    down: function (x, y) { return begin(x, y, false); },
    move: function (points) { for (var i = 0; i < points.length; i++) extend(points[i][0], points[i][1]); },
    stroke: function (points) {
      if (!active) return;
      for (var i = 0; i < points.length; i++) extend(points[i][0], points[i][1], true);
      timed('stroke end', end);
    },
    up: function () { end(); }
  };

  var mouseDown = false;
  docPane.parentNode.addEventListener('mousedown', function (e) {
    if (begin(e.clientX, e.clientY, e.button === 2)) { mouseDown = true; e.preventDefault(); }
  }, false);
  document.addEventListener('mousemove', function (e) {
    if (mouseDown) { extend(e.clientX, e.clientY); e.preventDefault(); }
  }, false);
  document.addEventListener('mouseup', function () { if (mouseDown) { mouseDown = false; end(); } }, false);
  document.oncontextmenu = function () { return false; };

  // ── Saving ──────────────────────────────────────────────────────────────

  function packStroke(pts) {
    var out = [];
    for (var i = 0; i < pts.length; i++) out.push([pts[i].x, pts[i].y]);
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
      for (var i = 0; i < list[s].length; i++) pts.push({ x: list[s][i][0], y: list[s][i][1] });
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
  // A drawer from the left: the agent's replies, the documents, the changed files as a tree
  // with folders that fold, and files the agent added for context. In a code review the
  // arrows in the bottom bar step through the changed files in the tree's order.

  var collapsed = {};

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
    closeFiles();
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

  function escape(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

  // Changed files as nested folders: { dirs: { name: node }, files: [doc index] }.
  function changeTree() {
    var root = { dirs: {}, files: [] };
    for (var i = 0; i < R.docs.length; i++) {
      var dd = R.docs[i];
      if (dd.kind !== 'diff') continue;
      var parts = dd.path.split('/'), node = root;
      for (var p = 0; p < parts.length - 1; p++) {
        if (!node.dirs[parts[p]]) node.dirs[parts[p]] = { dirs: {}, files: [] };
        node = node.dirs[parts[p]];
      }
      node.files.push(i);
    }
    return root;
  }

  function dirNames(node) { var out = []; for (var k in node.dirs) if (node.dirs.hasOwnProperty(k)) out.push(k); return out.sort(); }

  // Diff documents in the order the tree shows them, for the arrows.
  function diffOrder(node, out) {
    var names = dirNames(node);
    for (var d = 0; d < names.length; d++) diffOrder(node.dirs[names[d]], out);
    for (var f = 0; f < node.files.length; f++) out.push(node.files[f]);
    return out;
  }

  function fileRow(i, depth) {
    var dd = R.docs[i], n = marksIn(dd.id), whole = -1;
    for (var j = 0; j < R.docs.length; j++) if (R.docs[j].kind === 'file' && R.docs[j].path === dd.path) whole = j;
    var here = i === cur || (whole >= 0 && whole === cur);
    return '<div class="tree-row' + (here ? ' cur' : '') + '" data-doc="' + i + '" style="padding-left:' + (10 + depth * 18) + 'px">' +
      '<span class="st">' + (dd.status || '') + '</span>' + escape(dd.title) +
      ' <span class="delta">+' + (dd.plus || 0) + ' &minus;' + (dd.minus || 0) + '</span>' +
      (n ? ' <span class="count">&middot; ' + n + ' Mark.</span>' : '') +
      (whole >= 0 ? '<span class="whole" data-doc="' + whole + '">Datei</span>' : '') + '</div>';
  }

  // A folder with a single subfolder and no files of its own shows as one row, as on GitHub.
  function treeRows(node, path, depth) {
    var html = '', names = dirNames(node);
    for (var d = 0; d < names.length; d++) {
      var label = names[d], child = node.dirs[names[d]], full = path + names[d] + '/';
      while (!child.files.length && dirNames(child).length === 1) {
        var only = dirNames(child)[0];
        label += '/' + only;
        full += only + '/';
        child = child.dirs[only];
      }
      var closed = !!collapsed[full];
      html += '<div class="tree-row dir" data-dir="' + full + '" style="padding-left:' + (10 + depth * 18) + 'px">' + (closed ? '&#9656; ' : '&#9662; ') + escape(label) + '</div>';
      if (!closed) html += treeRows(child, full, depth + 1);
    }
    for (var f = 0; f < node.files.length; f++) html += fileRow(node.files[f], depth);
    return html;
  }

  function plainRows(kind, test) {
    var html = '';
    for (var i = 0; i < R.docs.length; i++) {
      var dd = R.docs[i];
      if (!test(dd)) continue;
      var n = marksIn(dd.id);
      html += '<div class="tree-row' + (i === cur ? ' cur' : '') + '" data-doc="' + i + '">' + escape(dd.path || dd.title) +
        (n ? ' <span class="count">&middot; ' + n + ' Mark.</span>' : '') + '</div>';
    }
    return html ? '<div class="section">' + kind + '</div>' + html : '';
  }

  function button(label, attrs, cls) {
    return '<button type="button" ' + attrs + (cls ? ' class="' + cls + '"' : '') + '>' + label + '</button>';
  }

  function drawerWidth() { return Math.min(560, W - 90); }

  function openFiles() {
    var html = '<h2>' + escape(R.title) + '</h2><p class="meta">Runde ' + R.round + ' &middot; ' + marks.length + ' Markierungen</p>';
    var toFile = doc().kind === 'diff' ? counterpart('file') : -1, toDiff = doc().kind === 'file' ? counterpart('diff') : -1;
    if (toFile >= 0) html += button('Ganze Datei an dieser Stelle &rarr;', 'data-jump="' + toFile + '"', 'wide jump');
    if (toDiff >= 0) html += button('Zum Diff an dieser Stelle &rarr;', 'data-jump="' + toDiff + '"', 'wide jump');
    html += plainRows('Antworten', function (dd) { return dd.kind === 'replies'; });
    html += plainRows('Dokumente', function (dd) { return !dd.context && (dd.kind === 'spec' || (dd.kind === 'file' && !hasDiff(dd.path))); });
    var tree = treeRows(changeTree(), '', 0);
    if (tree) html += '<div class="section">Ge&auml;nderte Dateien</div>' + tree;
    html += plainRows('Nachgeliefert', function (dd) { return dd.context; });
    html += button('An den Agenten senden (' + marks.length + ')', 'data-act="send"', 'wide send');
    html += button('Alle Reviews', 'data-act="inbox"', 'wide');
    if (window.eeeApp) html += button('App beenden', 'data-act="quit"', 'wide');
    filesView.innerHTML = html;
    place(filesView, 0, 0, drawerWidth(), H - TOOLBAR_H);
    place(el('shade'), drawerWidth(), 0, W - drawerWidth(), H - TOOLBAR_H);
  }

  function hasDiff(path) { for (var i = 0; i < R.docs.length; i++) if (R.docs[i].kind === 'diff' && R.docs[i].path === path) return true; return false; }

  function closeFiles() {
    filesView.style.display = 'none';
    el('shade').style.display = 'none';
  }

  function saveThen(next) {
    if (!saveTimer) { next(); return; }
    clearTimeout(saveTimer);
    saveTimer = null;
    post('/api/r/' + R.id + '/draft', { marks: packMarks() }, next);
  }

  function saveThenQuit() { saveThen(function () { window.eeeApp.quit(); }); }
  function toInbox() { saveThen(function () { window.location.href = '/'; }); }

  filesView.onclick = function (e) {
    var t = e.target;
    while (t && t !== filesView && !t.getAttribute('data-doc') && !t.getAttribute('data-dir') && !t.getAttribute('data-act') && !t.getAttribute('data-jump')) t = t.parentNode;
    if (!t || t === filesView) return;
    var act = t.getAttribute('data-act'), jump = t.getAttribute('data-jump'), dir = t.getAttribute('data-dir'), to = t.getAttribute('data-doc');
    if (act === 'send') return submit();
    if (act === 'inbox') return toInbox();
    if (act === 'quit') return saveThenQuit();
    if (jump) return go(Number(jump), lineAtView());
    if (dir) { collapsed[dir] = !collapsed[dir]; openFiles(); return; }
    if (to) go(Number(to));
  };

  // In a whole-file view the arrows step to the neighbouring files' whole views.
  function step(dir) {
    var order = diffOrder(changeTree(), []), path = doc().path, at = -1;
    for (var i = 0; i < order.length; i++) if (R.docs[order[i]].path === path) at = i;
    var next = order[at + dir];
    if (next === undefined) return;
    if (doc().kind === 'file') {
      for (var j = 0; j < R.docs.length; j++) if (R.docs[j].kind === 'file' && R.docs[j].path === R.docs[next].path) { go(j); return; }
    }
    go(next);
  }

  // ── Wiring ──────────────────────────────────────────────────────────────

  function setTool(t) { tool = t; status(); }

  function page(dir) {
    if (pane === 'note' && openMark) {
      openMark.noteScroll = Math.max(0, Math.round(openMark.noteScroll + dir * notePaneH * 0.75));
      showNote();
    } else scrollTo(scrolls[cur] + dir * docH * 0.75);
  }
  el('toolPen').onclick = function () { setTool('pen'); };
  el('toolEraser').onclick = function () { setTool('eraser'); };
  el('undo').onclick = undo;
  el('filesBtn').onclick = function () { if (filesView.style.display === 'block') closeFiles(); else openFiles(); };
  el('shade').onclick = closeFiles;
  el('prevDoc').onclick = function () { step(-1); };
  el('nextDoc').onclick = function () { step(1); };
  if (R.kind !== 'code') { el('prevDoc').style.display = 'none'; el('nextDoc').style.display = 'none'; }
  el('noteClose').onclick = closeNote;
  el('askAgent').onclick = ask;
  var stampButtons = noteBar.getElementsByTagName('button');
  for (var sb = 0; sb < stampButtons.length; sb++) {
    if (!stampButtons[sb].getAttribute('data-stamp')) continue;
    stampButtons[sb].onclick = function () {
      if (!openMark) return;
      var s = this.getAttribute('data-stamp');
      openMark.stamp = openMark.stamp === s ? null : s;
      drawBadge(openMark); status(); scheduleSave();
    };
  }
  window.keys = {
    press: function (name) {
      if (name === 'back') {
        if (filesView.style.display === 'block') closeFiles();
        else if (openMark) closeNote();
        else toInbox();
      } else if (name === 'home') saveThenQuit();
      else if (name === 'left') page(-1);
      else if (name === 'right') page(1);
      else if (name === 'g1') setTool('pen');
      else if (name === 'g2') setTool('eraser');
      else if (name === 'g3') undo();
      else if (name === 'g4') el('filesBtn').onclick();
      else return false;
      return true;
    }
  };
  document.onkeydown = function (e) {
    e = e || window.event;
    if (e.keyCode === 38 || e.keyCode === 33 || e.keyCode === 37) { page(-1); return false; }
    if (e.keyCode === 40 || e.keyCode === 34 || e.keyCode === 39) { page(1); return false; }
  };
  // QtWebKit on the tablet fires resize when the page resizes its own panes; answering every
  // one with a layout feeds it back without end and starves the app.
  window.onresize = function () {
    var w = window.innerWidth || document.documentElement.clientWidth;
    var h = window.innerHeight || document.documentElement.clientHeight;
    if (w !== W || h !== H) layout();
  };

  for (var k = 0; k < (R.marks || []).length; k++) {
    var saved = R.marks[k];
    if (docIndex(saved.doc) < 0) continue;
    marks.push({ id: saved.id, doc: saved.doc, ink: unpackStrokes(saved.ink), note: unpackStrokes(saved.note), noteScroll: saved.noteScroll || 0, rows: saved.rows, stamp: saved.stamp || null, asked: !!saved.asked });
  }

  // A code review opens on the first changed file as the tree lists it, unless the agent's
  // replies lead the round.
  function firstDocument() {
    if (R.kind !== 'code' || R.docs[0].kind === 'replies') return 0;
    var order = diffOrder(changeTree(), []);
    return order.length ? order[0] : 0;
  }

  viewport();
  docW = W - RAIL_W;
  docLayer.style.width = docW + 'px';
  showDocument(firstDocument());
  layout();
  timed('draw saved ink', function () { for (var di = 0; di < R.docs.length; di++) redrawDocInk(di); });
  redrawRail();
})();
