// A figure of a review page, a diagram above all, shown large enough to read: the hub renders
// figures at twice their size on the page, and this view shows them at up to that size. It
// covers the document's pane, so the note pane stays below it. The pen pans or, as pen or
// eraser, marks the figure; the marks are the page's, mapped onto it. The toolbar and the left
// and right buttons zoom; back closes it.

#ifndef EEE_FIGURE_H
#define EEE_FIGURE_H

#include <QtGui>

#include "baker.h"
#include "mirror.h"
#include "ui.h"

namespace native {

// The review view, as the figure view sees it: page coordinates in, and the ink back out.
class FigureHost {
public:
    virtual ~FigureHost() {}
    virtual Strokes inkWithin(const QRect &pageArea) = 0;
    virtual void figureStroke(const QPolygon &pageStroke) = 0;
    virtual void figureTap(const QPoint &pagePoint) = 0;
    virtual void figureErase(const QPoint &pagePoint) = 0;
};

class FigureView : public QWidget {
    Q_OBJECT
public:
    // box: where the figure sits on its page. at: where it was tapped, from 0 to 1 across it.
    FigureView(Mirror *mirror, FigureHost *host, const QString &key, const QRect &box, const QPointF &at, QWidget *parent)
        : QWidget(parent), mirror(mirror), host(host), key(key), box(box), at(at), mode("pan"), level(-1), pressed(false) {
        setAttribute(Qt::WA_OpaquePaintEvent);
        connect(mirror, SIGNAL(got(QString, QByteArray, bool)), this, SLOT(got(QString, QByteArray, bool)));
        mirror->get(key);
    }

    void penDown(const QPoint &screen) {
        QPoint p = mapFromGlobal(screen);
        pressed = true;
        live.clear();
        live << p;
        gesture = toolBar().contains(p) ? "bar" : level < 0 ? "none" : mode;
        if (gesture == "eraser") host->figureErase(toPage(p));
    }
    void penMoved(const QPoint &screen) {
        if (!pressed) return;
        QPoint p = mapFromGlobal(screen);
        if (p == live.last()) return;
        QPoint last = live.last();
        live << p;
        if (gesture == "pan") panBy(last - p);
        else if (gesture == "eraser") host->figureErase(toPage(p));
        else if (gesture == "pen") dirty |= QRect(last, p).normalized().adjusted(-4, -4, 4, 4);
    }
    void penBurst() {
        if (dirty.isEmpty()) return;
        repaint(dirty);
        dirty = QRect();
    }
    void penUp() {
        if (!pressed) return;
        pressed = false;
        QPoint first = live.first();
        if (gesture == "bar") {
            if (closeRect().contains(first)) emit closed();
            else if (zoomOutRect().contains(first)) zoom(-1);
            else if (zoomInRect().contains(first)) zoom(1);
            else if (fitRect().contains(first)) setLevel(0, center());
            else if (panRect().contains(first)) setMode("pan");
            else if (penRect().contains(first)) setMode("pen");
            else if (eraserRect().contains(first)) setMode("eraser");
        } else if (gesture == "pen") {
            if (live.boundingRect().width() < TAP && live.boundingRect().height() < TAP) host->figureTap(toPage(first));
            else {
                QPolygon stroke;
                foreach (const QPoint &p, live) {
                    QPoint q = toPage(p);
                    if (stroke.isEmpty() || stroke.last() != q) stroke << q;
                }
                host->figureStroke(stroke);
            }
        }
        QRect trail = live.boundingRect().adjusted(-4, -4, 4, 4);
        live.clear();
        update(trail);
    }
    // The tablet's buttons, named as in main.cpp.
    bool button(const QString &name) {
        if (name == "back") emit closed();
        else if (name == "left") zoom(-1);
        else if (name == "right") zoom(1);
        else if (name == "g1") setMode(mode == "pen" ? "pan" : "pen");
        else if (name == "g2") setMode(mode == "eraser" ? "pan" : "eraser");
        else return false;
        return true;
    }

signals:
    void closed();

protected:
    void paintEvent(QPaintEvent *event) {
        QPainter p(this);
        QRect clip = event->rect();
        p.setClipRect(clip);
        QRect view = viewRect();
        p.fillRect(view, Qt::white);
        if (shown.isNull()) {
            p.drawText(view, Qt::AlignCenter, message.isEmpty() ? QString::fromUtf8("Lade \xe2\x80\xa6") : message);
        } else {
            p.drawPixmap(-offset.x(), view.top() - offset.y(), shown);
            p.setClipRect(clip & view);
            // The page's ink over the figure, at the figure's scale.
            QRect area(toPage(clip.topLeft()), toPage(clip.bottomRight()));
            Strokes ink;
            foreach (const QPolygon &s, host->inkWithin(area.normalized().adjusted(-4, -4, 4, 4))) {
                QPolygon mapped;
                foreach (const QPoint &q, s) mapped << toView(q);
                ink << mapped;
            }
            inkPen(p, qMax(INK_WIDTH, qRound(INK_WIDTH * pageScale())));
            drawStrokes(p, ink, clip);
            if (live.size() > 1 && gesture == "pen") {
                inkPen(p, qMax(INK_WIDTH, qRound(INK_WIDTH * pageScale())));
                drawStrokes(p, Strokes() << live, clip);
            }
            p.setClipRect(clip);
        }
        QRect bar = toolBar();
        p.fillRect(bar, Qt::white);
        p.fillRect(bar.left(), bar.bottom() - 1, bar.width(), 2, Qt::black);
        paintButton(p, closeRect(), QString::fromUtf8("Zur\xc3\xbc" "ck"), false, 18);
        paintButton(p, zoomOutRect(), QString::fromUtf8("\xe2\x88\x92"), false, 24);
        paintButton(p, zoomInRect(), "+", false, 24);
        paintButton(p, fitRect(), "Ganz", false, 18);
        paintButton(p, panRect(), "Schieben", mode == "pan", 18);
        paintButton(p, penRect(), "Stift", mode == "pen", 18);
        paintButton(p, eraserRect(), "Radierer", mode == "eraser", 18);
    }
    void resizeEvent(QResizeEvent *) {
        if (level < 0) return;
        clampOffset();
        update();
    }

private slots:
    void got(const QString &k, const QByteArray &data, bool ok) {
        if (k != key) return;
        if (!ok || !source.loadFromData(data, "PNG")) {
            message = QString::fromUtf8("Bild nicht auf dem Tablet");
            update();
            return;
        }
        source = source.convertToFormat(QImage::Format_RGB32);
        // Fitting the width, then the page's own size and on up to the rendered size.
        double fit = double(width()) / source.width();
        scales << qMin(fit, 1.0);
        double steps[] = { 0.5, 0.75, 1.0 };
        for (int i = 0; i < 3; ++i)
            if (steps[i] > scales.last() + 0.05) scales << steps[i];
        setLevel(scales.size() > 1 ? scales.size() - 2 : 0, QPointF(at.x() * source.width(), at.y() * source.height()));
    }

private:
    static const int BAR_H = 50, TAP = 12;
    QRect toolBar() const { return QRect(0, 0, width(), BAR_H); }
    QRect viewRect() const { return QRect(0, BAR_H, width(), height() - BAR_H); }
    QRect barButton(int x, int w) const { return QRect(x, 5, w, BAR_H - 12); }
    QRect closeRect() const { return barButton(6, 92); }
    QRect zoomOutRect() const { return barButton(106, 48); }
    QRect zoomInRect() const { return barButton(160, 48); }
    QRect fitRect() const { return barButton(214, 70); }
    QRect panRect() const { return barButton(300, 104); }
    QRect penRect() const { return barButton(410, 76); }
    QRect eraserRect() const { return barButton(492, 104); }

    // Figure image pixels per page pixel, times the zoom: how much larger the page looks here.
    double pageScale() const { return level < 0 ? 1 : scales[level] * source.width() / qMax(1, box.width()); }
    QPoint toPage(const QPoint &v) const {
        double s = pageScale();
        return QPoint(box.left() + qRound((v.x() + offset.x()) / s), box.top() + qRound((v.y() - BAR_H + offset.y()) / s));
    }
    QPoint toView(const QPoint &page) const {
        double s = pageScale();
        return QPoint(qRound((page.x() - box.left()) * s) - offset.x(), qRound((page.y() - box.top()) * s) - offset.y() + BAR_H);
    }

    void setMode(const QString &m) {
        mode = m;
        update(toolBar());
    }
    // The point of the source image at the middle of the view.
    QPointF center() const {
        if (level < 0) return QPointF();
        QRect v = viewRect();
        return QPointF((offset.x() + v.width() / 2) / scales[level], (offset.y() + v.height() / 2) / scales[level]);
    }
    void zoom(int step) {
        if (level < 0) return;
        int next = qBound(0, level + step, scales.size() - 1);
        if (next != level) setLevel(next, center());
    }
    // The pixmap for a level is made once per change: scaling on every paint would be too slow here.
    void setLevel(int next, const QPointF &middle) {
        level = next;
        double s = scales[level];
        QImage scaled = s == 1.0 ? source : source.scaled(qRound(source.width() * s), qRound(source.height() * s), Qt::IgnoreAspectRatio, Qt::SmoothTransformation);
        // A colour pixmap comes out black on this panel.
        shown = QPixmap::fromImage(grayImage(scaled));
        QRect v = viewRect();
        offset = QPoint(qRound(middle.x() * s) - v.width() / 2, qRound(middle.y() * s) - v.height() / 2);
        clampOffset();
        update();
    }
    void clampOffset() {
        QRect v = viewRect();
        offset.setX(shown.width() <= v.width() ? (shown.width() - v.width()) / 2 : qBound(0, offset.x(), shown.width() - v.width()));
        offset.setY(shown.height() <= v.height() ? (shown.height() - v.height()) / 2 : qBound(0, offset.y(), shown.height() - v.height()));
    }
    void panBy(const QPoint &delta) {
        if (shown.isNull()) return;
        QPoint before = offset;
        offset += delta;
        clampOffset();
        QPoint moved = offset - before;
        if (moved.isNull()) return;
        QRect v = viewRect();
        if (qAbs(moved.x()) < v.width() && qAbs(moved.y()) < v.height()) scroll(-moved.x(), -moved.y(), v);
        else update(v);
    }

    Mirror *mirror;
    FigureHost *host;
    QString key, message, gesture;
    QRect box, dirty;
    QPointF at;
    QString mode;
    QImage source;
    QPixmap shown;
    QList<double> scales;
    int level;
    QPoint offset;
    QPolygon live;
    bool pressed;
};

} // namespace native

#endif
