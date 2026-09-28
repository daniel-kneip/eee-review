// Logs every QCop message on the channels the stock launcher and its apps use, to learn the
// launcher's protocol from a stock app. Runs as a QWS client beside the launcher, without a
// window of its own.
//
//   ./qcopspy [channel ...]

#include <QtGui>
#include <QCopChannel>

#include <cstdio>

class Spy : public QObject {
    Q_OBJECT
public:
    Spy(const QString &name, QObject *parent) : QObject(parent), name(name) {
        QCopChannel *channel = new QCopChannel(name, this);
        connect(channel, SIGNAL(received(QString, QByteArray)), this, SLOT(received(QString, QByteArray)));
    }

private slots:
    void received(const QString &message, const QByteArray &data) {
        QString printable;
        for (int i = 0; i < data.size(); ++i) {
            char c = data[i];
            printable += (c >= 32 && c < 127) ? QChar(c) : QChar('.');
        }
        fprintf(stderr, "%s  %-24s %-28s %3d bytes  %s\n", qPrintable(QTime::currentTime().toString("hh:mm:ss.zzz")),
                qPrintable(name), qPrintable(message), data.size(), qPrintable(printable));
    }

private:
    QString name;
};

int main(int argc, char **argv) {
    QApplication app(argc, argv);
    QStringList channels;
    for (int i = 1; i < argc; ++i) channels << argv[i];
    if (channels.isEmpty()) {
        channels << "launcher" << "statusbar" << "calculator" << "consoleq" << "eeereview" << "keyboardchannel"
                 << "qte/etablepowerchannel" << "qte/etablevkbchannel" << "QPE/System" << "QPE/Application";
    }
    foreach (const QString &c, channels) new Spy(c, &app);
    fprintf(stderr, "listening on %s\n", qPrintable(channels.join(", ")));
    return app.exec();
}

#include "main.moc"
