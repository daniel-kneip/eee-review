// The review page drawn natively: documents arrive from the hub as pre-rendered 4-bit gray
// strips (src/render/pages.mjs), so paging and scrolling only copy pixels. It behaves like
// web/review.js, which stays the reference: a stroke on the document starts a mark and opens
// its note beneath, strokes while a note is open add to that mark, a tap opens a mark's note.
// Marks go to the hub with their ink alone; the hub works out the rows they mean. Everything
// goes through the Mirror, so a review on the tablet opens and saves without the hub.
//
// The pen arrives from the app's PenReader in screen coordinates through penDown/penMoved/
// penUp; tslib's mouse echo of the same pen is ignored.

#ifndef EEE_NATIVE_H
#define EEE_NATIVE_H

#include <QtGui>

#include "baker.h"
#include "figure.h"
#include "mirror.h"
#include "ui.h"

namespace native {

static const int TOOLBAR_H = 54, NOTEBAR_H = 54, RAIL_W = 38, MIN_PANE = 120, RULE = 60;
static const int NOTE_TILE = 256;
// Decoded strips and baked tiles are kept this many strips around the view. Kept for every
// strip visited they filled 70 MB of the tablet's 256 in a review of 14 files.
static const int KEEP_STRIPS = 2;
static const int TAP_MAX = 12, ERASE_RADIUS = 14, SAVE_DELAY = 800, NEAR = 120, CONFIRM_MS = 5000, STATE_DELAY = 1500;

struct Mark {
    Mark() : noteScroll(0), asked(false), rowsKnown(false) {}
    QString id, doc, stamp;
    Strokes ink, note;
    int noteScroll;
    bool asked;
    // Rows the web page worked out; kept while the ink is unchanged, since the hub can only
    // locate ink on pages it has rendered.
    bool rowsKnown;
    QString rowsJson;
};
typedef QSharedPointer<Mark> MarkPtr;

struct Doc {
    Doc() : context(false), plus(0), minus(0), height(0), strip(512), scroll(0), loaded(false) {}
    QString id, kind, title, path, status;
    bool context;
    int plus, minus;
    QList<int> rowNew;   // the source line of each row, 0 where a row has none
    // Where each row sits on the rendered page, for jumping between a diff and its file.
    QList<int> rowTop, rowBottom, rowIndex;
    int height, strip, scroll;
    bool loaded;
    QList<QPixmap> strips;
    // The strips as they came, to burn ink into: a screen pixmap drawn into an image comes
    // out black on this panel.
    QList<QByteArray> pngs;
    QList<bool> requested;
    // The figures on the page, to open in the zoom view.
    QList<QRect> figureBoxes;
    QStringList figureNames;
};

// A document strip, or a slice of a note, with its ink burnt in by the Baker. Until a bake
// arrives it is painted from its source with the ink drawn over; strokes added since the
// last bake are drawn over what it shows.
struct Tile {
    Tile() : note(false), doc(0), index(0), busy(false), fresh(false), gen(0) {}
    QString key;
    bool note;
    int doc, index;
    MarkPtr mark;
    QRect band;
    QPixmap shown;
    QImage image;
    Strokes inFlight, unbaked;
    bool busy, fresh;
    int gen;
};

// Undo entries record what a change did, to put it back.
struct Undo {
    enum Kind { AddedInk, CreatedMark, AddedNote, ErasedInk, ErasedNote } kind;
    MarkPtr mark;
    QPolygon stroke;
    int at, markAt;
};

inline QString jsonString(const QString &s) {
    QString out = "\"";
    for (int i = 0; i < s.size(); ++i) {
        QChar c = s[i];
        if (c == '"' || c == '\\') out += '\\', out += c;
        else if (c.unicode() < 0x20) out += QString("\\u%1").arg(c.unicode(), 4, 16, QChar('0'));
        else out += c;
    }
    return out + "\"";
}

inline void appendInt(QByteArray &out, int v) {
    char buf[12];
    int n = 0;
    unsigned u = v < 0 ? -v : v;
    do buf[n++] = '0' + u % 10; while (u /= 10);
    if (v < 0) out += '-';
    while (n) out += buf[--n];
}

// A full note holds thousands of points; written through QString::arg they took the GUI
// thread long enough to swallow a word.
inline void appendStrokes(QByteArray &out, const Strokes &strokes) {
    out += '[';
    for (int s = 0; s < strokes.size(); ++s) {
        if (s) out += ',';
        out += '[';
        const QPolygon &pts = strokes[s];
        for (int i = 0; i < pts.size(); ++i) {
            out += i ? ",[" : "[";
            appendInt(out, pts[i].x());
            out += ',';
            appendInt(out, pts[i].y());
            out += ']';
        }
        out += ']';
    }
    out += ']';
}

inline Strokes strokesFrom(const QVariant &value) {
    Strokes out;
    foreach (const QVariant &s, value.toList()) {
        QPolygon poly;
        if (s.type() == QVariant::Polygon) poly = qvariant_cast<QPolygon>(s);
        else foreach (const QVariant &p, s.toList()) {
            QVariantList xy = p.toList();
            if (xy.size() >= 2) poly << QPoint(qRound(xy[0].toDouble()), qRound(xy[1].toDouble()));
        }
        if (!poly.isEmpty()) out << poly;
    }
    return out;
}

inline QRect boundsOf(const Strokes &strokes) {
    QRect r;
    foreach (const QPolygon &s, strokes) r |= s.boundingRect();
    return r;
}

inline int pathLength(const QPolygon &pts) {
    int len = 0;
    for (int i = 1; i < pts.size(); ++i) len += qAbs(pts[i].x() - pts[i - 1].x()) + qAbs(pts[i].y() - pts[i - 1].y());
    return len;
}

inline double segmentDistance(const QPoint &p, const QPoint &a, const QPoint &b) {
    double dx = b.x() - a.x(), dy = b.y() - a.y(), len = dx * dx + dy * dy;
    double t = len ? qBound(0.0, ((p.x() - a.x()) * dx + (p.y() - a.y()) * dy) / len, 1.0) : 0;
    double x = a.x() + t * dx - p.x(), y = a.y() + t * dy - p.y();
    return sqrt(x * x + y * y);
}

inline bool strokeHit(const QPolygon &pts, const QPoint &p) {
    if (pts.size() == 1) return segmentDistance(p, pts[0], pts[0]) < ERASE_RADIUS;
    for (int i = 1; i < pts.size(); ++i)
        if (segmentDistance(p, pts[i - 1], pts[i]) < ERASE_RADIUS) return true;
    return false;
}

class ReviewWidget : public QWidget {
    Q_OBJECT
public:
    ReviewWidget(Mirror *mirror, const QString &id)
        : mirror(mirror), figure(0), reviewId(id), round(0), cur(-1), noteH(0), tool("pen"), pane("doc"), pressed(false), noteExtent(0),
          loggedRss(0), drawerOpen(false), drawerScroll(0), drawerHeight(0), jumpDoc(-1), jumpLine(0) {
        setAttribute(Qt::WA_OpaquePaintEvent);
        setFocusPolicy(Qt::StrongFocus);
        connect(mirror, SIGNAL(got(QString, QByteArray, bool)), this, SLOT(got(QString, QByteArray, bool)));
        connect(mirror, SIGNAL(sent(QString, QString)), this, SLOT(sent(QString, QString)));
        saveTimer.setSingleShot(true);
        connect(&saveTimer, SIGNAL(timeout()), this, SLOT(save()));
        stateTimer.setSingleShot(true);
        connect(&stateTimer, SIGNAL(timeout()), this, SLOT(writeState()));
        connect(&pulse, SIGNAL(timeout()), this, SLOT(beat()));
        pulse.start(50);
        sinceBeat.start();
        baker = new Baker(this);
        connect(baker, SIGNAL(baked()), this, SLOT(applyBaked()));
        baker->start();
        mirror->get(reviewId + "/review.json");
        message = QString::fromUtf8("Lade \xe2\x80\xa6");
    }

    // Where to open, from state.json after the app was ended from outside.
    void resumeFrom(const QVariantMap &state) { resume = state; }
    // Saves what is pending, and where the view stands, for an end the app does not choose.
    void flush() {
        saveNow();
        writeState();
    }

signals:
    void closed();

public slots:
    // Screen coordinates, from the app's PenReader.
    void penDown(const QPoint &screen) {
        if (figure) {
            figure->penDown(screen);
            return;
        }
        QPoint p = mapFromGlobal(screen);
        baker->hold(true);
        pressed = true;
        gesture = targetAt(p);
        live.clear();
        live << p;
        startY = p.y();
        startNoteH = noteH;
        startDrawerScroll = drawerScroll;
        if (locked() && (gesture == "doc" || gesture == "note")) gesture = "read";
        if (gesture == "rail") railTo(p.y());
        else if (gesture == "noteRail") {
            noteExtent = noteLength();
            noteRailTo(p.y());
        } else if (gesture == "doc" || gesture == "note") {
            pane = gesture;
            if (tool == "eraser") erase(p);
        }
    }
    void penMoved(const QPoint &screen) {
        if (figure) {
            figure->penMoved(screen);
            return;
        }
        if (!pressed) return;
        QPoint p = mapFromGlobal(screen);
        if (p == live.last()) return;
        QPoint last = live.last();
        live << p;
        if (gesture == "rail") railTo(p.y());
        else if (gesture == "noteRail") noteRailTo(p.y());
        else if (gesture == "grip") dragGrip(p.y());
        else if (gesture == "drawer") drawerScrollTo(startDrawerScroll - (p.y() - startY));
        else if ((gesture == "doc" || gesture == "note") && tool == "eraser") erase(p);
        else if (gesture == "doc" || gesture == "note") dirty |= QRect(last, p).normalized().adjusted(-4, -4, 4, 4);
    }
    void penBurst() {
        if (dirty.isEmpty()) return;
        repaint(dirty);
        dirty = QRect();
    }
    void penUp() {
        if (figure) {
            figure->penUp();
            return;
        }
        if (!pressed) return;
        pressed = false;
        baker->hold(false);
        QPoint p = live.last();
        if (gesture == "grip") layoutChanged();
        else if (gesture == "shade") closeDrawer();
        else if (gesture == "drawer") { if (pathLength(live) < TAP_MAX) drawerTap(live.first()); }
        else if (gesture.startsWith("button:")) { if (buttonAt(p) == gesture) press(gesture.mid(7)); }
        else if (gesture == "read" && pathLength(live) < TAP_MAX && docRect().contains(live.first())) {
            MarkPtr hit = hitMark(toDoc(live.first()));
            if (hit && hit != openMark) openNote(hit);
            else if (!hit && !openFigureAt(toDoc(live.first()))) status(lockedText());
        }
        else if ((gesture == "doc" || gesture == "note") && tool == "pen") endStroke();
        QRect trail = live.boundingRect().adjusted(-4, -4, 4, 4);
        live.clear();
        gesture.clear();
        update(trail);
    }

    // The tablet's buttons, named as in main.cpp.
    bool button(const QString &name) {
        if (figure && figure->button(name)) return true;
        if (name == "back") {
            if (drawerOpen) closeDrawer();
            else if (openMark) closeNote();
            else leave();
        } else if (name == "home") saveThen("quitApp");
        else if (name == "left") drawerOpen ? drawerScrollTo(drawerScroll - drawerRect().height() * 3 / 4) : page(-1);
        else if (name == "right") drawerOpen ? drawerScrollTo(drawerScroll + drawerRect().height() * 3 / 4) : page(1);
        else if (name == "g1") setTool("pen");
        else if (name == "g2") setTool("eraser");
        else if (name == "g3") undo();
        else if (name == "g4") toggleDrawer();
        else return false;
        return true;
    }

protected:
    void keyPressEvent(QKeyEvent *event) {
        QString name = buttonName(event->key());
        if (!name.isEmpty()) button(name);
        else if (event->key() == Qt::Key_Escape) leave();
    }
    void mousePressEvent(QMouseEvent *) {}
    void mouseMoveEvent(QMouseEvent *) {}
    void mouseReleaseEvent(QMouseEvent *) {}

    void paintEvent(QPaintEvent *event) {
        QTime clock;
        clock.start();
        paint(event->rect());
        if (clock.elapsed() > 40)
            fprintf(stderr, "native: paint %dx%d took %d ms\n", event->rect().width(), event->rect().height(), clock.elapsed());
    }
    void paint(const QRect &area) {
        QPainter p(this);
        QRect clip = area;
        p.setClipRect(clip);
        if (clip.intersects(docRect())) paintDoc(p);
        if (clip.intersects(railRect())) paintRail(p);
        if (openMark && clip.intersects(noteBarRect())) paintNoteBar(p);
        if (openMark && clip.intersects(noteRect())) paintNote(p);
        if (openMark && clip.intersects(noteRailRect())) paintNoteRail(p);
        if (clip.intersects(toolBarRect())) paintToolBar(p);
        if (drawerOpen) paintDrawer(p, clip);
        if (live.size() > 1 && tool == "pen" && (gesture == "doc" || gesture == "note")) {
            p.setClipRect(clip & (gesture == "doc" ? docRect() : noteRect()));
            inkPen(p, gesture == "note" ? NOTE_INK_WIDTH : INK_WIDTH);
            drawStrokes(p, Strokes() << live, clip);
        }
    }
    void resizeEvent(QResizeEvent *) { layoutChanged(); }

private slots:
    void got(const QString &key, const QByteArray &data, bool ok) {
        QStringList parts = key.split('/');
        if (parts[0] != reviewId) return;
        if (parts.size() == 2) {
            if (ok) loadReview(parseJson(data).toMap());
            else {
                message = QString::fromUtf8("Nicht auf dem Tablet \xe2\x80\x93 daf\xc3\xbcr muss der Hub erreichbar sein");
                update();
            }
            return;
        }
        int index = parts[2].toInt();
        if (parts[1].toInt() != round || index >= docs.size()) return;
        if (!ok) status(QString::fromUtf8("Seiten fehlen \xe2\x80\x93 nicht auf dem Tablet"));
        if (parts[3] == "index.json") {
            if (ok) loadIndex(index, parseJson(data).toMap());
        } else if (ok) loadStrip(index, parts[3].section('.', 0, 0).toInt(), data);
        else requestStrips(index);
    }
    void sent(const QString &id, const QString &action) {
        if (id == reviewId && action == "request") status("Frage an den Agenten gesendet");
    }
    // Logs whenever the GUI thread went too long without getting round to its timers.
    void beat() {
        int ms = sinceBeat.restart();
        if (ms > 200) fprintf(stderr, "native: GUI stalled %d ms\n", ms);
        if (!sinceMemory.isValid() || sinceMemory.elapsed() > 5000) logMemory();
    }
    void save() { mirror->post(reviewId, "draft", marksBody()); }
    // What the view holds, whenever the resident size moved by a megabyte or more.
    void logMemory() {
        sinceMemory.start();
        QList<QByteArray> statm = readFile("/proc/self/statm").split(' ');
        int rss = statm.size() > 1 ? statm[1].toInt() * 4 / 1024 : 0;
        if (qAbs(rss - loggedRss) < 1) return;
        loggedRss = rss;
        int strips = 0, pngKb = 0, shown = 0, images = 0, imageKb = 0;
        foreach (const Doc &d, docs) {
            foreach (const QPixmap &px, d.strips) strips += !px.isNull();
            foreach (const QByteArray &png, d.pngs) pngKb += png.size() / 1024;
        }
        foreach (const Tile &t, tiles) {
            shown += !t.shown.isNull();
            if (!t.image.isNull()) ++images, imageKb += t.image.numBytes() / 1024;
        }
        fprintf(stderr, "native: rss %d MB, %d strips decoded, png %d KB, %d tiles shown, %d images %d KB\n", rss, strips,
                pngKb, shown, images, imageKb);
    }
    void applyBaked() {
        foreach (const Baked &b, baker->take()) {
            if (b.ms > 150) fprintf(stderr, "native: baked %s in %d ms\n", qPrintable(b.key), b.ms);
            if (!tiles.contains(b.key)) continue;
            Tile &t = tiles[b.key];
            t.busy = false;
            // Scrolled away while it baked: dropped like the rest there.
            if (!near(t)) {
                reset(t);
                continue;
            }
            if (b.gen == t.gen) {
                t.image = b.image;
                t.shown = QPixmap::fromImage(b.gray);
                t.inFlight.clear();
                t.fresh = true;
                QRect r = onScreen(t);
                if (!r.isEmpty()) update(r);
            }
            if (scrolling() && (!t.fresh || !t.unbaked.isEmpty())) bakeTile(t);
        }
    }
    void quitApp() { qApp->quit(); }
    void closeFigure() {
        figure->deleteLater();
        figure = 0;
        update();
    }
    void writeState() {
        Doc *d = doc();
        if (!d) return;
        QByteArray json = "{\"review\":" + jsonString(reviewId).toUtf8() + ",\"doc\":";
        appendInt(json, cur);
        json += ",\"scroll\":";
        appendInt(json, d->scroll);
        json += ",\"mark\":" + jsonString(openMark ? openMark->id : QString()).toUtf8() + ",\"noteScroll\":";
        appendInt(json, openMark ? openMark->noteScroll : 0);
        json += ",\"noteH\":";
        appendInt(json, noteH);
        writeFile(mirror->statePath(), json + "}");
    }
    void closeView() { emit closed(); }

private:
    // ── Layout ──────────────────────────────────────────────────────────
    int body() const { return height() - TOOLBAR_H; }
    int noteHeight() const { return openMark ? noteH : 0; }
    int docH() const { return openMark ? body() - NOTEBAR_H - noteH : body(); }
    int docW() const { return width() - RAIL_W; }
    QRect docRect() const { return QRect(0, 0, docW(), docH()); }
    QRect railRect() const { return QRect(docW(), 0, RAIL_W, docH()); }
    QRect noteBarRect() const { return openMark ? QRect(0, docH(), width(), NOTEBAR_H) : QRect(); }
    QRect noteRect() const { return openMark ? QRect(0, docH() + NOTEBAR_H, width() - RAIL_W, noteH) : QRect(); }
    QRect noteRailRect() const { return openMark ? QRect(width() - RAIL_W, docH() + NOTEBAR_H, RAIL_W, noteH) : QRect(); }
    QRect toolBarRect() const { return QRect(0, height() - TOOLBAR_H, width(), TOOLBAR_H); }

    void layoutChanged() {
        if (doc()) stateTimer.start(STATE_DELAY);
        if (!noteH) noteH = qRound(body() * 0.42);
        noteH = qBound(MIN_PANE, noteH, body() - NOTEBAR_H - MIN_PANE);
        clampScroll();
        update();
    }

    // ── Loading ─────────────────────────────────────────────────────────
    QString pageKey(int index, const QString &file) const { return QString("%1/%2/%3/%4").arg(reviewId).arg(round).arg(index).arg(file); }

    void loadReview(const QVariantMap &review) {
        title = review.value("title").toString();
        round = review.value("round").toInt();
        kind = review.value("kind").toString();
        reviewStatus = review.value("status").toString();
        foreach (const QVariant &v, review.value("docs").toList()) {
            QVariantMap m = v.toMap();
            Doc d;
            d.id = m.value("id").toString();
            d.kind = m.value("kind").toString();
            d.title = m.value("title").toString();
            d.path = m.value("path").toString();
            d.status = m.value("status").toString();
            d.context = m.value("context").toBool();
            d.plus = m.value("plus").toInt();
            d.minus = m.value("minus").toInt();
            foreach (const QVariant &line, m.value("rowNew").toList()) d.rowNew << line.toInt();
            docs << d;
        }
        QVariant saved = mirror->marks(reviewId, round);
        foreach (const QVariant &v, (saved.isValid() ? saved : review.value("marks")).toList()) {
            QVariantMap m = v.toMap();
            MarkPtr mark(new Mark);
            mark->id = m.value("id").toString();
            mark->doc = m.value("doc").toString();
            mark->ink = strokesFrom(m.value("ink"));
            mark->note = strokesFrom(m.value("note"));
            mark->noteScroll = m.value("noteScroll").toInt();
            mark->stamp = m.value("stamp").toString();
            mark->asked = m.value("asked").toBool();
            QStringList rows;
            foreach (const QVariant &r, m.value("rows").toList()) rows << QString::number(r.toInt());
            mark->rowsKnown = m.contains("rows");
            mark->rowsJson = "[" + rows.join(",") + "]";
            if (!mark->ink.isEmpty()) marks << mark;
        }
        message.clear();
        fprintf(stderr, "native: %s, %d docs, %d marks\n", qPrintable(title), docs.size(), marks.size());
        int doc = resume.isEmpty() ? -1 : resume.value("doc").toInt();
        showDoc(doc >= 0 && doc < docs.size() ? doc : firstDocument());
        if (doc != cur) resume.clear();
    }

    // Back where the app was when the tablet went to sleep: the scroll, and the open note.
    void resumeView() {
        docs[cur].scroll = resume.value("scroll").toInt();
        QString markId = resume.value("mark").toString();
        foreach (const MarkPtr &m, marks)
            if (m->id == markId && m->doc == docs[cur].id) {
                openMark = m;
                noteH = resume.value("noteH").toInt();
                m->noteScroll = resume.value("noteScroll").toInt();
            }
        resume.clear();
        fprintf(stderr, "native: resumed at %d\n", docs[cur].scroll);
    }

    // A code review opens on the first changed file as the drawer's tree lists it, unless the
    // agent's replies or its overview lead the round (the only documents without a path).
    int firstDocument() const {
        if (kind != "code" || docs.isEmpty() || docs[0].path.isEmpty()) return 0;
        QList<int> order = diffOrder(QString());
        return order.isEmpty() ? 0 : order.first();
    }

    void showDoc(int index) {
        if (index < 0 || index >= docs.size()) return;
        cur = index;
        openMark.clear();
        pane = "doc";
        if (!docs[cur].loaded) mirror->get(pageKey(cur, "index.json"));
        trimMemory();
        layoutChanged();
    }

    void loadIndex(int index, const QVariantMap &page) {
        Doc &d = docs[index];
        d.height = page.value("height").toInt();
        d.strip = qMax(1, page.value("strip").toInt());
        int count = page.value("count").toInt();
        d.strips.clear();
        d.pngs.clear();
        d.requested.clear();
        for (int n = 0; n < count; ++n) d.strips << QPixmap(), d.pngs << QByteArray(), d.requested << false;
        d.rowTop.clear();
        d.rowBottom.clear();
        d.rowIndex.clear();
        foreach (const QVariant &row, page.value("rows").toList()) {
            QVariantList r = row.toList();
            if (r.size() < 3) continue;
            d.rowTop << r[0].toInt();
            d.rowBottom << r[1].toInt();
            d.rowIndex << r[2].toInt();
        }
        d.figureBoxes.clear();
        d.figureNames.clear();
        foreach (const QVariant &v, page.value("figures").toList()) {
            QVariantMap f = v.toMap();
            QVariantList box = f.value("box").toList();
            if (box.size() < 4) continue;
            d.figureBoxes << QRect(QPoint(box[2].toInt(), box[0].toInt()), QPoint(box[3].toInt(), box[1].toInt()));
            d.figureNames << f.value("name").toString();
        }
        d.loaded = true;
        if (index == cur && !resume.isEmpty()) resumeView();
        if (index == jumpDoc) {
            jumpDoc = -1;
            jumpTo(jumpLine);
        }
        requestStrips(index);
        if (index == cur) layoutChanged();
    }

    // The strips in view first, then the rest one after another as each arrives.
    void requestStrips(int index) {
        Doc &d = docs[index];
        int first = d.scroll / d.strip, last = (d.scroll + docH()) / d.strip;
        int next = -1;
        for (int n = first; n <= last && n < d.strips.size(); ++n)
            if (!d.requested[n]) { next = n; break; }
        if (next < 0)
            for (int n = 0; n < d.strips.size(); ++n)
                if (!d.requested[n]) { next = n; break; }
        if (next < 0) return;
        d.requested[next] = true;
        mirror->get(pageKey(index, QString("%1.png").arg(next)));
    }

    void loadStrip(int index, int n, const QByteArray &data) {
        Doc &d = docs[index];
        if (n < d.strips.size()) {
            d.strips[n] = QPixmap();
            d.pngs[n] = data;
            tiles.remove(QString("d%1:%2").arg(index).arg(n));
        }
        if (index == cur) {
            QRect r(0, n * d.strip - d.scroll, docW(), d.strip);
            update(r & docRect());
        }
        requestStrips(index);
    }

    // ── Painting ────────────────────────────────────────────────────────
    Doc *doc() { return cur >= 0 && cur < docs.size() ? &docs[cur] : 0; }
    int number(const MarkPtr &mark) const { return marks.indexOf(mark) + 1; }

    void paintDoc(QPainter &p) {
        p.save();
        p.setClipRect(docRect() & p.clipRegion().boundingRect());
        p.fillRect(docRect(), Qt::white);
        Doc *d = doc();
        if (!d) {
            p.drawText(docRect(), Qt::AlignCenter, message);
            p.restore();
            return;
        }
        QRect clip = p.clipRegion().boundingRect();
        for (int n = 0; n < d->strips.size(); ++n) {
            int top = n * d->strip - d->scroll;
            if (d->pngs[n].isEmpty() || top > clip.bottom() || top + d->strip < clip.top()) continue;
            paintTile(p, docTile(cur, n), top, clip);
        }
        p.restore();
    }

    // ── Tiles ───────────────────────────────────────────────────────────
    Tile &docTile(int di, int n) {
        QString key = QString("d%1:%2").arg(di).arg(n);
        if (!tiles.contains(key)) {
            Tile t;
            t.key = key;
            t.doc = di;
            t.index = n;
            t.band = QRect(0, n * docs[di].strip, docW(), qMin(docs[di].strip, docs[di].height - n * docs[di].strip));
            tiles.insert(key, t);
        }
        return tiles[key];
    }
    Tile &noteTile(const MarkPtr &mark, int n) {
        QString key = QString("n%1:%2").arg(mark->id).arg(n);
        if (!tiles.contains(key)) {
            Tile t;
            t.key = key;
            t.note = true;
            t.mark = mark;
            t.index = n;
            t.band = QRect(0, n * NOTE_TILE, noteRect().width(), NOTE_TILE);
            tiles.insert(key, t);
        }
        return tiles[key];
    }

    static QPoint badgeAt(const MarkPtr &mark) {
        QRect b = boundsOf(mark->ink);
        return QPoint(qMax(0, b.left() - 30), b.top() - 30);
    }
    // Where a mark's ink and badge sit on its document.
    static QRect markArea(const MarkPtr &mark) {
        return (boundsOf(mark->ink) | QRect(badgeAt(mark), QSize(60, 28))).adjusted(-4, -4, 4, 4);
    }

    // A mark's number and stamp, drawn here since the Baker's thread cannot draw text.
    QImage badgeArt(int n, const QString &stamp) {
        QString key = QString("%1:%2").arg(n).arg(stamp);
        if (arts.contains(key)) return arts[key];
        QImage art(60, 28, QImage::Format_ARGB32_Premultiplied);
        art.fill(0);
        QPainter p(&art);
        p.fillRect(0, 0, 28, 28, Qt::black);
        p.setPen(Qt::white);
        QFont f = font();
        f.setPixelSize(19);
        f.setBold(true);
        p.setFont(f);
        p.drawText(QRect(0, 0, 28, 28), Qt::AlignCenter, QString::number(n));
        paintStamp(p, stamp, 32, 2);
        p.end();
        return arts[key] = art;
    }

    // The ink over a tile's band, and on a document the badges there.
    void inkOf(const Tile &t, Strokes &strokes, QList<QPoint> &at, QList<QImage> &art) {
        QRect band = t.band.adjusted(0, -4, 0, 4);
        if (t.note) {
            foreach (const QPolygon &s, t.mark->note)
                if (s.boundingRect().intersects(band)) strokes << s;
            return;
        }
        for (int m = 0; m < marks.size(); ++m) {
            if (marks[m]->doc != docs[t.doc].id) continue;
            foreach (const QPolygon &s, marks[m]->ink)
                if (s.boundingRect().intersects(band)) strokes << s;
            if (markArea(marks[m]).intersects(band)) {
                at << badgeAt(marks[m]);
                art << badgeArt(m + 1, marks[m]->stamp);
            }
        }
    }

    // Tiles are baked only around scrolling. While the view stands still, strokes over a tile
    // cost little to draw, since only the few pixels under the pen are painted again; once it
    // moves, whole tiles come into view and their ink has to be in the image.
    bool scrolling() const { return lastScroll.isValid() && lastScroll.elapsed() < 3000; }
    // A strip is decoded when it comes into view.
    const QPixmap &stripAt(int di, int n) {
        Doc &d = docs[di];
        if (d.strips[n].isNull() && !d.pngs[n].isEmpty()) d.strips[n].loadFromData(d.pngs[n], "PNG");
        return d.strips[n];
    }
    // Lets go of what is away from the view: decoded strips, and the images of tiles, which
    // are composed again should they come back.
    void trimMemory() {
        for (int di = 0; di < docs.size(); ++di) {
            Doc &d = docs[di];
            int first = d.scroll / d.strip - KEEP_STRIPS, last = (d.scroll + docH()) / d.strip + KEEP_STRIPS;
            for (int n = 0; n < d.strips.size(); ++n)
                if (!d.strips[n].isNull() && (di != cur || n < first || n > last)) d.strips[n] = QPixmap();
        }
        for (QMap<QString, Tile>::iterator it = tiles.begin(); it != tiles.end(); ++it) {
            Tile &t = it.value();
            if ((!t.shown.isNull() || !t.image.isNull()) && !near(t)) reset(t);
        }
    }
    bool near(const Tile &t) const {
        if (t.note) {
            if (t.mark != openMark) return false;
            return t.index >= openMark->noteScroll / NOTE_TILE - KEEP_STRIPS &&
                   t.index <= (openMark->noteScroll + noteH) / NOTE_TILE + KEEP_STRIPS;
        }
        const Doc &d = docs[t.doc];
        return t.doc == cur && t.index >= d.scroll / d.strip - KEEP_STRIPS && t.index <= (d.scroll + docH()) / d.strip + KEEP_STRIPS;
    }
    void scrolled() {
        lastScroll.start();
        stateTimer.start(STATE_DELAY);
        trimMemory();
        // Only near the view: every tile further away was just let go of.
        for (QMap<QString, Tile>::iterator it = tiles.begin(); it != tiles.end(); ++it) {
            Tile &t = it.value();
            if (near(t) && (!t.fresh || !t.unbaked.isEmpty())) bakeTile(t);
        }
    }

    // Sends a tile to the Baker: its new strokes onto its last image, or all of it afresh.
    void bakeTile(Tile &t) {
        if (t.busy) return;
        BakeJob job;
        job.key = t.key;
        job.gen = t.gen;
        job.band = t.band;
        job.ruleEvery = t.note ? RULE : 0;
        if (t.fresh && !t.image.isNull()) {
            if (t.unbaked.isEmpty()) return;
            job.base = t.image;
            job.strokes = t.unbaked;
        } else {
            inkOf(t, job.strokes, job.badgeAt, job.badges);
            if (job.strokes.isEmpty() && job.badges.isEmpty()) {
                t.fresh = true;
                t.image = QImage();
                t.shown = t.note ? QPixmap() : stripAt(t.doc, t.index);
                t.inFlight.clear();
                t.unbaked.clear();
                return;
            }
            if (!t.note) job.png = docs[t.doc].pngs[t.index];
        }
        t.inFlight += t.unbaked;
        t.unbaked.clear();
        t.busy = true;
        baker->add(job);
    }

    void paintTile(QPainter &p, Tile &t, int top, const QRect &clip) {
        if (scrolling() && (!t.fresh || !t.unbaked.isEmpty())) bakeTile(t);
        QRect area = clip.translated(0, t.band.top() - top);
        p.save();
        if (!t.shown.isNull()) {
            p.drawPixmap(0, top, t.shown);
            p.translate(0, top - t.band.top());
            inkPen(p, t.note ? NOTE_INK_WIDTH : INK_WIDTH);
            drawStrokes(p, t.inFlight, area);
            drawStrokes(p, t.unbaked, area);
        } else {
            if (t.note) {
                p.fillRect(QRect(0, top, t.band.width(), t.band.height()), Qt::white);
                for (int y = (RULE - t.band.top() % RULE) % RULE; y < t.band.height(); y += RULE)
                    p.fillRect(0, top + y, t.band.width(), 1, QColor(0xbb, 0xbb, 0xbb));
            } else p.drawPixmap(0, top, stripAt(t.doc, t.index));
            Strokes strokes;
            QList<QPoint> at;
            QList<QImage> art;
            inkOf(t, strokes, at, art);
            p.translate(0, top - t.band.top());
            inkPen(p, t.note ? NOTE_INK_WIDTH : INK_WIDTH);
            drawStrokes(p, strokes, area);
            for (int i = 0; i < art.size(); ++i) p.drawImage(at[i], art[i]);
        }
        p.restore();
    }

    QRect onScreen(const Tile &t) {
        if (t.note) {
            if (t.mark != openMark) return QRect();
            QRect r = noteRect();
            return QRect(0, r.top() + t.band.top() - openMark->noteScroll, t.band.width(), t.band.height()) & r;
        }
        if (t.doc != cur) return QRect();
        return QRect(0, t.band.top() - docs[cur].scroll, t.band.width(), t.band.height()) & docRect();
    }

    static void reset(Tile &t) {
        t.fresh = false;
        t.gen++;
        t.shown = QPixmap();
        t.image = QImage();
        t.inFlight.clear();
        t.unbaked.clear();
    }

    // Tiles of a document (all documents for an empty id: numbers shift in all of them when
    // a mark goes) over area, or entirely for a null area, are composed afresh.
    void invalidateDoc(const QRect &area, const QString &docId = QString()) {
        for (QMap<QString, Tile>::iterator it = tiles.begin(); it != tiles.end(); ++it) {
            Tile &t = it.value();
            if (t.note || (!docId.isEmpty() && docs[t.doc].id != docId)) continue;
            if (area.isNull() || t.band.intersects(area)) reset(t);
        }
        update(docRect());
        update(railRect());
    }
    void invalidateNotes(const MarkPtr &mark = MarkPtr(), const QRect &area = QRect()) {
        for (QMap<QString, Tile>::iterator it = tiles.begin(); it != tiles.end(); ++it) {
            Tile &t = it.value();
            if (!t.note || (mark && t.mark != mark)) continue;
            if (area.isNull() || t.band.intersects(area)) reset(t);
        }
        update(noteRect());
    }

    // A stroke added to a note, or to a document without moving a badge, is drawn onto the
    // tiles it crosses rather than composing them afresh.
    void addStroke(const QPolygon &stroke, const MarkPtr &noteOf) {
        QRect area = stroke.boundingRect().adjusted(-4, -4, 4, 4);
        for (QMap<QString, Tile>::iterator it = tiles.begin(); it != tiles.end(); ++it) {
            Tile &t = it.value();
            if (noteOf ? (!t.note || t.mark != noteOf) : (t.note || t.doc != cur)) continue;
            if (!t.band.intersects(area) || !t.fresh) continue;
            t.unbaked << stroke;
        }
    }

    void paintStamp(QPainter &p, const QString &stamp, int x, int y) {
        p.setPen(QPen(Qt::black, 3, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
        if (stamp == "ok") {
            QPolygon tick;
            tick << QPoint(x, y + 12) << QPoint(x + 7, y + 20) << QPoint(x + 20, y + 4);
            p.drawPolyline(tick);
        } else if (stamp == "no") {
            p.drawLine(x + 3, y + 5, x + 18, y + 20);
            p.drawLine(x + 18, y + 5, x + 3, y + 20);
        } else if (stamp == "ask") {
            QFont f = font();
            f.setPixelSize(22);
            f.setBold(true);
            p.setFont(f);
            p.drawText(x + 5, y + 21, "?");
        }
    }

    // The whole document mapped onto the rail: the view as a frame, marks as numbered tabs.
    void paintRail(QPainter &p) {
        QRect r = railRect();
        p.fillRect(r, QColor(0xf2, 0xf2, 0xf2));
        p.fillRect(r.left(), 0, 2, r.height(), Qt::black);
        Doc *d = doc();
        if (!d || !d->height) return;
        double scale = double(r.height()) / qMax(d->height, 1);
        int frameTop = int(d->scroll * scale);
        p.fillRect(r.left() + 3, frameTop, RAIL_W - 6, qMax(8, int(docH() * scale)), QColor(0xcc, 0xcc, 0xcc));
        QFont f = font();
        f.setPixelSize(15);
        f.setBold(true);
        p.setFont(f);
        for (int m = 0; m < marks.size(); ++m) {
            if (marks[m]->doc != d->id) continue;
            int y = int(boundsOf(marks[m]->ink).top() * scale);
            p.fillRect(r.left() + 4, y, RAIL_W - 8, 20, Qt::black);
            p.setPen(Qt::white);
            p.drawText(QRect(r.left() + 4, y, RAIL_W - 8, 20), Qt::AlignCenter, QString::number(m + 1));
        }
    }

    struct Button {
        QString name, label;
        QRect rect;
        bool on;
    };

    QList<Button> noteButtons() const {
        QList<Button> out;
        QRect bar = noteBarRect();
        const char *names[] = { "ok", "no", "ask", "question", "close" };
        const char *labels[] = { "OK", "Nein", "?", "Agent fragen", "Schlie\xc3\x9f" "en" };
        int widths[] = { 64, 72, 50, 140, 110 };
        int x = 190;
        for (int i = 0; i < 5; ++i) {
            Button b;
            b.name = names[i];
            b.label = QString::fromUtf8(labels[i]);
            b.rect = QRect(x, bar.top() + 6, widths[i], NOTEBAR_H - 12);
            b.on = i < 3 && openMark && openMark->stamp == names[i];
            out << b;
            x += widths[i] + 8;
        }
        return out;
    }

    QList<Button> toolButtons() const {
        QList<Button> out;
        QRect bar = toolBarRect();
        const char *names[] = { "files", "pen", "eraser", "undo", "prev", "next" };
        const char *labels[] = { "Dateien", "Stift", "Radierer", "\xe2\x86\xb6", "\xe2\x97\x80", "\xe2\x96\xb6" };
        int widths[] = { 96, 76, 104, 50, 50, 50 };
        int x = 6;
        for (int i = 0; i < 6; ++i) {
            Button b;
            b.name = names[i];
            b.label = QString::fromUtf8(labels[i]);
            b.rect = QRect(x, bar.top() + 6, widths[i], TOOLBAR_H - 12);
            b.on = QString(names[i]) == tool || (i == 0 && drawerOpen);
            out << b;
            x += widths[i] + 6;
        }
        return out;
    }

    void paintButtons(QPainter &p, const QList<Button> &buttons) {
        foreach (const Button &b, buttons) paintButton(p, b.rect, b.label, b.on);
    }

    void paintNoteBar(QPainter &p) {
        QRect bar = noteBarRect();
        p.fillRect(bar, QColor(0xe6, 0xe6, 0xe6));
        p.fillRect(bar.left(), bar.top(), bar.width(), 2, Qt::black);
        QFont f = font();
        f.setPixelSize(18);
        f.setBold(true);
        p.setFont(f);
        p.setPen(Qt::black);
        QString label = QString::fromUtf8("\xe2\x98\xb0  Notiz %1").arg(number(openMark));
        if (openMark->asked) label += QString::fromUtf8(" \xc2\xb7 gefragt");
        p.drawText(QRect(12, bar.top(), 176, NOTEBAR_H), Qt::AlignVCenter | Qt::AlignLeft, label);
        paintButtons(p, noteButtons());
    }

    void paintNote(QPainter &p) {
        QRect r = noteRect();
        p.save();
        p.setClipRect(r & p.clipRegion().boundingRect());
        int scroll = openMark->noteScroll;
        QRect clip = p.clipRegion().boundingRect();
        for (int t = scroll / NOTE_TILE; t * NOTE_TILE - scroll < r.height(); ++t) {
            int top = r.top() + t * NOTE_TILE - scroll;
            if (top > clip.bottom() || top + NOTE_TILE < clip.top()) continue;
            paintTile(p, noteTile(openMark, t), top, clip);
        }
        p.restore();
    }

    // The note has no end, so its rail spans the ink so far and a screen beyond it.
    int noteLength() const {
        int bottom = 0;
        foreach (const QPolygon &s, openMark->note) bottom = qMax(bottom, s.boundingRect().bottom());
        return qMax(bottom, openMark->noteScroll) + 2 * noteH;
    }

    void paintNoteRail(QPainter &p) {
        QRect r = noteRailRect();
        p.fillRect(r, QColor(0xf2, 0xf2, 0xf2));
        p.fillRect(r.left(), r.top(), 2, r.height(), Qt::black);
        int length = pressed && gesture == "noteRail" ? noteExtent : noteLength();
        double scale = double(r.height()) / length;
        p.fillRect(r.left() + 3, r.top() + int(openMark->noteScroll * scale), RAIL_W - 6, qMax(8, int(noteH * scale)),
                   QColor(0xcc, 0xcc, 0xcc));
    }

    void paintToolBar(QPainter &p) {
        QRect bar = toolBarRect();
        p.fillRect(bar, QColor(0xe6, 0xe6, 0xe6));
        p.fillRect(bar.left(), bar.top(), bar.width(), 2, Qt::black);
        QList<Button> buttons = toolButtons();
        paintButtons(p, buttons);
        QFont f = font();
        f.setPixelSize(16);
        p.setFont(f);
        p.setPen(Qt::black);
        int left = buttons.last().rect.right() + 10;
        QString text = !message.isEmpty() ? message : docStatus();
        p.drawText(QRect(left, bar.top(), bar.width() - left - 6, TOOLBAR_H), Qt::AlignVCenter | Qt::AlignLeft,
                   p.fontMetrics().elidedText(text, Qt::ElideRight, bar.width() - left - 6));
    }

    QString docStatus() {
        if (locked()) return lockedText();
        Doc *d = doc();
        return d ? QString::fromUtf8("%1 \xc2\xb7 %2 Mark.").arg(d->title).arg(marks.size()) : title;
    }

    void status(const QString &text) {
        message = text;
        update(toolBarRect());
        QTimer::singleShot(3000, this, SLOT(clearStatus()));
    }

private slots:
    void clearStatus() {
        message.clear();
        update(toolBarRect());
    }
    void disarm() {
        if (armed.isEmpty() || armedAt.elapsed() < CONFIRM_MS) return;
        armed.clear();
        clearStatus();
        if (drawerOpen) {
            buildDrawer();
            update(drawerRect());
        }
    }

private:
    // ── Scrolling ───────────────────────────────────────────────────────
    int maxScroll() {
        Doc *d = doc();
        return d ? qMax(0, d->height - docH()) : 0;
    }
    void clampScroll() {
        Doc *d = doc();
        if (d) d->scroll = qBound(0, d->scroll, maxScroll());
    }
    void scrollTo(int y) {
        Doc *d = doc();
        if (!d) return;
        int target = qBound(0, y, maxScroll());
        int dy = target - d->scroll;
        if (!dy) return;
        d->scroll = target;
        scrolled();
        if (qAbs(dy) < docH()) scroll(0, -dy, docRect());
        else update(docRect());
        update(railRect());
        requestStrips(cur);
    }
    void page(int dir) {
        if (pane == "note" && openMark) {
            noteScrollTo(openMark->noteScroll + dir * noteH * 3 / 4);
        } else scrollTo(doc() ? doc()->scroll + dir * docH() * 3 / 4 : 0);
    }
    int railScroll(int y) {
        Doc *d = doc();
        if (!d) return 0;
        return int(double(y) / docH() * d->height) - docH() / 2;
    }
    void railTo(int y) { scrollTo(railScroll(y)); }
    void noteRailTo(int y) {
        int top = noteRailRect().top();
        noteScrollTo(int(double(y - top) / noteH * noteExtent) - noteH / 2);
    }
    void noteScrollTo(int y) {
        int target = qMax(0, y), dy = target - openMark->noteScroll;
        if (!dy) return;
        openMark->noteScroll = target;
        scrolled();
        if (qAbs(dy) < noteH) scroll(0, -dy, noteRect());
        else update(noteRect());
        update(noteRailRect());
    }
    void dragGrip(int y) {
        noteH = qBound(MIN_PANE, startNoteH - (y - startY), body() - NOTEBAR_H - MIN_PANE);
    }

    // ── Gestures ────────────────────────────────────────────────────────
    QString targetAt(const QPoint &p) {
        if (drawerOpen) {
            if (drawerRect().contains(p)) return "drawer";
            QString b = toolBarRect().contains(p) ? buttonAt(p) : QString();
            return b.isEmpty() ? "shade" : b;
        }
        QString b = buttonAt(p);
        if (!b.isEmpty()) return b;
        if (railRect().contains(p)) return "rail";
        if (docRect().contains(p)) return doc() ? "doc" : "";
        if (openMark && noteBarRect().contains(p)) return "grip";
        if (openMark && noteRect().contains(p)) return "note";
        if (openMark && noteRailRect().contains(p)) return "noteRail";
        return "";
    }
    QString buttonAt(const QPoint &p) {
        QList<Button> all = toolButtons();
        if (openMark) all += noteButtons();
        foreach (const Button &b, all)
            if (b.rect.contains(p)) return "button:" + b.name;
        return "";
    }

    void press(const QString &name) {
        if (locked() && (name == "ok" || name == "no" || name == "ask" || name == "question" || name == "undo" || name == "send")) {
            status(lockedText());
            return;
        }
        if (name == "files") toggleDrawer();
        else if (name == "pen" || name == "eraser") setTool(name);
        else if (name == "undo") undo();
        else if (name == "prev") step(-1);
        else if (name == "next") step(1);
        else if (name == "send") submit();
        else if (name == "close") closeNote();
        else if (name == "question") ask();
        else if (openMark && (name == "ok" || name == "no" || name == "ask")) {
            openMark->stamp = openMark->stamp == name ? QString() : name;
            invalidateDoc(markArea(openMark), openMark->doc);
            update(noteBarRect());
            scheduleSave();
        }
    }

    void setTool(const QString &t) {
        tool = t;
        update(toolBarRect());
    }

    QPoint toDoc(const QPoint &p) { return QPoint(p.x(), p.y() + (doc() ? doc()->scroll : 0)); }
    QPoint toNote(const QPoint &p) { return QPoint(p.x(), p.y() - noteRect().top() + openMark->noteScroll); }

    void endStroke() {
        if (gesture == "note" && openMark) {
            QPolygon stroke;
            foreach (const QPoint &p, live) stroke << toNote(p);
            openMark->note << stroke;
            Undo u = { Undo::AddedNote, openMark, stroke, 0, 0 };
            undoStack << u;
            addStroke(stroke, openMark);
            scheduleSave();
            return;
        }
        QPolygon stroke;
        foreach (const QPoint &p, live) stroke << toDoc(p);
        if (pathLength(stroke) < TAP_MAX) {
            MarkPtr hit = hitMark(stroke[0]);
            if (hit && hit != openMark) openNote(hit);
            else if (!hit) openFigureAt(stroke[0]);
            return;
        }
        // A stroke well away from the open mark means something else.
        if (openMark && openMark->doc == doc()->id &&
            boundsOf(openMark->ink).adjusted(-NEAR, -NEAR, NEAR, NEAR).intersects(stroke.boundingRect())) {
            QRect before = markArea(openMark);
            QPoint badge = badgeAt(openMark);
            openMark->ink << stroke;
            openMark->rowsKnown = false;
            Undo u = { Undo::AddedInk, openMark, stroke, 0, 0 };
            undoStack << u;
            if (badgeAt(openMark) == badge) addStroke(stroke, MarkPtr());
            else invalidateDoc(before | markArea(openMark), openMark->doc);
            scheduleSave();
            return;
        }
        MarkPtr created(new Mark);
        created->id = QString::number(QDateTime::currentDateTime().toTime_t(), 36) + QString::number(qrand() % 1000000, 36);
        created->doc = doc()->id;
        created->ink << stroke;
        marks << created;
        Undo u = { Undo::CreatedMark, created, stroke, 0, 0 };
        undoStack << u;
        invalidateDoc(markArea(created), created->doc);
        openNote(created);
        scheduleSave();
    }

    // A tap on a figure opens it in the zoom view, centred where it was tapped.
    bool openFigureAt(const QPoint &p) {
        Doc *d = doc();
        for (int i = 0; d && i < d->figureBoxes.size(); ++i) {
            QRect box = d->figureBoxes[i];
            if (!box.contains(p)) continue;
            QPointF at(double(p.x() - box.left()) / box.width(), double(p.y() - box.top()) / box.height());
            figure = new FigureView(mirror, reviewId + "/fig/" + d->figureNames[i], at, this);
            connect(figure, SIGNAL(closed()), this, SLOT(closeFigure()));
            figure->setGeometry(rect());
            figure->show();
            return true;
        }
        return false;
    }

    MarkPtr hitMark(const QPoint &p) {
        for (int m = marks.size() - 1; m >= 0; --m) {
            if (marks[m]->doc != doc()->id) continue;
            if (boundsOf(marks[m]->ink).adjusted(-40, -40, 40, 40).contains(p)) return marks[m];
        }
        return MarkPtr();
    }

    void openNote(const MarkPtr &mark) {
        openMark = mark;
        layoutChanged();
        QRect b = boundsOf(mark->ink);
        if (b.top() < doc()->scroll || b.bottom() > doc()->scroll + docH()) {
            doc()->scroll = b.top() - docH() / 4;
            clampScroll();
            requestStrips(cur);
        }
        update();
    }

    void closeNote() {
        openMark.clear();
        pane = "doc";
        trimMemory();
        layoutChanged();
        scheduleSave();
    }

    void erase(const QPoint &p) {
        if (locked()) return;
        if (gesture == "note" && openMark) {
            QPoint at = toNote(p);
            for (int i = openMark->note.size() - 1; i >= 0; --i) {
                if (!strokeHit(openMark->note[i], at)) continue;
                Undo u = { Undo::ErasedNote, openMark, openMark->note.takeAt(i), i, 0 };
                undoStack << u;
                invalidateNotes(openMark, u.stroke.boundingRect().adjusted(-4, -4, 4, 4));
                scheduleSave();
                return;
            }
            return;
        }
        QPoint at = toDoc(p);
        for (int m = marks.size() - 1; m >= 0; --m) {
            MarkPtr mark = marks[m];
            if (mark->doc != doc()->id) continue;
            for (int i = mark->ink.size() - 1; i >= 0; --i) {
                if (!strokeHit(mark->ink[i], at)) continue;
                QRect before = markArea(mark);
                Undo u = { Undo::ErasedInk, mark, mark->ink.takeAt(i), i, m };
                mark->rowsKnown = false;
                if (mark->ink.isEmpty()) {
                    marks.removeAt(m);
                    if (openMark == mark) { openMark.clear(); layoutChanged(); }
                    invalidateDoc(QRect());
                } else invalidateDoc(before, mark->doc);
                undoStack << u;
                scheduleSave();
                return;
            }
        }
    }

    void undo() {
        if (locked()) return;
        if (undoStack.isEmpty()) return;
        Undo u = undoStack.takeLast();
        switch (u.kind) {
        case Undo::AddedInk: u.mark->ink.removeAll(u.stroke); break;
        case Undo::CreatedMark:
            marks.removeAll(u.mark);
            if (openMark == u.mark) { openMark.clear(); layoutChanged(); }
            break;
        case Undo::AddedNote: u.mark->note.removeAll(u.stroke); break;
        case Undo::ErasedInk:
            u.mark->ink.insert(u.at, u.stroke);
            if (!marks.contains(u.mark)) marks.insert(qMin(u.markAt, marks.size()), u.mark);
            break;
        case Undo::ErasedNote: u.mark->note.insert(u.at, u.stroke); break;
        }
        invalidateDoc(QRect());
        invalidateNotes();
        scheduleSave();
    }

    // In a code review the arrows step through the changed files in the tree's order, to the
    // whole file when one is shown; otherwise through every document.
    void step(int dir) {
        Doc *d = doc();
        if (!d) return;
        if (kind != "code" || (d->kind != "diff" && d->kind != "file")) {
            go(cur + dir);
            return;
        }
        QList<int> order = diffOrder(QString());
        int at = -1;
        for (int i = 0; i < order.size(); ++i)
            if (docs[order[i]].path == d->path) at = i;
        if (at + dir < 0 || at + dir >= order.size()) return;
        int next = order[at + dir];
        go(d->kind == "file" ? counterpart(next, "file") : next);
    }

    // The document of kind for the same path as docs[index], or -1.
    int counterpart(int index, const QString &kindOf) const {
        if (index < 0 || docs[index].path.isEmpty()) return -1;
        for (int i = 0; i < docs.size(); ++i)
            if (docs[i].kind == kindOf && docs[i].path == docs[index].path) return i;
        return -1;
    }

    void go(int index, int line = 0) {
        if (index < 0 || index >= docs.size()) return;
        drawerOpen = false;
        saveNow();
        showDoc(index);
        if (!line) return;
        if (docs[index].loaded) jumpTo(line);
        else {
            jumpDoc = index;
            jumpLine = line;
        }
    }

    // The source line nearest a third down the view, as the web page takes it.
    int lineAtView() {
        Doc *d = doc();
        if (!d) return 0;
        int y = d->scroll + docH() / 3, best = -1, bestGap = 0;
        for (int i = 0; i < d->rowIndex.size(); ++i) {
            int line = d->rowIndex[i] < d->rowNew.size() ? d->rowNew[d->rowIndex[i]] : 0;
            if (!line) continue;
            int gap = qAbs((d->rowTop[i] + d->rowBottom[i]) / 2 - y);
            if (best < 0 || gap < bestGap) best = line, bestGap = gap;
        }
        return qMax(best, 0);
    }
    void jumpTo(int line) {
        Doc *d = doc();
        if (!d) return;
        for (int i = 0; i < d->rowIndex.size(); ++i) {
            int at = d->rowIndex[i] < d->rowNew.size() ? d->rowNew[d->rowIndex[i]] : 0;
            if (at >= line) {
                d->scroll = d->rowTop[i] - docH() / 3;
                clampScroll();
                requestStrips(cur);
                update();
                return;
            }
        }
    }

    // ── Drawer ──────────────────────────────────────────────────────────
    // As on the web page: replies, documents, the changed files as a tree with folders that
    // fold, files the agent added for context, and the round's actions.
    struct DrawerRow {
        enum Kind { Title, Meta, Section, File, Dir, Plain, Action } kind;
        QString text, key;
        int depth, doc, whole, top, height;
        bool current;
    };

    QRect drawerRect() const { return QRect(0, 0, qMin(560, width() - 90), height() - TOOLBAR_H); }

    void toggleDrawer() { drawerOpen ? closeDrawer() : openDrawer(); }
    void openDrawer() {
        drawerOpen = true;
        drawerScroll = 0;
        buildDrawer();
        update();
    }
    void closeDrawer() {
        drawerOpen = false;
        update();
    }
    void drawerScrollTo(int y) {
        int top = qBound(0, y, qMax(0, drawerHeight - drawerRect().height()));
        if (top == drawerScroll) return;
        drawerScroll = top;
        update(drawerRect());
    }

    // The diff documents under prefix, in the tree's order: folders by name first, then files.
    QList<int> diffOrder(const QString &prefix) const {
        QList<int> out;
        QStringList dirs;
        for (int i = 0; i < docs.size(); ++i) {
            if (docs[i].kind != "diff" || !docs[i].path.startsWith(prefix)) continue;
            QString rest = docs[i].path.mid(prefix.size());
            if (rest.contains('/') && !dirs.contains(rest.section('/', 0, 0))) dirs << rest.section('/', 0, 0);
        }
        dirs.sort();
        foreach (const QString &dir, dirs) out += diffOrder(prefix + dir + "/");
        for (int i = 0; i < docs.size(); ++i)
            if (docs[i].kind == "diff" && docs[i].path.startsWith(prefix) && !docs[i].path.mid(prefix.size()).contains('/')) out << i;
        return out;
    }

    int marksIn(const QString &docId) const {
        int n = 0;
        foreach (const MarkPtr &m, marks)
            if (m->doc == docId) ++n;
        return n;
    }
    QString marksNote(const QString &docId) const {
        int n = marksIn(docId);
        return n ? QString::fromUtf8(" \xc2\xb7 %1 Mark.").arg(n) : QString();
    }

    void addRow(DrawerRow::Kind kind, const QString &text, int height, const QString &key = QString(), int docIndex = -1,
                int depth = 0, int whole = -1) {
        DrawerRow r;
        r.kind = kind;
        r.text = text;
        r.key = key;
        r.depth = depth;
        r.doc = docIndex;
        r.whole = whole;
        r.top = drawerHeight;
        r.height = height;
        r.current = docIndex >= 0 && (docIndex == cur || whole == cur);
        drawerRows << r;
        drawerHeight += height;
    }

    // A folder with a single subfolder and no files of its own shows as one row, as on GitHub.
    void treeRows(const QString &prefix, int depth) {
        QStringList dirs;
        for (int i = 0; i < docs.size(); ++i) {
            if (docs[i].kind != "diff" || !docs[i].path.startsWith(prefix)) continue;
            QString rest = docs[i].path.mid(prefix.size());
            if (rest.contains('/') && !dirs.contains(rest.section('/', 0, 0))) dirs << rest.section('/', 0, 0);
        }
        dirs.sort();
        foreach (const QString &dir, dirs) {
            QString label = dir, full = prefix + dir + "/";
            for (;;) {
                QStringList sub;
                bool files = false;
                for (int i = 0; i < docs.size(); ++i) {
                    if (docs[i].kind != "diff" || !docs[i].path.startsWith(full)) continue;
                    QString rest = docs[i].path.mid(full.size());
                    if (!rest.contains('/')) files = true;
                    else if (!sub.contains(rest.section('/', 0, 0))) sub << rest.section('/', 0, 0);
                }
                if (files || sub.size() != 1) break;
                label += "/" + sub.first();
                full += sub.first() + "/";
            }
            bool closed = collapsed.contains(full);
            addRow(DrawerRow::Dir, QString::fromUtf8(closed ? "\xe2\x96\xb8 " : "\xe2\x96\xbe ") + label, 40, full, -1, depth);
            if (!closed) treeRows(full, depth + 1);
        }
        for (int i = 0; i < docs.size(); ++i) {
            if (docs[i].kind != "diff" || !docs[i].path.startsWith(prefix) || docs[i].path.mid(prefix.size()).contains('/')) continue;
            QString text = QString::fromUtf8("%1  +%2 \xe2\x88\x92%3").arg(docs[i].title).arg(docs[i].plus).arg(docs[i].minus) + marksNote(docs[i].id);
            addRow(DrawerRow::File, text, 40, docs[i].status, i, depth, counterpart(i, "file"));
        }
    }

    void plainRows(const QString &section, bool (*wanted)(const Doc &, const QList<Doc> &)) {
        bool any = false;
        for (int i = 0; i < docs.size(); ++i) {
            if (!wanted(docs[i], docs)) continue;
            if (!any) addRow(DrawerRow::Section, section, 38);
            any = true;
            addRow(DrawerRow::Plain, (docs[i].path.isEmpty() ? docs[i].title : docs[i].path) + marksNote(docs[i].id), 40, QString(), i);
        }
    }
    static bool isReplies(const Doc &d, const QList<Doc> &) { return d.kind == "replies"; }
    static bool isContext(const Doc &d, const QList<Doc> &) { return d.context; }
    static bool isDocument(const Doc &d, const QList<Doc> &all) {
        if (d.context) return false;
        if (d.kind == "spec") return true;
        if (d.kind != "file") return false;
        foreach (const Doc &o, all)
            if (o.kind == "diff" && o.path == d.path) return false;
        return true;
    }

    void buildDrawer() {
        drawerRows.clear();
        drawerHeight = 10;
        addRow(DrawerRow::Title, title, 40);
        addRow(DrawerRow::Meta, QString::fromUtf8("Runde %1 \xc2\xb7 %2 Markierungen").arg(round).arg(marks.size()), 34);
        Doc *d = doc();
        if (d && d->kind == "diff" && counterpart(cur, "file") >= 0)
            addRow(DrawerRow::Action, QString::fromUtf8("Ganze Datei an dieser Stelle \xe2\x86\x92"), 56, "toFile");
        if (d && d->kind == "file" && counterpart(cur, "diff") >= 0)
            addRow(DrawerRow::Action, QString::fromUtf8("Zum Diff an dieser Stelle \xe2\x86\x92"), 56, "toDiff");
        plainRows("Antworten", isReplies);
        plainRows("Dokumente", isDocument);
        int before = drawerRows.size();
        treeRows(QString(), 0);
        if (drawerRows.size() > before) {
            DrawerRow section;
            section.kind = DrawerRow::Section;
            section.text = QString::fromUtf8("Ge\xc3\xa4nderte Dateien");
            section.depth = 0;
            section.doc = section.whole = -1;
            section.height = 38;
            section.current = false;
            section.top = drawerRows[before].top;
            for (int i = before; i < drawerRows.size(); ++i) drawerRows[i].top += section.height;
            drawerRows.insert(before, section);
            drawerHeight += section.height;
        }
        plainRows("Nachgeliefert", isContext);
        drawerHeight += 10;
        if (!locked())
            addRow(DrawerRow::Action, armed == "send" ? QString("Wirklich senden? Nochmal tippen") : QString("An den Agenten senden (%1)").arg(marks.size()), 56, "send");
        addRow(DrawerRow::Action, "Alle Reviews", 56, "inbox");
        addRow(DrawerRow::Action, "App beenden", 56, "quit");
        drawerHeight += 10;
    }

    void paintDrawer(QPainter &p, const QRect &clip) {
        QRect r = drawerRect();
        QRect shade(r.right() + 1, 0, width() - r.width(), r.height());
        if (clip.intersects(shade)) p.fillRect(shade & clip, QColor(0, 0, 0, 64));
        if (!clip.intersects(r)) return;
        p.save();
        p.setClipRect(r & clip);
        p.fillRect(r, Qt::white);
        p.fillRect(r.right() - 2, 0, 3, r.height(), Qt::black);
        QFont f = font();
        foreach (const DrawerRow &row, drawerRows) {
            QRect box(0, row.top - drawerScroll, r.width() - 3, row.height);
            if (!box.intersects(clip)) continue;
            int left = 14 + row.depth * 18;
            QRect text = box.adjusted(left, 0, -12, 0);
            f.setBold(row.kind == DrawerRow::Title || row.kind == DrawerRow::Section);
            f.setPixelSize(row.kind == DrawerRow::Title ? 22 : row.kind == DrawerRow::Meta ? 15 : 17);
            p.setFont(f);
            p.setPen(Qt::black);
            if (row.current) p.fillRect(box, QColor(0xdd, 0xdd, 0xdd));
            switch (row.kind) {
            case DrawerRow::Action:
                paintButton(p, box.adjusted(12, 6, -12, -6), row.text, row.key == "toFile" || row.key == "toDiff" || row.key == "send", 17);
                break;
            case DrawerRow::Section:
                p.drawText(text, Qt::AlignLeft | Qt::AlignBottom, row.text);
                p.fillRect(box.left() + 14, box.bottom(), box.width() - 28, 1, Qt::black);
                break;
            case DrawerRow::File: {
                QRect st(text.left(), box.top() + 9, 22, 22);
                p.drawRect(st);
                p.drawText(st, Qt::AlignCenter, row.key);
                QRect rest = text.adjusted(30, 0, 0, 0);
                if (row.whole >= 0) {
                    QRect pill = wholeRect(box);
                    p.drawRect(pill);
                    p.drawText(pill, Qt::AlignCenter, "Datei");
                    rest.setRight(pill.left() - 8);
                }
                p.drawText(rest, Qt::AlignLeft | Qt::AlignVCenter, p.fontMetrics().elidedText(row.text, Qt::ElideMiddle, rest.width()));
                break;
            }
            default:
                p.drawText(text, Qt::AlignLeft | Qt::AlignVCenter, p.fontMetrics().elidedText(row.text, Qt::ElideMiddle, text.width()));
            }
        }
        p.restore();
    }
    QRect wholeRect(const QRect &box) const { return QRect(box.right() - 72, box.top() + 8, 60, box.height() - 16); }

    void drawerTap(const QPoint &p) {
        foreach (const DrawerRow &row, drawerRows) {
            QRect box(0, row.top - drawerScroll, drawerRect().width() - 3, row.height);
            if (!box.contains(p)) continue;
            if (row.kind == DrawerRow::Dir) {
                if (collapsed.contains(row.key)) collapsed.remove(row.key);
                else collapsed.insert(row.key);
                buildDrawer();
                drawerScrollTo(drawerScroll);
                update(drawerRect());
            } else if (row.kind == DrawerRow::File) go(row.whole >= 0 && wholeRect(box).contains(p) ? row.whole : row.doc);
            else if (row.kind == DrawerRow::Plain) go(row.doc);
            else if (row.key == "toFile") go(counterpart(cur, "file"), lineAtView());
            else if (row.key == "toDiff") go(counterpart(cur, "diff"), lineAtView());
            else if (row.key == "send") submit();
            else if (row.key == "inbox") leave();
            else if (row.key == "quit") saveThen("quitApp");
            return;
        }
    }

    // ── Saving ──────────────────────────────────────────────────────────
    QByteArray markJson(const MarkPtr &m) {
        QByteArray json;
        json.reserve(4096);
        json += "{\"id\":" + jsonString(m->id).toUtf8() + ",\"doc\":" + jsonString(m->doc).toUtf8() + ",\"ink\":";
        appendStrokes(json, m->ink);
        json += ",\"note\":";
        appendStrokes(json, m->note);
        json += ",\"noteScroll\":";
        appendInt(json, m->noteScroll);
        json += ",\"stamp\":" + (m->stamp.isEmpty() ? QByteArray("null") : jsonString(m->stamp).toUtf8());
        json += m->asked ? ",\"asked\":true" : ",\"asked\":false";
        if (m->rowsKnown) json += ",\"rows\":" + m->rowsJson.toUtf8();
        return json + "}";
    }
    QByteArray marksJson() {
        QTime clock;
        clock.start();
        QByteArray out = "[";
        for (int i = 0; i < marks.size(); ++i) {
            if (i) out += ',';
            out += markJson(marks[i]);
        }
        out += "]";
        if (clock.elapsed() > 50) fprintf(stderr, "native: marks to JSON took %d ms for %d bytes\n", clock.elapsed(), out.size());
        return out;
    }
    void scheduleSave() {
        if (!locked()) saveTimer.start(SAVE_DELAY);
    }
    void saveNow() {
        if (!saveTimer.isActive()) return;
        saveTimer.stop();
        save();
    }
    // Saves any pending change, then calls the slot named method.
    void saveThen(const char *method) {
        saveNow();
        QMetaObject::invokeMethod(this, method, Qt::QueuedConnection);
    }
    void leave() { saveThen("closeView"); }
    // The round goes to the agent for good, so it takes a second tap.
    void submit() {
        if (locked()) return;
        int bare = 0;
        foreach (const MarkPtr &m, marks)
            if (m->note.isEmpty() && m->stamp.isEmpty()) ++bare;
        QString prompt = marks.isEmpty() ? QString::fromUtf8("Nichts markiert \xe2\x80\x93 trotzdem senden? Nochmal tippen")
                       : bare ? QString::fromUtf8("%1 Markierungen senden, %2 ohne Notiz oder Stempel? Nochmal tippen").arg(marks.size()).arg(bare)
                              : QString::fromUtf8("%1 Markierungen senden? Nochmal tippen").arg(marks.size());
        if (!confirmed("send", prompt)) return;
        saveTimer.stop();
        mirror->post(reviewId, "submit", marksBody());
        emit closed();
    }
    void ask() {
        if (!openMark || locked()) return;
        if (!confirmed("question", QString::fromUtf8("Frage mit dieser Notiz an den Agenten schicken? Nochmal tippen"))) return;
        QByteArray body = "{\"round\":";
        appendInt(body, round);
        body += ",\"mark\":" + markJson(openMark) + "}";
        mirror->post(reviewId, "request", body);
        openMark->asked = true;
        scheduleSave();
        status(mirror->online() ? QString::fromUtf8("Frage wird gesendet \xe2\x80\xa6")
                                : QString::fromUtf8("Frage geht raus, sobald der Hub erreichbar ist"));
    }
    // True on the second tap within CONFIRM_MS; the first only asks.
    bool confirmed(const QString &what, const QString &prompt) {
        if (armed == what && armedAt.elapsed() < CONFIRM_MS) {
            armed.clear();
            return true;
        }
        armed = what;
        armedAt.start();
        message = prompt;
        update(toolBarRect());
        if (drawerOpen) {
            buildDrawer();
            update(drawerRect());
        }
        QTimer::singleShot(CONFIRM_MS, this, SLOT(disarm()));
        return false;
    }
    // A submitted round is the agent's until it answers; the app only shows it.
    bool locked() const { return reviewStatus == "submitted" || mirror->submitWaiting(reviewId); }
    QString lockedText() const { return QString::fromUtf8("Beim Agenten \xe2\x80\x93 wartet auf seine Antwort"); }

    QByteArray marksBody() {
        QByteArray body = "{\"round\":";
        appendInt(body, round);
        return body + ",\"marks\":" + marksJson() + "}";
    }

    Mirror *mirror;
    FigureView *figure;
    QVariantMap resume;
    QTimer stateTimer;
    QString reviewId, title, kind, message, reviewStatus, armed;
    QTime armedAt;
    int round;
    QList<Doc> docs;
    QList<MarkPtr> marks;
    MarkPtr openMark;
    QList<Undo> undoStack;
    int cur, noteH;
    QString tool, pane, gesture;
    QPolygon live;
    QRect dirty;
    bool pressed;
    int startY, startNoteH, noteExtent;
    QTimer saveTimer;
    Baker *baker;
    QMap<QString, Tile> tiles;
    QMap<QString, QImage> arts;
    QTime lastScroll, sinceBeat, sinceMemory;
    int loggedRss;
    bool drawerOpen;
    int drawerScroll, drawerHeight, startDrawerScroll, jumpDoc, jumpLine;
    QList<DrawerRow> drawerRows;
    QSet<QString> collapsed;
    QTimer pulse;
};

} // namespace native

#endif
