// The hub's inbox and review pages in a full-screen QWebView, with the pen read natively and
// handed to the page's window.pen. Taps on the page's buttons still reach it as the usual
// tslib mouse clicks.
//
//   ./eeereview [hub url] [top]
//
// top is how many pixels the system header covers; without it the header's height is
// taken from the available screen geometry.

#include <QtGui>
#include <QtWebKit>

#include <cstdio>

#include "../common/pen.h"

// Ink is drawn here, over the page, while the pen is down, and the page gets the stroke
// whole when it lifts: one evaluateJavaScript per stroke instead of per point, which on
// this CPU is what kept the ink trailing the pen.
class ReviewView : public QWebView {
    Q_OBJECT
public:
    ReviewView() : swallowing(false) {
        page()->mainFrame()->setScrollBarPolicy(Qt::Vertical, Qt::ScrollBarAlwaysOff);
        page()->mainFrame()->setScrollBarPolicy(Qt::Horizontal, Qt::ScrollBarAlwaysOff);
        PenReader *pen = new PenReader("/dev/input/event2", this);
        connect(pen, SIGNAL(down(int, int, int, qint64)), this, SLOT(penDown(int, int, int, qint64)));
        connect(pen, SIGNAL(moved(int, int, int, qint64)), this, SLOT(penMoved(int, int, int, qint64)));
        connect(pen, SIGNAL(up()), this, SLOT(penUp()));
        connect(pen, SIGNAL(burstDone()), this, SLOT(showInk()));
        streamBatch.setInterval(40);
        connect(&streamBatch, SIGNAL(timeout()), this, SLOT(flushStream()));
    }

protected:
    // tslib delivers the same pen as mouse events. Over a canvas they would set WebKit
    // selecting text for every move, work the GUI thread cannot spare while ink is drawn,
    // so a press there is kept from WebKit until its release.
    void mousePressEvent(QMouseEvent *event) {
        swallowing = run(QString("window.pen && pen.over ? pen.over(%1, %2) : false").arg(event->x()).arg(event->y())).toBool();
        if (!swallowing) QWebView::mousePressEvent(event);
    }
    void mouseMoveEvent(QMouseEvent *event) {
        if (!swallowing) QWebView::mouseMoveEvent(event);
    }
    void mouseReleaseEvent(QMouseEvent *event) {
        if (swallowing) swallowing = false;
        else QWebView::mouseReleaseEvent(event);
    }

    void paintEvent(QPaintEvent *event) {
        QWebView::paintEvent(event);
        if (ink.size() < 2) return;
        QPainter painter(this);
        painter.setClipRect(event->rect());
        painter.setRenderHint(QPainter::Antialiasing);
        for (int i = 1; i < ink.size(); ++i) {
            painter.setPen(QPen(Qt::black, inkWidth(pressures[i]), Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
            painter.drawLine(ink[i - 1], ink[i]);
        }
    }

private slots:
    void penDown(int x, int y, int pressure, qint64) {
        QPoint p = toView(x, y);
        mode = run(QString("window.pen ? pen.down(%1, %2, %3) : ''").arg(p.x()).arg(p.y()).arg(pressure)).toString();
        ink.clear();
        pressures.clear();
        streaming.clear();
        if (mode == "ink") { ink << p; pressures << pressure; }
        else if (mode == "stream") streamBatch.start();
    }
    void penMoved(int x, int y, int pressure, qint64) {
        QPoint p = toView(x, y);
        if (mode == "stream") streaming << p;
        if (mode != "ink" || p == ink.last()) return;
        QPoint last = ink.last();
        ink << p;
        pressures << pressure;
        dirty |= QRect(last, p).normalized().adjusted(-4, -4, 4, 4);
    }
    void showInk() {
        if (dirty.isEmpty()) return;
        repaint(dirty);
        dirty = QRect();
    }
    void penUp() {
        if (mode == "ink") {
            QStringList out;
            for (int i = 1; i < ink.size(); ++i) out << QString("[%1,%2,%3]").arg(ink[i].x()).arg(ink[i].y()).arg(pressures[i]);
            run("pen.stroke([" + out.join(",") + "])");
            QRect dirty = QPolygon(ink).boundingRect().adjusted(-4, -4, 4, 4);
            ink.clear();
            pressures.clear();
            update(dirty);
        } else if (mode == "stream") {
            streamBatch.stop();
            flushStream();
            run("pen.up()");
        }
        mode.clear();
    }
    void flushStream() {
        if (streaming.isEmpty()) return;
        run("pen.move(" + points(streaming) + ")");
        streaming.clear();
    }

private:
    static QString points(const QVector<QPoint> &list) {
        QStringList out;
        foreach (const QPoint &p, list) out << QString("[%1,%2]").arg(p.x()).arg(p.y());
        return "[" + out.join(",") + "]";
    }
    QPoint toView(int x, int y) const { return mapFromGlobal(calibration.toScreen(x, y)); }
    QVariant run(const QString &script) { return page()->mainFrame()->evaluateJavaScript(script); }

    Calibration calibration;
    QString mode;
    QVector<QPoint> ink, streaming;
    QVector<int> pressures;
    QRect dirty;
    bool swallowing;
    QTimer streamBatch;
};

int main(int argc, char **argv) {
    QApplication app(argc, argv);
    QUrl url(argc > 1 ? QString(argv[1]) : QString("http://127.0.0.1:8770/"));
    QRect screen = QApplication::desktop()->screenGeometry();
    QRect available = QApplication::desktop()->availableGeometry();
    fprintf(stderr, "screen %dx%d+%d+%d, available %dx%d+%d+%d\n", screen.width(), screen.height(), screen.x(),
            screen.y(), available.width(), available.height(), available.x(), available.y());
    int top = argc > 2 ? QString(argv[2]).toInt() : available.y();

    ReviewView view;
    view.setWindowFlags(Qt::FramelessWindowHint);
    view.setGeometry(screen.x(), screen.y() + top, screen.width(), screen.height() - top);
    view.load(url);
    view.show();
    return app.exec();
}

#include "main.moc"
