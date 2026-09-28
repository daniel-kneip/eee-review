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

// Matches INK_WIDTH in web/review.js.
static const int INK_WIDTH = 2;

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

// What the pages may ask of the app, as window.eeeApp: to quit, back to the launcher, and
// to look for a hub again.
class AppBridge : public QObject {
    Q_OBJECT
public slots:
    void quit() { qApp->quit(); }
    void retry() { emit retryRequested(); }
signals:
    void retryRequested();
};

// Shown when no hub answers, so the app never sits on a page load that cannot finish.
static const char *UNREACHABLE =
    "<html><body style='font-family:sans-serif;margin:40px'><h1 style='font-size:26px'>Kein Hub erreichbar</h1>"
    "<p style='font-size:19px'>Der Hub auf dem Laptop antwortet weder über das USB-Kabel noch über WLAN. "
    "Läuft <code>eee-review hub</code>, und steckt das Kabel?</p>"
    "<p><button style='font-size:22px;padding:8px 24px;margin-right:16px' onclick='eeeApp.retry()'>Nochmal</button>"
    "<button style='font-size:22px;padding:8px 24px' onclick='eeeApp.quit()'>Beenden</button></p></body></html>";

class ReviewView : public QWebView {
    Q_OBJECT
public:
    ReviewView(const QStringList &list) : urls(list), tried(0), attempts(0), started(false), swallowing(false), pending(0) {
        setPage(new LoggingPage(this));
        connect(page()->mainFrame(), SIGNAL(javaScriptWindowObjectCleared()), this, SLOT(exposeApp()));
        connect(&bridge, SIGNAL(retryRequested()), this, SLOT(restart()));
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
public slots:
    void start() {
        if (tried >= urls.size()) {
            fprintf(stderr, "%s no hub reachable\n", stamp());
            setHtml(QString::fromUtf8(UNREACHABLE));
            return;
        }
        fprintf(stderr, "%s probing %s\n", stamp(), qPrintable(urls[tried]));
        pending = probe.get(QNetworkRequest(QUrl(urls[tried] + "api/ping")));
        probeTimeout.start(tried == 0 ? 2000 : 4000);
    }

    void restart() {
        tried = 0;
        attempts = 0;
        start();
    }

protected:
    // Whatever the page does, these keys leave the app. Every key is logged, since which codes
    // the tablet's buttons send is not documented anywhere.
    void keyPressEvent(QKeyEvent *event) {
        fprintf(stderr, "%s key 0x%x\n", stamp(), event->key());
        if (event->key() == Qt::Key_Escape || event->key() == Qt::Key_Back || event->key() == Qt::Key_Home ||
            event->key() == Qt::Key_HomePage) {
            qApp->quit();
            return;
        }
        QWebView::keyPressEvent(event);
    }

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
        painter.setPen(QPen(Qt::black, INK_WIDTH, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
        painter.drawPolyline(ink.constData(), ink.size());
    }

private slots:
    void exposeApp() { page()->mainFrame()->addToJavaScriptWindowObject("eeeApp", &bridge); }
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
            // The cable comes up a few seconds after start.sh loads the gadget, once the Mac has
            // noticed the device and eeelink on both ends has connected, so it gets several tries.
            if (tried == 0 && ++attempts < CABLE_ATTEMPTS) {
                QTimer::singleShot(1000, this, SLOT(start()));
                return;
            }
            ++tried;
            attempts = 0;
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
    void penDown(int x, int y, int, qint64) {
        QPoint p = toView(x, y);
        mode = run(QString("window.pen ? pen.down(%1, %2) : ''").arg(p.x()).arg(p.y())).toString();
        ink.clear();
        streaming.clear();
        if (mode == "ink") ink << p;
        else if (mode == "stream") streamBatch.start();
    }
    void penMoved(int x, int y, int, qint64) {
        stats.penFrames++;
        QPoint p = toView(x, y);
        if (mode == "stream") streaming << p;
        if (mode != "ink" || p == ink.last()) return;
        QPoint last = ink.last();
        ink << p;
        dirty |= QRect(last, p).normalized().adjusted(-4, -4, 4, 4);
    }
    void showInk() {
        if (dirty.isEmpty()) return;
        repaint(dirty);
        dirty = QRect();
    }
    void penUp() {
        if (mode == "ink") {
            run("pen.stroke(" + points(ink.mid(1)) + ")");
            QRect dirty = QPolygon(ink).boundingRect().adjusted(-4, -4, 4, 4);
            ink.clear();
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
        int ms = clock.elapsed();
        stats.js++;
        stats.jsMs += ms;
        if (ms > 200) fprintf(stderr, "%s slow js %d ms: %s\n", stamp(), ms, qPrintable(script.left(40)));
        return r;
    }

    Calibration calibration;
    QString mode;
    QVector<QPoint> ink, streaming;
    QRect dirty;
    static const char *stamp() {
        static char buf[16];
        strcpy(buf, qPrintable(QTime::currentTime().toString("hh:mm:ss.zzz")));
        return buf;
    }

    static const int CABLE_ATTEMPTS = 6;
    QStringList urls;
    int tried;
    int attempts;
    bool started;
    bool swallowing;
    QNetworkAccessManager probe;
    QNetworkReply *pending;
    QTimer probeTimeout;
    QTimer heartbeat;
    AppBridge bridge;
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
