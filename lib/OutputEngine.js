'use strict';
/**
 * OutputEngine.js
 *
 * Dynamische Zusatz-Ausgänge: downconvertierte Programm-Ausgänge oder Cleanfeed
 * (Signal ohne Grafik/Compositor — vor dem Grafik-Layer abgegriffen).
 *
 * Zapft dieselben intervideosink/interaudiosink-Kanäle an, die MasterPipeline
 * bereits für die Aufzeichnung bereitstellt (siehe RecordEngine.js):
 *   video: rec_pgm_v (Programm, inkl. Grafik) | rec_clean_v (Cleanfeed, vor Grafik/Compositor)
 *   audio: rec_pgm_a_agrp_<groupId>  (von AudioRouter pro Audiogruppe erzeugt)
 * → kein Eingriff in MasterPipeline.js nötig; jeder Zusatz-Ausgang läuft als
 *   eigene, unabhängige gst-kit-Pipeline und kann frei gestartet/gestoppt werden,
 *   ohne den Master-Pfad (und damit A/V-Sync von PGM) zu beeinflussen.
 */

const { EventEmitter } = require('events');
const { Pipeline }     = require('gst-kit');
const { INTERLACED_MODES, interlaceChainStr } = require('./InterlaceChain');

function _videoChannel(out) {
  return out.source === 'clean' ? 'rec_clean_v' : 'rec_pgm_v';
}

function _audioChannel(out) {
  const grp = (out.audioGroup || 'pgm-stereo').replace(/-/g, '_');
  return `rec_pgm_a_agrp_${grp}`;
}

// decklinkvideosink ist mode-gebunden (kein freies width/height) — jede Mode hat eine
// feste Auflösung/Framerate. Progressive Modi (inkl. SD pal-p/ntsc-p) decken den
// Hauptfall "HD-Master auf SD/kleinere HD-Auflösung downconverten" ab.
// Interlaced Modi (1080i50/1080i5994/1080i60/pal/ntsc): jetzt unterstützt via
// interlace-Kette (siehe lib/InterlaceChain.js) — Mode-Daten (PAR/colorimetry)
// stammen aus dem decklinkvideosink Sink-Pad-Template; die Kette zieht per
// videorate auf die Feldrate hoch und erzeugt mit `interlace field-pattern=1:1`
// interleaved Frames in Mode-Framerate (Details/Begründung in InterlaceChain.js).
// interlaced:true-Einträge: fps = FRAME-Rate (interleaved), par aus Sink-Template.
const DECKLINK_MODES = {
  'pal-p':     { w: 720,  h: 576,  fps: 50            },
  '720p50':    { w: 1280, h: 720,  fps: 50            },
  '720p5994':  { w: 1280, h: 720,  fps: '60000/1001' },
  '1080p25':   { w: 1920, h: 1080, fps: 25            },
  '1080p2997': { w: 1920, h: 1080, fps: '30000/1001' },
  '1080p50':   { w: 1920, h: 1080, fps: 50            },
  // Interlaced (aus InterlaceChain.INTERLACED_MODES übernommen, um die
  // Caps-Daten nur an einer Stelle zu pflegen)
  ...Object.fromEntries(Object.entries(INTERLACED_MODES).map(([k, v]) =>
    [k, { w: v.w, h: v.h, fps: v.fps, par: v.par, interlaced: true }]
  )),
};

function _buildDecklinkPipelineStr(out) {
  const videoChannel = _videoChannel(out);
  const audioChannel = _audioChannel(out);
  const dn   = parseInt(out.deviceNumber);
  if (!Number.isInteger(dn) || dn < 0) throw new Error('DeckLink: deviceNumber fehlt/ungültig');
  const mode = DECKLINK_MODES[out.decklinkMode] ? out.decklinkMode : '1080p25';
  const m    = DECKLINK_MODES[mode];
  const fpsFraction = String(m.fps).includes('/') ? m.fps : `${m.fps}/1`;

  // Rate/Interlace-Stufe: progressiv = videorate auf Mode-Framerate zwingen
  // (sonst not-negotiated wenn Master-fps ≠ Mode-fps); interlaced = gemeinsame
  // interlace-Kette (videorate auf Feldrate + interlace 1:1, inkl. SD-PAR).
  const rateStage = m.interlaced
    ? interlaceChainStr(mode)
    : `videorate ! video/x-raw,width=${m.w},height=${m.h},framerate=${fpsFraction}`;

  // sync=true: in dieser eigenständigen Pipeline ist der DeckLink-Sink der einzige
  // Clock-Provider → GStreamer wählt automatisch die Karten-Clock (auf IP100 PTP-locked).
  // Mit sync=true taktet die Hardware das scheduled playback framegenau; sync=false
  // würde die Buffer nur "so schnell wie möglich" durchreichen (Drift/Repeats).
  const videoBranch = (
    `intervideosrc channel=${videoChannel}` +
    ` ! queue max-size-buffers=10 max-size-time=200000000 max-size-bytes=0 leaky=downstream` +
    ` ! videoconvert ! videoscale ! ${rateStage}` +
    ` ! videoconvert` +
    ` ! decklinkvideosink device-number=${dn} mode=${mode} sync=true`
  );
  if (out.decklinkAudio === false) return videoBranch;

  const audioBranch = (
    `interaudiosrc channel=${audioChannel} do-timestamp=true` +
    ` ! queue max-size-buffers=20 max-size-time=200000000 max-size-bytes=0 leaky=downstream` +
    ` ! audioconvert ! audioresample ! audio/x-raw,format=S16LE,rate=48000,channels=2` +
    ` ! decklinkaudiosink device-number=${dn} sync=true`
  );
  return `${videoBranch} ${audioBranch}`;
}

// Intel MTL / SMPTE ST2110 Zusatz-Ausgang (Intel E810 o.ä.). dev-port/dev-ip
// kommen von out.st2110DevIface/st2110DevIp (Server befüllt sie aus
// _settings.st2110 — EIN MTL-Kontext pro Prozess, siehe scripts/install-mtl.sh).
// videoformat/breite/höhe/fps/payload-type sind je Ausgang konfigurierbar
// (out.st2110Video), Audio optional (out.st2110Audio, weglassen = kein Audio).
//
// ACHTUNG: Element-/Property-Namen (mtl_st20p_tx/mtl_st30p_tx, dev-port, dev-ip,
// ip, udp-port, payload-type, fmt, …) folgen der öffentlich dokumentierten MTL-
// GStreamer-Plugin-API — NICHT gegen echten gst-inspect-1.0-Output verifiziert
// (MTL war bei Implementierung noch nicht installiert, siehe scripts/install-mtl.sh).
// Nach der Installation gegen `gst-inspect-1.0 mtl_st20p_tx`/`mtl_st30p_tx` prüfen
// und hier ggf. anpassen — dies ist die einzige Stelle für die Zusatz-Ausgang-TX-Seite.
function _buildSt2110PipelineStr(out) {
  const videoChannel = _videoChannel(out);
  const audioChannel = _audioChannel(out);
  const v = out.st2110Video || {};
  if (!v.ip || !v.port) throw new Error('ST2110: Video-Ziel-IP/Port fehlt');
  const devProps = `dev-port=${out.st2110DevIface || 'auto'}${out.st2110DevIp ? ` dev-ip=${out.st2110DevIp}` : ''}`;
  const width  = parseInt(v.width)  || 1920;
  const height = parseInt(v.height) || 1080;
  const fps    = v.fps || 25;

  // sync=true: eigenständige Pipeline, mtl_st20p_tx ist der einzige Clock-Provider
  // (Sink-Clock-Auto-Selection, MTL-Kontext ist PTP-locked) — analog zum
  // DeckLink-Zusatz-Ausgang oben.
  const videoBranch = (
    `intervideosrc channel=${videoChannel}` +
    ` ! queue max-size-buffers=10 max-size-time=200000000 max-size-bytes=0 leaky=downstream` +
    ` ! videoconvert ! videoscale ! video/x-raw,width=${width},height=${height}` +
    ` ! videorate ! video/x-raw,framerate=${fps}/1` +
    ` ! mtl_st20p_tx ${devProps} ip=${v.ip} udp-port=${v.port}` +
    ` payload-type=${v.payloadType ?? 112} fmt=${v.format || 'YUV422PLANAR10LE'} sync=true`
  );
  const a = out.st2110Audio;
  if (!a?.ip || !a?.port) return videoBranch;

  const audioBranch = (
    `interaudiosrc channel=${audioChannel} do-timestamp=true` +
    ` ! queue max-size-buffers=20 max-size-time=200000000 max-size-bytes=0 leaky=downstream` +
    ` ! audioconvert ! audioresample ! audio/x-raw,format=S24LE,rate=48000,channels=2` +
    ` ! mtl_st30p_tx ${devProps} ip=${a.ip} udp-port=${a.port}` +
    ` payload-type=${a.payloadType ?? 111} channel=2 sampling=${a.sampling || '48kHz'}` +
    ` ptime=${a.ptime || '1ms'} fmt=${a.format || 'pcm24'} sync=true`
  );
  return `${videoBranch} ${audioBranch}`;
}

function _buildPipelineStr(out) {
  if (out.sink === 'decklink') return _buildDecklinkPipelineStr(out);
  if (out.sink === 'st2110')  return _buildSt2110PipelineStr(out);
  const videoChannel = _videoChannel(out);
  const audioChannel = _audioChannel(out);
  const w = parseInt(out.width)  || 0;
  const h = parseInt(out.height) || 0;
  // Downconvert nur wenn beide Maße gesetzt sind — sonst Passthrough in Originalauflösung.
  const scale   = (w && h) ? ` ! videoscale ! video/x-raw,width=${w},height=${h}` : '';
  const bitrate = parseInt(out.bitrate) || 4000;
  const preset  = out.speedPreset || 'veryfast';

  const videoBranch = (
    `intervideosrc channel=${videoChannel}` +
    ` ! queue max-size-buffers=10 max-size-time=200000000 max-size-bytes=0 leaky=downstream` +
    ` ! videoconvert${scale}` +
    ` ! x264enc tune=zerolatency speed-preset=${preset} bitrate=${bitrate} key-int-max=50` +
    ` ! h264parse config-interval=1` +
    ` ! queue max-size-buffers=10` +
    ` ! mux.`
  );
  const audioBranch = (
    `interaudiosrc channel=${audioChannel} do-timestamp=true` +
    ` ! queue max-size-buffers=20 max-size-time=200000000 max-size-bytes=0 leaky=downstream` +
    ` ! audioconvert ! audioresample` +
    ` ! avenc_aac bitrate=192000` +
    ` ! aacparse` +
    ` ! queue max-size-buffers=20` +
    ` ! mux.`
  );

  switch (out.sink) {
    case 'rtmp':
      return `${videoBranch} ${audioBranch} flvmux name=mux streamable=true ! rtmpsink location="${out.uri}" sync=false`;
    case 'srt':
      return `${videoBranch} ${audioBranch} mpegtsmux name=mux ! srtsink uri="${out.uri}" wait-for-connection=false`;
    case 'udp': {
      const m = (out.uri || '').match(/^udp:\/\/([^:/?]+):(\d+)/i);
      if (!m) throw new Error(`UDP-Ziel ungültig (erwartet udp://host:port): "${out.uri}"`);
      return `${videoBranch} ${audioBranch} mpegtsmux name=mux ! udpsink host="${m[1]}" port=${m[2]} sync=false`;
    }
    case 'file': {
      const quoted = `"${String(out.uri || '').replace(/"/g, '\\"')}"`;
      return `${videoBranch} ${audioBranch} matroskamux name=mux streamable=true ! filesink location=${quoted} sync=false`;
    }
    default:
      throw new Error(`Unbekannter Sink-Typ: "${out.sink}"`);
  }
}

// Auto-Restart-Backoff bei Bus-error/eos oder play()-Fehler (24/7-Robustheit).
const RESTART_DELAYS_MS = [5000, 10000, 20000, 40000, 60000]; // letzter Wert wiederholt sich (max 60s)
const STABLE_RESET_MS   = 5 * 60 * 1000;                      // 5min unterbrechungsfrei → Backoff zurücksetzen

class OutputEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._log     = opts.log || ((msg, lvl) => console.log(`[output/${lvl||'info'}] ${msg}`));
    this._outputs = new Map();   // id → config { id, label, enabled, source, audioGroup, width, height, bitrate, speedPreset, sink, uri }
    this._active  = new Map();   // id → { pipeline, startMs }
    this._restartTimers   = new Map(); // id → Timeout-Handle (geplanter Neustart)
    this._restartAttempts = new Map(); // id → Anzahl aufeinanderfolgender Fehlversuche
    this._stableTimers    = new Map(); // id → Timeout-Handle (Backoff-Reset nach stabilem Lauf)
    this._restartTotals   = new Map(); // id → Restart-Gesamtzähler (Diagnose, nie zurückgesetzt)
    this._lastErrors      = new Map(); // id → { error, ts } letzter Fehler (Diagnose-Bundle)
    for (const o of (opts.outputs || [])) this._outputs.set(o.id, o);
  }

  // Letzten Fehler für Diagnose merken (getStatus/DiagnosticBundle).
  _noteError(id, error) {
    this._lastErrors.set(id, { error: String(error), ts: new Date().toISOString() });
  }

  // Bricht geplanten Auto-Restart + Stable-Reset-Timer für einen Output ab.
  _clearRestart(id) {
    const t = this._restartTimers.get(id);
    if (t) { clearTimeout(t); this._restartTimers.delete(id); }
    const st = this._stableTimers.get(id);
    if (st) { clearTimeout(st); this._stableTimers.delete(id); }
  }

  // Plant einen Neustart mit Backoff (5s,10s,20s,40s,max 60s) — nur wenn der Output
  // weiterhin enabled ist. Läuft er 5min unterbrechungsfrei, wird der Zähler zurückgesetzt.
  _scheduleRestart(id) {
    const cfg = this._outputs.get(id);
    if (!cfg || !cfg.enabled) return;
    if (this._restartTimers.has(id)) return; // bereits geplant

    const attempt = (this._restartAttempts.get(id) || 0) + 1;
    this._restartAttempts.set(id, attempt);
    this._restartTotals.set(id, (this._restartTotals.get(id) || 0) + 1);
    const delay = RESTART_DELAYS_MS[Math.min(attempt - 1, RESTART_DELAYS_MS.length - 1)];

    this._log(`Output "${cfg.label || id}": Auto-Restart in ${delay / 1000}s (Versuch ${attempt})`, 'warn');
    this.emit('restarting', { id, label: cfg.label, attempt, delayMs: delay });

    const t = setTimeout(() => {
      this._restartTimers.delete(id);
      if (this._outputs.get(id)?.enabled) this.start(id);
    }, delay);
    this._restartTimers.set(id, t);
  }

  // Nach STABLE_RESET_MS unterbrechungsfreiem Lauf: Backoff-Zähler zurücksetzen.
  _armStableReset(id) {
    const prev = this._stableTimers.get(id);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this._stableTimers.delete(id);
      this._restartAttempts.delete(id);
    }, STABLE_RESET_MS);
    this._stableTimers.set(id, t);
  }

  setConfig(outputs) {
    // Läuft ein Output gerade, dessen Konfiguration sich ändert oder der entfernt wurde → stoppen.
    const ids = new Set(outputs.map(o => o.id));
    for (const id of [...this._active.keys()]) {
      if (!ids.has(id)) this.stop(id);
    }
    // Geplante Auto-Restarts für entfernte/nicht mehr existierende IDs abbrechen.
    for (const id of [...this._restartTimers.keys(), ...this._stableTimers.keys()]) {
      if (!ids.has(id)) this._clearRestart(id);
    }
    this._outputs = new Map(outputs.map(o => [o.id, o]));
  }

  getConfig() {
    return [...this._outputs.values()];
  }

  start(id) {
    const cfg = this._outputs.get(id);
    if (!cfg) { this._log(`start: unbekannter Output "${id}"`, 'warn'); return false; }
    if (this._active.has(id)) { this._log(`Output "${id}" läuft bereits — stoppe zuerst`, 'warn'); this.stop(id); }

    let pipeStr;
    try { pipeStr = _buildPipelineStr(cfg); }
    catch(e) { this._log(`Output "${id}": ${e.message}`, 'error'); this._noteError(id, e.message); this.emit('error', { id, error: e.message }); return false; }

    const dest = cfg.sink === 'decklink' ? `DeckLink ${cfg.deviceNumber} (${cfg.decklinkMode || '1080p25'})` : `${cfg.sink}${cfg.uri ? ' ' + cfg.uri : ''}`;
    this._log(`Starte Zusatz-Ausgang "${cfg.label || id}" (${cfg.source === 'clean' ? 'Cleanfeed' : 'Programm'} → ${dest})`, 'info');

    let pipeline;
    try { pipeline = new Pipeline(pipeStr); }
    catch(e) { this._log(`Pipeline-Fehler "${id}": ${e.message}`, 'error'); this._noteError(id, e.message); this.emit('error', { id, error: e.message }); return false; }

    this._active.set(id, { pipeline, startMs: Date.now() });
    this.emit('started', { id, label: cfg.label });

    pipeline.play(-1).then(() => {
      this._armStableReset(id);
      this._busLoop(id, pipeline);
    }).catch(e => {
      this._log(`play error "${id}": ${e.message}`, 'error');
      if (this._active.get(id)?.pipeline === pipeline) {
        this._active.delete(id);
        this._noteError(id, e.message);
        this.emit('stopped', { id, error: e.message });
        this._scheduleRestart(id);
      }
    });

    return true;
  }

  async _busLoop(id, p) {
    while (true) {
      if (this._active.get(id)?.pipeline !== p) break;
      let msg;
      try { msg = await p.busPop(500); } catch { break; }
      if (!msg) continue;
      if (msg.type === 'error') {
        this._log(`[${id}] GStreamer-Fehler: ${msg.errorMessage || 'unbekannt'}`, 'error');
        if (this._active.get(id)?.pipeline === p) {
          this._active.delete(id);
          p.stop(3000).catch(() => {});
          this._noteError(id, msg.errorMessage || 'GStreamer-Fehler');
          this.emit('stopped', { id, error: msg.errorMessage || 'GStreamer-Fehler' });
          this._scheduleRestart(id);
        }
        break;
      }
      if (msg.type === 'eos') {
        if (this._active.get(id)?.pipeline === p) {
          this._active.delete(id);
          p.stop(3000).catch(() => {});
          this.emit('stopped', { id });
          this._scheduleRestart(id);
        }
        break;
      }
    }
  }

  // Manuell gestoppt (User/Config-Änderung) — kein Auto-Restart, geplante Restarts abbrechen.
  stop(id) {
    this._clearRestart(id);
    this._restartAttempts.delete(id);
    const entry = this._active.get(id);
    if (!entry) return;
    this._log(`Stoppe Zusatz-Ausgang "${id}"`, 'info');
    this._active.delete(id);  // beendet _busLoop
    entry.pipeline.stop(3000)
      .then(() => this.emit('stopped', { id }))
      .catch(e => { this._log(`stop error "${id}": ${e.message}`, 'warn'); this.emit('stopped', { id, error: e.message }); });
  }

  stopAll() {
    for (const id of [...this._active.keys()]) this.stop(id);
    // Auch geplante Auto-Restarts für aktuell nicht laufende Outputs abbrechen.
    for (const id of [...this._restartTimers.keys()]) this._clearRestart(id);
  }

  startEnabled() {
    for (const cfg of this._outputs.values()) {
      if (cfg.enabled) this.start(cfg.id);
    }
  }

  getStatus() {
    const result = {};
    for (const cfg of this._outputs.values()) {
      const active = this._active.get(cfg.id);
      result[cfg.id] = {
        label:      cfg.label,
        enabled:    !!cfg.enabled,
        running:    !!active,
        durationMs: active ? Date.now() - active.startMs : 0,
        source:       cfg.source,
        sink:         cfg.sink,
        uri:          cfg.uri,
        deviceNumber: cfg.deviceNumber,
        decklinkMode: cfg.decklinkMode,
      };
    }
    return result;
  }
}

module.exports = OutputEngine;
