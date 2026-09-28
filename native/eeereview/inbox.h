// The app's start: finds a hub, then lists the open reviews from /api/inbox and opens one
// on a tap. The hub URLs are tried in order: the cable first (eeelink's local end), then
// the Wi-Fi address deploy left behind.

#ifndef EEE_INBOX_H
#define EEE_INBOX_H

#include <QtGui>
#include <QtNetwork>

#include "native.h"

namespace native {

class InboxWidget : public QWidget {
    Q_OBJECT
public:
    InboxWidget(const QStringList &urls) : urls(urls), tried(0), attempts(0), pending(0), pressed(false), scrollY(0) {
        setAttribute(Qt::WA_OpaquePaintEvent);
        setFocusPolicy(Qt::StrongFocus);
        connect(&net, SIGNAL(finished(QNetworkReply *)), this, SLOT(fetched(QNetworkReply *)));
        probeTimeout.setSingleShot(true);
        connect(&probeTimeout, SIGNAL(timeout()), this, SLOT(probeTimedOut()));
        connect(&refreshTimer, SIGNAL(timeout()), this, SLOT(refresh()));
        state = "probing";
    }
    QString hubUrl() const { return hub; }

signals:
    void open(const QString &id);

public slots:
    void start() {
        state = "probing";
        update();
        if (tried >= urls.size()) {
            fprintf(stderr, "no hub reachable\n");
            state = "unreachable";
            update();
            return;
        }
        pending = net.get(QNetworkRequest(QUrl(urls[tried] + "api/ping")));
        pending->setProperty("what", "ping");
        probeTimeout.start(tried == 0 ? 2000 : 4000);
    }
    void refresh() {
        if (hub.isEmpty()) return;
        QNetworkReply *reply = net.get(QNetworkRequest(QUrl(hub + "api/inbox")));
        reply->setProperty("what", "inbox");
    }

    void penDown(const QPoint &screen) {
        pressed = true;
        downAt = lastAt = mapFromGlobal(screen);
        startScroll = scrollY;
        moved = 0;
    }
    void penMoved(const QPoint &screen) {
        if (!pressed) return;
        QPoint p = mapFromGlobal(screen);
        moved = qMax(moved, qAbs(p.y() - downAt.y()));
        lastAt = p;
        if (state == "list" && moved > TAP_MAX) scrollTo(startScroll - (p.y() - downAt.y()));
    }
    void penBurst() {}
    void penUp() {
        if (!pressed) return;
        pressed = false;
        if (moved <= TAP_MAX) tap(downAt);
    }

protected:
    void keyPressEvent(QKeyEvent *event) {
        QString name = buttonName(event->key());
        if (name == "left") scrollTo(scrollY - height() * 3 / 4);
        else if (name == "right") scrollTo(scrollY + height() * 3 / 4);
        else if (name == "back" || name == "home" || event->key() == Qt::Key_Escape) qApp->quit();
        else if (name.isEmpty()) fprintf(stderr, "key 0x%x\n", event->key());
    }
    void mousePressEvent(QMouseEvent *) {}
    void mouseMoveEvent(QMouseEvent *) {}
    void mouseReleaseEvent(QMouseEvent *) {}

    void paintEvent(QPaintEvent *event) {
        QPainter p(this);
        p.setClipRect(event->rect());
        p.fillRect(rect(), Qt::white);
        QFont f = font();
        f.setBold(true);
        f.setPixelSize(30);
        p.setFont(f);
        p.setPen(Qt::black);
        if (state == "probing") {
            f.setBold(false);
            f.setPixelSize(22);
            p.setFont(f);
            p.drawText(rect(), Qt::AlignCenter, QString::fromUtf8("Suche den Hub \xe2\x80\xa6"));
            return;
        }
        if (state == "unreachable") {
            p.drawText(QRect(40, 40, width() - 80, 50), Qt::AlignLeft | Qt::AlignVCenter, "Kein Hub erreichbar");
            f.setBold(false);
            f.setPixelSize(19);
            p.setFont(f);
            p.drawText(QRect(40, 100, width() - 80, 120), Qt::AlignLeft | Qt::TextWordWrap,
                       QString::fromUtf8("Der Hub auf dem Laptop antwortet weder \xc3\xbc" "ber das USB-Kabel noch \xc3\xbc" "ber WLAN. "
                                         "L\xc3\xa4uft eee-review hub, und steckt das Kabel?"));
            paintButton(p, retryRect(), "Nochmal", false, 22);
            paintButton(p, quitRect(), "Beenden", false, 22);
            return;
        }
        p.translate(0, -scrollY);
        p.drawText(QRect(16, 12, width() - 200, 50), Qt::AlignLeft | Qt::AlignVCenter, "Reviews");
        paintButton(p, quitRect(), "Beenden", false, 20);
        if (items.isEmpty()) {
            f.setBold(false);
            f.setPixelSize(20);
            p.setFont(f);
            p.drawText(QRect(16, 80, width() - 32, 60), Qt::AlignLeft | Qt::TextWordWrap,
                       QString::fromUtf8("Nichts offen. Neue Reviews erscheinen hier von selbst."));
        }
        for (int i = 0; i < items.size(); ++i) {
            QRect box = itemRect(i);
            QVariantMap item = items[i].toMap();
            bool fresh = item.value("status").toString() == "open";
            p.fillRect(box, Qt::black);
            p.fillRect(box.adjusted(fresh ? 6 : 3, fresh ? 6 : 3, fresh ? -6 : -3, fresh ? -6 : -3), Qt::white);
            f.setBold(true);
            f.setPixelSize(24);
            p.setFont(f);
            QRect text = box.adjusted(18, 10, -18, -10);
            p.drawText(text, Qt::AlignLeft | Qt::AlignTop, p.fontMetrics().elidedText(item.value("title").toString(), Qt::ElideRight, text.width()));
            f.setBold(false);
            f.setPixelSize(18);
            p.setFont(f);
            QString sub = QString::fromUtf8("%1 \xc2\xb7 Runde %2 \xc2\xb7 %3")
                              .arg(item.value("kind").toString() == "code" ? "Code" : "Dokument")
                              .arg(item.value("round").toInt())
                              .arg(item.value("label").toString());
            p.setPen(QColor(0x44, 0x44, 0x44));
            p.drawText(text, Qt::AlignLeft | Qt::AlignBottom, sub);
            p.setPen(Qt::black);
        }
    }

private slots:
    void fetched(QNetworkReply *reply) {
        reply->deleteLater();
        QString what = reply->property("what").toString();
        if (what == "ping") {
            if (reply != pending) return;
            probeTimeout.stop();
            pending = 0;
            if (reply->error() == QNetworkReply::NoError) {
                hub = urls[tried];
                fprintf(stderr, "hub at %s\n", qPrintable(hub));
                state = "list";
                refresh();
                refreshTimer.start(10000);
                update();
                return;
            }
            fprintf(stderr, "no hub at %s: %s\n", qPrintable(urls[tried]), qPrintable(reply->errorString()));
            // The cable comes up a few seconds after start.sh loads the gadget, once the Mac has
            // noticed the device and eeelink on both ends has connected, so it gets several tries.
            if (tried == 0 && ++attempts < CABLE_ATTEMPTS) {
                QTimer::singleShot(1000, this, SLOT(start()));
                return;
            }
            ++tried;
            attempts = 0;
            start();
        } else if (what == "inbox" && reply->error() == QNetworkReply::NoError) {
            items = parseJson(reply->readAll()).toList();
            if (isVisible()) update();
        }
    }
    void probeTimedOut() {
        if (pending) pending->abort();
    }

private:
    static const int CABLE_ATTEMPTS = 6;
    QRect quitRect() const { return state == "unreachable" ? QRect(230, 240, 170, 56) : QRect(width() - 150, 16, 134, 44); }
    QRect retryRect() const { return QRect(40, 240, 170, 56); }
    QRect itemRect(int i) const { return QRect(16, 76 + i * 104, width() - 32, 92); }

    void scrollTo(int y) {
        int content = itemRect(items.size()).top() + 20;
        int target = qBound(0, y, qMax(0, content - height()));
        if (target == scrollY) return;
        scrollY = target;
        update();
    }

    void tap(const QPoint &at) {
        if (state == "unreachable") {
            if (retryRect().contains(at)) {
                tried = 0;
                attempts = 0;
                start();
            } else if (quitRect().contains(at)) qApp->quit();
            return;
        }
        if (state != "list") return;
        QPoint p = at + QPoint(0, scrollY);
        if (quitRect().contains(p)) {
            qApp->quit();
            return;
        }
        for (int i = 0; i < items.size(); ++i)
            if (itemRect(i).contains(p)) emit open(items[i].toMap().value("id").toString());
    }

    QStringList urls;
    int tried, attempts;
    QString hub, state;
    QNetworkAccessManager net;
    QNetworkReply *pending;
    QTimer probeTimeout, refreshTimer;
    QVariantList items;
    bool pressed;
    QPoint downAt, lastAt;
    int moved, startScroll, scrollY;
};

} // namespace native

#endif
