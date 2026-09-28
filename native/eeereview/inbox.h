// The app's start: lists the open reviews as the Mirror knows them, whether a hub answers or
// not, and opens one on a tap. Without a hub and without a copy there is nothing to show.

#ifndef EEE_INBOX_H
#define EEE_INBOX_H

#include <QtGui>

#include "mirror.h"
#include "native.h"

namespace native {

class InboxWidget : public QWidget {
    Q_OBJECT
public:
    InboxWidget(Mirror *mirror) : mirror(mirror), pressed(false), scrollY(0) {
        setAttribute(Qt::WA_OpaquePaintEvent);
        setFocusPolicy(Qt::StrongFocus);
        connect(mirror, SIGNAL(changed()), this, SLOT(changed()));
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
        if (state() == "list" && moved > TAP_MAX) scrollTo(startScroll - (p.y() - downAt.y()));
    }
    void penBurst() {}
    void penUp() {
        if (!pressed) return;
        pressed = false;
        if (moved <= TAP_MAX) tap(downAt);
    }

signals:
    void open(const QString &id);

public slots:
    void changed() {
        if (isVisible()) update();
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
        QString now = state();
        if (now == "probing") {
            f.setBold(false);
            f.setPixelSize(22);
            p.setFont(f);
            p.drawText(rect(), Qt::AlignCenter, QString::fromUtf8("Suche den Hub \xe2\x80\xa6"));
            return;
        }
        if (now == "unreachable") {
            p.drawText(QRect(40, 40, width() - 80, 50), Qt::AlignLeft | Qt::AlignVCenter, "Kein Hub erreichbar");
            f.setBold(false);
            f.setPixelSize(19);
            p.setFont(f);
            p.drawText(QRect(40, 100, width() - 80, 120), Qt::AlignLeft | Qt::TextWordWrap,
                       QString::fromUtf8("Der Hub auf dem Laptop antwortet weder \xc3\xbc" "ber das USB-Kabel noch \xc3\xbc" "ber WLAN, "
                                         "und auf dem Tablet liegt noch nichts. L\xc3\xa4uft eee-review hub, und steckt das Kabel?"));
            paintButton(p, retryRect(), "Nochmal", false, 22);
            paintButton(p, quitRect(), "Beenden", false, 22);
            return;
        }
        p.translate(0, -scrollY);
        p.drawText(QRect(16, 12, width() - 200, 50), Qt::AlignLeft | Qt::AlignVCenter, "Reviews");
        paintButton(p, quitRect(), "Beenden", false, 20);
        if (mirror->connection() == "offline") paintButton(p, connectRect(), "Verbinden", false, 20);
        paintConnection(p);
        QVariantList items = mirror->inbox();
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
            QString id = item.value("id").toString();
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
            QString label = item.value("label").toString();
            if (mirror->submitWaiting(id)) label = mirror->online() ? "wird gesendet" : "wartet auf den Hub";
            QString copy = mirror->ready(id) ? QString("auf dem Tablet")
                         : mirror->online() ? QString::fromUtf8("l\xc3\xa4" "dt \xe2\x80\xa6")
                                            : QString("nur mit Hub");
            QString sub = QString::fromUtf8("%1 \xc2\xb7 Runde %2 \xc2\xb7 %3 \xc2\xb7 %4")
                              .arg(item.value("kind").toString() == "code" ? "Code" : "Dokument")
                              .arg(item.value("round").toInt())
                              .arg(label, copy);
            p.setPen(QColor(0x44, 0x44, 0x44));
            p.drawText(text, Qt::AlignLeft | Qt::AlignBottom, sub);
            p.setPen(Qt::black);
        }
    }

private:
    // The list whenever there is one to show, from the hub or the tablet's copy.
    QString state() const {
        if (mirror->hasInbox() || mirror->online()) return "list";
        return mirror->connection() == "probing" ? "probing" : "unreachable";
    }
    void paintConnection(QPainter &p) {
        QString text;
        if (mirror->connection() == "probing") text = QString::fromUtf8("Suche den Hub \xe2\x80\xa6");
        else if (mirror->online()) text = mirror->viaCable() ? "Hub per Kabel" : "Hub per WLAN";
        else text = "Offline";
        int waiting = mirror->waiting();
        if (waiting) text += QString::fromUtf8(" \xc2\xb7 %1 wartend").arg(waiting);
        QFont f = font();
        f.setPixelSize(18);
        p.setFont(f);
        p.setPen(QColor(0x44, 0x44, 0x44));
        int right = mirror->connection() == "offline" ? connectRect().left() : quitRect().left();
        p.drawText(QRect(170, 12, right - 16 - 170, 50), Qt::AlignRight | Qt::AlignVCenter, text);
        p.setPen(Qt::black);
    }
    QRect quitRect() const { return state() == "unreachable" ? QRect(230, 240, 170, 56) : QRect(width() - 150, 16, 134, 44); }
    QRect connectRect() const { return QRect(width() - 300, 16, 134, 44); }
    QRect retryRect() const { return QRect(40, 240, 170, 56); }
    QRect itemRect(int i) const { return QRect(16, 76 + i * 104, width() - 32, 92); }

    void scrollTo(int y) {
        int content = itemRect(mirror->inbox().size()).top() + 20;
        int target = qBound(0, y, qMax(0, content - height()));
        if (target == scrollY) return;
        scrollY = target;
        update();
    }

    void tap(const QPoint &at) {
        QString now = state();
        if (now == "unreachable") {
            if (retryRect().contains(at)) mirror->start();
            else if (quitRect().contains(at)) qApp->quit();
            return;
        }
        if (now != "list") return;
        QPoint p = at + QPoint(0, scrollY);
        if (quitRect().contains(p)) {
            qApp->quit();
            return;
        }
        if (mirror->connection() == "offline" && connectRect().contains(p)) {
            mirror->reconnect();
            return;
        }
        QVariantList items = mirror->inbox();
        for (int i = 0; i < items.size(); ++i)
            if (itemRect(i).contains(p)) emit open(items[i].toMap().value("id").toString());
    }

    Mirror *mirror;
    bool pressed;
    QPoint downAt, lastAt;
    int moved, startScroll, scrollY;
};

} // namespace native

#endif
