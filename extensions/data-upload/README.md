# data-upload

Ein gemeinsames Upload-Portal für alle Datenpartner mit Anmeldung per E-Mail-Link (zuerst: Stadt Stuttgart). Ersetzt das Google-Sheet + E-Mail-Verfahren.

```
Partner wählt eine freigeschaltete Region, lädt Excel/CSV/PDF/Screenshot hoch + kurze Beschreibung
  → Claude (claude-opus-5-5) ordnet die Daten einem Ziel-Datensatz zu und extrahiert {period, category, value}
  → Server prüft Kategorien/Zeiträume und vergleicht mit der DB (neu / geändert / unverändert)
  → Stadt sieht die Vorschau und klickt »Zur Freigabe senden«
  → Slack-Nachricht mit Diff + Buttons »Übernehmen« / »Ablehnen«
  → »Übernehmen« schreibt in einer Transaktion in die Directus-Collection
```

Daten, die zu keinem Ziel-Datensatz passen, landen trotzdem in Slack (ohne Übernehmen-Button) und werden manuell bearbeitet. Die Originaldateien werden immer in Directus-Files gespeichert.

## URLs

| Pfad | Zweck |
|---|---|
| `GET /data-upload/` | Upload-Portal (Anmeldung per E-Mail-Link) |
| `GET /data-upload/review/:id?sig=…` | Vollständige Diff-Ansicht (Link aus Slack) |
| `POST /data-upload/slack/actions` | Slack Interactivity Request URL |

## Einrichtung

1. **Env-Variablen** im Directus-Container:
   ```
   ANTHROPIC_API_KEY=…
   ANTHROPIC_WORKSPACE_ID=wrkspc_…      # nur nötig bei Keys, die keinem Workspace zugeordnet sind (sk-ant-usr-…)
   SLACK_BOT_TOKEN=…                    # @klimadashbot, braucht chat:write
   SLACK_SIGNING_SECRET=…               # Slack-App → Basic Information
   DATA_UPLOAD_SLACK_CHANNEL=C…         # Kanal für Freigaben; Bot muss Mitglied sein
   DATA_UPLOAD_FOLDER=…                 # directus_folders.id für die Originaldateien (»Daten-Upload (privat)«)
   ```
   `SECRET` und `PUBLIC_URL` nutzt die Extension von Directus mit. Die Anmeldelinks werden über den E-Mail-Versand von Directus verschickt (`EMAIL_TRANSPORT`, `EMAIL_FROM` – derselbe wie für »Passwort vergessen«).
2. **Slack-App** → *Interactivity & Shortcuts* → aktivieren, Request URL:
   `https://<directus-host>/data-upload/slack/actions`
3. Bauen und deployen (`npm run build`, dann Directus neu starten). Die internen Tabellen `data_upload_submissions` und `data_upload_logins` legt die Extension beim ersten Aufruf selbst an.
   Die Collection `data_upload_access` legt sie **nicht** an – sie wurde einmalig über die Directus-API erstellt (Felder siehe unten). Grund: Directus prüft beim Start zunächst gegen die Limits der Core-Lizenz, bis die eigene Lizenz geladen ist; eine Extension, die beim Start Collections anlegt, scheitert daran mit »collections limit exceeded«.
4. Zugänge in `data_upload_access` eintragen (siehe unten).

## Zugänge

Eine Zeile in `data_upload_access` = eine E-Mail-Adresse darf Daten für eine Region hochladen.

| Feld | Bedeutung |
|---|---|
| `email` | Adresse (Groß-/Kleinschreibung egal) |
| `region` | Region (M2O auf `regions`) – die Daten werden immer für diese Region gespeichert, egal was in der Datei steht |
| `datasets` | erlaubte Datensätze; leer = alle |
| `active` | aus = Zugang sofort gesperrt (auch laufende Sitzungen) |
| `note` | frei, z. B. »Statistisches Amt, Ansprechpartnerin für Kfz-Daten« |

Wer mehrere Zeilen hat, wählt die Region im Portal aus einer Liste. Im Verlauf sieht man alle Uploads für die eigenen Regionen, auch die von Kolleg:innen.

Stuttgart: Region **Stuttgart (Gemeinde)** `dd4fd7ac-aa2b-4762-8902-1be6ef2fcdb2` – nicht den gleichnamigen Kreis.

## Anmeldung

Partner geben ihre E-Mail-Adresse ein und bekommen einen Link (20 Min. gültig, einmal verwendbar). Die Sitzung hält 7 Tage. Wird die Zeile in `data_upload_access` deaktiviert oder gelöscht, ist der Zugang sofort gesperrt. Der Link wird erst per JavaScript eingelöst, damit Mail-Scanner (Outlook Safe Links), die Links vorab aufrufen, ihn nicht verbrauchen. Jeder Upload speichert die Adresse der Person, die ihn hochgeladen hat; sie steht auch in der Slack-Nachricht.

## Neuen Datensatz hinzufügen

Eintrag in `src/datasets.ts`: Collection, Kategorien, Periodenformat, Mapping-Hinweise für Claude und `fixedFields` – welche Schlüssel (Region als UUID oder als Code, Land, …) mit jeder Zeile geschrieben werden. Zugänge mit leerer Datensatz-Liste bekommen ihn automatisch; die Auswahl im Feld `datasets` wird beim Neuanlegen der Collection gesetzt und muss für neue Datensätze im Admin ergänzt werden.

## Quelle

Nennt die Datei keine Quelle, wird die Quelle des neuesten vorhandenen Werts derselben Region übernommen, sonst »<Region> (Daten-Upload)«. Die Quelle steht in Vorschau und Slack und kann dort geprüft werden.

## Hinweise

- Pkw-Neuzulassungen (`mobility_cars_registrations`) sind **kumulativ seit Jahresbeginn** (so wie bisher in `mobility_cars_registrations`). `Sonstige` = Brennstoffzelle + Flüssiggas + Erdgas + Sonstige.
- Der **Pkw-Bestand** (Tab »PKW-Bestand« im alten Sheet) geht nach `mobility_cars`, Stichtag = Monatsende. Diese Collection hat keine `update`-Spalte und führt die Region als Code statt UUID. Für kreisfreie Städte (AGS endet auf `000` und der Elternkreis hat die ersten fünf Stellen als Code) wird der Kreis-Code geschrieben, weil die Monatswerte dort liegen: Stuttgart → `08111`. Der geschriebene Schlüssel steht in der Slack-Nachricht (`region=08111, country=DE`); beim Übernehmen wird genau dieser Schlüssel verwendet.
- Freigaben sind idempotent: der Status wird atomar von `pending` auf `applying` gesetzt, ein Doppelklick schreibt nicht doppelt. Beim Übernehmen werden bestehende Werte neu gelesen, gleiche Werte werden übersprungen.

## Sicherheit

- **Anmeldelinks:** 256 Bit Zufall, nur der Hash wird gespeichert, einmal verwendbar, 20 Minuten gültig. Sitzungen sind mit `SECRET` signiert; der Zugang wird bei jeder Anfrage neu geprüft.
- **Limits** (in der Tabelle `data_upload_rate`, gelten über alle Instanzen und Neustarts hinweg): Anmeldelinks 10 pro IP und 5 pro Adresse in 15 Minuten, Link-Einlösen 30 pro IP in 15 Minuten, Auswertungen 20 pro Adresse in 24 Stunden. Uploads: max. 10 Dateien, 20 MB pro Datei, 40 MB insgesamt.
- **Originaldateien** liegen im Ordner `DATA_UPLOAD_FOLDER`. Die Public-Policy darf `directus_files` nur außerhalb dieses Ordners lesen – sonst wären die Dateien über `/files` und `/assets` öffentlich auffindbar.
- **Slack:** Texte von Uploadern und Claude werden escaped (keine `<!channel>`-Erwähnungen oder getarnten Links).
- **Seite:** Directus erlaubt per CSP nur Skripte vom eigenen Server, deshalb liegt das Seiten-JavaScript unter `app.js` / `review.js`.
