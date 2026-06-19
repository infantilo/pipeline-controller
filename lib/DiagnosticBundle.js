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
  parts.push(`Diagnose-Bundle — Pipeline Controller — ${new Date().toISOString()}`);

  parts.push(section('System', [
    sh('uname -a'),
    sh("grep -E '^(PRETTY_NAME|VERSION)=' /etc/os-release 2>/dev/null"),
  ].join('\n')));

  parts.push(section('GStreamer-Version', sh('gst-inspect-1.0 --version')));

  for (const el of DECKLINK_ELEMENTS) {
    parts.push(section(`gst-inspect: ${el}`, sh(`gst-inspect-1.0 ${el} 2>&1 | head -15`)));
  }

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

  const recent = (logs || []).slice(-150)
    .map(e => `[${new Date(e.ts).toISOString().slice(11, 23)}][${(e.level || '').toUpperCase()}][${e.source}] ${e.msg}`)
    .join('\n');
  parts.push(section('Letzte Server-Logs (max. 150 Zeilen)', recent));

  const crash = readLastCrash(workDir);
  if (crash) parts.push(section('Letzter erkannter Prozess-Absturz (von scripts/collect-crash-diagnostics.sh)', crash));

  return parts.join('\n');
}

module.exports = { collect, readLastCrash };
