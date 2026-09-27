// Reading the Eee Note EA800's Wacom pen straight from evdev, the way the stock note app
// does, instead of through tslib, which reaches Qt at about a quarter of the rate and
// without pressure.

#ifndef EEENOTE_PEN_H
#define EEENOTE_PEN_H

#include <QtGui>
#include <QScreen>

#include <fcntl.h>
#include <linux/input.h>
#include <unistd.h>

// Maps raw digitizer units to screen pixels with the calibration the system's own
// calibration app writes for tslib to /etc/pointercal. tslib reads the Wacom with its axes
// swapped relative to evdev, so evdev's Y is tslib's x and evdev's X its y.
class Calibration {
public:
    Calibration() : valid(false) {
        QFile file("/etc/pointercal");
        if (!file.open(QIODevice::ReadOnly)) return;
        QStringList parts = QString(file.readAll()).simplified().split(' ');
        if (parts.size() < 7) return;
        for (int i = 0; i < 7; ++i) a[i] = parts[i].toLongLong();
        valid = a[6] != 0;
    }
    QPoint toScreen(int x, int y) const {
        QScreen *screen = QScreen::instance();
        QPoint device = valid ? QPoint(int((a[2] + a[0] * y + a[1] * x) / a[6]), int((a[5] + a[3] * y + a[4] * x) / a[6]))
                              : QPoint(y / 16, x / 16);
        return screen->mapFromDevice(device, QSize(screen->deviceWidth(), screen->deviceHeight()));
    }
    bool valid;

private:
    qint64 a[7];
};

// Stroke width in screen pixels for a raw pen pressure (0-255), steep at both ends and flat
// through ordinary writing. The knots match PRESSURE_KNOTS in src/render/ink.mjs and
// web/review.js, so ink keeps its look when the page takes a stroke over.
inline qreal inkWidth(int pressure) {
    static const int P[] = { 0, 100, 200, 235 };
    static const qreal Wd[] = { 0.3, 1.1, 1.7, 4.5 };
    if (pressure <= P[0]) return Wd[0];
    for (int i = 1; i < 4; ++i) {
        if (pressure <= P[i]) return Wd[i - 1] + (pressure - P[i - 1]) * (Wd[i] - Wd[i - 1]) / (P[i] - P[i - 1]);
    }
    return Wd[3];
}

// Reads on its own thread so the kernel's queue is drained however long the GUI thread is
// busy: evdev keeps only 64 events per reader (about 150 ms of pen), and when it overflows
// the touch and release events go with the rest, fusing strokes into one. Frames are
// collected under a lock and handed to the GUI thread in bursts by a timer, so a slow
// frame there costs one late burst instead of a backlog of 130 queued calls a second.
class PenReader : public QThread {
    Q_OBJECT
public:
    PenReader(const char *device, QObject *parent)
        : QThread(parent), x(0), y(0), pressure(0), touching(false), wasTouching(false) {
        fd = ::open(device, O_RDONLY);
        if (fd < 0) return;
        connect(&drain, SIGNAL(timeout()), this, SLOT(deliver()));
        drain.start(15);
        start();
    }
    // The thread spends its life blocked in read(), which only terminate() interrupts.
    ~PenReader() {
        if (isRunning()) {
            terminate();
            wait();
        }
    }
    bool isOpen() const { return fd >= 0; }

signals:
    void down(int x, int y, int pressure, qint64 ms);
    void moved(int x, int y, int pressure, qint64 ms);
    void up();
    void burstDone();

protected:
    void run() {
        struct input_event events[64];
        ssize_t bytes;
        while ((bytes = ::read(fd, events, sizeof(events))) > 0) {
            for (int i = 0; i < int(bytes / sizeof(struct input_event)); ++i) handle(events[i]);
        }
    }

private slots:
    void deliver() {
        QList<Frame> burst;
        {
            QMutexLocker lock(&mutex);
            burst = frames;
            frames.clear();
        }
        if (burst.isEmpty()) return;
        foreach (const Frame &f, burst) {
            if (f.kind == Frame::Down) emit down(f.x, f.y, f.pressure, f.ms);
            else if (f.kind == Frame::Move) emit moved(f.x, f.y, f.pressure, f.ms);
            else emit up();
        }
        emit burstDone();
    }

private:
    struct Frame {
        enum Kind { Down, Move, Up } kind;
        int x, y, pressure;
        qint64 ms;
    };

    void handle(const struct input_event &e) {
        if (e.type == EV_ABS && e.code == ABS_X) x = e.value;
        else if (e.type == EV_ABS && e.code == ABS_Y) y = e.value;
        else if (e.type == EV_ABS && e.code == ABS_PRESSURE) pressure = e.value;
        else if (e.type == EV_KEY && e.code == BTN_TOUCH) touching = e.value != 0;
        else if (e.type == EV_SYN) frame(qint64(e.time.tv_sec) * 1000 + e.time.tv_usec / 1000);
    }
    void frame(qint64 ms) {
        Frame f = { Frame::Move, x, y, pressure, ms };
        if (touching && !wasTouching) f.kind = Frame::Down;
        else if (!touching && wasTouching) f.kind = Frame::Up;
        else if (!touching) return;
        wasTouching = touching;
        QMutexLocker lock(&mutex);
        frames.append(f);
    }

    int fd, x, y, pressure;
    bool touching, wasTouching;
    QMutex mutex;
    QList<Frame> frames;
    QTimer drain;
};

#endif
