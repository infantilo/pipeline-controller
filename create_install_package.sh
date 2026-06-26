#!/usr/bin/env bash
# =============================================================================
# create_install_package.sh — Erstellt ein portables Installations-Paket
#
# Paketinhalt (tar.gz):
#   PipelineController-VERSION/
#     install.sh          ← interaktiver Installer (Node.js + GStreamer prüfen,
#                            Dateien kopieren, Systemd-Service einrichten)
#     src/                ← Anwendungsquellen (ohne node_modules / Laufzeitdaten)
#     INSTALL.md
#     README.md
#
# Verwendung:
#   ./create_install_package.sh [VERSION]
#   APPVER=2.1.0 ./create_install_package.sh
# =============================================================================
set -euo pipefail

APPNAME="PipelineController"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT_DIR="$(dirname "${SCRIPT_DIR}")"

log() { echo "[pkg] $*"; }
err() { echo "[ERR] $*" >&2; exit 1; }

# ── Versionierung ─────────────────────────────────────────────────────────────
# Priorität: positionaler Arg > APPVER env-var > Session-Lock > auto-increment
_PKG_JSON="${SCRIPT_DIR}/package.json"
_VER_LOCK="${SCRIPT_DIR}/.build-session-version"
if [[ -n "${1:-}" ]]; then
    APPVER="${1}"
elif [[ -n "${APPVER:-}" ]]; then
    : # Explicit override — use as-is
elif [[ -f "${_VER_LOCK}" ]] && [[ $(( $(date +%s) - $(stat -c %Y "${_VER_LOCK}") )) -lt 3600 ]]; then
    APPVER="$(cat "${_VER_LOCK}")"
    log "Session-Version wiederverwendet: ${APPVER}"
else
    _cur="$(node -p "require('${_PKG_JSON}').version" 2>/dev/null || echo "1.0.0")"
    IFS='.' read -r _maj _min _pat <<< "$_cur"
    APPVER="${_maj}.${_min}.$(( _pat + 1 ))"
    node -e "
      const fs=require('fs'), p=JSON.parse(fs.readFileSync('${_PKG_JSON}','utf8'));
      p.version='${APPVER}';
      fs.writeFileSync('${_PKG_JSON}',JSON.stringify(p,null,2)+'\n');
    "
    echo "$APPVER" > "${_VER_LOCK}"
    log "Version erhöht: ${_cur} → ${APPVER}"
fi

# Releases-Verzeichnis (git-ignoriert; Artefakte werden via GitHub Releases verteilt)
RELEASES_DIR="${SCRIPT_DIR}/releases"
mkdir -p "${RELEASES_DIR}"

PKG_NAME="${APPNAME}-${APPVER}"
STAGING_DIR="${PARENT_DIR}/${PKG_NAME}"
OUTPUT_TGZ="${RELEASES_DIR}/${PKG_NAME}.tar.gz"

command -v tar &>/dev/null || err "tar nicht gefunden"

# ── Paket-Modus ───────────────────────────────────────────────────────────────
# CLEAN_BUILD=1 (Standard): Media, Bilder, Marina-Ordner, Playlisten ausschließen;
#   von templates/grafik nur 02700111 und dve-lower-third einbinden.
# CLEAN_BUILD=0: Alles einschließen.
# Env-Var überschreibt die Abfrage: CLEAN_BUILD=0 ./create_install_package.sh
if [[ -z "${CLEAN_BUILD:-}" ]]; then
    echo ""
    echo "┌─────────────────────────────────────────────────────────┐"
    echo "│  Paket-Modus                                             │"
    echo "├─────────────────────────────────────────────────────────┤"
    echo "│  [J] CLEAN  — kein media/, keine images/, kein marina/, │"
    echo "│              keine playlists/, Grafik-Templates nur:    │"
    echo "│              02700111 + dve-lower-third                  │"
    echo "│  [n] VOLL   — alles einschließen                         │"
    echo "└─────────────────────────────────────────────────────────┘"
    read -r -p "  Auswahl [J/n]: " _BUILD_ANS
    if [[ "${_BUILD_ANS,,}" == "n" ]]; then
        CLEAN_BUILD=0
    else
        CLEAN_BUILD=1
    fi
fi
log "Paket-Modus: $([[ ${CLEAN_BUILD} -eq 1 ]] && echo "CLEAN" || echo "VOLL")"

# ── Staging vorbereiten ────────────────────────────────────────────────────────
log "Staging: ${STAGING_DIR}"
rm -rf "${STAGING_DIR}"
mkdir -p "${STAGING_DIR}/src"

# ── Quellen kopieren (nur relevante Dateien) ───────────────────────────────────
log "Kopiere Anwendungsquellen …"

# Clean-Modus-Ausschlüsse vorbereiten
_RSYNC_CLEAN_ARGS=()
if [[ "${CLEAN_BUILD:-1}" == "1" ]]; then
    _RSYNC_CLEAN_ARGS=(
        '--exclude=media/'
        '--exclude=recordings/'
        '--exclude=images/'
        '--exclude=marina/'
        '--exclude=playlists/'
        '--exclude=templates/grafik/'
    )
fi

rsync -a \
         --exclude='node_modules' \
         --exclude='build_appimage_tmp' \
         --exclude='releases' \
         --exclude='*.AppImage' \
         --exclude='*.log' \
         --exclude='*.deb' \
         --exclude='library.json' \
         --exclude='startlog.log' \
         --exclude='gst_audio.log' \
         --exclude='filelist.txt' \
         --exclude='.git' \
         --exclude='*.mxf' --exclude='*.MXF' \
         --exclude='*.mp4' --exclude='*.MP4' \
         --exclude='*.mov' --exclude='*.MOV' \
         --exclude='*.mkv' --exclude='*.MKV' \
         --exclude='*.ts'  --exclude='*.TS'  \
         --exclude='*.mpeg' --exclude='*.mpg' \
         --exclude='*.avi'  --exclude='*.AVI' \
         --exclude='*.wav'  --exclude='*.WAV' \
         "${_RSYNC_CLEAN_ARGS[@]}" \
         "${SCRIPT_DIR}/" "${STAGING_DIR}/src/" 2>/dev/null || {
  # rsync nicht verfügbar — cp fallback
  cp -r "${SCRIPT_DIR}/." "${STAGING_DIR}/src/"
  rm -rf "${STAGING_DIR}/src/node_modules" \
         "${STAGING_DIR}/src/build_appimage_tmp" \
         "${STAGING_DIR}/src/library.json" \
         "${STAGING_DIR}/src/startlog.log" \
         "${STAGING_DIR}/src/gst_audio.log" \
         "${STAGING_DIR}/src/filelist.txt" 2>/dev/null || true
  find "${STAGING_DIR}/src" -maxdepth 1 -name "*.AppImage" -delete 2>/dev/null || true
  find "${STAGING_DIR}/src" -maxdepth 1 -name "*.deb"      -delete 2>/dev/null || true
  # Video/Audio-Dateien löschen
  for ext in mxf MXF mp4 MP4 mov MOV mkv MKV ts TS mpeg mpg avi AVI wav WAV; do
    find "${STAGING_DIR}/src" -name "*.${ext}" -delete 2>/dev/null || true
  done
  if [[ "${CLEAN_BUILD:-1}" == "1" ]]; then
    rm -rf "${STAGING_DIR}/src/media" \
           "${STAGING_DIR}/src/recordings" \
           "${STAGING_DIR}/src/images" \
           "${STAGING_DIR}/src/marina" \
           "${STAGING_DIR}/src/playlists" \
           "${STAGING_DIR}/src/templates/grafik" 2>/dev/null || true
  fi
}

# Laufzeitverzeichnisse sicherstellen (falls leer und daher nicht kopiert)
mkdir -p "${STAGING_DIR}/src/media" \
         "${STAGING_DIR}/src/recordings" \
         "${STAGING_DIR}/src/playlists" \
         "${STAGING_DIR}/src/asrun"

# Clean-Modus: nur die zwei erlaubten Grafik-Templates einbinden
if [[ "${CLEAN_BUILD:-1}" == "1" ]]; then
    mkdir -p "${STAGING_DIR}/src/templates/grafik"
    for _tmpl in "02700111" "dve-lower-third"; do
        _tmpl_src="${SCRIPT_DIR}/templates/grafik/${_tmpl}"
        if [[ -d "${_tmpl_src}" ]]; then
            cp -r "${_tmpl_src}" "${STAGING_DIR}/src/templates/grafik/${_tmpl}"
            log "Grafik-Template eingebunden: ${_tmpl}"
        else
            warn "Grafik-Template nicht gefunden: ${_tmpl}"
        fi
    done
fi

# ── GStreamer .deb in Paket-Root kopieren (ermöglicht Offline-Installation) ────
for deb in "${SCRIPT_DIR}"/gstreamer1.0-plugins-bad_*.deb; do
  [[ -f "$deb" ]] && cp "$deb" "${STAGING_DIR}/" && log "GStreamer-Paket mitgepackt: $(basename "$deb")"
done

# Docs in Paket-Root
[[ -f "${SCRIPT_DIR}/INSTALL.md" ]] && cp "${SCRIPT_DIR}/INSTALL.md" "${STAGING_DIR}/"
[[ -f "${SCRIPT_DIR}/README.md"  ]] && cp "${SCRIPT_DIR}/README.md"  "${STAGING_DIR}/"

# ── install.sh generieren ─────────────────────────────────────────────────────
log "Generiere install.sh …"
cat > "${STAGING_DIR}/install.sh" <<'INSTALL_SH'
#!/usr/bin/env bash
# Pipeline Controller — Installations-Skript (ohne AppImage)
# Führe dieses Skript im entpackten Paket-Verzeichnis aus.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="${SCRIPT_DIR}/src"

# ── Ausgabe-Helfer ─────────────────────────────────────────────────────────────
RED='\033[0;31m'; YEL='\033[1;33m'; GRN='\033[0;32m'; NC='\033[0m'
log()  { echo "  $*"; }
ok()   { echo -e "${GRN}✓${NC} $*"; }
warn() { echo -e "${YEL}! WARNUNG:${NC} $*"; }
err()  { echo -e "${RED}✗ FEHLER:${NC} $*" >&2; exit 1; }
ask()  { echo -e "\n${YEL}▶${NC} $*"; }

echo "═══════════════════════════════════════════════════════"
echo "  Pipeline Controller — Installation"
echo "═══════════════════════════════════════════════════════"

# ── Root-Prüfung ───────────────────────────────────────────────────────────────
if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  echo -e "${RED}ACHTUNG: Nicht als root/sudo ausführen!${NC}"
  echo "  PulseAudio/PipeWire läuft als normaler Benutzer — als root kein Audio."
  ask "Trotzdem fortfahren (nicht empfohlen)? [j/N]"
  read -r ROOT_CONT
  [[ "${ROOT_CONT,,}" == "j" ]] || err "Abbruch. Bitte ohne sudo erneut versuchen."
fi

# ── Node.js prüfen ─────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  warn "Node.js nicht gefunden."
  echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
  echo "  source ~/.bashrc && nvm install --lts"
  err "Node.js >= 18 erforderlich."
fi
NODE_VER="$(node -e 'process.stdout.write(process.version)')"
NODE_MAJOR="${NODE_VER#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
[[ "$NODE_MAJOR" -lt 18 ]] && err "Node.js ${NODE_VER} zu alt — mindestens v18 erforderlich."
ok "Node.js ${NODE_VER}"

# ── System-Abhängigkeiten installieren ────────────────────────────────────────
# Enthält gstreamer1.0-plugins-bad (PFLICHT: intervideosrc/sink für Preview + Audio-Routing)
# und ffmpeg (PFLICHT: ffprobe für Medienanalyse).
# apt-get install ist idempotent — bereits installierte Pakete werden übersprungen.
echo ""
echo "System-Abhängigkeiten:"
echo "  GStreamer: tools, plugins-base/good/bad/ugly/libav/x/alsa/gl"
echo "  ffmpeg (ffprobe)"
ask "Jetzt installieren? (sudo) [J/n]"
read -r DO_SYS_DEPS
if [[ "${DO_SYS_DEPS,,}" != "n" ]]; then
  # Lokales gstreamer-plugins-bad .deb zuerst (ermöglicht Offline-Installation)
  for deb in "${SCRIPT_DIR}"/gstreamer1.0-plugins-bad_*.deb; do
    if [[ -f "$deb" ]]; then
      log "Lokales .deb: $(basename "$deb")"
      sudo dpkg -i "$deb" 2>/dev/null || true
      sudo apt-get install -f -y 2>/dev/null || true
    fi
  done
  sudo apt-get install -y \
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
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
    && ok "System-Abhängigkeiten installiert." \
    || warn "apt-get fehlgeschlagen — manche Pakete fehlen möglicherweise."
else
  warn "System-Abhängigkeiten übersprungen."
fi

# ── Kritische Plugins verifizieren ────────────────────────────────────────────
echo ""
log "Prüfe kritische GStreamer-Plugins …"
MISSING_PLUGINS=()
for plugin in intervideosrc intervideosink interaudiosrc interaudiosink; do
  if command -v gst-inspect-1.0 &>/dev/null && gst-inspect-1.0 "$plugin" &>/dev/null 2>&1; then
    log "  $plugin: OK"
  else
    MISSING_PLUGINS+=("$plugin")
    warn "$plugin: FEHLT"
  fi
done
if [[ "${#MISSING_PLUGINS[@]}" -gt 0 ]]; then
  warn "Fehlende Plugins: ${MISSING_PLUGINS[*]}"
  warn "Diese kommen aus gstreamer1.0-plugins-bad."
  warn "Manuell: sudo apt install gstreamer1.0-plugins-bad"
  ask "Trotzdem fortfahren? Preview und Audio-Routing werden nicht funktionieren. [j/N]"
  read -r CONT_MISSING
  [[ "${CONT_MISSING,,}" == "j" ]] || err "Abbruch. Bitte plugins-bad installieren."
else
  ok "Alle GStreamer-Plugins vorhanden."
fi

if command -v ffprobe &>/dev/null; then
  ok "ffprobe: OK"
else
  warn "ffprobe fehlt — Medienanalyse und Clip-Dauer nicht verfügbar."
fi

# ── Installationsverzeichnis wählen ───────────────────────────────────────────
DEFAULT_INSTALL="${HOME}/pipeline-controller"
ask "Installationsverzeichnis (Enter = ${DEFAULT_INSTALL}):"
read -r CUSTOM_DIR
INSTALL_DIR="${CUSTOM_DIR:-$DEFAULT_INSTALL}"

if [[ -d "${INSTALL_DIR}" ]]; then
  ask "Verzeichnis existiert bereits. Überschreiben/aktualisieren? [j/N]"
  read -r OVR
  [[ "${OVR,,}" == "j" ]] || err "Abbruch."
fi
mkdir -p "${INSTALL_DIR}"

# ── Dateien kopieren ───────────────────────────────────────────────────────────
log "Kopiere Anwendung nach ${INSTALL_DIR} …"
if command -v rsync &>/dev/null; then
  rsync -a --exclude='library.json' --exclude='startlog.log' \
           "${SRC_DIR}/" "${INSTALL_DIR}/"
else
  cp -r "${SRC_DIR}/." "${INSTALL_DIR}/"
fi
ok "Dateien kopiert."

mkdir -p "${INSTALL_DIR}/recordings" "${INSTALL_DIR}/media" \
         "${INSTALL_DIR}/playlists"  "${INSTALL_DIR}/asrun"
ok "Laufzeit-Verzeichnisse: recordings/ media/ playlists/ asrun/"

# ── settings.json: maschinen-spezifische Pfade entfernen ─────────────────────
SETTINGS_FILE="${INSTALL_DIR}/settings.json"
if [[ -f "${SETTINGS_FILE}" ]]; then
  # Write cleanup script to file — avoids all shell-quoting issues with inline node -e.
  # Node.js is guaranteed available (checked at script start).
  _JS="${INSTALL_DIR}/.install_fix.js"
  cat > "${_JS}" << 'JSEOF'
'use strict';
const fs = require('fs'), path = require('path');
const [sf, installDir] = process.argv.slice(2);
const s = JSON.parse(fs.readFileSync(sf, 'utf8'));

// Set ALL path keys explicitly to correct install-dir locations.
// Do NOT rely on server defaults — user must see correct paths in config UI.
// Do NOT check os.path.exists: source+remote may share filesystem (NFS/SSHFS),
// making old paths appear valid on the remote machine.
s.mediaDir    = path.join(installDir, 'media');
s.recordDir   = path.join(installDir, 'recordings');
s.playlistsDir= path.join(installDir, 'playlists');
s.grafixDir   = path.join(installDir, 'templates', 'grafik');
s.asRunDir    = path.join(installDir, 'asrun');
s.backupMediaDirs = [];
delete s.userLogPath;

// idleImagePath: keep relative filename (resolved via images/ dir), clear absolute
if (typeof s.idleImagePath === 'string' && path.isAbsolute(s.idleImagePath)) {
  console.log(`  idleImagePath ${JSON.stringify(s.idleImagePath)} → '' (absolut → relativ)`);
  delete s.idleImagePath;
}

// videoSink: ximagesink/xvimagesink/glimagesink need X11 display.
// Headless remote → fails → master pipeline fails → no video → preview black.
const X11_SINKS = ['ximagesink','xvimagesink','glimagesink','wayland'];
if (s.videoSink && X11_SINKS.some(x => s.videoSink.includes(x))) {
  console.log(`  videoSink ${JSON.stringify(s.videoSink)} → "fakesink"`);
  s.videoSink = 'fakesink';
}

fs.writeFileSync(sf, JSON.stringify(s, null, 2));
console.log(`  mediaDir    = ${s.mediaDir}`);
console.log(`  recordDir   = ${s.recordDir}`);
console.log(`  playlistsDir= ${s.playlistsDir}`);
console.log(`  grafixDir   = ${s.grafixDir}`);
console.log(`  videoSink   = ${s.videoSink || '(auto)'}`);
console.log(`  idleImagePath = ${s.idleImagePath || '(leer)'}`);
JSEOF
  node "${_JS}" "${SETTINGS_FILE}" "${INSTALL_DIR}" \
    && ok "settings.json: Pfade auf Install-Verzeichnis gesetzt." \
    || warn "settings.json Bereinigung fehlgeschlagen."
  rm -f "${_JS}"
fi

# ── plugins.json: plugin-spezifische Pfade anpassen ──────────────────────────
# Betroffen: FTM sourcePaths/destDir, sowie alle anderen absoluten Pfade aus
# der Quellmaschine (erkennbar an /home/... oder /root/...).
PLUGINS_FILE="${INSTALL_DIR}/plugins.json"
if [[ -f "${PLUGINS_FILE}" ]]; then
  _JS="${INSTALL_DIR}/.install_fix_plugins.js"
  cat > "${_JS}" << 'JSEOF'
'use strict';
const fs = require('fs'), path = require('path');
const [pf, installDir] = process.argv.slice(2);
const p = JSON.parse(fs.readFileSync(pf, 'utf8'));

// Walk all string values — clear any that are absolute paths not under installDir.
// Unconditional: do not check existence (NFS/SSHFS makes old paths appear valid).
function fixAbsPaths(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string' && path.isAbsolute(v) && !v.startsWith(installDir)) {
      console.log(`  ${k}: ${JSON.stringify(v)} → ''`);
      obj[k] = '';
    } else if (typeof v === 'object') {
      fixAbsPaths(v);
    }
  }
}

// FTM: set sourcePaths and destDir explicitly; enable only FTM by default
const ftmCfg = p['file-transfer-manager']?.config;
if (ftmCfg) {
  ftmCfg.sourcePaths = path.join(installDir, 'recordings');
  ftmCfg.destDir     = path.join(installDir, 'media');
  console.log(`  FTM.sourcePaths = ${ftmCfg.sourcePaths}`);
  console.log(`  FTM.destDir     = ${ftmCfg.destDir}`);
}
// Only FTM active by default; user enables others in plugin manager
for (const id of Object.keys(p)) {
  if (id !== 'file-transfer-manager') {
    p[id] = { ...p[id], enabled: false };
    console.log(`  ${id}: disabled`);
  }
}
if (!p['file-transfer-manager']) p['file-transfer-manager'] = { enabled: true };
else p['file-transfer-manager'].enabled = true;

fixAbsPaths(p);

// Restore FTM sourcePaths after generic walk (fixAbsPaths would have cleared it
// if installDir itself contains the old prefix, which it doesn't — but be safe)
if (ftmCfg) ftmCfg.sourcePaths = path.join(installDir, 'recordings');

fs.writeFileSync(pf, JSON.stringify(p, null, 2));
console.log(`  FTM.sourcePaths = ${ftmCfg?.sourcePaths}`);
console.log(`  FTM.destDir     = ${JSON.stringify(ftmCfg?.destDir)}`);
JSEOF
  node "${_JS}" "${PLUGINS_FILE}" "${INSTALL_DIR}" \
    && ok "plugins.json: Plugin-Pfade angepasst." \
    || warn "plugins.json Bereinigung fehlgeschlagen."
  rm -f "${_JS}"
fi

# ── npm install ───────────────────────────────────────────────────────────────
log "npm install --omit=dev …"
cd "${INSTALL_DIR}"
npm install --omit=dev 2>&1 | tail -5
ok "npm-Abhängigkeiten installiert."

# ── Puppeteer: Chromium herunterladen ─────────────────────────────────────────
# Puppeteer liegt in ${INSTALL_DIR}/node_modules/puppeteer (npm install oben).
# Chromium wird nach ~/.cache/puppeteer/ heruntergeladen (User-Home, nicht root).
log "Puppeteer: Chromium installieren (oGraf HTML5-Grafikengine) …"
PUPPETEER_OK=false
if [[ -f "${INSTALL_DIR}/node_modules/puppeteer/install.mjs" ]]; then
  node "${INSTALL_DIR}/node_modules/puppeteer/install.mjs" && PUPPETEER_OK=true || true
fi
if [[ "${PUPPETEER_OK}" != "true" ]]; then
  (cd "${INSTALL_DIR}" && npx --yes puppeteer browsers install chrome) \
    && PUPPETEER_OK=true || true
fi
# Verifikation: prüft ob Chromium-Binary tatsächlich im Cache liegt
if [[ "${PUPPETEER_OK}" == "true" ]]; then
  CHROME_BIN="$(node -e "try{const p=require('${INSTALL_DIR}/node_modules/puppeteer');console.log(p.executablePath())}catch(e){}" 2>/dev/null || true)"
  if [[ -x "${CHROME_BIN}" ]]; then
    ok "Chromium bereit: ${CHROME_BIN}"
  else
    warn "Puppeteer-Download abgeschlossen, aber Chromium-Binary nicht ausführbar: ${CHROME_BIN:-unbekannt}"
    log "Prüfe: node -e \"require('puppeteer').executablePath()\" in ${INSTALL_DIR}"
    PUPPETEER_OK=false
  fi
fi
if [[ "${PUPPETEER_OK}" != "true" ]]; then
  warn "Chromium-Download fehlgeschlagen. oGraf-Grafiken werden nicht funktionieren."
  log "Manuell: cd ${INSTALL_DIR} && npx puppeteer browsers install chrome"
fi

# ── Start-Skript ──────────────────────────────────────────────────────────────
STARTSCRIPT="${INSTALL_DIR}/start.sh"
cat > "${STARTSCRIPT}" <<'EOF'
#!/usr/bin/env bash
# Nicht mit sudo starten — PulseAudio läuft als normaler Benutzer.
if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  echo "WARNUNG: Als root gestartet — Audio wird nicht funktionieren!"
fi
cd "$(dirname "$0")"
exec node server.js "$@"
EOF
chmod +x "${STARTSCRIPT}"
ok "Start-Skript: ${STARTSCRIPT}"

# ── Systemd User-Service (optional) ───────────────────────────────────────────
ask "Systemd User-Service einrichten (Autostart beim Login)? [j/N]"
read -r CREATE_SERVICE
if [[ "${CREATE_SERVICE,,}" == "j" ]]; then
  SERVICE_DIR="${HOME}/.config/systemd/user"
  mkdir -p "${SERVICE_DIR}"
  XDG_RD="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  NODE_BIN="$(command -v node)"
  cat > "${SERVICE_DIR}/pipeline-controller.service" <<EOF
[Unit]
Description=Pipeline Controller GStreamer Broadcast Playout
After=network.target sound.target

[Service]
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} ${INSTALL_DIR}/server.js
Restart=on-failure
RestartSec=5
Environment=HOME=${HOME}
Environment=XDG_RUNTIME_DIR=${XDG_RD}
Environment=PULSE_SERVER=unix:${XDG_RD}/pulse/native
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=${XDG_RD}/bus

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable pipeline-controller.service
  ok "Systemd Service aktiviert."
  log "Start:  systemctl --user start pipeline-controller"
  log "Stop:   systemctl --user stop pipeline-controller"
  log "Logs:   journalctl --user -u pipeline-controller -f"
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo " Installation abgeschlossen!"
echo " Starten:  ${STARTSCRIPT}"
echo " Web-UI:   http://localhost:3000"
echo "═══════════════════════════════════════════════════════"
INSTALL_SH
chmod +x "${STAGING_DIR}/install.sh"

# ── tar.gz erstellen ──────────────────────────────────────────────────────────
log "Erstelle ${OUTPUT_TGZ} …"
rm -f "${OUTPUT_TGZ}"
cd "${PARENT_DIR}"
tar -czf "${OUTPUT_TGZ}" "$(basename "${STAGING_DIR}")"
rm -rf "${STAGING_DIR}"

# ── Ergebnis ──────────────────────────────────────────────────────────────────
log "──────────────────────────────────────────────────────"
log "Fertig:  ${OUTPUT_TGZ}"
log "Größe:   $(du -sh "${OUTPUT_TGZ}" | cut -f1)"
log ""
log "Auf Ziel-Rechner:"
log "  tar -xzf $(basename "${OUTPUT_TGZ}")"
log "  cd ${PKG_NAME}"
log "  bash install.sh"
log "──────────────────────────────────────────────────────"

# ── Git-Tag & GitHub Release ──────────────────────────────────────────────────
_TAG="v${APPVER}"
echo ""
echo "┌─────────────────────────────────────────────────────────────┐"
echo "│  Release-Tag                                                 │"
echo "├─────────────────────────────────────────────────────────────┤"
printf "│  Git-Tag %-51s │\n" "${_TAG} erstellen + package.json committen?"
echo "│  (Nur sinnvoll wenn kein weiteres Build-Artefakt folgt)     │"
echo "└─────────────────────────────────────────────────────────────┘"
read -r -p "  Git-Tag + Commit erstellen? [J/n]: " _TAG_ANS
if [[ "${_TAG_ANS,,}" != "n" ]]; then
    if git -C "${SCRIPT_DIR}" diff --quiet HEAD -- package.json 2>/dev/null; then
        log "package.json bereits committed — kein Commit nötig"
    else
        git -C "${SCRIPT_DIR}" add package.json
        git -C "${SCRIPT_DIR}" commit -m "chore: release ${_TAG}"
        log "package.json committed"
    fi
    if git -C "${SCRIPT_DIR}" tag --list | grep -qx "${_TAG}"; then
        log "Tag ${_TAG} existiert bereits — übersprungen"
    else
        git -C "${SCRIPT_DIR}" tag -a "${_TAG}" -m "Release ${_TAG}"
        log "Tag ${_TAG} erstellt"
    fi
    read -r -p "  Tag + Commit pushen? [J/n]: " _PUSH_ANS
    if [[ "${_PUSH_ANS,,}" != "n" ]]; then
        git -C "${SCRIPT_DIR}" push
        git -C "${SCRIPT_DIR}" push origin "${_TAG}"
        log "Gepusht"
    fi
    echo ""
    log "GitHub Release erstellen (nach 'gh auth login'):"
    echo "  gh release create ${_TAG} \\"
    echo "    '${OUTPUT_TGZ}' \\"
    echo "    --title '${APPNAME} ${APPVER}' \\"
    echo "    --notes 'Release ${APPVER}'"
fi
rm -f "${_VER_LOCK}"
