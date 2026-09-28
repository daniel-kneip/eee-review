// eee-review on the Eee Note: the inbox and the reviews drawn natively from the hub's
// pre-rendered pages, with the pen read straight from the Wacom. The reviews are kept on the
// tablet too (mirror.h), so they can be reviewed without the hub.
//
//   ./eeereview [hub url ...]
//
// The hub URLs are tried in order until one answers: start.sh passes none, and the app then
// tries the cable (eeelink's local end, 127.0.0.1:8770) and the Wi-Fi address after it.

#include <QtGui>
#include <QCopChannel>

#include <cstdio>

#include "../common/pen.h"
#include "inbox.h"
#include "mirror.h"
#include "native.h"

// eeeserver starts the app and shows a loading dialog until the app reports App/showed to the
// launcher with its name, as a streamed QString. The status bar title and App/hide follow the
// stock apps, which send them on the way in and out.
static const char *APP_NAME = "eeereview";

static QByteArray streamed(const QString &text) {
    QByteArray data;
    QDataStream out(&data, QIODevice::WriteOnly);
    out << text;
    return data;
}

class LauncherLink : public QObject {
    Q_OBJECT
public:
    LauncherLink(QObject *parent) : QObject(parent) {
        const char *channels[] = { APP_NAME, "qte/etablepowerchannel" };
        for (int i = 0; i < 2; ++i) {
            QCopChannel *channel = new QCopChannel(channels[i], this);
            connect(channel, SIGNAL(received(QString, QByteArray)), this, SLOT(received(QString, QByteArray)));
        }
        connect(qApp, SIGNAL(aboutToQuit()), this, SLOT(hidden()));
    }
    void showed() {
        QCopChannel::send("launcher", "App/showed", streamed(APP_NAME));
        QCopChannel::send("statusbar", "title changed", streamed("eee-review"));
    }

private slots:
    void hidden() {
        QCopChannel::send("statusbar", "title changed", streamed("Home"));
        QCopChannel::send("launcher", "App/hide", streamed(APP_NAME));
        QCopChannel::flush();
    }
    void received(const QString &message, const QByteArray &data) {
        fprintf(stderr, "qcop %s (%d bytes)\n", qPrintable(message), data.size());
        if (message == "app/shutdown") qApp->quit();
    }
};

// Hands the pen to whichever view is up, and swaps the inbox for a review and back.
class Shell : public QObject {
    Q_OBJECT
public:
    Shell(const QStringList &urls, const QRect &geometry)
        : mirror(urls, "/eTablet/eee-review/cache"), inbox(&mirror), review(0), area(geometry) {
        inbox.setWindowFlags(Qt::FramelessWindowHint);
        inbox.setGeometry(area);
        connect(&inbox, SIGNAL(open(QString)), this, SLOT(openReview(QString)));
        PenReader *pen = new PenReader("/dev/input/event2", this);
        connect(pen, SIGNAL(down(int, int, int, qint64)), this, SLOT(penDown(int, int, int, qint64)));
        connect(pen, SIGNAL(moved(int, int, int, qint64)), this, SLOT(penMoved(int, int, int, qint64)));
        connect(pen, SIGNAL(up()), this, SLOT(penUp()));
        connect(pen, SIGNAL(burstDone()), this, SLOT(penBurst()));
        inbox.show();
        inbox.setFocus();
        mirror.start();
    }
    void drain() { mirror.drain(3000); }

private slots:
    void openReview(const QString &id) {
        if (review) return;
        fprintf(stderr, "open review %s\n", qPrintable(id));
        review = new native::ReviewWidget(&mirror, id);
        review->setWindowFlags(Qt::FramelessWindowHint);
        review->setGeometry(area);
        connect(review, SIGNAL(closed()), this, SLOT(closeReview()));
        review->show();
        review->setFocus();
        inbox.hide();
    }
    void closeReview() {
        review->deleteLater();
        review = 0;
        inbox.show();
        inbox.setFocus();
        mirror.refresh();
    }
    void penDown(int x, int y, int, qint64) {
        QPoint p = calibration.toScreen(x, y);
        if (review) review->penDown(p);
        else inbox.penDown(p);
    }
    void penMoved(int x, int y, int, qint64) {
        QPoint p = calibration.toScreen(x, y);
        if (review) review->penMoved(p);
        else inbox.penMoved(p);
    }
    void penBurst() {
        if (review) review->penBurst();
    }
    void penUp() {
        if (review) review->penUp();
        else inbox.penUp();
    }

private:
    Calibration calibration;
    native::Mirror mirror;
    native::InboxWidget inbox;
    native::ReviewWidget *review;
    QRect area;
};

// Started from the menu, the app gets no arguments and no log: it brings up the USB link
// itself and tries the cable first, then the Wi-Fi address deploy left behind.
static QStringList menuStart() {
    rename("/tmp/eeereview.log", "/tmp/eeereview.log.1");
    freopen("/tmp/eeereview.log", "w", stderr);
    setvbuf(stderr, 0, _IONBF, 0);
    QProcess::execute("/bin/sh", QStringList() << "/eTablet/eee-review/start.sh" << "link");
    QStringList urls;
    urls << "http://127.0.0.1:8770/";
    QFile wifi("/eTablet/eee-review/hub-wifi");
    if (wifi.open(QIODevice::ReadOnly)) {
        QString url = QString::fromUtf8(wifi.readAll()).trimmed();
        if (!url.isEmpty()) urls << url;
    }
    return urls;
}

int main(int argc, char **argv) {
    QApplication app(argc, argv);
    QStringList urls;
    for (int i = 1; i < argc; ++i) urls << QString(argv[i]);
    if (urls.isEmpty()) urls = menuStart();
    QRect screen = QApplication::desktop()->screenGeometry();
    int top = QApplication::desktop()->availableGeometry().y();
    Shell shell(urls, QRect(screen.x(), screen.y() + top, screen.width(), screen.height() - top));
    LauncherLink launcher(&app);
    launcher.showed();
    int code = app.exec();
    shell.drain();
    return code;
}

#include "main.moc"
