#!/usr/bin/env bash
# =============================================================================
# build_appimage.sh — Erstellt ein AppImage des PIPELINE CONTROLLER
#
# Enthält: Node.js Runtime, node_modules (inkl. gst-kit),
#          GStreamer 1.22 Plugins, alle .so-Abhängigkeiten
#
# Voraussetzung: sudo apt-get install -y patchelf
# =============================================================================
set -euo pipefail

# ── Konfiguration ─────────────────────────────────────────────────────────────
APPNAME="PipelineController"
APPVER="${APPVER:-1.0.0}"
ARCH="x86_64"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT_DIR="$(dirname "${SCRIPT_DIR}")"

# Build artefacts live OUTSIDE the project directory
BUILD_DIR="${PARENT_DIR}/build_appimage_tmp"
APPDIR="${BUILD_DIR}/AppDir"
# Tools are cached persistently (survive between builds)
TOOLS_DIR="${PARENT_DIR}/.pipeline-build-tools"

# Node.js
NODE_BIN="$(command -v node 2>/dev/null || true)"
[[ -z "$NODE_BIN" ]] && NODE_BIN="/home/infantilo/.config/nvm/versions/node/v25.8.2/bin/node"
NODE_DIR="$(dirname "$NODE_BIN")"

# node_modules
if   [[ -d "${SCRIPT_DIR}/node_modules" ]];   then NODE_MODULES_SRC="${SCRIPT_DIR}/node_modules"
elif [[ -d "/home/infantilo/node_modules" ]];  then NODE_MODULES_SRC="/home/infantilo/node_modules"
else echo "FEHLER: node_modules nicht gefunden!" >&2; exit 1; fi

# ── Ziel-ABI-Quelle (Glibc/ld-Kompatibilität) ─────────────────────────────────
# Build-Host (z.B. Debian 12, glibc 2.36) ist NEUER als das Ziel-System
# (Ubuntu 22.04, glibc 2.35). Mit libc/pthread/etc. bewusst ausgeschlossen
# (siehe copy_libs) lädt das AppImage diese vom Zielsystem — bundlete .so-Dateien,
# die gegen eine neuere Glibc gelinkt wurden, brechen dort mit "Symbol/Version
# nicht gefunden" (äußert sich oft wie "Lib fehlt"). Fix: GStreamer/ffmpeg/libstdc++
# aus einem extrahierten Ubuntu-22.04-Paketbaum holen statt vom Build-Host.
# Baum erzeugen: siehe scripts/build_jammy_pkgroot.sh
JAMMY_ROOT="${JAMMY_ROOT:-/opt/jammy-apt/extracted}"
if [[ -d "$JAMMY_ROOT" ]]; then
    echo "[build] Ziel-ABI-Quelle: ${JAMMY_ROOT} (Ubuntu 22.04 Pakete)"
    GST_PLUGIN_SRC="${JAMMY_ROOT}/usr/lib/x86_64-linux-gnu/gstreamer-1.0"
    GST_LIB_SRC="${JAMMY_ROOT}/usr/lib/x86_64-linux-gnu"
    GST_SCANNER_SRC="${JAMMY_ROOT}/usr/lib/x86_64-linux-gnu/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner"
    FFMPEG_SRC="${JAMMY_ROOT}/usr/bin/ffmpeg"
    FFPROBE_SRC="${JAMMY_ROOT}/usr/bin/ffprobe"
else
    echo "[WARN]  JAMMY_ROOT (${JAMMY_ROOT}) nicht gefunden — falle auf Build-Host-Libs zurück." >&2
    echo "[WARN]    Das AppImage kann dann auf älteren Ziel-Systemen mit Glibc-Symbolfehlern scheitern." >&2
    GST_PLUGIN_SRC="/usr/lib/x86_64-linux-gnu/gstreamer-1.0"
    GST_LIB_SRC="/usr/lib/x86_64-linux-gnu"
    GST_SCANNER_SRC="/usr/lib/x86_64-linux-gnu/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner"
    FFMPEG_SRC="$(command -v ffmpeg 2>/dev/null || true)"
    FFPROBE_SRC="$(command -v ffprobe 2>/dev/null || true)"
fi

# ── Hilfsfunktionen ───────────────────────────────────────────────────────────
log()  { echo "[build] $*"; }
warn() { echo "[WARN]  $*" >&2; }

fetch() {
    local url="$1" dest="$2"
    if [[ ! -f "$dest" ]]; then
        log "Download: $(basename "$dest")"
        curl -fsSL --retry 3 -o "$dest" "$url"
        chmod +x "$dest"
    fi
}

# Iterative Library-Sammlung: alle .so-Deps einer Liste von Dateien kopieren
# copy_libs <outdir> <file1> [file2 ...]
# SONAME → Pfad auflösen. JAMMY_ROOT (Ziel-ABI) hat Vorrang vor dem Build-Host —
# sonst landen z.B. transitive Deps von jammy-Paketen (libexpat, libpcre1) über
# den Host-ldconfig-Cache in einer falschen (zu neuen) Glibc-Version im Bundle.
# Bewusst KEIN `ldd $file`-Aufruf mit umgebogenem LD_LIBRARY_PATH — würde auch
# ld-linux/libc selbst über jammy auflösen und die aufrufende Shell zerschießen.
_LDCONFIG_CACHE="$(/sbin/ldconfig -p 2>/dev/null)"

_resolve_soname() {
    local soname="$1" d
    if [[ -n "${JAMMY_ROOT:-}" && -d "${JAMMY_ROOT}" ]]; then
        for d in "${JAMMY_ROOT}/usr/lib/x86_64-linux-gnu" "${JAMMY_ROOT}/lib/x86_64-linux-gnu"; do
            [[ -e "${d}/${soname}" ]] && { echo "${d}/${soname}"; return 0; }
        done
    fi
    awk -v s="$soname" '$1==s{print $NF; exit}' <<< "$_LDCONFIG_CACHE"
}

copy_libs() {
    local outdir="$1"; shift
    local seen_file; seen_file="$(mktemp)"
    local queue_file; queue_file="$(mktemp)"

    # Initiale Dateien in Queue schreiben
    for f in "$@"; do [[ -f "$f" ]] && echo "$f" >> "$queue_file"; done

    while [[ -s "$queue_file" ]]; do
        # Erste Zeile lesen und entfernen
        local file; file="$(head -n1 "$queue_file")"
        sed -i '1d' "$queue_file"

        local base; base="$(basename "$file")"

        # Bereits verarbeitet?
        grep -qxF "$base" "$seen_file" 2>/dev/null && continue
        echo "$base" >> "$seen_file"

        # Datei kopieren (falls noch nicht da)
        if [[ ! -f "${outdir}/${base}" ]]; then
            cp -aL "$file" "${outdir}/${base}" 2>/dev/null || true
        fi

        # Symlink-Ziel auch kopieren
        if [[ -L "$file" ]]; then
            local real; real="$(realpath "$file" 2>/dev/null || true)"
            if [[ -n "$real" && -f "$real" ]]; then
                local rbase; rbase="$(basename "$real")"
                if ! grep -qxF "$rbase" "$seen_file" 2>/dev/null; then
                    [[ ! -f "${outdir}/${rbase}" ]] && cp -a "$real" "${outdir}/${rbase}" 2>/dev/null || true
                    echo "$rbase" >> "$seen_file"
                fi
            fi
        fi

        # NEEDED-Einträge (statisch aus dem ELF gelesen) auflösen und in Queue aufnehmen
        while IFS= read -r soname; do
            [[ -z "$soname" ]]             && continue
            [[ "$soname" == *"ld-linux"* ]] && continue
            [[ "$soname" == libc.so*      ]] && continue
            [[ "$soname" == libpthread*   ]] && continue
            [[ "$soname" == libm.so*      ]] && continue
            [[ "$soname" == libdl.so*     ]] && continue
            [[ "$soname" == librt.so*     ]] && continue
            [[ "$soname" == libutil.so*   ]] && continue
            grep -qxF "$soname" "$seen_file" 2>/dev/null && continue
            local resolved; resolved="$(_resolve_soname "$soname")"
            [[ -n "$resolved" ]] && echo "$resolved" >> "$queue_file"
        done < <(readelf -d "$file" 2>/dev/null | grep -oP 'Shared library: \[\K[^\]]+' || true)
    done

    rm -f "$seen_file" "$queue_file"
}

# ── Aufräumen & Vorbereiten ───────────────────────────────────────────────────
log "Aufräumen: ${BUILD_DIR}"
rm -rf "$BUILD_DIR"
mkdir -p "$APPDIR" "$TOOLS_DIR"

# ── Tools herunterladen ───────────────────────────────────────────────────────
APPIMAGETOOL="${TOOLS_DIR}/appimagetool-x86_64.AppImage"
fetch "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage" \
      "$APPIMAGETOOL"

# ── AppDir-Struktur ───────────────────────────────────────────────────────────
APP_USR="${APPDIR}/usr"
APP_BIN="${APP_USR}/bin"
APP_LIB="${APP_USR}/lib"
APP_GST="${APP_USR}/lib/gstreamer-1.0"
APP_GSTTOOLS="${APP_USR}/lib/gstreamer1.0/gstreamer-1.0"
APP_SRC="${APPDIR}/app"

mkdir -p "$APP_BIN" "$APP_LIB" "$APP_GST" "$APP_GSTTOOLS" "$APP_SRC"

# ── 0. ABI-kritische Basis-Libs zuerst aus JAMMY_ROOT vorlegen ────────────────
# copy_libs() überspringt Dateien, die bereits im Zielverzeichnis liegen — daher
# müssen die Ziel-ABI-Versionen von libstdc++/libgcc/libatomic VOR dem
# Node-Bundling (das sonst die Build-Host-Versionen mitzieht) kopiert werden.
if [[ -d "$JAMMY_ROOT" ]]; then
    log "Basis-Libs (libstdc++/libgcc/libatomic) aus ${JAMMY_ROOT}..."
    for pat in 'libstdc++.so*' 'libgcc_s.so*' 'libatomic.so*'; do
        for f in "${GST_LIB_SRC}/"${pat}; do
            [[ -f "$f" || -L "$f" ]] && cp -aL "$f" "${APP_LIB}/$(basename "$f")" 2>/dev/null || true
        done
    done
fi

# ── 1. Node.js ────────────────────────────────────────────────────────────────
log "Node.js: ${NODE_BIN}"
cp -a "$NODE_BIN" "${APP_BIN}/node"
for bin in npm npx; do
    [[ -f "${NODE_DIR}/${bin}" ]] && cp -a "${NODE_DIR}/${bin}" "${APP_BIN}/${bin}" || true
done
copy_libs "$APP_LIB" "$NODE_BIN"

# ── 2. Anwendungsquellen ──────────────────────────────────────────────────────
log "App-Quellen: ${SCRIPT_DIR}"
(
    cd "${SCRIPT_DIR}"
    tar --create \
        --exclude='./node_modules' \
        --exclude='./build_appimage_tmp' \
        --exclude='./.git' \
        --exclude='./*.AppImage' \
        --exclude='./asrun' \
        --exclude='./recordings' \
        --exclude='./library.json' \
        --exclude='./startlog.log' \
        --exclude='./gst_audio.log' \
        --exclude='./*.zip' \
        --exclude='./*.deb' \
        . \
    | tar --extract --directory="${APP_SRC}"
)
mkdir -p "${APP_SRC}/asrun"

# ── 3. node_modules ──────────────────────────────────────────────────────────
log "node_modules: ${NODE_MODULES_SRC}"
cp -a "${NODE_MODULES_SRC}" "${APPDIR}/node_modules"

# Deps aller nativen Addons
log "Native Addon Dependencies..."
mapfile -t ADDONS < <(find "${APPDIR}/node_modules" -name '*.node' 2>/dev/null || true)
[[ ${#ADDONS[@]} -gt 0 ]] && copy_libs "$APP_LIB" "${ADDONS[@]}"

# ── 4. GStreamer-Plugins ──────────────────────────────────────────────────────
log "GStreamer-Plugins: ${GST_PLUGIN_SRC}"
if [[ -d "$GST_PLUGIN_SRC" ]]; then
    cp -a "${GST_PLUGIN_SRC}/." "${APP_GST}/"
    log "GStreamer Plugin-Dependencies..."
    mapfile -t GST_PLUGINS < <(find "${APP_GST}" -name '*.so' 2>/dev/null || true)
    [[ ${#GST_PLUGINS[@]} -gt 0 ]] && copy_libs "$APP_LIB" "${GST_PLUGINS[@]}"
else
    warn "GStreamer-Plugin-Verzeichnis nicht gefunden: ${GST_PLUGIN_SRC}"
fi

# ── 5. GStreamer-Kernbibliotheken ─────────────────────────────────────────────
log "GStreamer-Kernbibliotheken..."
GST_CORE_PATTERNS=(
    libgstreamer-1.0.so* libgstbase-1.0.so* libgstaudio-1.0.so*
    libgstvideo-1.0.so* libgstpbutils-1.0.so* libgstapp-1.0.so*
    libgstnet-1.0.so* libgsttag-1.0.so* libgstcontroller-1.0.so*
    libgstgl-1.0.so* libgstrtp-1.0.so* libgstrtsp-1.0.so*
    libgstsdp-1.0.so* libgstallocators-1.0.so* libgstcodecparsers-1.0.so*
    libgstmpegts-1.0.so* libgstplay-1.0.so* libgstplayer-1.0.so*
    libgstwebrtc-1.0.so* libgstbadaudio-1.0.so*
    libglib-2.0.so* libgmodule-2.0.so* libgobject-2.0.so*
    libgio-2.0.so* libffi.so* libz.so* liborc-0.4.so*
    libpulse.so* libpulse-simple.so* libasound.so*
    libavcodec.so* libavformat.so* libavutil.so*
    libswresample.so* libswscale.so* libx264.so* libxml2.so*
)
CORE_FILES=()
for pat in "${GST_CORE_PATTERNS[@]}"; do
    for f in "${GST_LIB_SRC}/"${pat}; do
        [[ -f "$f" || -L "$f" ]] && CORE_FILES+=("$f")
    done
done
[[ ${#CORE_FILES[@]} -gt 0 ]] && copy_libs "$APP_LIB" "${CORE_FILES[@]}"

# ── 5b. ffmpeg / ffprobe ──────────────────────────────────────────────────────
for _bin in ffmpeg ffprobe; do
    _bin_var="${_bin^^}_SRC"
    _bin_path="${!_bin_var:-}"
    if [[ -n "$_bin_path" && -f "$_bin_path" ]]; then
        log "Bundling ${_bin}: ${_bin_path}"
        cp -aL "$_bin_path" "${APP_BIN}/${_bin}"
        copy_libs "$APP_LIB" "$_bin_path"
    else
        warn "${_bin} nicht gefunden — wird vom Zielsystem benötigt"
    fi
done

# ── 6. gst-plugin-scanner ─────────────────────────────────────────────────────
if [[ -f "$GST_SCANNER_SRC" ]]; then
    log "gst-plugin-scanner"
    cp -a "$GST_SCANNER_SRC" "${APP_GSTTOOLS}/gst-plugin-scanner"
    copy_libs "$APP_LIB" "$GST_SCANNER_SRC"
fi

# ── 6b. Chrome Headless Shell (Puppeteer / oGraf) ─────────────────────────────
log "Chrome Headless Shell suchen..."
CHROME_BIN=""
CHROME_SEARCH_DIRS=(
    "${XDG_CACHE_HOME:-${HOME}/.cache}/puppeteer/chrome-headless-shell"
    "/home/infantilo/.cache/puppeteer/chrome-headless-shell"
)
for _dir in "${CHROME_SEARCH_DIRS[@]}"; do
    if [[ -d "$_dir" ]]; then
        _found="$(find "$_dir" -name "chrome-headless-shell" -type f 2>/dev/null | head -1)"
        [[ -n "$_found" ]] && { CHROME_BIN="$_found"; break; }
    fi
done

if [[ -n "$CHROME_BIN" ]]; then
    CHROME_SRC_DIR="$(dirname "$CHROME_BIN")"
    APP_CHROME="${APP_USR}/lib/chrome-headless-shell"
    log "Chrome Headless Shell: ${CHROME_SRC_DIR}"
    mkdir -p "$APP_CHROME"
    cp -a "${CHROME_SRC_DIR}/." "${APP_CHROME}/"
    chmod +x "${APP_CHROME}/chrome-headless-shell" 2>/dev/null || true
    log "Chrome Headless Shell eingebunden ($(du -sh "$APP_CHROME" | cut -f1))"
else
    warn "Chrome Headless Shell nicht gefunden — oGraf/Puppeteer ohne eigenes Chrome"
    warn "  Installieren: npx puppeteer browsers install chrome-headless-shell"
fi

# ── 7. patchelf ───────────────────────────────────────────────────────────────
if command -v patchelf &>/dev/null; then
    log "patchelf: RPATH setzen..."
    find "${APPDIR}" \( -name '*.node' -o -name 'node' \) | while read -r bin; do
        patchelf --set-rpath '$ORIGIN/../usr/lib:$ORIGIN/../../usr/lib' "$bin" 2>/dev/null || true
    done
    find "${APP_GST}" -name '*.so' | while read -r so; do
        patchelf --set-rpath '$ORIGIN/../lib' "$so" 2>/dev/null || true
    done
else
    warn "patchelf nicht gefunden – empfohlen: sudo apt install patchelf"
fi

# ── 8. settings.json ──────────────────────────────────────────────────────────
if [[ ! -f "${APP_SRC}/settings.json" ]]; then
    cat > "${APP_SRC}/settings.json" <<'JSON'
{
  "idleSource": "smpte",
  "idleImagePath": "IndianHeadTestPattern16x9.png",
  "width": 640,
  "height": 360,
  "fps": 25,
  "debugEnabled": false,
  "debugVerbose": false,
  "autoGap": true,
  "gapSource": "idle",
  "audioSink": "fakesink",
  "videoSink": "ximagesink",
  "asRunDir": "",
  "asRunEnabled": true,
  "authEnabled": false,
  "gstDebugFilter": "*:1"
}
JSON
fi

# Entwicklungsmaschinen-Pfade aus dem gebündelten Template entfernen.
# server.js fällt bei fehlenden Feldern auf _writablePath() / WORK_DIR zurück.
node -e "
const fs = require('fs');
const p = '${APP_SRC}/settings.json';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
['asRunDir','mediaDir','playlistsDir','grafixDir'].forEach(k => delete s[k]);
fs.writeFileSync(p, JSON.stringify(s, null, 2));
" 2>/dev/null || { warn "Node konnte settings.json nicht bereinigen — manuelle Prüfung empfohlen"; }

# ── 9. Icon ───────────────────────────────────────────────────────────────────
ICON_SRC=""
for c in "${SCRIPT_DIR}/icon.png" "${SCRIPT_DIR}/public/icon.png" \
          "${SCRIPT_DIR}/assets/icon.png" "${SCRIPT_DIR}/ui/icon.png"; do
    [[ -f "$c" ]] && { ICON_SRC="$c"; break; }
done
if [[ -n "$ICON_SRC" ]]; then
    cp "$ICON_SRC" "${APPDIR}/PipelineController.png"
else
    # 1×1 PNG Platzhalter
    base64 -d <<'EOF' > "${APPDIR}/PipelineController.png"
iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==
EOF
fi
mkdir -p "${APP_USR}/share/icons/hicolor/256x256/apps"
cp "${APPDIR}/PipelineController.png" \
   "${APP_USR}/share/icons/hicolor/256x256/apps/PipelineController.png"

# ── 10. .desktop ──────────────────────────────────────────────────────────────
cat > "${APPDIR}/PipelineController.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Pipeline Controller
Comment=GStreamer Broadcast Playout Controller
Exec=PipelineController
Icon=PipelineController
Categories=AudioVideo;Video;
Terminal=false
EOF
mkdir -p "${APP_USR}/share/applications"
cp "${APPDIR}/PipelineController.desktop" \
   "${APP_USR}/share/applications/PipelineController.desktop"

# ── 11. AppRun ────────────────────────────────────────────────────────────────
cat > "${APPDIR}/AppRun" <<'APPRUN'
#!/usr/bin/env bash
set -euo pipefail

APPDIR="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
export APPDIR

export PATH="${APPDIR}/usr/bin:${PATH}"
export LD_LIBRARY_PATH="${APPDIR}/usr/lib:${LD_LIBRARY_PATH:-}"
export GST_PLUGIN_PATH="${APPDIR}/usr/lib/gstreamer-1.0"
export GST_PLUGIN_SCANNER="${APPDIR}/usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner"
export GST_REGISTRY="${XDG_CACHE_HOME:-${HOME}/.cache}/pipeline-controller/registry.x86_64.bin"
mkdir -p "$(dirname "$GST_REGISTRY")"

WORK_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/pipeline-controller"
mkdir -p "${WORK_DIR}/asrun"

# Konfig-Dateien beim ersten Start in WORK_DIR kopieren
if [[ ! -f "${WORK_DIR}/settings.json" ]]; then
    cp "${APPDIR}/app/settings.json" "${WORK_DIR}/settings.json"
fi
for _cfg in audio_config.json grafik_hotkeys.json users.json; do
    if [[ ! -f "${WORK_DIR}/${_cfg}" && -f "${APPDIR}/app/${_cfg}" ]]; then
        cp "${APPDIR}/app/${_cfg}" "${WORK_DIR}/${_cfg}"
    fi
done

# oGraf-Templates: beim ersten Start und nach AppImage-Update synchronisieren.
# Nur neue/fehlende Templates werden kopiert — bestehende Nutzer-Templates bleiben erhalten.
_TMPL_SRC="${APPDIR}/app/templates/grafik"
_TMPL_DST="${WORK_DIR}/templates/grafik"
mkdir -p "${_TMPL_DST}"
if [[ -d "${_TMPL_SRC}" ]]; then
    if command -v rsync &>/dev/null; then
        rsync -a --ignore-existing "${_TMPL_SRC}/" "${_TMPL_DST}/"
    else
        cp -rn "${_TMPL_SRC}/." "${_TMPL_DST}/" 2>/dev/null || true
    fi
fi

# Playlists: beim ersten Start in WORK_DIR kopieren (schreibbar).
# Bestehende User-Playlists werden nicht überschrieben.
_PL_SRC="${APPDIR}/app/playlists"
_PL_DST="${WORK_DIR}/playlists"
mkdir -p "${_PL_DST}"
if [[ -d "${_PL_SRC}" ]]; then
    cp -rn "${_PL_SRC}/." "${_PL_DST}/" 2>/dev/null || true
fi

# Media: Env-Var-Fallback auf squashfs-Kopie, solange settings.json kein mediaDir setzt.
# Der User kann dies durch Setzen von "mediaDir" in settings.json überschreiben.
if [[ -z "${MEDIA_DIR:-}" && -d "${APPDIR}/app/media" ]]; then
    export MEDIA_DIR="${APPDIR}/app/media"
fi

# ── Puppeteer / oGraf: Chrome Headless Shell ──────────────────────────────────
# Chrome muss auf einem beschreibbaren Dateisystem laufen (nicht direkt aus
# squashfs). Beim ersten Start (oder nach AppImage-Update) wird es extrahiert.
_CHROME_IN_APPDIR="${APPDIR}/usr/lib/chrome-headless-shell/chrome-headless-shell"
_CHROME_USER_DIR="${WORK_DIR}/chrome-headless-shell"
_CHROME_USER_BIN="${_CHROME_USER_DIR}/chrome-headless-shell"

if [[ -f "$_CHROME_IN_APPDIR" ]]; then
    _NEED_EXTRACT=0
    if [[ ! -x "$_CHROME_USER_BIN" ]]; then
        _NEED_EXTRACT=1
    elif [[ -n "${APPIMAGE:-}" && "$APPIMAGE" -nt "$_CHROME_USER_BIN" ]]; then
        _NEED_EXTRACT=1
    fi
    if [[ "$_NEED_EXTRACT" -eq 1 ]]; then
        echo "[AppRun] Extrahiere Chrome Headless Shell → ${_CHROME_USER_DIR} ..."
        rm -rf "$_CHROME_USER_DIR"
        mkdir -p "$_CHROME_USER_DIR"
        cp -a "${APPDIR}/usr/lib/chrome-headless-shell/." "${_CHROME_USER_DIR}/"
        chmod +x "$_CHROME_USER_BIN"
        echo "[AppRun] Chrome Headless Shell bereit."
    fi
    export PUPPETEER_EXECUTABLE_PATH="$_CHROME_USER_BIN"
fi
export PUPPETEER_CACHE_DIR="${WORK_DIR}/puppeteer-cache"
export PUPPETEER_SKIP_DOWNLOAD=1

cd "${APPDIR}/app"

# ── Absturz-resistenter Start: persistentes Logfile + Auto-Restart-Loop ──────
# Hintergrund: Auf abgeschotteten Zielrechnern (kein Internet, nur Jumphost+RDP)
# ist es extrem mühsam, Logs/Stacktraces nachträglich einzusammeln. Ein nativer
# Absturz (Segfault im gst-kit-Addon, z.B. bei DeckLink-Quellen) killt den ganzen
# Node-Prozess OHNE dass JS-Handler (uncaughtException) greifen — daher wird hier
# auf Shell-Ebene mitgeschnitten: stdout/stderr laufen dauerhaft in ein Logfile,
# und nach jedem abnormalen Exit sammelt collect-crash-diagnostics.sh automatisch
# Coredump/dmesg/DeckLink-Status in EINEM Report, bevor der Server neu startet.
LOG_DIR="${WORK_DIR}/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/server.log"
# Logfile beim Start auf die letzten 5000 Zeilen begrenzen (kein unbegrenztes Wachstum)
if [[ -f "$LOG_FILE" ]]; then
    tail -n 5000 "$LOG_FILE" > "${LOG_FILE}.tmp" 2>/dev/null && mv "${LOG_FILE}.tmp" "$LOG_FILE"
fi

ulimit -c unlimited 2>/dev/null || true

# ── Hardware-Erkennung (DeckLink / NVIDIA) ────────────────────────────────────
# Läuft VOR dem Node-Start, damit (a) sofort im Log sichtbar ist, ob die Karten
# überhaupt erkannt wurden (statt erst nach evtl. langwierigem Geräte-Scan in
# Node), und (b) Node per Env-Var weiß, ob es DeckLink/NVIDIA-Pfade überhaupt
# probieren muss — vermeidet unnötige gst-device-monitor-Scans und Log-Rauschen
# auf Maschinen ohne diese Hardware.
HW_DECKLINK_PRESENT=0
if lsmod 2>/dev/null | grep -qi blackmagic; then
    HW_DECKLINK_PRESENT=1
elif command -v lspci &>/dev/null && lspci 2>/dev/null | grep -qi blackmagic; then
    HW_DECKLINK_PRESENT=1
fi
export HW_DECKLINK_PRESENT

HW_NVIDIA_PRESENT=0
if command -v nvidia-smi &>/dev/null && nvidia-smi -L &>/dev/null; then
    HW_NVIDIA_PRESENT=1
elif command -v lspci &>/dev/null && lspci 2>/dev/null | grep -qi nvidia; then
    HW_NVIDIA_PRESENT=1
fi
export HW_NVIDIA_PRESENT

{
    echo "=== AppRun: Hardware-Erkennung $(date -Is) ==="
    echo "  DeckLink: $([[ $HW_DECKLINK_PRESENT -eq 1 ]] && echo "gefunden" || echo "nicht gefunden")"
    echo "  NVIDIA:   $([[ $HW_NVIDIA_PRESENT -eq 1 ]] && echo "gefunden" || echo "nicht gefunden")"
} >> "$LOG_FILE"
echo "[AppRun] DeckLink: $([[ $HW_DECKLINK_PRESENT -eq 1 ]] && echo "✓ gefunden" || echo "✗ nicht gefunden") | NVIDIA: $([[ $HW_NVIDIA_PRESENT -eq 1 ]] && echo "✓ gefunden" || echo "✗ nicht gefunden")"

while true; do
    echo "=== AppRun: Start $(date -Is) ===" >> "$LOG_FILE"
    set +e
    "${APPDIR}/usr/bin/node" \
        --require "${APPDIR}/app/appimage_bootstrap.js" \
        "${APPDIR}/app/server.js" \
        "$@" >> "$LOG_FILE" 2>&1
    NODE_EXIT=$?
    set -e
    echo "=== AppRun: Node beendet, Exit-Code=${NODE_EXIT} $(date -Is) ===" >> "$LOG_FILE"

    if [[ "$NODE_EXIT" -eq 0 ]]; then
        echo "[AppRun] Geordneter Shutdown — beende."
        break
    fi

    echo "[AppRun] Abnormaler Exit (${NODE_EXIT}) — sammle Diagnose-Report..."
    if [[ -x "${APPDIR}/app/scripts/collect-crash-diagnostics.sh" ]]; then
        "${APPDIR}/app/scripts/collect-crash-diagnostics.sh" "$NODE_EXIT" "$LOG_FILE" "$WORK_DIR" || true
    fi
    echo "[AppRun] Neustart in 3s... (Diagnose unter ${WORK_DIR}/diagnostics/latest-crash.txt)"
    sleep 3
done
APPRUN
chmod +x "${APPDIR}/AppRun"

# ── 12. Bootstrap-Modul ───────────────────────────────────────────────────────
cat > "${APP_SRC}/appimage_bootstrap.js" <<'JS'
'use strict';
const path = require('path');
const fs   = require('fs');
const workDir = path.join(
    process.env.XDG_DATA_HOME || path.join(process.env.HOME, '.local', 'share'),
    'pipeline-controller'
);
const settingsPath = path.join(workDir, 'settings.json');
if (fs.existsSync(settingsPath)) {
    const Module = require('module');
    const _orig = Module._resolveFilename.bind(Module);
    Module._resolveFilename = function(request, parent, isMain, options) {
        if (request.endsWith('settings.json') && !request.startsWith(workDir)) {
            return settingsPath;
        }
        return _orig(request, parent, isMain, options);
    };
}
JS

# ── 13. AppImage bauen ────────────────────────────────────────────────────────
log "AppImage wird gebaut..."
OUTPUT="${PARENT_DIR}/${APPNAME}-${APPVER}-${ARCH}.AppImage"

ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 "$APPIMAGETOOL" --verbose "$APPDIR" "$OUTPUT" 2>&1

log "─────────────────────────────────────────────────"
log "Fertig:   ${OUTPUT}"
log "Größe:    $(du -sh "$OUTPUT" | cut -f1)"
log "Temp-Dir: ${BUILD_DIR} (kann gelöscht werden)"
log "Start:    ${APPNAME}-${APPVER}-${ARCH}.AppImage"
log "Konfig:   ~/.local/share/pipeline-controller/"
log "─────────────────────────────────────────────────"
