#!/usr/bin/env bash
# collect-crash-diagnostics.sh — Wird von AppRun nach einem ABNORMALEN Node-Exit
# (Signal/Crash, z.B. native Segfault im gst-kit-Addon) aufgerufen.
#
# Schreibt EIN Diagnose-File nach <WORK_DIR>/diagnostics/, das alles enthält, was
# zur Ferndiagnose nötig ist — ohne dass am abgeschotteten Zielrechner irgendetwas
# per Hand eingetippt oder ein Logfile/Coredump separat transferiert werden muss.
# Der User öffnet es einfach (z.B. via "📦 Diagnose-Bundle" in der UI, das diese
# Datei automatisch mit einbettet) und kann den Text per Copy&Paste weitergeben.
#
# Aufruf: collect-crash-diagnostics.sh <exit_code> <log_file> <work_dir>
set -uo pipefail

EXIT_CODE="${1:-?}"
LOG_FILE="${2:-}"
WORK_DIR="${3:-${HOME}/.local/share/pipeline-controller}"

OUT_DIR="${WORK_DIR}/diagnostics"
mkdir -p "$OUT_DIR"
TS="$(date -Is)"
TS_FILE="$(date +%Y%m%d-%H%M%S)"
OUT="${OUT_DIR}/crash-${TS_FILE}.txt"

SIGNAL_NAME=""
if [[ "$EXIT_CODE" =~ ^[0-9]+$ ]] && (( EXIT_CODE > 128 )); then
    SIGNUM=$(( EXIT_CODE - 128 ))
    SIGNAL_NAME="$(kill -l "$SIGNUM" 2>/dev/null || echo "Signal ${SIGNUM}")"
fi

{
    echo "Crash-Report — ${TS}"
    echo "Exit-Code: ${EXIT_CODE}${SIGNAL_NAME:+ (Signal: ${SIGNAL_NAME})}"
    echo

    echo "━━━ Letzte Log-Zeilen (gefiltert: ERROR/WARN/decklink/FATAL) ━━━"
    if [[ -f "$LOG_FILE" ]]; then
        FILTERED="$(tail -n 2000 "$LOG_FILE" | grep -iE 'error|warn|fatal|decklink|segfault|crash' | tail -n 120)"
        if [[ -n "$FILTERED" ]]; then echo "$FILTERED"; else echo "(keine Treffer — letzte 60 Zeilen ungefiltert:)"; tail -n 60 "$LOG_FILE"; fi
    else
        echo "(kein Logfile unter ${LOG_FILE} gefunden)"
    fi
    echo

    echo "━━━ dmesg (gefiltert: blackmagic/decklink/segfault/node) ━━━"
    dmesg 2>/dev/null | tail -n 500 | grep -iE 'blackmagic|decklink|segfault|node\[' | tail -n 60 || echo "(dmesg nicht lesbar — evtl. fehlende Rechte; siehe 'journalctl -k' als Alternative)"
    echo

    echo "━━━ Resilienz-Status ━━━"
    echo "Crash-Zähler: ${PC_CRASH_COUNT_NEXT:-?}  → nächster Start im Safe-Mode ${PC_SAFE_MODE_NEXT:-0}  (0=normal, 1=Software-Decode/Compositor, 2=Pipeline-Autostart aus)"
    echo "ulimit -c: $(ulimit -c)   core_pattern: $(cat /proc/sys/kernel/core_pattern 2>/dev/null)   gdb: $(command -v gdb || echo 'NICHT installiert (sudo apt install gdb)')"
    echo

    echo "━━━ gdb-Backtrace (Neustart unter gdb) ━━━"
    if [[ -n "${GDB_BACKTRACE_FILE:-}" && -s "${GDB_BACKTRACE_FILE}" ]]; then
        # Reihenfolge der gdb-Ausgabe: CRASH-THREAD, ALLE THREADS, REGISTER, BIBLIOTHEKEN.
        # NICHT per tail kürzen (das schnitt früher den Crash-Thread ab): stattdessen
        # Leerlauf-Threads (uv-worker/V8-Worker/Inspector) herausfiltern, Libs auf
        # gst/decklink/nvidia/gl reduzieren.
        grep -vE '^\[New Thread|^\[Thread .* exited|^\[Detaching' "$GDB_BACKTRACE_FILE" | awk '
            /^===== GELADENE BIBLIOTHEKEN/ { inlib=1; print; next }
            /^=====/                      { inlib=0 }
            inlib { if ($0 ~ /gst|decklink|DeckLink|nvidia|nvcuvid|libGL|libEGL|gst_kit|^\[Inferior/) print; next }
            /^Thread [0-9]+ /             { blk=$0; skip=0; next_is_block=1 }
            { print }' | awk -v RS='' -v ORS='\n\n' '
            /PlatformWorkerThread|SignalInspector|DelayedTaskSche|uv_cond_wait.*\n.*worker \(arg/ && !/CRASH|SIG/ { next }
            { print }' | head -n 400
    else
        echo "(kein gdb-Backtrace: gdb nicht installiert oder PC_GDB=0 gesetzt)"
    fi
    echo

    echo "━━━ Letzte 60 Log-Zeilen UNGEFILTERT (vor dem Absturz) ━━━"
    [[ -f "$LOG_FILE" ]] && tail -n 60 "$LOG_FILE" | cut -c1-300
    echo

    echo "━━━ Coredump + Backtrace ━━━"
    CORE=""
    # 1) klassisches core/core.<pid> im aktuellen Arbeitsverzeichnis von AppRun
    for f in core core.*; do
        [[ -f "$f" ]] && CORE="$f" && break
    done
    # 2) systemd-coredump (Ubuntu-Standard, kein Root nötig wenn coredumpctl verfügbar)
    if [[ -z "$CORE" ]] && command -v coredumpctl &>/dev/null; then
        CDINFO="$(coredumpctl list --no-pager -1 node 2>/dev/null | tail -n 1)"
        if [[ -n "$CDINFO" ]]; then
            echo "systemd-coredump-Eintrag gefunden:"
            echo "$CDINFO"
            if command -v gdb &>/dev/null; then
                echo "--- Backtrace (coredumpctl debug) ---"
                coredumpctl debug node -1 --no-pager -A '-batch -ex "thread apply all bt" -ex quit' 2>&1 | tail -n 80
            else
                echo "(gdb nicht installiert — keine automatische Backtrace-Extraktion möglich)"
            fi
        fi
    fi
    # 3) Ubuntu apport (/var/crash) — meist lesbar ohne Root für den crashenden User
    if [[ -z "$CORE" && -d /var/crash ]]; then
        LATEST_APPORT="$(ls -t /var/crash/*node*.crash 2>/dev/null | head -n1)"
        if [[ -n "$LATEST_APPORT" ]]; then
            echo "Apport-Report gefunden: ${LATEST_APPORT}"
            echo "(enthält i.d.R. bereits einen Stacktrace — Auszug:)"
            grep -A 60 -i "^Stacktrace" "$LATEST_APPORT" 2>/dev/null | head -n 80
        fi
    fi
    if [[ -n "$CORE" ]]; then
        echo "Core-Datei gefunden: ${CORE}"
        if command -v gdb &>/dev/null; then
            NODE_BIN="$(command -v node || echo node)"
            gdb -batch -ex "thread apply all bt full" -ex quit "$NODE_BIN" "$CORE" 2>&1 | tail -n 100
        else
            echo "(gdb nicht installiert — Core-Datei liegt unter ${CORE}, manuell mit 'gdb node ${CORE}' analysieren)"
        fi
    fi
    if [[ -z "$CORE" ]] && ! command -v coredumpctl &>/dev/null && [[ ! -d /var/crash ]]; then
        echo "(kein Coredump gefunden. Einmalig aktivierbar mit:"
        echo "   echo '/tmp/core.%e.%p' | sudo tee /proc/sys/kernel/core_pattern"
        echo " — danach lösen erneute Abstürze automatisch einen verwertbaren Coredump aus.)"
    fi
    echo

    echo "━━━ DeckLink-Status zum Zeitpunkt des Crashs ━━━"
    gst-device-monitor-1.0 2>&1 | grep -B2 -A12 -i "decklink\|blackmagic" | head -n 60
    systemctl status desktopvideod 2>&1 | head -n 10
    echo

    echo "━━━ Ressourcen zum Zeitpunkt des Crashs ━━━"
    free -h 2>/dev/null
    echo
    nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv 2>/dev/null

} > "$OUT" 2>&1

cp -f "$OUT" "${OUT_DIR}/latest-crash.txt" 2>/dev/null || true

# Alte Reports begrenzen (letzte 20 behalten)
ls -t "${OUT_DIR}"/crash-*.txt 2>/dev/null | tail -n +21 | xargs -r rm -f
ls -t "${OUT_DIR}"/gdb-backtrace-*.txt 2>/dev/null | tail -n +11 | xargs -r rm -f

echo "[collect-crash-diagnostics] Report geschrieben: ${OUT}"
