/**
 * DiagnosticBundle.js
 * ════════════════════════════════════════════════════════════════════
 * Sammelt alle Informationen, die zur Ferndiagnose von DeckLink/GPU/
 * Pipeline-Problemen nötig sind, in EINEM Text-Bundle.
 *
 * Hintergrund: Der Zielrechner ist abgeschottet (kein Internet, nur
 * Jumphost+RDP-Zugriff) — Logfiles/Befehlsausgaben einzeln einzusammeln
 * ist extrem mühsam. Dieses Modul liefert auf Knopfdruck (GET /api/debug/bundle)
 * ein einziges kopierbares Text-Dokument, das der Nutzer direkt aus dem
 * Browser (der ja per RDP sichtbar ist) per Copy&Paste weitergeben kann —
 * ohne Terminal, ohne Datei-Transfer.
 *
 * Für native Abstürze (Prozess stirbt komplett, JS-Handler greifen nicht)
 * siehe scripts/collect-crash-diagnostics.sh — schreibt
 * <workDir>/diagnostics/latest-crash.txt, das hier mit eingebettet wird.
 */
'use strict';
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

function sh(cmd, timeoutMs = 4000) {
  try {
    return execSync(cmd, { timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    const out = (e.stdout || '').toString().trim();
    if (out) return out;
    return `[nicht verfügbar: ${e.message.split('\n')[0]}]`;
  }
}

function section(title, body) {
  const text = (body || '').toString().trim() || '(leer)';
  return `\n━━━ ${title} ━━━\n${text}\n`;
}

const DECKLINK_ELEMENTS = ['decklinkvideosrc', 'decklinkvideosink', 'decklinkaudiosrc', 'decklinkaudiosink'];

function readLastCrash(workDir) {
  try {
    const f = path.join(workDir, 'diagnostics', 'latest-crash.txt');
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  } catch {}
  return null;
}

const DECKLINK_LOG_MAX_LINES = 300;
const DECKLINK_LOG_TAIL_BYTES = 4 * 1024 * 1024; // nur die letzten ~4MB lesen, Logfile kann groß sein

// build_appimage.sh (AppRun) leitet stdout/stderr des Node-Prozesses dauerhaft
// nach <workDir>/logs/server.log um. GST_DEBUG=decklink:5 (siehe Server-Tab-Preset)
// schreibt DORT hin — nicht in den internen App-Log-Ringpuffer weiter unten, der
// nur die eigenen log()-Aufrufe enthält. Ohne diesen Ausschnitt fehlt der echte
// HRESULT/Fehlertext der Blackmagic-API bei state-change-Fehlern ohne Detail.
// Echte native GStreamer-Debug-Zeilen sehen aus wie:
//   0:00:03.123456789  1234   0x55d2... DEBUG    decklinkvideosink gstdecklinkvideosink.cpp:456:func: ...
// — klar unterscheidbar von den eigenen [LEVEL][source]-Log-Zeilen der App.
// Wenn NUR letztere auftauchen, war GST_DEBUG für diesen Prozess nicht wirksam
// (typisch: Filter-String kaputt/mit "GST_DEBUG="-Präfix gespeichert, oder nach
// dem Setzen nur die Pipeline statt des ganzen Server-Prozesses neu gestartet —
// GST_DEBUG wird nur bei gst_init() beim Prozessstart gelesen).
const NATIVE_GST_LOG_RE = /^\d+:\d{2}:\d{2}\.\d+\s+\d+\s+0x[0-9a-fA-F]+\s+(TRACE|DEBUG|INFO|LOG|WARN|FIXME|ERROR)\b/;

function decklinkLogTrace(workDir) {
  try {
    const logFile = path.join(workDir, 'logs', 'server.log');
    if (!fs.existsSync(logFile)) return null;
    const stat  = fs.statSync(logFile);
    const start = Math.max(0, stat.size - DECKLINK_LOG_TAIL_BYTES);
    const fd    = fs.openSync(logFile, 'r');
    const buf   = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const allText = buf.toString('utf8');
    const lines = allText.split('\n').filter(l => /decklink/i.test(l));
    if (lines.length === 0) return '(keine decklink-Zeilen in logs/server.log — GST_DEBUG=decklink:5 im Server-Tab aktivieren und den KOMPLETTEN SERVER-PROZESS neu starten, bevor dieses Bundle erneut gezogen wird)';
    const hasNative = lines.some(l => NATIVE_GST_LOG_RE.test(l));
    const tail = lines.slice(-DECKLINK_LOG_MAX_LINES).join('\n');
    if (!hasNative) {
      // Unterscheiden: GST_DEBUG komplett inaktiv (keine einzige native Zeile im
      // ganzen Ausschnitt) vs. aktiv, aber die decklink-Kategorie selbst hat in
      // diesem Zeitraum nichts geloggt (z.B. weil der Fehler über eine andere
      // Kategorie wie basesrc/GST_ERROR_SYSTEM lief, nicht über "decklink").
      const anyNativeAnywhere = allText.split('\n').some(l => NATIVE_GST_LOG_RE.test(l));
      if (anyNativeAnywhere) {
        return `⚠ GST_DEBUG ist aktiv (native Trace-Zeilen im Log vorhanden), aber KEINE davon ist als "decklink" getaggt.\n`
          + `Der Fehler/die Meldung lief vermutlich über eine andere Kategorie (z.B. basesrc, GST_ERROR_SYSTEM) statt über\n`
          + `"decklink" selbst — Preset ggf. um "*:2" oder eine konkretere Kategorie erweitern statt nur "decklink:5".\n\n${tail}`;
      }
      return `⚠ Nur App-Log-Zeilen gefunden, KEINE native GStreamer-Trace-Zeile (Format "H:MM:SS.nnnnnnnnn PID 0xADDR LEVEL category ...") im ganzen Ausschnitt.\n`
        + `GST_DEBUG war für diesen Prozess wahrscheinlich NICHT aktiv — häufigste Ursachen: (1) der gespeicherte Filter-String ist ungültig\n`
        + `(z.B. mit "GST_DEBUG="-Präfix oder Leerzeichen gespeichert — gst_debug_set_threshold_from_string() ignoriert das wortlos),\n`
        + `(2) nach dem Setzen wurde nur die Master-Pipeline statt des kompletten Server-Prozesses neu gestartet (GST_DEBUG wird nur bei\n`
        + `Prozessstart/gst_init() gelesen). Aktuellen Filter prüfen (Server-Tab), Server-Prozess komplett neu starten, Bundle erneut ziehen.\n\n${tail}`;
    }
    return tail;
  } catch (e) {
    return `[nicht verfügbar: ${e.message}]`;
  }
}

// gst-inspect zeigt nur Property-DEFINITIONEN (Name + Default), nicht was DIESE
// konkrete Karte/Instanz gerade tatsächlich fährt. Für Duplex-fähige Karten ist
// aber genau das entscheidend (profile-id/duplex-mode können den Output einer
// bereits laufenden Sink-Instanz umkonfigurieren, sobald eine zweite
// Decklink-Rolle auf demselben device-number geöffnet wird). Deshalb: alle
// decklink-Elemente aus dem tatsächlichen Pipeline-String parsen und — sofern
// die Pipeline läuft und das Element benannt ist — live vom GstElement lesen.
function decklinkLiveProfile(master) {
  const pipelineString = master?.pipelineString || '';
  const re = /\b(decklinkvideosrc|decklinkvideosink|decklinkaudiosrc|decklinkaudiosink)\b([^!]*)/gi;
  const found = [];
  let m;
  while ((m = re.exec(pipelineString))) {
    const rest  = m[2] || '';
    const nameM = /\bname=(\S+)/.exec(rest);
    const devM  = /\bdevice-number=(\d+)/.exec(rest);
    found.push({ el: m[1], name: nameM ? nameM[1] : null, device: devM ? devM[1] : null });
  }
  if (found.length === 0) return '(keine DeckLink-Elemente im aktuellen Pipeline-String — Master evtl. nicht gestartet)';

  const PROPS = ['duplex-mode', 'profile-id', 'persistent-id', 'mode'];
  const lines = [];
  for (const f of found) {
    lines.push(`${f.el} device-number=${f.device ?? '?'} name=${f.name ?? '(unbenannt)'}`);
    let gstEl = null;
    if (f.name) {
      try { gstEl = master.pipeline?.getElementByName?.(f.name) || null; } catch { gstEl = null; }
    }
    if (!gstEl) { lines.push('  (keine Live-Instanz abfragbar — Pipeline läuft nicht, Element unbenannt oder nicht gefunden)'); continue; }
    for (const prop of PROPS) {
      try {
        const v = gstEl.getElementProperty(prop);
        const val = (v !== null && typeof v === 'object' && 'value' in v) ? v.value : v;
        lines.push(`  ${prop} = ${JSON.stringify(val)}`);
      } catch {
        lines.push(`  ${prop} = (Property nicht unterstützt von dieser Element-/Plugin-Version)`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * @param {object} opts
 * @param {object}   opts.settings    — aktuelle _settings
 * @param {object}   opts.masterOpts  — aktuelle masterOpts
 * @param {object}   [opts.master]    — MasterPipeline-Instanz (für pipelineString)
 * @param {object}   [opts.debugger_] — PipelineDebugger-Instanz
 * @param {Array}    [opts.logs]      — In-Memory-Log-Ringpuffer [{ts,level,source,msg}]
 * @param {string}   opts.workDir     — schreibbares Arbeitsverzeichnis (für Crash-Reports)
 */
function collect({ settings = {}, masterOpts = {}, master = null, debugger_ = null, logs = [], workDir }) {
  const parts = [];
  // App-Version + Prozess-Boot-Zeit direkt im Header: ohne das ist "wurde der Fix
  // schon deployed?" und "läuft der Prozess seit dem letzten Settings-Save schon
  // neu?" (relevant für GST_DEBUG, das nur bei gst_init()/Prozessstart gelesen
  // wird) aus dem Bundle allein nicht zu beantworten.
  let appVersion = '?';
  try { appVersion = require(path.join(__dirname, '..', 'package.json')).version; } catch {}
  const bootIso = new Date(Date.now() - process.uptime() * 1000).toISOString();
  parts.push(`Diagnose-Bundle — Pipeline Controller v${appVersion} — ${new Date().toISOString()} (Prozess-Start: ${bootIso}, PID ${process.pid}, uptime ${Math.round(process.uptime())}s)`);

  parts.push(section('System', [
    sh('uname -a'),
    sh("grep -E '^(PRETTY_NAME|VERSION)=' /etc/os-release 2>/dev/null"),
  ].join('\n')));

  parts.push(section('GStreamer-Version', sh('gst-inspect-1.0 --version')));

  for (const el of DECKLINK_ELEMENTS) {
    // Volle Property-Liste (nicht nur Factory-Details) — hier stehen
    // duplex-mode/profile-id/persistent-id, falls diese Plugin-Version sie kennt.
    parts.push(section(`gst-inspect: ${el}`, sh(`gst-inspect-1.0 ${el} 2>&1`)));
  }
  parts.push(section('DeckLink Duplex/Profile-Properties (Definition, aus gst-inspect)',
    sh(`for e in ${DECKLINK_ELEMENTS.join(' ')}; do echo "── $e ──"; gst-inspect-1.0 "$e" 2>&1 | grep -A6 -iE '^[[:space:]]*(duplex-mode|profile-id|persistent-id)[[:space:]]*:' || echo '  (keine dieser Properties vorhanden)'; done`)));

  const lsmodHit = sh("lsmod 2>/dev/null | grep -i blackmagic");
  parts.push(section('DeckLink-Kernel-Modul / Treiber-Paket',
    lsmodHit && !lsmodHit.startsWith('[nicht verfügbar')
      ? lsmodHit
      : sh("dpkg -l 2>/dev/null | grep -i -E 'desktopvideo|blackmagic'")));

  parts.push(section('DesktopVideo-Service-Status', sh('systemctl status desktopvideod 2>&1 | head -10')));

  parts.push(section('Erkannte Geräte (gefiltert auf DeckLink/Blackmagic)',
    sh('gst-device-monitor-1.0 2>&1 | grep -B2 -A12 -i "decklink\\|blackmagic"', 6000)));

  parts.push(section('NVIDIA-GPU', sh('nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>&1')));

  const liveDl = (settings.liveSources || []).filter(l => /decklink/i.test(`${l.gstSrc || ''}${l.id || ''}${l.type || ''}`));
  parts.push(section('Konfigurierte DeckLink-Live-Quellen', JSON.stringify(liveDl, null, 2)));

  parts.push(section('Master-Konfiguration', JSON.stringify({
    width: masterOpts.width, height: masterOpts.height, fps: masterOpts.fps,
    videoSink: masterOpts.videoSink, audioSink: masterOpts.audioSink,
    gpuCompositor: masterOpts.gpuCompositor, gpuDecode: masterOpts.gpuDecode,
    gstDebugFilter: settings.gstDebugFilter || '(aus)',
  }, null, 2)));

  if (debugger_) {
    try { parts.push(section('PipelineDebugger-Stats', JSON.stringify(debugger_.getStats(), null, 2))); }
    catch (e) { parts.push(section('PipelineDebugger-Stats', `[Fehler: ${e.message}]`)); }
  }

  if (master && master.pipelineString) {
    parts.push(section('Aktueller Master-Pipeline-String', master.pipelineString));
  }

  if (master) {
    parts.push(section('DeckLink Duplex/Profile (Ist-Zustand aus laufender Pipeline)', decklinkLiveProfile(master)));
  }

  const recent = (logs || []).slice(-150)
    .map(e => `[${new Date(e.ts).toISOString().slice(11, 23)}][${(e.level || '').toUpperCase()}][${e.source}] ${e.msg}`)
    .join('\n');
  parts.push(section('Letzte Server-Logs (max. 150 Zeilen)', recent));

  parts.push(section(`GStreamer decklink Debug-Trace (aus logs/server.log, max. ${DECKLINK_LOG_MAX_LINES} Zeilen)`,
    decklinkLogTrace(workDir) || '(kein logs/server.log gefunden — läuft dieser Prozess nicht über AppRun/build_appimage.sh?)'));

  const crash = readLastCrash(workDir);
  if (crash) parts.push(section('Letzter erkannter Prozess-Absturz (von scripts/collect-crash-diagnostics.sh)', crash));

  return parts.join('\n');
}

module.exports = { collect, readLastCrash };
