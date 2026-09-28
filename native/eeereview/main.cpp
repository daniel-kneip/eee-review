// The hub's inbox and review pages in a full-screen QWebView, with the pen read natively and
// handed to the page's window.pen. Taps on the page's buttons still reach it as the usual
// tslib mouse clicks.
//
//   ./eeereview [hub url ...]
//
// The hub URLs are tried in order until one loads: start.sh passes the cable first
// (eeelink's local end, 127.0.0.1:8770) and the Wi-Fi address after it.

#include <QtGui>
#include <QtNetwork>
#include <QtWebKit>

#include <cstdio>
#include <cstring>

#include "../common/pen.h"

// Ink is drawn here, over the page, while the pen is down, and the page gets the stroke
// whole when it lifts: one evaluateJavaScript per stroke instead of per point, which on
// this CPU is what kept the ink trailing the pen.
// Page script errors and console output go to stderr, the only place to see them on the tablet.
class LoggingPage : public QWebPage {
    Q_OBJECT
public:
    LoggingPage(QObject *parent) : QWebPage(parent) {}

protected:
    void javaScriptConsoleMessage(const QString &message, int line, const QString &source) {
        fprintf(stderr, "js %s:%d: %s\n", qPrintable(source), line, qPrintable(message));
    }

public slots:
    // QtWebKit asks this when a page script has run for several seconds. Stopping it keeps
    // the tablet usable; a review page never has work that takes that long.
    bool shouldInterruptJavaScript() {
        fprintf(stderr, "js: script ran too long, interrupted\n");
        return true;
    }
};

class ReviewView : public QWebView {
    Q_OBJECT
public:
    ReviewView(const QStringList &list) : urls(list), tried(0), started(false), swallowing(false), pending(0) {
        setPage(new LoggingPage(this));
        connect(this, SIGNAL(loadStarted()), this, SLOT(loading()));
        connect(this, SIGNAL(loadFinished(bool)), this, SLOT(loaded(bool)));
        connect(page()->networkAccessManager(), SIGNAL(finished(QNetworkReply *)), this, SLOT(fetched(QNetworkReply *)));
        connect(&probe, SIGNAL(finished(QNetworkReply *)), this, SLOT(probed(QNetworkReply *)));
        connect(&probeTimeout, SIGNAL(timeout()), this, SLOT(probeTimedOut()));
        probeTimeout.setSingleShot(true);
        page()->mainFrame()->setScrollBarPolicy(Qt::Vertical, Qt::ScrollBarAlwaysOff);
        page()->mainFrame()->setScrollBarPolicy(Qt::Horizontal, Qt::ScrollBarAlwaysOff);
        PenReader *pen = new PenReader("/dev/input/event2", this);
        connect(pen, SIGNAL(down(int, int, int, qint64)), this, SLOT(penDown(int, int, int, qint64)));
        connect(pen, SIGNAL(moved(int, int, int, qint64)), this, SLOT(penMoved(int, int, int, qint64)));
        connect(pen, SIGNAL(up()), this, SLOT(penUp()));
        connect(pen, SIGNAL(burstDone()), this, SLOT(showInk()));
        connect(&heartbeat, SIGNAL(timeout()), this, SLOT(beat()));
        heartbeat.start(5000);
        streamBatch.setInterval(40);
        connect(&streamBatch, SIGNAL(timeout()), this, SLOT(flushStream()));
    }

    // Each hub address is asked for its inbox before the page loads one, so the route is
    // settled once and every later page is on the same host.
    void start() {
        if (tried >= urls.size()) {
            fprintf(stderr, "%s no hub reachable, showing the last address anyway\n", stamp());
            load(QUrl(urls.last()));
            return;
        }
        fprintf(stderr, "%s probing %s\n", stamp(), qPrintable(urls[tried]));
        pending = probe.get(QNetworkRequest(QUrl(urls[tried] + "api/ping")));
        probeTimeout.start(4000);
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
        stats.mouseMoves++;
        if (!swallowing) QWebView::mouseMoveEvent(event);
    }
    void mouseReleaseEvent(QMouseEvent *event) {
        if (swallowing) swallowing = false;
        else QWebView::mouseReleaseEvent(event);
    }

    void paintEvent(QPaintEvent *event) {
        QTime clock;
        clock.start();
        QWebView::paintEvent(event);
        stats.paints++;
        stats.paintMs += clock.elapsed();
        stats.paintArea += event->rect().width() * event->rect().height();
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
    void probed(QNetworkReply *reply) {
        reply->deleteLater();
        if (reply != pending) return;
        probeTimeout.stop();
        pending = 0;
        if (reply->error() == QNetworkReply::NoError) {
            fprintf(stderr, "%s hub at %s\n", stamp(), qPrintable(urls[tried]));
            load(QUrl(urls[tried]));
        } else {
            fprintf(stderr, "%s no hub at %s: %s\n", stamp(), qPrintable(urls[tried]), qPrintable(reply->errorString()));
            ++tried;
            start();
        }
    }
    void probeTimedOut() {
        if (pending) pending->abort();
    }
    void beat() {
        fprintf(stderr, "%s alive: %d paints %d ms %d kpx, %d mouse moves, %d pen frames, %d js %d ms\n", stamp(), stats.paints,
                stats.paintMs, stats.paintArea / 1000, stats.mouseMoves, stats.penFrames, stats.js, stats.jsMs);
        stats = Stats();
    }
    void loading() { fprintf(stderr, "%s loading\n", stamp()); }
    void fetched(QNetworkReply *reply) {
        if (reply->error() != QNetworkReply::NoError) {
            fprintf(stderr, "failed %s: %s\n", qPrintable(reply->url().toString()), qPrintable(reply->errorString()));
        }
    }
    void loaded(bool ok) {
        fprintf(stderr, "%s loaded %s: %s\n", stamp(), qPrintable(url().toString()), ok ? "ok" : "failed");
    }
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
        stats.penFrames++;
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
    QVariant run(const QString &script) {
        QTime clock;
        clock.start();
        QVariant r = page()->mainFrame()->evaluateJavaScript(script);
        stats.js++;
        stats.jsMs += clock.elapsed();
        return r;
    }

    Calibration calibration;
    QString mode;
    QVector<QPoint> ink, streaming;
    QVector<int> pressures;
    QRect dirty;
    static const char *stamp() {
        static char buf[16];
        strcpy(buf, qPrintable(QTime::currentTime().toString("hh:mm:ss.zzz")));
        return buf;
    }

    QStringList urls;
    int tried;
    bool started;
    bool swallowing;
    QNetworkAccessManager probe;
    QNetworkReply *pending;
    QTimer probeTimeout;
    QTimer heartbeat;
    struct Stats {
        Stats() : paints(0), paintMs(0), paintArea(0), mouseMoves(0), penFrames(0), js(0), jsMs(0) {}
        int paints, paintMs, paintArea, mouseMoves, penFrames, js, jsMs;
    } stats;
    QTimer streamBatch;
};

int main(int argc, char **argv) {
    QApplication app(argc, argv);
    QStringList urls;
    for (int i = 1; i < argc; ++i) urls << QString(argv[i]);
    if (urls.isEmpty()) urls << "http://127.0.0.1:8770/";
    QRect screen = QApplication::desktop()->screenGeometry();
    QRect available = QApplication::desktop()->availableGeometry();
    fprintf(stderr, "screen %dx%d+%d+%d, available %dx%d+%d+%d\n", screen.width(), screen.height(), screen.x(),
            screen.y(), available.width(), available.height(), available.x(), available.y());
    int top = available.y();

    ReviewView view(urls);
    view.setWindowFlags(Qt::FramelessWindowHint);
    view.setGeometry(screen.x(), screen.y() + top, screen.width(), screen.height() - top);
    view.start();
    view.show();
    return app.exec();
}

#include "main.moc"
