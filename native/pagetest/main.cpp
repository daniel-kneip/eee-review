// Probe: shows a document pre-rendered by scripts/render-pages.mjs as pixmap strips, to measure
// how fast the Eee Note pages and scrolls pixels compared with WebKit laying out the page.
//
//   ./pagetest http://127.0.0.1:8770/pages/<id>/<doc>/
//
// Left/Right page by three quarters of a screen, a pen drag scrolls, Generic 1 repaints the
// whole screen, Generic 2 scrolls in 20 small steps. Back or Home quits. Timings go to stderr.

#include <QtGui>
#include <QtNetwork>

#include <cstdio>

static const char *stamp() {
    static char buf[16];
    snprintf(buf, sizeof buf, "%s", qPrintable(QTime::currentTime().toString("hh:mm:ss.zzz")));
    return buf;
}

class PageView : public QWidget {
    Q_OBJECT
public:
    PageView(const QString &base) : base(base), height_(0), strip(512), scrollY(0), dragging(false), paints(0) {
        setAttribute(Qt::WA_OpaquePaintEvent);
        connect(&net, SIGNAL(finished(QNetworkReply *)), this, SLOT(fetched(QNetworkReply *)));
        started.start();
        net.get(QNetworkRequest(QUrl(base + "index.json")));
    }

private slots:
    void fetched(QNetworkReply *reply) {
        reply->deleteLater();
        QByteArray data = reply->readAll();
        if (reply->url().path().endsWith("index.json")) {
            QString text = QString::fromUtf8(data);
            QRegExp h("\"height\":(\\d+)"), c("\"count\":(\\d+)"), s("\"strip\":(\\d+)");
            if (h.indexIn(text) >= 0) height_ = h.cap(1).toInt();
            if (s.indexIn(text) >= 0) strip = s.cap(1).toInt();
            int count = c.indexIn(text) >= 0 ? c.cap(1).toInt() : 0;
            fprintf(stderr, "%s index: %d px in %d strips\n", stamp(), height_, count);
            for (int n = 0; n < count; ++n) {
                strips.append(QPixmap());
                net.get(QNetworkRequest(QUrl(base + QString::number(n) + ".png")));
            }
            return;
        }
        int n = QFileInfo(reply->url().path()).baseName().toInt();
        QTime decode;
        decode.start();
        QPixmap pixmap;
        pixmap.loadFromData(data, "PNG");
        if (n >= 0 && n < strips.size()) strips[n] = pixmap;
        fprintf(stderr, "%s strip %d: %d bytes, decoded in %d ms\n", stamp(), n, data.size(), decode.elapsed());
        bool done = true;
        for (int i = 0; i < strips.size(); ++i) done = done && !strips[i].isNull();
        if (done) fprintf(stderr, "%s all strips in %d ms\n", stamp(), started.elapsed());
        update();
    }
    void smoothStep() {
        if (steps-- <= 0) { fprintf(stderr, "%s smooth scroll done in %d ms\n", stamp(), smooth.elapsed()); return; }
        scrollBy(20);
        QTimer::singleShot(0, this, SLOT(smoothStep()));
    }

protected:
    void paintEvent(QPaintEvent *event) {
        QTime t;
        t.start();
        QPainter p(this);
        QRect r = event->rect();
        p.fillRect(r, Qt::white);
        for (int n = 0; n < strips.size(); ++n) {
            int top = n * strip - scrollY;
            if (strips[n].isNull() || top > r.bottom() || top + strips[n].height() < r.top()) continue;
            p.drawPixmap(0, top, strips[n]);
        }
        p.end();
        paints++;
        fprintf(stderr, "%s paint %dx%d in %d ms\n", stamp(), r.width(), r.height(), t.elapsed());
    }
    void keyPressEvent(QKeyEvent *event) {
        int page = height() * 3 / 4;
        switch (event->key()) {
        case Qt::Key_F6: timedScroll(-page); break;
        case Qt::Key_F12: timedScroll(page); break;
        case Qt::Key_F2: { QTime t; t.start(); repaint(); fprintf(stderr, "%s full repaint %d ms\n", stamp(), t.elapsed()); break; }
        case Qt::Key_F3: steps = 20; smooth.start(); smoothStep(); break;
        case Qt::Key_F1: case Qt::Key_F9: case Qt::Key_Escape: qApp->quit(); break;
        default: fprintf(stderr, "%s key 0x%x\n", stamp(), event->key());
        }
    }
    void mousePressEvent(QMouseEvent *event) { dragging = true; lastY = event->y(); }
    void mouseMoveEvent(QMouseEvent *event) {
        if (!dragging) return;
        scrollBy(lastY - event->y());
        lastY = event->y();
    }
    void mouseReleaseEvent(QMouseEvent *) { dragging = false; }

private:
    void timedScroll(int dy) {
        QTime t;
        t.start();
        scrollBy(dy);
        repaint(); // flush the exposed area now so the time covers it
        fprintf(stderr, "%s page %+d -> y %d in %d ms\n", stamp(), dy, scrollY, t.elapsed());
    }
    void scrollBy(int dy) {
        int target = qBound(0, scrollY + dy, qMax(0, height_ - height()));
        dy = target - scrollY;
        if (!dy) return;
        scrollY = target;
        if (qAbs(dy) < height()) scroll(0, -dy);
        else update();
    }

    QString base;
    QNetworkAccessManager net;
    QList<QPixmap> strips;
    int height_, strip, scrollY, lastY;
    bool dragging;
    int paints, steps;
    QTime started, smooth;
};

int main(int argc, char **argv) {
    QApplication app(argc, argv);
    if (argc < 2) { fprintf(stderr, "usage: pagetest http://hub/pages/<id>/<doc>/\n"); return 1; }
    QRect screen = QApplication::desktop()->screenGeometry();
    int top = QApplication::desktop()->availableGeometry().y();
    PageView view(argv[1]);
    view.setWindowFlags(Qt::FramelessWindowHint);
    view.setGeometry(screen.x(), screen.y() + top, screen.width(), screen.height() - top);
    view.show();
    view.setFocus();
    return app.exec();
}

#include "main.moc"
