# PIPELINE CONTROLLER — Vollinstallation (ohne AppImage)

Getestet auf **Debian 12 (Bookworm)** / Ubuntu 22.04+  
Node.js **v18+** (getestet mit v25), GStreamer **1.22**

---

## 1. Systemabhängigkeiten

```bash
sudo apt update && sudo apt install -y \
  gstreamer1.0-tools \
  gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-ugly \
  gstreamer1.0-libav \
  gstreamer1.0-x \
  gstreamer1.0-alsa \
  gstreamer1.0-gl \
  ffmpeg \
  pulseaudio \
  python3-gi \
  gir1.2-gstreamer-1.0
```

**Puppeteer/oGraf Chrome-Abhängigkeiten** (für HTML5-Grafikengine):

```bash
sudo apt install -y \
  libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libxkbcommon0 libpango-1.0-0 libcairo2 \
  libasound2 libnspr4 libnss3 libx11-xcb1 \
  libxcb-dri3-0 libdrm2
```

---

## 2. Node.js installieren (via nvm — empfohlen)

```bash
# nvm installieren
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc   # oder neue Shell öffnen

# Node.js LTS installieren
nvm install --lts
nvm use --lts

# Versionen prüfen
node --version   # ≥ v18
npm --version
```

> **Alternativ** (Debian-Paket, ältere Version):
> ```bash
> sudo apt install nodejs npm
> ```
> Wenn die Version < 18 ist, zwingend nvm nutzen.

---

## 3. Projektverzeichnis einrichten

```bash
# Projektordner anlegen (Pfad anpassen)
INSTALL_DIR="$HOME/pipeline-controller"
mkdir -p "$INSTALL_DIR"

# Quelldateien kopieren (von dieser Maschine oder Quellpfad anpassen)
cp -r "/home/infantilo/PIPELINE CONTROLLER/"* "$INSTALL_DIR/"

# In Projektverzeichnis wechseln
cd "$INSTALL_DIR"
```

---

## 4. Node.js-Pakete installieren

```bash
cd "$INSTALL_DIR"
npm install
```

**Was installiert wird:**

| Paket | Zweck |
|---|---|
| `gst-kit` | GStreamer Node.js Bindings (Kernkomponente) |
| `basic-ftp` | File Transfer Manager Plugin (FTP/FTPS) |
| `net-snmp` | SNMP-Monitor Plugin |
| `puppeteer` | oGraf HTML5-Grafikengine (lädt Chrome headless) |

> `puppeteer` lädt beim ersten `npm install` automatisch Chrome Headless Shell (~170 MB).  
> Ohne Internet: `PUPPETEER_SKIP_DOWNLOAD=1 npm install` und Chrome manuell installieren (siehe Abschnitt 7).

---

## 5. gst-kit verifizieren

`gst-kit` benötigt GStreamer-Entwicklungsbibliotheken:

```bash
# Prüfen ob gst-kit funktioniert
node -e "const g = require('gst-kit'); const p = new g.Pipeline('fakesink'); console.log('gst-kit OK');"
```

Schlägt das fehl:

```bash
sudo apt install -y \
  libgstreamer1.0-dev \
  libgstreamer-plugins-base1.0-dev \
  libglib2.0-dev \
  build-essential

# Dann gst-kit neu kompilieren
cd "$INSTALL_DIR"
npm rebuild gst-kit
```

---

## 6. Verzeichnisse anlegen

```bash
cd "$INSTALL_DIR"
mkdir -p asrun recordings media playlists
```

---

## 7. Konfiguration (settings.json)

Die Datei `settings.json` liegt im Projektverzeichnis. Mindest-Konfiguration für Erststart:

```json
{
  "width": 1920,
  "height": 1080,
  "fps": 25,
  "videoSink": "ximagesink",
  "audioSink": "pulsesink",
  "idleSource": "smpte",
  "mediaDir": "/pfad/zu/deinen/medien",
  "asRunDir": "/pfad/zum/pipeline-controller/asrun",
  "asRunEnabled": true,
  "authEnabled": false,
  "debugEnabled": false
}
```

**Wichtige Felder:**

| Feld | Beschreibung | Typische Werte |
|---|---|---|
| `videoSink` | GStreamer Video-Ausgabe | `ximagesink`, `xvimagesink`, `fakesink` (Test) |
| `audioSink` | GStreamer Audio-Ausgabe | `pulsesink`, `alsasink`, `fakesink` (Test) |
| `mediaDir` | Pfad zum Medienverzeichnis | `/home/user/media` |
| `width`/`height` | Auflösung | `1920`/`1080` oder `1280`/`720` |
| `fps` | Bildrate | `25` (PAL/DVB), `30` (NTSC) |

---

## 8. Starten

```bash
cd "$INSTALL_DIR"
node server.js
```

Browser öffnen: **http://localhost:3000**

**Mit Debug-Ausgabe:**

```bash
node server.js --debug
```

**Als Hintergrundprozess (systemd-Dienst):**

```bash
# Service-Datei erstellen
sudo tee /etc/systemd/system/pipeline-controller.service > /dev/null <<EOF
[Unit]
Description=Pipeline Controller Broadcast Playout
After=network.target pulseaudio.service
Wants=pulseaudio.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$(which node) server.js
Restart=on-failure
RestartSec=5
Environment=DISPLAY=:0
Environment=PULSE_SERVER=unix:/run/user/$(id -u)/pulse/native

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable pipeline-controller
sudo systemctl start pipeline-controller

# Logs verfolgen
journalctl -fu pipeline-controller
```

---

## 9. oGraf / Puppeteer (HTML5-Grafikengine)

```bash
# Chrome Headless Shell nachinstallieren (falls bei npm install übersprungen)
cd "$INSTALL_DIR"
npx puppeteer browsers install chrome-headless-shell

# Prüfen
node -e "const p = require('puppeteer'); console.log('Puppeteer:', p.executablePath?.() || 'OK')"
```

> oGraf startet ohne Puppeteer — Grafikengine ist dann deaktiviert.  
> Der Server läuft in jedem Fall.

---

## 10. GStreamer-Plugin-Test

```bash
# Plugins prüfen
gst-inspect-1.0 --version
gst-inspect-1.0 interleave
gst-inspect-1.0 interaudiosrc
gst-inspect-1.0 input-selector

# Einfacher Pipelinetest
gst-launch-1.0 videotestsrc num-buffers=25 ! fakesink
```

**Fehlt `interaudiosrc`?** → `gstreamer1.0-plugins-bad` nachinstallieren:
```bash
sudo apt install gstreamer1.0-plugins-bad
```

---

## 11. PulseAudio konfigurieren

Für sauberes Audio-Routing ohne Knistern/Dropouts:

```bash
# PulseAudio mit hoher Priorität starten (nur falls als Service nötig)
pulseaudio --start --log-target=syslog

# Latenz optimieren (~50ms statt 200ms)
# /etc/pulse/daemon.conf:
sudo sed -i 's/; default-sample-rate = 44100/default-sample-rate = 48000/' /etc/pulse/daemon.conf
sudo sed -i 's/; default-fragments = 4/default-fragments = 2/' /etc/pulse/daemon.conf
sudo sed -i 's/; default-fragment-size-msec = 25/default-fragment-size-msec = 25/' /etc/pulse/daemon.conf
pulseaudio --kill && pulseaudio --start
```

---

## 12. Schnelltest (ohne Display)

Zum Testen ob der Server grundsätzlich startet:

```bash
cd "$INSTALL_DIR"
# Testkonfiguration: kein Video-/Audioausgabe
node -e "
process.env.FORCE_FAKESINK = '1';
" server.js &
sleep 3
curl -s http://localhost:3000/api/state | python3 -m json.tool | head -10
kill %1
```

---

## 13. Update-Workflow

```bash
cd "$INSTALL_DIR"

# Quellcode aktualisieren (manuell kopieren oder git pull wenn Repo vorhanden)
# cp -r "/neue/quelldateien/"* .

# Node.js-Pakete aktualisieren
npm update

# Dienst neu starten
sudo systemctl restart pipeline-controller
```

---

## Fehlersuche

| Problem | Lösung |
|---|---|
| `Cannot find module 'gst-kit'` | `npm install` im Projektverzeichnis |
| `Error: GStreamer pipeline failed` | `gst-launch-1.0 videotestsrc ! fakesink` testen |
| `ENOENT settings.json` | `settings.json` im Projektverzeichnis anlegen |
| Audio knistert / Dropouts | PulseAudio-Latenz erhöhen, `realtime-scheduling=yes` in `/etc/pulse/daemon.conf` |
| `ximagesink` Fehler ohne Display | `videoSink: "fakesink"` in settings.json, oder `DISPLAY=:0` setzen |
| Puppeteer Chrome nicht gefunden | `npx puppeteer browsers install chrome-headless-shell` |
| Port 3000 belegt | `PORT=3001 node server.js` |

---

## Verzeichnisstruktur nach Installation

```
pipeline-controller/
├── server.js              # Hauptserver
├── package.json           # npm-Abhängigkeiten
├── settings.json          # Konfiguration
├── ui.html                # Web-UI
├── lib/                   # Engine-Bibliotheken
├── plugins/               # Plugin-System
├── templates/             # oGraf-Grafik-Templates
├── node_modules/          # npm-Pakete (nach npm install)
├── media/                 # Medienverzeichnis
├── playlists/             # Playlist-Dateien
├── recordings/            # Aufzeichnungen
└── asrun/                 # As-Run-Protokolle
```
