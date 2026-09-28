// The app's copy of the open reviews, so they can be reviewed away from the laptop. While a
// hub answers, the mirror keeps the inbox, each review and all its pages on the tablet, and
// what the app sends goes into an outbox first, which is sent on whenever the hub answers.
//
// Under the cache directory:
//   inbox.json                          the inbox as the hub last sent it
//   <id>/review.json, <id>/version      the review as the hub last sent it, and its round:docs:status
//   <id>/marks.json                     the tablet's own marks, as last saved
//   <id>/<round>/<doc>/index.json, <n>.png   the pages
//   <id>/out/<seq>-<action>.json        posts the hub has not taken yet
//   <id>/refused/<seq>-<action>.json    posts the hub refused, kept for the user to see

#ifndef EEE_MIRROR_H
#define EEE_MIRROR_H

#include <QtCore>
#include <QtNetwork>
#include <QtScript>

#include <unistd.h>

namespace native {

// Qt 4.6's QScriptValue::toVariant leaves objects as script objects, so values are walked here.
inline QVariant fromScript(const QScriptValue &value) {
    if (value.isArray()) {
        QVariantList list;
        int length = value.property("length").toInt32();
        for (int i = 0; i < length; ++i) list << fromScript(value.property(i));
        return list;
    }
    if (value.isObject()) {
        QVariantMap map;
        QScriptValueIterator it(value);
        while (it.hasNext()) {
            it.next();
            map.insert(it.name(), fromScript(it.value()));
        }
        return map;
    }
    if (value.isNull() || value.isUndefined()) return QVariant();
    return value.toVariant();
}

inline QVariant parseJson(const QByteArray &data) {
    QScriptEngine engine;
    return fromScript(engine.evaluate("(" + QString::fromUtf8(data) + ")"));
}

inline QByteArray readFile(const QString &path) {
    QFile f(path);
    return f.open(QIODevice::ReadOnly) ? f.readAll() : QByteArray();
}

// Written aside and renamed, and synced, so a flat battery leaves the old file or the new one.
inline bool writeFile(const QString &path, const QByteArray &data) {
    QDir().mkpath(QFileInfo(path).path());
    QFile f(path + ".tmp");
    if (!f.open(QIODevice::WriteOnly) || f.write(data) != data.size()) return false;
    f.flush();
    fsync(f.handle());
    f.close();
    QFile::remove(path);
    return QFile::rename(path + ".tmp", path);
}

inline void removeTree(const QString &path) {
    QDir dir(path);
    foreach (const QFileInfo &entry, dir.entryInfoList(QDir::NoDotAndDotDot | QDir::AllEntries | QDir::Hidden)) {
        if (entry.isDir()) removeTree(entry.filePath());
        else QFile::remove(entry.filePath());
    }
    dir.rmdir(path);
}

// Aborts its reply after a while: a pulled cable leaves eeelink's local end accepting and
// never answering. (QNetworkReply::abort is no slot in Qt 4.6.)
class Deadline : public QObject {
    Q_OBJECT
public:
    Deadline(QNetworkReply *reply, int ms) : QObject(reply), reply(reply) { QTimer::singleShot(ms, this, SLOT(expire())); }
private slots:
    void expire() { reply->abort(); }
private:
    QNetworkReply *reply;
};

class Mirror : public QObject {
    Q_OBJECT
public:
    Mirror(const QStringList &urls, const QString &dir)
        : urls(urls), dir(dir + "/"), state("probing"), tried(0), attempts(0), firstProbe(true), pinging(false), pushing(0), syncing(0),
          syncPaused(false), lastSeq(0) {
        connect(&net, SIGNAL(finished(QNetworkReply *)), this, SLOT(fetched(QNetworkReply *)));
        connect(&refreshTimer, SIGNAL(timeout()), this, SLOT(refresh()));
        reprobeTimer.setSingleShot(true);
        connect(&reprobeTimer, SIGNAL(timeout()), this, SLOT(reprobe()));
        items = parseJson(readFile(this->dir + "inbox.json")).toList();
        foreach (const QVariant &v, items) nextMissing(v.toMap().value("id").toString());
    }

    // "probing" until the first answer or the last address failed, then "online" or "offline".
    QString connection() const { return state; }
    bool online() const { return state == "online"; }
    bool viaCable() const { return online() && hub == urls.value(0); }
    bool hasInbox() const { return QFile::exists(dir + "inbox.json"); }
    QVariantList inbox() const { return items; }

    // Everything of the review is on the tablet.
    bool ready(const QString &id) const { return syncs.value(id).done; }
    QStringList outbox(const QString &id) const {
        return QDir(dir + id + "/out").entryList(QStringList() << "*.json", QDir::Files, QDir::Name);
    }
    bool submitWaiting(const QString &id) const {
        foreach (const QString &name, outbox(id))
            if (name.endsWith("-submit.json")) return true;
        return false;
    }
    int refused(const QString &id) const {
        return QDir(dir + id + "/refused").entryList(QStringList() << "*.json", QDir::Files).size();
    }
    int waiting() const {
        int n = 0;
        foreach (const QString &id, QDir(dir).entryList(QDir::Dirs | QDir::NoDotAndDotDot)) n += outbox(id).size();
        return n;
    }

    // The marks the tablet last saved for the round, or an invalid value when it saved none.
    QVariant marks(const QString &id, int round) const {
        QVariantMap saved = parseJson(readFile(dir + id + "/marks.json")).toMap();
        return saved.value("round").toInt() == round ? saved.value("marks") : QVariant();
    }

    // A review ("<id>/review.json") or a page file ("<id>/<round>/<doc>/<file>"), from the
    // tablet when it is there and from the hub otherwise; answered through got().
    void get(const QString &key) {
        if (QFile::exists(dir + key) && !(key.endsWith("/review.json") && online() && stale(key.section('/', 0, 0)))) {
            local << key;
            QTimer::singleShot(0, this, SLOT(answerLocal()));
        } else if (state == "probing") waitingGets << key;
        else if (online()) download(key, "get");
        else {
            failed << key;
            QTimer::singleShot(0, this, SLOT(answerLocal()));
        }
    }

    // Queues a post for the hub. A draft or a submit carries all the marks, so it replaces a
    // draft still waiting, and becomes the marks the tablet shows next time.
    void post(const QString &id, const QString &action, const QByteArray &body) {
        QString out = dir + id + "/out/";
        if (action != "request") {
            foreach (const QString &name, outbox(id))
                if (name.endsWith("-draft.json")) QFile::remove(out + name);
            writeFile(dir + id + "/marks.json", body);
        }
        qint64 seq = qint64(QDateTime::currentDateTime().toTime_t()) * 1000 + QTime::currentTime().msec();
        lastSeq = qMax(seq, lastSeq + 1);
        writeFile(out + QString("%1-%2.json").arg(lastSeq, 14, 10, QChar('0')).arg(action), body);
        push();
    }

    // On the way out: gives what waits a moment to reach the hub, since the outbox is only
    // sent again once the app runs.
    void drain(int ms) {
        QTime clock;
        clock.start();
        QTimer tick;
        tick.start(100);
        while (online() && waiting() && clock.elapsed() < ms) QCoreApplication::processEvents(QEventLoop::WaitForMoreEvents);
    }

signals:
    void got(const QString &key, const QByteArray &data, bool ok);
    void sent(const QString &id, const QString &action);
    void changed();

public slots:
    void start() {
        tried = 0;
        attempts = 0;
        firstProbe = true;
        setState("probing");
        probe();
    }
    // Looks for the hub again now, not when the next try is due.
    void reconnect() {
        if (online() || pinging) return;
        reprobeTimer.stop();
        setState("probing");
        reprobe();
    }
    void refresh() {
        if (!online()) return;
        QNetworkReply *reply = request(hub + "api/inbox", 5000);
        reply->setProperty("kind", "inbox");
    }

private slots:
    void probe() {
        pinging = true;
        QNetworkReply *reply = request(urls[tried] + "api/ping", tried == 0 ? 2000 : 4000);
        reply->setProperty("kind", "ping");
    }
    void reprobe() {
        tried = 0;
        attempts = 0;
        probe();
    }
    void answerLocal() {
        QStringList keys = local, missing = failed;
        local.clear();
        failed.clear();
        foreach (const QString &key, keys) emit got(key, readFile(dir + key), true);
        foreach (const QString &key, missing) emit got(key, QByteArray(), false);
    }

    void fetched(QNetworkReply *reply) {
        reply->deleteLater();
        QString kind = reply->property("kind").toString();
        int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        bool ok = reply->error() == QNetworkReply::NoError;
        if (kind == "ping") {
            pinging = false;
            if (ok) {
                hub = urls[tried];
                fprintf(stderr, "mirror: hub at %s\n", qPrintable(hub));
                refreshTimer.start(10000);
                setState("online");
                refresh();
                push();
                return;
            }
            if (firstProbe) fprintf(stderr, "mirror: no hub at %s: %s\n", qPrintable(urls[tried]), qPrintable(reply->errorString()));
            // The cable comes up a few seconds after start.sh loads the gadget, once the Mac has
            // noticed the device and eeelink on both ends has connected, so it gets several tries.
            if (firstProbe && tried == 0 && ++attempts < CABLE_ATTEMPTS) {
                QTimer::singleShot(1000, this, SLOT(probe()));
                return;
            }
            if (++tried < urls.size()) {
                attempts = 0;
                probe();
                return;
            }
            firstProbe = false;
            setState("offline");
            reprobeTimer.start(10000);
            return;
        }
        if (kind == "inbox" && !ok) {
            // Only the inbox decides: a first render of a long page can outlast its timeout.
            fprintf(stderr, "mirror: inbox failed, offline: %s\n", qPrintable(reply->errorString()));
            goOffline();
        } else if (kind == "inbox") {
            QByteArray data = reply->readAll();
            items = parseJson(data).toList();
            writeFile(dir + "inbox.json", data);
            prune();
            syncPaused = false;
            emit changed();
            push();
            sync();
        } else if (kind == "get" || kind == "sync") {
            QString key = reply->property("key").toString();
            if (ok) store(key, reply->readAll());
            else fprintf(stderr, "mirror: %s %s failed: %s\n", qPrintable(kind), qPrintable(key), qPrintable(reply->errorString()));
            if (kind == "get") emit got(key, ok ? readFile(dir + key) : QByteArray(), ok);
            else {
                syncing = 0;
                if (!ok) syncPaused = true;
                sync();
            }
        } else if (kind == "push") {
            pushing = 0;
            QString file = reply->property("file").toString();
            // The hub refuses what it cannot take (a round that has moved on), which a retry
            // would not change.
            if (!ok && status == 0) fprintf(stderr, "mirror: sending %s failed: %s\n", qPrintable(file), qPrintable(reply->errorString()));
            else if (ok || (status >= 400 && status < 500)) {
                if (ok) QFile::remove(file);
                else {
                    fprintf(stderr, "mirror: hub refused %s: %d\n", qPrintable(file), status);
                    QString id = reply->property("id").toString();
                    QDir().mkpath(dir + id + "/refused");
                    QFile::rename(file, dir + id + "/refused/" + QFileInfo(file).fileName());
                }
                if (ok) emit sent(reply->property("id").toString(), reply->property("action").toString());
                emit changed();
                push();
            }
        }
    }

private:
    static const int CABLE_ATTEMPTS = 6;

    QNetworkReply *request(const QString &url, int timeout, const QByteArray *body = 0) {
        QNetworkRequest req((QUrl(url)));
        QNetworkReply *reply;
        if (body) {
            req.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
            reply = net.post(req, *body);
        } else reply = net.get(req);
        new Deadline(reply, timeout);
        return reply;
    }

    void setState(const QString &s) {
        if (s == state) return;
        state = s;
        if (s != "probing") {
            foreach (const QString &key, waitingGets) get(key);
            waitingGets.clear();
        }
        emit changed();
    }
    void goOffline() {
        hub.clear();
        refreshTimer.stop();
        setState("offline");
        reprobeTimer.start(3000);
        if (syncing) syncing->abort();
        if (pushing) pushing->abort();
    }

    QVariantMap item(const QString &id) const {
        foreach (const QVariant &v, items)
            if (v.toMap().value("id").toString() == id) return v.toMap();
        return QVariantMap();
    }
    // The review's copy is fetched again when this changes: a new round, context added, or the
    // status the app locks a submitted round by.
    QString version(const QString &id) const {
        QVariantMap it = item(id);
        return QString("%1:%2:%3").arg(it.value("round").toInt()).arg(it.value("docs").toInt()).arg(it.value("status").toString());
    }
    bool stale(const QString &id) const { return QString::fromUtf8(readFile(dir + id + "/version")) != version(id); }

    QString remote(const QString &key) const {
        QStringList parts = key.split('/');
        if (parts.size() == 2) return QString("api/r/%1").arg(parts[0]);
        return QString("r/%1/%2/pages/%3/%4").arg(parts[0], parts[1], parts[2], parts[3]);
    }
    void download(const QString &key, const QString &kind) {
        QNetworkReply *reply = request(hub + remote(key), 60000);
        reply->setProperty("kind", kind);
        reply->setProperty("key", key);
        if (kind == "sync") syncing = reply;
    }
    void store(const QString &key, const QByteArray &data) {
        writeFile(dir + key, data);
        if (key.endsWith("/review.json")) {
            QString id = key.section('/', 0, 0);
            writeFile(dir + id + "/version", version(id).toUtf8());
        }
    }

    // One post at a time, oldest first, so a review's draft never overtakes its submit.
    void push() {
        if (!online() || pushing) return;
        QStringList files;
        foreach (const QString &id, QDir(dir).entryList(QDir::Dirs | QDir::NoDotAndDotDot))
            foreach (const QString &name, outbox(id)) files << name + "|" + id;
        if (files.isEmpty()) return;
        files.sort();
        QString name = files[0].section('|', 0, 0), id = files[0].section('|', 1, 1);
        QString action = name.section('-', 1).section('.', 0, 0);
        QString file = dir + id + "/out/" + name;
        QByteArray body = readFile(file);
        pushing = request(QString("%1api/r/%2/%3").arg(hub, id, action), 30000, &body);
        pushing->setProperty("kind", "push");
        pushing->setProperty("file", file);
        pushing->setProperty("id", id);
        pushing->setProperty("action", action);
    }

    // Fetches what is missing of the open reviews, one file at a time, in inbox order. Each
    // review's position is kept, so every file is looked for once.
    struct Sync {
        Sync() : doc(0), strip(-1), count(0), done(false) {}
        QString version;
        int doc, strip, count;
        bool done;
    };
    void sync() {
        if (!online() || syncing || syncPaused) return;
        foreach (const QVariant &v, items) {
            QString id = v.toMap().value("id").toString();
            QString missing = nextMissing(id);
            if (missing.isEmpty()) continue;
            download(missing, "sync");
            return;
        }
    }
    QString nextMissing(const QString &id) {
        QVariantMap it = item(id);
        int round = it.value("round").toInt(), docs = it.value("docs").toInt();
        Sync &s = syncs[id];
        if (s.version != version(id)) {
            s = Sync();
            s.version = version(id);
        }
        if (s.done) return QString();
        if (stale(id)) return id + "/review.json";
        for (; s.doc < docs; ++s.doc, s.strip = -1) {
            QString base = QString("%1/%2/%3/").arg(id).arg(round).arg(s.doc);
            if (s.strip < 0) {
                QByteArray index = readFile(dir + base + "index.json");
                if (index.isEmpty()) return base + "index.json";
                QRegExp count("\"count\":(\\d+)");
                s.count = count.indexIn(QString::fromUtf8(index.left(200))) >= 0 ? count.cap(1).toInt() : 0;
                s.strip = 0;
            }
            for (; s.strip < s.count; ++s.strip)
                if (!QFile::exists(QString("%1%2%3.png").arg(dir, base).arg(s.strip))) return QString("%1%2.png").arg(base).arg(s.strip);
        }
        s.done = true;
        fprintf(stderr, "mirror: %s is on the tablet\n", qPrintable(id));
        foreach (const QString &name, QDir(dir + id).entryList(QDir::Dirs | QDir::NoDotAndDotDot))
            if (name != QString::number(round) && name != "out") removeTree(dir + id + "/" + name);
        emit changed();
        return QString();
    }

    // Reviews gone from the inbox are closed; their copies go once nothing of them waits.
    void prune() {
        foreach (const QString &id, QDir(dir).entryList(QDir::Dirs | QDir::NoDotAndDotDot))
            if (item(id).isEmpty() && outbox(id).isEmpty()) {
                removeTree(dir + id);
                syncs.remove(id);
            }
    }

    QStringList urls;
    QString dir, hub, state;
    int tried, attempts;
    bool firstProbe, pinging;
    QNetworkAccessManager net;
    QTimer refreshTimer, reprobeTimer;
    QVariantList items;
    QStringList local, failed, waitingGets;
    QNetworkReply *pushing, *syncing;
    bool syncPaused;
    qint64 lastSeq;
    QMap<QString, Sync> syncs;
};

} // namespace native

#endif
