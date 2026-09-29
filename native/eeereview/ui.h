// Drawing and button names shared by the app's views.

#ifndef EEE_UI_H
#define EEE_UI_H

#include <QtGui>

namespace native {

inline void paintButton(QPainter &p, const QRect &rect, const QString &label, bool on, int px = 18) {
    QFont f = p.font();
    f.setPixelSize(px);
    f.setBold(false);
    p.setFont(f);
    p.fillRect(rect, on ? Qt::black : Qt::white);
    p.setPen(QPen(Qt::black, 2));
    p.drawRect(rect.adjusted(1, 1, -1, -1));
    p.setPen(on ? Qt::white : Qt::black);
    p.drawText(rect, Qt::AlignCenter, label);
}

// The Eee Note's buttons arrive as function keys.
inline QString buttonName(int key) {
    switch (key) {
    case Qt::Key_F1: return "back";
    case Qt::Key_F2: return "g1";
    case Qt::Key_F3: return "g2";
    case Qt::Key_F4: return "g3";
    case Qt::Key_F5: return "g4";
    case Qt::Key_F6: return "left";
    case Qt::Key_F9: return "home";
    case Qt::Key_F12: return "right";
    default: return QString();
    }
}

} // namespace native

#endif
