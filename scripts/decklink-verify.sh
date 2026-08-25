#!/usr/bin/env bash
# decklink-verify.sh — Offline-Verifikation der DeckLink-Ausgabe (IP100 etc.)
# ════════════════════════════════════════════════════════════════════════════
# Für abgeschottete Zielrechner (kein Internet, nur Jumphost): reine bash +
# gst-launch-1.0/gst-inspect-1.0/gst-device-monitor-1.0, keine weiteren
# Abhängigkeiten. Jeder Lauf schreibt einen Report nach
# <workDir>/diagnostics/decklink-verify-<ts>.txt UND auf stdout.
#
# Modi:
#   detect              Karten + Sink/Source-Caps auflisten
#   modes [dev]         Jeden unterstützten Mode 5s real auf die Karte ausgeben
#                       (progressive UND interlaced), PASS/FAIL je Mode
#   clock [dev]         Prüfen ob GstDecklinkClock als Pipeline-Clock gewählt wird
#   soak <min> [dev] [mode]  Langlauf, zählt drop/late/QoS-Zeilen pro Minute
#   duplex [devA] [devB] [secs]  6 Kombinations-Tests (Sink allein / + Live-Quelle /
#                       + Audio-Sink / alle vier Rollen / auf anderem device-number) —
#                       grenzt ein, ob "state change failed" bei zweiter Decklink-Rolle
#                       am selben device-number liegt oder grundsätzlich ist
#   ptp                 PTP-Status (ptp4l/phc2sys, ethtool -T, pmc) — tolerant
#   (ohne Argument)     default = detect + clock + modes Kurzdurchlauf
#
# ACHTUNG: Die DeckLink-Karte ist exklusiv — der Playout-Server muss gestoppt
# sein. Der Guard bricht sonst ab (Übersteuerung: --force).
set -uo pipefail

# ── workDir-Ermittlung (wie collect-crash-diagnostics.sh: PC_DATA_DIR bzw. Default) ──
WORK_DIR="${PC_DATA_DIR:-${HOME}/.local/share/pipeline-controller}"
OUT_DIR="${WORK_DIR}/diagnostics"
mkdir -p "$OUT_DIR" 2>/dev/null || { OUT_DIR="/tmp"; }
TS_FILE="$(date +%Y%m%d-%H%M%S)"
REPORT="${OUT_DIR}/decklink-verify-${TS_FILE}.txt"

# Alles was via out() läuft geht in Report UND stdout
out() { printf '%s\n' "$*" | tee -a "$REPORT"; }
hdr() { out ""; out "━━━ $* ━━━"; }

# ── Argumente ────────────────────────────────────────────────────────────────
FORCE=0
ARGS=()
for a in "$@"; do
    [[ "$a" == "--force" ]] && FORCE=1 || ARGS+=("$a")
done
CMD="${ARGS[0]:-default}"

# ── Guard: Playout-Server darf nicht laufen (Karte ist exklusiv) ─────────────
guard_server() {
    local hits=""
    # Node-Server oder AppImage-Prozess
    if pgrep -f 'node.*server\.js' >/dev/null 2>&1; then hits="node server.js"; fi
    if pgrep -f 'PipelineController.*\.AppImage' >/dev/null 2>&1; then hits="${hits:+$hits, }PipelineController AppImage"; fi
    # Portcheck (Default 3000, via PORT-Env übersteuerbar)
    local port="${PORT:-3000}"
    if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
        exec 3>&- 3<&- || true
        hits="${hits:+$hits, }Port ${port} belegt"
    fi
    if [[ -n "$hits" ]]; then
        if [[ "$FORCE" == "1" ]]; then
            out "WARNUNG: Playout-Server scheint zu laufen (${hits}) — --force gesetzt, fahre fort."
        else
            out "ABBRUCH: Playout-Server läuft offenbar (${hits})."
            out "Die DeckLink-Karte ist exklusiv — Server erst stoppen, dann erneut ausführen."
            out "Übersteuerung (auf eigene Gefahr): $0 $CMD --force"
            exit 2
        fi
    fi
}

# ── Mode-Tabelle — MUSS mit lib/InterlaceChain.js / lib/OutputEngine.js übereinstimmen ──
# Format: name|breite|höhe|framerate|interlaced(0/1)|par|feldrate
# Interlaced: framerate = FRAME-Rate (interleaved), feldrate = 2×framerate.
MODES_TABLE="
pal-p|720|576|50/1|0||
720p50|1280|720|50/1|0||
720p5994|1280|720|60000/1001|0||
1080p25|1920|1080|25/1|0||
1080p2997|1920|1080|30000/1001|0||
1080p50|1920|1080|50/1|0||
1080i50|1920|1080|25/1|1|1/1|50/1
1080i5994|1920|1080|30000/1001|1|1/1|60000/1001
1080i60|1920|1080|30/1|1|1/1|60/1
pal|720|576|25/1|1|12/11|50/1
ntsc|720|486|30000/1001|1|10/11|60000/1001
"

mode_row() { echo "$MODES_TABLE" | grep -m1 "^${1}|" || true; }

# Baut die gst-launch-Argumente (als String) für einen Mode: Quelle → Sink.
# num-buffers auf ~<sekunden>s bei der jeweiligen Quell-Framerate.
build_launch() {
    local row="$1" dev="$2" secs="$3" numbuf_override="${4:-}"
    local name w h fps il par frate
    IFS='|' read -r name w h fps il par frate <<< "$row"
    local src_fps num den nb
    if [[ "$il" == "1" ]]; then src_fps="$frate"; else src_fps="$fps"; fi
    num="${src_fps%%/*}"; den="${src_fps##*/}"
    nb=$(( num * secs / den )); (( nb < 1 )) && nb=1
    [[ -n "$numbuf_override" ]] && nb="$numbuf_override"
    local parcaps=""
    [[ -n "$par" ]] && parcaps=",pixel-aspect-ratio=${par}"
    if [[ "$il" == "1" ]]; then
        # Gleiche Kette wie lib/InterlaceChain.js: videorate auf Feldrate → interlace 1:1
        echo "videotestsrc is-live=true num-buffers=${nb} pattern=smpte" \
             "! video/x-raw,format=UYVY,width=${w},height=${h},framerate=${frate}${parcaps}" \
             "! interlace top-field-first=true field-pattern=1:1" \
             "! video/x-raw,interlace-mode=interleaved,width=${w},height=${h},framerate=${fps}${parcaps}" \
             "! videoconvert ! decklinkvideosink device-number=${dev} mode=${name} sync=true"
    else
        echo "videotestsrc is-live=true num-buffers=${nb} pattern=smpte" \
             "! video/x-raw,format=UYVY,width=${w},height=${h},framerate=${fps}" \
             "! videoconvert ! decklinkvideosink device-number=${dev} mode=${name} sync=true"
    fi
}

# ── detect ───────────────────────────────────────────────────────────────────
do_detect() {
    hdr "detect: GStreamer + DeckLink-Elemente"
    out "$(gst-inspect-1.0 --version 2>&1 | head -2)"
    for el in decklinkvideosink decklinkaudiosink decklinkvideosrc decklinkaudiosrc; do
        if gst-inspect-1.0 "$el" >/dev/null 2>&1; then
            out "  ${el}: vorhanden"
        else
            out "  ${el}: FEHLT (gst-plugins-bad/decklink nicht installiert?)"
        fi
    done

    hdr "detect: Karten (gst-device-monitor Video/Sink + Video/Source)"
    local mon
    mon="$(timeout 15 gst-device-monitor-1.0 2>/dev/null | grep -B2 -A14 -i 'decklink\|blackmagic' || true)"
    if [[ -n "$mon" ]]; then out "$mon"; else out "(keine DeckLink/Blackmagic-Geräte gefunden)"; fi

    hdr "detect: Treiber/Service"
    out "$(lsmod 2>/dev/null | grep -i blackmagic || echo '(kein blackmagic-Kernelmodul geladen)')"
    out "$(systemctl status desktopvideod 2>&1 | head -5 || true)"

    hdr "detect: Sink-Template-Caps (Auszug decklinkvideosink)"
    # head schließt die Pipe (SIGPIPE) → Exit-Status unbrauchbar; daher Variable + Fallback
    local caps
    caps="$(gst-inspect-1.0 decklinkvideosink 2>/dev/null | sed -n '/SINK template/,/^$/p' | head -40)"
    out "${caps:-(nicht verfügbar)}"
}

# Liefert 0 wenn mind. eine Karte da ist (für frühe, klare FAIL-Meldung).
has_card() {
    timeout 15 gst-device-monitor-1.0 Video/Sink 2>/dev/null | grep -qi 'decklink\|blackmagic'
}

# ── modes ────────────────────────────────────────────────────────────────────
do_modes() {
    local dev="${1:-0}" quick="${2:-0}"
    guard_server
    hdr "modes: 5s-Realtest je Mode auf device-number=${dev}"
    if ! has_card; then
        out "FAIL: keine DeckLink-Karte gefunden — Mode-Tests nicht möglich."
        return 1
    fi
    local pass=0 fail=0
    local list="$MODES_TABLE"
    # Kurzdurchlauf (default-Modus): nur je ein progressiver + ein interlaced Mode
    [[ "$quick" == "1" ]] && list="$(mode_row 1080p25)
$(mode_row 1080i50)"
    while IFS= read -r row; do
        [[ -z "$row" ]] && continue
        local name="${row%%|*}"
        local launch; launch="$(build_launch "$row" "$dev" 5)"
        out ""
        out "Mode ${name}: gst-launch-1.0 ${launch}"
        local errf; errf="$(mktemp)"
        if timeout 40 gst-launch-1.0 -q ${launch} >/dev/null 2>"$errf"; then
            out "  PASS: ${name}"
            pass=$((pass+1))
        else
            out "  FAIL: ${name}"
            grep -m4 -iE 'error|not-negotiated|could not' "$errf" | sed 's/^/    /' | tee -a "$REPORT"
            fail=$((fail+1))
        fi
        rm -f "$errf"
    done <<< "$list"
    out ""
    out "modes-Zusammenfassung: ${pass} PASS, ${fail} FAIL"
    [[ "$fail" -eq 0 ]]
}

# ── clock ────────────────────────────────────────────────────────────────────
do_clock() {
    local dev="${1:-0}"
    guard_server
    hdr "clock: Pipeline-Clock-Auswahl mit decklinkvideosink (device-number=${dev})"
    if ! has_card; then
        out "FAIL: keine DeckLink-Karte gefunden — Clock-Test nicht möglich."
        return 1
    fi
    local errf; errf="$(mktemp)"
    # CLOCK:4 + Pipeline/Bin-Kategorien: loggt die Clock-Auswahl ("... selected/obtained clock ...")
    GST_DEBUG="CLOCK:4,bin:4,GST_PIPELINE:4" GST_DEBUG_NO_COLOR=1 \
        timeout 30 gst-launch-1.0 -q \
        videotestsrc is-live=true num-buffers=75 \
        ! video/x-raw,format=UYVY,width=1920,height=1080,framerate=25/1 \
        ! videoconvert ! decklinkvideosink device-number="$dev" mode=1080p25 sync=true \
        >/dev/null 2>"$errf"
    local rc=$?
    local clockhits
    clockhits="$(grep -i 'decklinkclock' "$errf" | head -8 || true)"
    out "Clock-Log-Treffer (GstDecklinkClock):"
    if [[ -n "$clockhits" ]]; then
        out "$clockhits"
        out "PASS: GstDecklinkClock wird als Pipeline-Clock verwendet."
        rm -f "$errf"; return 0
    else
        out "(keine GstDecklinkClock-Zeilen im CLOCK-Log)"
        out "Gewählte Clock laut Log:"
        out "$(grep -iE 'select.*clock|obtained clock|using.*clock' "$errf" | head -5 || echo '(nichts gefunden)')"
        out "FAIL: DeckLink-Clock wurde NICHT gewählt (rc=${rc})."
        rm -f "$errf"; return 1
    fi
}

# ── soak ─────────────────────────────────────────────────────────────────────
do_soak() {
    local mins="${1:-}" dev="${2:-0}" mode="${3:-1080p25}"
    if [[ -z "$mins" ]]; then
        out "FAIL: soak braucht eine Laufzeit in Minuten: $0 soak <minuten> [dev] [mode]"
        return 1
    fi
    guard_server
    hdr "soak: ${mins}min Dauerausgabe device-number=${dev} mode=${mode}"
    if ! has_card; then
        out "FAIL: keine DeckLink-Karte gefunden — Soak-Test nicht möglich."
        return 1
    fi
    local row; row="$(mode_row "$mode")"
    if [[ -z "$row" ]]; then
        out "FAIL: unbekannter Mode '${mode}'. Verfügbar:"
        out "$(echo "$MODES_TABLE" | cut -d'|' -f1 | grep -v '^$' | sed 's/^/  /')"
        return 1
    fi
    # Sekunden aus (ggf. gebrochenen) Minuten — awk statt bash-Arithmetik (0.5 etc.)
    local secs; secs="$(awk -v m="$mins" 'BEGIN{ printf "%d", (m*60 < 1 ? 1 : m*60) }')"
    local gstlog; gstlog="$(mktemp "${TMPDIR:-/tmp}/decklink-soak-XXXXXX.log")"
    local launch; launch="$(build_launch "$row" "$dev" "$secs")"
    out "Laufzeit: ${secs}s | GST_DEBUG=decklink:4,*basesink*:4 → ${gstlog}"
    out "Pipeline: gst-launch-1.0 ${launch}"
    GST_DEBUG="decklink:4,*basesink*:4" GST_DEBUG_NO_COLOR=1 GST_DEBUG_FILE="$gstlog" \
        timeout $((secs + 30)) gst-launch-1.0 -q ${launch} >/dev/null 2>&1
    local rc=$?
    out "gst-launch Exit-Code: ${rc}"

    hdr "soak: Auswertung drop/late/QoS pro Minute"
    if [[ ! -s "$gstlog" ]]; then
        out "FAIL: kein GST_DEBUG-Log entstanden (${gstlog})"
        return 1
    fi
    # GStreamer-Log-Zeitstempel: H:MM:SS.nnnnnnnnn → Minute extrahieren und zählen
    awk '
        /[Dd]rop|late|[Qq]o[sS]/ {
            if (match($1, /^[0-9]+:[0-9]+:/)) {
                split($1, t, ":"); min = t[1]*60 + t[2];
                cnt[min]++; total++;
            }
        }
        END {
            for (m in cnt) printf "  Minute %d: %d Treffer\n", m, cnt[m];
            printf "  Gesamt: %d drop/late/QoS-Zeilen\n", total+0;
        }
    ' "$gstlog" | tee -a "$REPORT"
    local total
    total="$(grep -ciE 'drop|late|qos' "$gstlog" || true)"
    out "soak-Ergebnis: ${total:-0} auffällige Zeilen in ${secs}s (Log: ${gstlog})"
    [[ "$rc" -eq 0 ]]
}

# ── duplex ───────────────────────────────────────────────────────────────────
# Reproduziert den gemeldeten Bug isoliert (ohne Node-App): decklinkvideosink
# läuft solo einwandfrei, schlägt aber fehl sobald eine Live-Quelle
# (decklinkvideosrc) oder ein decklinkaudiosink dazukommt. Jeder Test ist EINE
# gst-launch-Pipeline mit mehreren Decklink-Rollen gleichzeitig — wie im echten
# Master-Prozess (ein Prozess, mehrere Decklink-Elemente in derselben Pipeline).
# Tests 5/6 wiederholen 2/3 auf einem ANDEREN device-number, um zu trennen ob
# der Konflikt am WIEDERVERWENDEN desselben device-number liegt oder generell
# bei einer zweiten Decklink-Instanz im selben Prozess auftritt.
do_duplex() {
    local devA="${1:-0}" devB="${2:-1}" secs="${3:-8}"
    guard_server
    hdr "duplex: Kombinations-Tests device-number=${devA} (Tests 5/6 zusätzlich gegen device-number=${devB})"
    if ! has_card; then
        out "FAIL: keine DeckLink-Karte gefunden — Duplex-Tests nicht möglich."
        return 1
    fi
    out "Jeder Test läuft ${secs}s als EINE gst-launch-1.0-Pipeline (SIGINT-Stop danach),"
    out "GST_DEBUG=decklink:5,*:2 wird je Test mitgeschnitten. rc≠0 oder ERROR-Zeilen vor Ablauf → FAIL."

    local vsink="videotestsrc is-live=true pattern=smpte ! video/x-raw,format=UYVY,width=1920,height=1080,framerate=25/1 ! videoconvert ! decklinkvideosink device-number=${devA} mode=1080p25 sync=true"
    local asrc="audiotestsrc wave=silence is-live=true ! audio/x-raw,format=S16LE,channels=2,rate=48000"

    local order=(
        "1-baseline-sink-allein"
        "2-plus-videosrc-gleiches-device"
        "3-plus-audiosink-gleiches-device"
        "4-alle-vier-rollen-gleiches-device"
        "5-plus-videosrc-ANDERES-device"
        "6-plus-audiosink-ANDERES-device"
    )
    declare -A LAUNCH=(
        ["1-baseline-sink-allein"]="${vsink}"
        ["2-plus-videosrc-gleiches-device"]="${vsink} decklinkvideosrc device-number=${devA} mode=auto ! fakesink"
        ["3-plus-audiosink-gleiches-device"]="${vsink} ${asrc} ! decklinkaudiosink device-number=${devA}"
        ["4-alle-vier-rollen-gleiches-device"]="${vsink} ${asrc} ! decklinkaudiosink device-number=${devA} decklinkvideosrc device-number=${devA} mode=auto ! fakesink decklinkaudiosrc device-number=${devA} ! fakesink"
        ["5-plus-videosrc-ANDERES-device"]="${vsink} decklinkvideosrc device-number=${devB} mode=auto ! fakesink"
        ["6-plus-audiosink-ANDERES-device"]="${vsink} ${asrc} ! decklinkaudiosink device-number=${devB}"
    )

    local pass=0 fail=0
    local -a failed_tests=()
    for key in "${order[@]}"; do
        local launch="${LAUNCH[$key]}"
        out ""
        out "── Test ${key} ──"
        out "gst-launch-1.0 ${launch}"
        local errf; errf="$(mktemp)"
        GST_DEBUG="decklink:5,*:2" GST_DEBUG_NO_COLOR=1 \
            timeout -s INT "${secs}" gst-launch-1.0 -q ${launch} >/dev/null 2>"$errf"
        local rc=$?
        local errlines
        errlines="$(grep -iE 'ERROR|not-negotiated|could not' "$errf" || true)"
        if [[ "$rc" -eq 0 && -z "$errlines" ]]; then
            out "  PASS (rc=${rc}, lief ${secs}s ohne Fehler)"
            pass=$((pass+1))
        else
            out "  FAIL (rc=${rc})"
            local dllines; dllines="$(grep -i decklink "$errf" | tail -30 || true)"
            if [[ -n "$dllines" ]]; then
                out "  decklink-Zeilen (letzte 30):"
                out "$dllines"
            else
                out "  (keine decklink-Zeilen — allgemeine Fehler:)"
                out "$(grep -iE 'error' "$errf" | tail -10 || true)"
            fi
            fail=$((fail+1))
            failed_tests+=("$key")
        fi
        rm -f "$errf"
    done

    out ""
    out "duplex-Zusammenfassung: ${pass} PASS, ${fail} FAIL"
    [[ "$fail" -gt 0 ]] && out "Fehlgeschlagen: ${failed_tests[*]}"
    if [[ "$fail" -gt 0 ]]; then
        out ""
        out "Interpretationshilfe:"
        out "  Test 1 FAIL                        → Grundproblem, nicht duplex-bezogen (Karte/Treiber generell defekt)."
        out "  2 und/oder 3 FAIL, 5 und 6 PASS     → Konflikt spezifisch bei WIEDERVERWENDUNG desselben device-number."
        out "                                        Fix: Live-Quelle/Audio-Sink auf anderen device-number legen."
        out "  2/3 UND 5/6 FAIL                    → Konflikt ist nicht device-number-spezifisch, tritt bei jeder"
        out "                                        zweiten Decklink-Instanz im selben Prozess auf (Plugin-/"
        out "                                        Treiber-/Lizenz-Limit, keine reine Config-Frage)."
        out "  Nur 4 FAIL, 2/3 PASS                → Konflikt erst bei allen vier Rollen gleichzeitig (Ressourcen-"
        out "                                        limit, z.B. max. gleichzeitige Streams der Karte)."
    fi
    [[ "$fail" -eq 0 ]]
}

# ── ptp ──────────────────────────────────────────────────────────────────────
do_ptp() {
    hdr "ptp: Prozesse"
    out "$(pgrep -a ptp4l 2>/dev/null || echo '(ptp4l läuft nicht)')"
    out "$(pgrep -a phc2sys 2>/dev/null || echo '(phc2sys läuft nicht)')"

    hdr "ptp: Journal-Tail (ptp4l/phc2sys, tolerant)"
    if command -v journalctl >/dev/null 2>&1; then
        out "$(journalctl -u ptp4l -n 15 --no-pager 2>/dev/null || true)"
        out "$(journalctl -u phc2sys -n 15 --no-pager 2>/dev/null || true)"
        out "$(journalctl -n 200 --no-pager 2>/dev/null | grep -iE 'ptp4l|phc2sys' | tail -15 || true)"
    else
        out "(journalctl nicht verfügbar)"
    fi

    hdr "ptp: ethtool -T je NIC (Hardware-Timestamping-Fähigkeiten)"
    if command -v ethtool >/dev/null 2>&1; then
        for nic in /sys/class/net/*; do
            local n; n="$(basename "$nic")"
            [[ "$n" == "lo" ]] && continue
            out "--- ${n} ---"
            out "$(ethtool -T "$n" 2>&1 | head -20)"
        done
    else
        out "(ethtool nicht installiert)"
    fi

    hdr "ptp: pmc (PTP-Management, falls vorhanden)"
    if command -v pmc >/dev/null 2>&1; then
        out "$(pmc -u -b 0 'GET CURRENT_DATA_SET' 2>&1 | head -20 || true)"
        out "$(pmc -u -b 0 'GET TIME_STATUS_NP' 2>&1 | head -20 || true)"
    else
        out "(pmc nicht installiert — linuxptp-Paket)"
    fi
}

# ── Main ─────────────────────────────────────────────────────────────────────
out "decklink-verify — $(date -Is) — Modus: ${CMD}"
out "Host: $(hostname) | Report: ${REPORT}"

RC=0
case "$CMD" in
    detect) do_detect ;;
    modes)  do_modes "${ARGS[1]:-0}" 0 || RC=$? ;;
    clock)  do_clock "${ARGS[1]:-0}" || RC=$? ;;
    soak)   do_soak "${ARGS[1]:-}" "${ARGS[2]:-0}" "${ARGS[3]:-1080p25}" || RC=$? ;;
    duplex) do_duplex "${ARGS[1]:-0}" "${ARGS[2]:-1}" "${ARGS[3]:-8}" || RC=$? ;;
    ptp)    do_ptp ;;
    default)
        do_detect
        do_clock 0            || RC=$?
        do_modes 0 1          || RC=$?
        ;;
    *)
        out "Unbekannter Modus: ${CMD}"
        out "Nutzung: $0 [detect|modes [dev]|clock [dev]|soak <min> [dev] [mode]|duplex [devA] [devB] [secs]|ptp] [--force]"
        RC=1
        ;;
esac

out ""
out "Report gespeichert: ${REPORT}"
exit "$RC"
