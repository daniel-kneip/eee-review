// Ink test for the Eee Note EA800: draws what common/pen.h reads from the Wacom, with
// pressure as width. Strokes go to the probe server's /tinte on "Senden".
//
//   ./inktest [http://laptop:8765]

#include <QtGui>
#include <QtNetwork>

#include "../common/pen.h"

struct InkPoint {
    int x, y, pressure;
    qint64 ms;
};
typedef QList<InkPoint> Stroke;

class InkCanvas : public QWidget {
    Q_OBJECT
public:
    InkCanvas(Calibration *calibration, QWidget *parent)
        : QWidget(parent), calibration(calibration), drawing(false) {
        setAttribute(Qt::WA_OpaquePaintEvent);
    }
    QList<Stroke> strokes;

    QPoint toLocal(const InkPoint &p) const { return mapFromGlobal(calibration->toScreen(p.x, p.y)); }

public slots:
    void penDown(int x, int y, int pressure, qint64 ms) {
        drawing = rect().contains(mapFromGlobal(calibration->toScreen(x, y)));
        if (!drawing) return;
        strokes.append(Stroke());
        add(x, y, pressure, ms);
    }
    void penMoved(int x, int y, int pressure, qint64 ms) {
        if (drawing) add(x, y, pressure, ms);
    }
    void penUp() {
        drawing = false;
        emit changed();
    }
    void clear() {
        strokes.clear();
        redraw();
        emit changed();
    }
    void redraw() {
        ink.fill(Qt::white);
        QPainter painter(&ink);
        painter.setRenderHint(QPainter::Antialiasing);
        foreach (const Stroke &s, strokes) {
            for (int i = 1; i < s.size(); ++i) segment(painter, s[i - 1], s[i]);
        }
        update();
    }

signals:
    void changed();

protected:
    // A QPixmap takes the screen's own format; the stock display driver crashes drawing a
    // QImage in RGB16 onto it.
    void resizeEvent(QResizeEvent *) {
        ink = QPixmap(size());
        redraw();
    }
    void paintEvent(QPaintEvent *event) {
        QPainter painter(this);
        painter.drawPixmap(event->rect(), ink, event->rect());
    }

private:
    QRect segment(QPainter &painter, const InkPoint &a, const InkPoint &b) {
        QPoint from = toLocal(a), to = toLocal(b);
        qreal width = inkWidth(b.pressure);
        painter.setPen(QPen(Qt::black, width, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
        painter.drawLine(from, to);
        int pad = int(width) + 2;
        return QRect(from, to).normalized().adjusted(-pad, -pad, pad, pad);
    }
    void add(int x, int y, int pressure, qint64 ms) {
        InkPoint point = { x, y, pressure, ms };
        Stroke &stroke = strokes.last();
        if (!stroke.isEmpty()) {
            QPainter painter(&ink);
            painter.setRenderHint(QPainter::Antialiasing);
            update(segment(painter, stroke.last(), point));
        }
        stroke.append(point);
    }

    Calibration *calibration;
    QPixmap ink;
    bool drawing;
};

class Window : public QWidget {
    Q_OBJECT
public:
    Window(const QString &server) : server(server) {
        setStyleSheet("QPushButton { border: 3px solid black; background: white; padding: 6px 16px; }"
                      "QLabel { padding-left: 10px; }");
        QPushButton *clearButton = new QPushButton(QString::fromUtf8("Löschen"));
        QPushButton *sendButton = new QPushButton("Senden");
        QPushButton *quitButton = new QPushButton("Beenden");
        status = new QLabel;
        canvas = new InkCanvas(&calibration, this);

        QHBoxLayout *bar = new QHBoxLayout;
        bar->addWidget(clearButton);
        bar->addWidget(sendButton);
        bar->addWidget(quitButton);
        bar->addWidget(status, 1);
        QVBoxLayout *layout = new QVBoxLayout(this);
        layout->setContentsMargins(6, 6, 6, 6);
        // The system's header stays above full-screen windows and hides their top edge.
        layout->addWidget(canvas, 1);
        layout->addLayout(bar);

        pen = new PenReader("/dev/input/event2", this);
        connect(pen, SIGNAL(down(int, int, int, qint64)), canvas, SLOT(penDown(int, int, int, qint64)));
        connect(pen, SIGNAL(moved(int, int, int, qint64)), canvas, SLOT(penMoved(int, int, int, qint64)));
        connect(pen, SIGNAL(up()), canvas, SLOT(penUp()));
        connect(canvas, SIGNAL(changed()), this, SLOT(showStats()));
        connect(clearButton, SIGNAL(clicked()), canvas, SLOT(clear()));
        connect(sendButton, SIGNAL(clicked()), this, SLOT(send()));
        connect(quitButton, SIGNAL(clicked()), qApp, SLOT(quit()));
        connect(&network, SIGNAL(finished(QNetworkReply *)), this, SLOT(sent(QNetworkReply *)));
        if (!pen->isOpen()) status->setText("Stift nicht lesbar: /dev/input/event2");
        else if (!calibration.valid) status->setText("Keine Kalibrierung in /etc/pointercal");
        else status->setText("Stift bereit");
    }

private slots:
    void showStats() {
        int points = 0;
        qint64 ms = 0;
        foreach (const Stroke &s, canvas->strokes) {
            points += s.size();
            if (s.size() > 1) ms += s.last().ms - s.first().ms;
        }
        int rate = ms > 0 ? int((points - canvas->strokes.size()) * 1000 / ms) : 0;
        status->setText(QString("%1 Striche, %2 Punkte, %3/s").arg(canvas->strokes.size()).arg(points).arg(rate));
    }
    void send() {
        QStringList strokes;
        foreach (const Stroke &s, canvas->strokes) {
            QStringList points;
            foreach (const InkPoint &p, s) {
                QPoint local = canvas->toLocal(p);
                points << QString("%1,%2,%3,%4").arg(local.x()).arg(local.y()).arg(p.pressure).arg(p.ms);
            }
            strokes << points.join(" ");
        }
        QByteArray body = QString("%1x%2\n%3").arg(canvas->width()).arg(canvas->height()).arg(strokes.join("|")).toUtf8();
        QNetworkRequest request(QUrl(server + "/tinte"));
        request.setHeader(QNetworkRequest::ContentTypeHeader, "text/plain");
        network.post(request, body);
        status->setText("Sende ...");
    }
    void sent(QNetworkReply *reply) {
        status->setText(reply->error() == QNetworkReply::NoError ? "Gesendet" : "Fehler: " + reply->errorString());
        reply->deleteLater();
    }

private:
    QString server;
    QLabel *status;
    InkCanvas *canvas;
    PenReader *pen;
    Calibration calibration;
    QNetworkAccessManager network;
};

int main(int argc, char **argv) {
    QApplication app(argc, argv);
    QFont font = app.font();
    font.setPointSize(16);
    app.setFont(font);
    Window window(argc > 1 ? QString(argv[1]) : QString("http://127.0.0.1:8765"));
    window.showFullScreen();
    return app.exec();
}

#include "main.moc"
