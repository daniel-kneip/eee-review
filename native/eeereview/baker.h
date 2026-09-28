// Burns ink into tiles of the native review off the GUI thread. A job either draws new
// strokes onto a tile's last image, or composes the tile afresh from its source; the result
// comes back as the tile's new image and a gray copy ready for QPixmap::fromImage, which has
// to happen in the GUI thread. Text cannot be drawn safely off the GUI thread under Qt
// Embedded, so badges arrive as finished images.

#ifndef EEE_BAKER_H
#define EEE_BAKER_H

#include <QtGui>

#include <sys/resource.h>
#include <sys/syscall.h>
#include <unistd.h>

namespace native {

typedef QList<QPolygon> Strokes;
// Notes are handwriting in small letters, which a thicker line blurs together.
static const int INK_WIDTH = 2, NOTE_INK_WIDTH = 1;

// Only the segments that reach into area are drawn: while the pen moves, the area is the few
// pixels it just crossed, and stroking a whole long line for them is what lags.
inline void drawStrokes(QPainter &p, const Strokes &strokes, const QRect &area) {
    foreach (const QPolygon &s, strokes) {
        if (!s.boundingRect().adjusted(-3, -3, 3, 3).intersects(area)) continue;
        if (s.size() == 1) {
            p.drawPoint(s[0]);
            continue;
        }
        for (int i = 1; i < s.size(); ++i)
            if (QRect(s[i - 1], s[i]).normalized().adjusted(-3, -3, 3, 3).intersects(area)) p.drawLine(s[i - 1], s[i]);
    }
}

inline void inkPen(QPainter &p, int width = INK_WIDTH) {
    p.setRenderHint(QPainter::Antialiasing);
    p.setPen(QPen(Qt::black, width, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
}

// The panel is 8-bit gray, and on it QPixmap::fromImage turns an RGB image black; an 8-bit
// image with a gray colour table, as the PNG strips decode to, converts fine.
inline QImage grayImage(const QImage &rgb) {
    static QVector<QRgb> table;
    if (table.isEmpty())
        for (int i = 0; i < 256; ++i) table << qRgb(i, i, i);
    QImage gray(rgb.width(), rgb.height(), QImage::Format_Indexed8);
    gray.setColorTable(table);
    for (int y = 0; y < rgb.height(); ++y) {
        const QRgb *in = (const QRgb *)rgb.scanLine(y);
        uchar *out = gray.scanLine(y);
        for (int x = 0; x < rgb.width(); ++x) out[x] = qGreen(in[x]);
    }
    return gray;
}

struct BakeJob {
    QString key;
    int gen;
    QRect band;       // the tile's place in document or note coordinates
    QImage base;      // the tile's last image to draw onto; null to compose afresh
    QByteArray png;   // a document strip's source, when composing afresh
    int ruleEvery;    // a note tile's ruled lines, when composing afresh
    Strokes strokes;
    QList<QPoint> badgeAt;
    QList<QImage> badges;
};

struct Baked {
    QString key;
    int gen;
    QImage image, gray;
    int ms;
};

class Baker : public QThread {
    Q_OBJECT
public:
    Baker(QObject *parent) : QThread(parent), stopping(false), held(false) {}
    ~Baker() {
        {
            QMutexLocker lock(&mutex);
            stopping = true;
            wake.wakeAll();
        }
        wait();
    }
    void add(const BakeJob &job) {
        QMutexLocker lock(&mutex);
        jobs << job;
        wake.wakeAll();
    }
    // Holds the next job back while the pen is down, so ink never waits on a bake.
    void hold(bool on) {
        QMutexLocker lock(&mutex);
        held = on;
        if (!held) wake.wakeAll();
    }
    QList<Baked> take() {
        QMutexLocker lock(&mutex);
        QList<Baked> out = done;
        done.clear();
        return out;
    }

signals:
    void baked();

protected:
    void run() {
        // Linux applies a nice value to one thread when given its id: the GUI thread then
        // wins the CPU back as soon as the pen needs it.
        setpriority(PRIO_PROCESS, syscall(SYS_gettid), 19);
        for (;;) {
            BakeJob job;
            {
                QMutexLocker lock(&mutex);
                while ((jobs.isEmpty() || held) && !stopping) wake.wait(&mutex);
                if (stopping) return;
                job = jobs.takeFirst();
            }
            QTime clock;
            clock.start();
            Baked result;
            result.key = job.key;
            result.gen = job.gen;
            result.image = compose(job);
            result.gray = grayImage(result.image);
            result.ms = clock.elapsed();
            {
                QMutexLocker lock(&mutex);
                done << result;
            }
            emit baked();
        }
    }

private:
    static QImage compose(const BakeJob &job) {
        QImage image;
        if (!job.base.isNull()) image = job.base;
        else if (!job.png.isEmpty()) image = QImage::fromData(job.png, "PNG").convertToFormat(QImage::Format_RGB32);
        else {
            image = QImage(job.band.size(), QImage::Format_RGB32);
            image.fill(0xffffffff);
        }
        QPainter p(&image);
        if (job.base.isNull() && job.ruleEvery)
            for (int y = (job.ruleEvery - job.band.top() % job.ruleEvery) % job.ruleEvery; y < image.height(); y += job.ruleEvery)
                p.fillRect(0, y, image.width(), 1, QColor(0xbb, 0xbb, 0xbb));
        p.translate(0, -job.band.top());
        inkPen(p, job.ruleEvery ? NOTE_INK_WIDTH : INK_WIDTH);
        drawStrokes(p, job.strokes, job.band);
        for (int i = 0; i < job.badges.size(); ++i) p.drawImage(job.badgeAt[i], job.badges[i]);
        return image;
    }

    QMutex mutex;
    QWaitCondition wake;
    QList<BakeJob> jobs;
    QList<Baked> done;
    bool stopping, held;
};

} // namespace native

#endif
