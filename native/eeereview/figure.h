// A figure of a review page, a diagram above all, shown large enough to read: the hub renders
// figures at twice their size on the page, and this view shows them at up to that size. The
// pen pans; the toolbar and the left and right buttons zoom; back closes it.

#ifndef EEE_FIGURE_H
#define EEE_FIGURE_H

#include <QtGui>

#include "baker.h"
#include "mirror.h"
#include "ui.h"

namespace native {

class FigureView : public QWidget {
    Q_OBJECT
public:
    // at: where the figure was tapped, from 0 to 1 across it, to be centred on.
    FigureView(Mirror *mirror, const QString &key, const QPointF &at, QWidget *parent)
        : QWidget(parent), mirror(mirror), key(key), at(at), level(-1), pressed(false) {
        setAttribute(Qt::WA_OpaquePaintEvent);
        connect(mirror, SIGNAL(got(QString, QByteArray, bool)), this, SLOT(got(QString, QByteArray, bool)));
        mirror->get(key);
    }

    void penDown(const QPoint &screen) {
        QPoint p = mapFromGlobal(screen);
        pressed = true;
        downAt = lastAt = p;
        gesture = toolBar().contains(p) ? "bar" : "pan";
    }
    void penMoved(const QPoint &screen) {
        if (!pressed || gesture != "pan") return;
        QPoint p = mapFromGlobal(screen);
        panBy(lastAt - p);
        lastAt = p;
    }
    void penUp() {
        if (!pressed) return;
        pressed = false;
        if (gesture == "bar") {
            if (zoomOutRect().contains(downAt)) zoom(-1);
            else if (zoomInRect().contains(downAt)) zoom(1);
            else if (fitRect().contains(downAt)) setLevel(0, center());
            else if (closeRect().contains(downAt)) emit closed();
        }
    }
    // The tablet's buttons, named as in main.cpp.
    bool button(const QString &name) {
        if (name == "back") emit closed();
        else if (name == "left") zoom(-1);
        else if (name == "right") zoom(1);
        else return false;
        return true;
    }

signals:
    void closed();

protected:
    void paintEvent(QPaintEvent *event) {
        QPainter p(this);
        p.setClipRect(event->rect());
        QRect view = viewRect();
        p.fillRect(view, Qt::white);
        if (shown.isNull()) {
            p.drawText(view, Qt::AlignCenter, message.isEmpty() ? QString::fromUtf8("Lade \xe2\x80\xa6") : message);
        } else p.drawPixmap(-offset.x(), -offset.y(), shown);
        QRect bar = toolBar();
        p.fillRect(bar, Qt::white);
        p.fillRect(bar.left(), bar.top(), bar.width(), 2, Qt::black);
        paintButton(p, closeRect(), QString::fromUtf8("Zur\xc3\xbc" "ck"), false, 18);
        paintButton(p, zoomOutRect(), QString::fromUtf8("\xe2\x88\x92"), false, 24);
        paintButton(p, zoomInRect(), "+", false, 24);
        paintButton(p, fitRect(), "Ganz", false, 18);
        QFont f = font();
        f.setPixelSize(16);
        p.setFont(f);
        p.setPen(Qt::black);
        if (level >= 0)
            p.drawText(QRect(fitRect().right() + 16, bar.top(), 200, bar.height()), Qt::AlignVCenter | Qt::AlignLeft,
                       QString("Zoom %1 %").arg(qRound(scales[level] * 100)));
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
    static const int BAR_H = 54;
    QRect viewRect() const { return QRect(0, 0, width(), height() - BAR_H); }
    QRect toolBar() const { return QRect(0, height() - BAR_H, width(), BAR_H); }
    QRect closeRect() const { return QRect(6, toolBar().top() + 7, 100, BAR_H - 14); }
    QRect zoomOutRect() const { return QRect(118, toolBar().top() + 7, 56, BAR_H - 14); }
    QRect zoomInRect() const { return QRect(182, toolBar().top() + 7, 56, BAR_H - 14); }
    QRect fitRect() const { return QRect(246, toolBar().top() + 7, 80, BAR_H - 14); }

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
    QString key, message, gesture;
    QPointF at;
    QImage source;
    QPixmap shown;
    QList<double> scales;
    int level;
    QPoint offset, downAt, lastAt;
    bool pressed;
};

} // namespace native

#endif
