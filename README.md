# eee-review

Reviews auf dem Asus Eee Note EA800: Ein Coding-Agent schickt Specs, Pläne oder Code-Änderungen
aufs Tablet. Dort wird mit dem Stift markiert und handschriftlich kommentiert, und alles geht
Runde für Runde an den Agenten zurück.

```
Agent ──MCP──▶ eee-review mcp ──HTTP──▶ Hub (Laptop, Port 8770) ◀──WLAN── eeereview (Tablet)
```

- **Hub** (`src/hub`): Hält die Reviews unter `~/.eee-review` und rendert Markdown, Code und
  Diffs zu schlichtem HTML. Er liefert Eingangsliste und Review-Seiten ans Tablet. Die
  Agenten-API ist nur über localhost erreichbar.
- **MCP-Server** (`src/mcp`): Stellt dem Agenten die Tools `review_create`, `review_wait`,
  `review_respond`, `review_add_context`, `review_close` und `review_list` bereit. Ist der Hub
  noch nicht gestartet, startet der MCP-Server ihn im Hintergrund.
- **Tablet-Seite** (`web/`): Leiste unten mit Stift, Radierer und Hand. Dazu kommen eine
  Notiz, die sich größer ziehen und endlos scrollen lässt, eine Scrollleiste mit den Nummern
  der Markierungen, Stempel (OK, Nein, ?) und die Schaltfläche „Frage", die sofort Kontext beim
  Agenten anfordert. Jeder Strich wird automatisch gespeichert.
- **eeereview** (`native/`): Qt-Embedded-4.6-App für das Tablet. Sie zeigt die Seiten in
  einem WebView und liest den Stift direkt von `/dev/input/event2`, mit rund 130 Punkten pro
  Sekunde und Druck. Die Tinte zeichnet sie selbst über die Seite.

## Einrichten

```sh
npm install
claude mcp add eee-review --scope user -- node "$PWD/src/cli.mjs" mcp
ln -s "$PWD/skill" ~/.claude/skills/eee-review      # optional: Ablauf für den Agenten
```

Tablet-App bauen (Docker; lädt beim ersten Mal die FreeeNote-Werkzeugkette, etwa 78 MB, und
braucht für die Mac-Seite des USB-Links `brew install libusb`) und aufs Tablet bringen (Telnet
aus FreeeNote, Hub muss laufen):

```sh
npm run native
node src/cli.mjs hub &
node src/cli.mjs deploy <tablet-ip>   # beim ersten Mal über WLAN, danach übers Kabel
```

Auf dem Tablet startet `/eTablet/eee-review/start.sh` den USB-Link und die App.

## Per Kabel statt WLAN

`eeelink` (`native/eeelink`) tunnelt TCP durch das USB-Kabel, ohne IP. Echtes USB-Netzwerk
geht mit diesem Tablet am Mac nicht: Es bietet Ethernet nur als RNDIS an, und macOS hat
dafür keinen Treiber. Der serielle ACM-Modus lässt den seriellen Treiber von macOS schon beim
Öffnen hängen. Übrig bleibt `g_serial` im rohen Bulk-Modus: macOS lässt das Gerät in Ruhe,
die Mac-Seite spricht es über libusb an, und das Tablet nutzt `/dev/ttyGS0`.

- Auf dem Tablet lauscht `eeelink` auf `127.0.0.1:8770`. Die App lädt zuerst diese Adresse
  und erst danach die WLAN-Adresse des Hubs.
- Auf dem Mac startet der Hub `eeelink-host` selbst mit. Es verbindet die Anfragen des Tablets
  mit dem Hub und leitet `127.0.0.1:2323` auf das Telnet des Tablets weiter; darüber läuft
  auch `deploy`.
- Mit `EEE_REVIEW_BIND=127.0.0.1` lauscht der Hub nur noch lokal, und das Tablet erreicht
  ihn nur noch übers Kabel. Mit abgeschaltetem WLAN ist dann auch das Telnet des Tablets
  von außen nicht mehr zu erreichen.

## Ablauf

1. „Schick mir das Spec zum Review" oder „Lass mich den Code reviewen". Der Agent ruft
   `review_create` und dann `review_wait` auf.
2. Das Review erscheint in der Eingangsliste auf dem Tablet. Antippen, lesen, markieren.
3. Über „Dateien" wählst du Dokument, Diff oder ganze Datei; von einem Diff aus springst du
   mit „Ganze Datei an dieser Stelle" direkt zur ganzen Datei. Mit „An den Agenten senden"
   schickst du die Runde ab.
4. Der Agent liest die Markierungen, ändert die Dateien und antwortet. Die nächste Runde
   beginnt mit einer Seite „Antworten": deine Notiz, seine Lesart und seine Antwort.

## Entwickeln

```sh
npm test
EEE_REVIEW_HOME=/tmp/eee EEE_REVIEW_PORT=8771 node src/cli.mjs hub
```

Die Tablet-Seite muss in QtWebKit 533 laufen, also Safari-5-Niveau: ES5 ohne `bind`, kein
`classList`, kein Flexbox. Die Druckkurve steht an drei Stellen, die zusammen geändert werden
müssen: `src/render/ink.mjs`, `web/review.js` und `native/common/pen.h`.
