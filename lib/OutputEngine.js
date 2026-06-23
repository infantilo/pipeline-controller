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

function _videoChannel(out) {
  return out.source === 'clean' ? 'rec_clean_v' : 'rec_pgm_v';
}

function _audioChannel(out) {
  const grp = (out.audioGroup || 'pgm-stereo').replace(/-/g, '_');
  return `rec_pgm_a_agrp_${grp}`;
}

// decklinkvideosink ist mode-gebunden (kein freies width/height) — jede Mode hat eine
// feste Auflösung/Framerate. Nur PROGRESSIVE Modi: interlaced SD/HD-Modi (ntsc/pal/
// 1080i…) verlangen vom Sink zusätzlich exakte pixel-aspect-ratio/Format-Kombinationen
// je Mode (siehe decklinkvideosink Sink-Pad-Template) — nicht pauschal robust treffbar,
// daher bewusst nicht angeboten. Progressive Modi (inkl. SD pal-p/ntsc-p) decken den
// Hauptfall "HD-Master auf SD/kleinere HD-Auflösung downconverten" zuverlässig ab.
const DECKLINK_MODES = {
  'pal-p':     { w: 720,  h: 576,  fps: 50            },
  '720p50':    { w: 1280, h: 720,  fps: 50            },
  '720p5994':  { w: 1280, h: 720,  fps: '60000/1001' },
  '1080p25':   { w: 1920, h: 1080, fps: 25            },
  '1080p2997': { w: 1920, h: 1080, fps: '30000/1001' },
  '1080p50':   { w: 1920, h: 1080, fps: 50            },
};

function _buildDecklinkPipelineStr(out) {
  const videoChannel = _videoChannel(out);
  const audioChannel = _audioChannel(out);
  const dn   = parseInt(out.deviceNumber);
  if (!Number.isInteger(dn) || dn < 0) throw new Error('DeckLink: deviceNumber fehlt/ungültig');
  const mode = DECKLINK_MODES[out.decklinkMode] ? out.decklinkMode : '1080p25';
  const m    = DECKLINK_MODES[mode];
  const fpsFraction = String(m.fps).includes('/') ? m.fps : `${m.fps}/1`;

  const videoBranch = (
    `intervideosrc channel=${videoChannel}` +
    ` ! queue max-size-buffers=10 max-size-time=200000000 max-size-bytes=0 leaky=downstream` +
    ` ! videoconvert ! videoscale ! video/x-raw,width=${m.w},height=${m.h},framerate=${fpsFraction}` +
    ` ! videoconvert` +
    ` ! decklinkvideosink device-number=${dn} mode=${mode} sync=false`
  );
  if (out.decklinkAudio === false) return videoBranch;

  const audioBranch = (
    `interaudiosrc channel=${audioChannel} do-timestamp=true` +
    ` ! queue max-size-buffers=20 max-size-time=200000000 max-size-bytes=0 leaky=downstream` +
    ` ! audioconvert ! audioresample ! audio/x-raw,format=S16LE,rate=48000,channels=2` +
    ` ! decklinkaudiosink device-number=${dn} sync=false`
  );
  return `${videoBranch} ${audioBranch}`;
}

function _buildPipelineStr(out) {
  if (out.sink === 'decklink') return _buildDecklinkPipelineStr(out);
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

class OutputEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._log     = opts.log || ((msg, lvl) => console.log(`[output/${lvl||'info'}] ${msg}`));
    this._outputs = new Map();   // id → config { id, label, enabled, source, audioGroup, width, height, bitrate, speedPreset, sink, uri }
    this._active  = new Map();   // id → { pipeline, startMs }
    for (const o of (opts.outputs || [])) this._outputs.set(o.id, o);
  }

  setConfig(outputs) {
    // Läuft ein Output gerade, dessen Konfiguration sich ändert oder der entfernt wurde → stoppen.
    const ids = new Set(outputs.map(o => o.id));
    for (const id of [...this._active.keys()]) {
      if (!ids.has(id)) this.stop(id);
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
    catch(e) { this._log(`Output "${id}": ${e.message}`, 'error'); this.emit('error', { id, error: e.message }); return false; }

    const dest = cfg.sink === 'decklink' ? `DeckLink ${cfg.deviceNumber} (${cfg.decklinkMode || '1080p25'})` : `${cfg.sink}${cfg.uri ? ' ' + cfg.uri : ''}`;
    this._log(`Starte Zusatz-Ausgang "${cfg.label || id}" (${cfg.source === 'clean' ? 'Cleanfeed' : 'Programm'} → ${dest})`, 'info');

    let pipeline;
    try { pipeline = new Pipeline(pipeStr); }
    catch(e) { this._log(`Pipeline-Fehler "${id}": ${e.message}`, 'error'); this.emit('error', { id, error: e.message }); return false; }

    this._active.set(id, { pipeline, startMs: Date.now() });
    this.emit('started', { id, label: cfg.label });

    pipeline.play(-1).then(() => {
      this._busLoop(id, pipeline);
    }).catch(e => {
      this._log(`play error "${id}": ${e.message}`, 'error');
      if (this._active.get(id)?.pipeline === pipeline) {
        this._active.delete(id);
        this.emit('stopped', { id, error: e.message });
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
          this.emit('stopped', { id, error: msg.errorMessage || 'GStreamer-Fehler' });
        }
        break;
      }
      if (msg.type === 'eos') {
        if (this._active.get(id)?.pipeline === p) {
          this._active.delete(id);
          p.stop(3000).catch(() => {});
          this.emit('stopped', { id });
        }
        break;
      }
    }
  }

  stop(id) {
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
