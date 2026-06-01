/**
 * PipelineDebugger.js
 * ════════════════════════════════════════════════════════════════════
 * Optionales Debug-System für GStreamer-Pipelines.
 * Aktivierung: opts.debug = true (in server.js oder per API)
 *
 * FEATURES:
 *   1. Drop-Frame-Zähler   — QoS-Messages → dropped/rendered Frames pro Pipeline
 *   2. Bus-Message-Log     — Alle GStreamer Bus-Messages mit Timestamp
 *   3. CPU/Memory          — Node.js Prozess + System-Werte per Pipeline-Slot
 *   4. Pipeline-String-Dump — Bei Fehler vollständiger Pipeline-String in Log
 *
 * VERWENDUNG:
 *   const dbg = new PipelineDebugger({ enabled: true, broadcast });
 *   dbg.watchPipeline('master', masterPipeline.pipeline);
 *   dbg.watchPipeline('player1', playerPipeline.vPipeline);
 *   dbg.stop('player1');  // beim Stop
 *   dbg.dumpPipelineOnError('master', pipelineString, errorMsg);
 *
 * OVERHEAD:
 *   Wenn disabled: null-overhead (alle Methoden sind no-ops).
 *   Wenn enabled:  ~1-2% CPU durch Bus-Polling + Stats-Intervall.
 */

'use strict';
const os = require('os');

// ── Helpers ─────────────────────────────────────────────────────────────────

function nowMs() { return Date.now(); }
function nowStr() { return new Date().toISOString().slice(11, 23); } // HH:MM:SS.mmm

// ── PipelineDebugger ─────────────────────────────────────────────────────────

class PipelineDebugger {
  /**
   * @param {object}   opts
   * @param {boolean}  opts.enabled          — Debug aktiv? (false = no-op)
   * @param {Function} opts.broadcast        — broadcast(event, data) für SSE
   * @param {Function} [opts.log]            — log(msg, level, source) Funktion
   * @param {number}   [opts.statsIntervalMs=2000]  — Stats-Broadcast-Intervall
   * @param {number}   [opts.busPollingMs=200]       — Bus-Poll-Intervall pro Pipeline
   * @param {boolean}  [opts.verboseBus=false]       — Alle Bus-Messages (inkl. state-changed)
   */
  constructor(opts = {}) {
    this.enabled         = opts.enabled         ?? false;
    this.broadcast       = opts.broadcast       || (() => {});
    this.log             = opts.log             || ((m, l, s) => console.log(`[${l}][${s}] ${m}`));
    this.statsIntervalMs = opts.statsIntervalMs || 2000;
    this.busPollingMs    = opts.busPollingMs    || 200;
    this.verboseBus      = opts.verboseBus      || false;

    // Zustand pro Pipeline-Slot
    // { pipeline, name, busLoop, stats: { dropped, rendered, qosEvents, busMessages[] } }
    this._slots        = new Map();
    this._statsTimer   = null;
    this._startTime    = nowMs();

    if (this.enabled) this._startStatsInterval();
  }

  // ── Aktivierung ──────────────────────────────────────────────────────────

  enable()  { if (!this.enabled) { this.enabled = true;  this._startStatsInterval(); } }
  disable() {
    this.enabled = false;
    if (this._statsTimer) { clearInterval(this._statsTimer); this._statsTimer = null; }
    for (const [name] of this._slots) this._stopBusWatch(name);
  }

  setVerboseBus(v) { this.verboseBus = !!v; }

  // ── Pipeline beobachten ──────────────────────────────────────────────────

  /**
   * Registriert eine Pipeline zur Beobachtung.
   * Startet Bus-Watch-Loop und Drop-Frame-Tracking.
   * @param {string}   name      — z.B. 'master', 'player1', 'player2'
   * @param {object}   pipeline  — gst-kit Pipeline-Objekt (mit .busPop())
   * @param {string}   [pStr]    — Pipeline-String für Dump bei Fehler
   */
  /**
   * Registriert einen Pipeline-String ohne Bus-Watch zu starten.
   * Für Player-Pipelines die ihren eigenen _watchBus haben —
   * ein zweiter Bus-Watch würde Bus-Messages wegkonsumieren.
   */
  registerPipelineStr(name, pStr) {
    if (!this.enabled || !pStr) return;
    this._stopBusWatch(name);
    this._slots.set(name, {
      pipeline: null, name, pStr, owner: null, busLoop: false,
      stats: { dropped:0, rendered:0, qosEvents:0, busMessages:[], errors:[], startedAt:nowMs() },
    });
  }

  watch(name, pipeline, pStr = null, owner = null) {
    if (!this.enabled || !pipeline) return;

    // Vorherigen Slot für diesen Namen stoppen
    this._stopBusWatch(name);

    const slot = {
      pipeline,
      name,
      pStr,
      owner,   // Optionaler Owner für Message-Forwarding (z.B. MasterPipeline)
      busLoop: true,
      stats: {
        dropped:     0,
        rendered:    0,
        qosEvents:   0,
        busMessages: [],     // [ { ts, type, src, msg } ] — ringbuffer 100
        errors:      [],     // [ { ts, src, msg } ]
        startedAt:   nowMs(),
      },
    };

    this._slots.set(name, slot);
    this._runBusWatch(slot);
    this.log(`Debug-Watch: ${name}`, 'debug', 'debugger');
  }

  /**
   * Stoppt Beobachtung einer Pipeline (z.B. wenn Player gestoppt).
   */
  stop(name) {
    this._stopBusWatch(name);
    this._slots.delete(name);
  }

  stopAll() {
    for (const [name] of this._slots) this._stopBusWatch(name);
    this._slots.clear();
  }

  // ── Bus-Watch ────────────────────────────────────────────────────────────

  async _runBusWatch(slot) {
    const { name } = slot;
    while (slot.busLoop && slot.pipeline) {
      try {
        const msg = await slot.pipeline.busPop(this.busPollingMs);
        if (!msg) continue;

        const type = msg.type || '';
        const src  = msg.srcElementName || '?';
        const ts   = nowStr();

        // ── QoS / Drop-Frame ────────────────────────────────────────────
        if (type === 'qos') {
          slot.stats.qosEvents++;
          // gst-kit gibt dropped/rendered als Felder zurück wenn verfügbar
          const dropped  = msg.dropped  ?? msg.qosDropped  ?? null;
          const rendered = msg.rendered ?? msg.qosRendered ?? null;
          if (dropped  !== null) slot.stats.dropped  += dropped;
          if (rendered !== null) slot.stats.rendered += rendered;

          if (this.verboseBus || slot.stats.qosEvents % 10 === 0) {
            this.log(
              `QoS [${name}] drop=${slot.stats.dropped} render=${slot.stats.rendered} events=${slot.stats.qosEvents}`,
              'debug', 'debugger'
            );
          }
          this._addBusMessage(slot, { ts, type: 'qos', src,
            msg: `dropped=${dropped ?? '?'} rendered=${rendered ?? '?'}` });
          continue;
        }

        // ── Fehler ──────────────────────────────────────────────────────
        if (type === 'error') {
          const errMsg = msg.errorMessage || msg.message || '';
          slot.stats.errors.push({ ts, src, msg: errMsg });
          if (slot.stats.errors.length > 20) slot.stats.errors.shift();

          this.log(`BUS ERROR [${name}] ${src}: ${errMsg.slice(0, 200)}`, 'warn', 'debugger');
          this._addBusMessage(slot, { ts, type: 'error', src, msg: errMsg.slice(0, 200) });

          // Pipeline-String-Dump bei Fehler
          if (slot.pStr) {
            this._dumpPipelineString(name, slot.pStr, `Bus-Error: ${errMsg.slice(0, 100)}`);
          }
          this.broadcast('debug-error', { name, ts, src, msg: errMsg.slice(0, 200) });
          continue;
        }

        // ── State-Changed (nur verbose) ──────────────────────────────────
        if (type === 'state-changed') {
          if (this.verboseBus) {
            const stateStr = `${msg.oldState ?? '?'} → ${msg.newState ?? '?'}`;
            this._addBusMessage(slot, { ts, type: 'state-changed', src, msg: stateStr });
            this.log(`STATE [${name}] ${src}: ${stateStr}`, 'debug', 'debugger');
          }
          continue;
        }

        // ── Element-Messages (level → Audio-Pegel) ──────────────────────
        if (type === 'element') {
          // Level-Messages an den Pipeline-Owner forwarden (z.B. MasterPipeline)
          if (slot.owner && src.startsWith('level_')) {
            slot.owner.emit?.('level-bus-msg', msg);
          }
          continue;
        }

        // ── Alle anderen Messages (verbose) ──────────────────────────────
        if (this.verboseBus && type !== 'new-clock' && type !== 'stream-status') {
          const detail = msg.errorMessage || msg.message || JSON.stringify(msg).slice(0, 80);
          this._addBusMessage(slot, { ts, type, src, msg: detail });
          this.log(`BUS [${name}] ${type} ${src}: ${detail}`, 'debug', 'debugger');
        }

      } catch { break; }
    }
  }

  _stopBusWatch(name) {
    const slot = this._slots.get(name);
    if (slot) slot.busLoop = false;
  }

  _addBusMessage(slot, entry) {
    slot.stats.busMessages.push(entry);
    if (slot.stats.busMessages.length > 100) slot.stats.busMessages.shift();
  }

  // ── Pipeline-String-Dump ─────────────────────────────────────────────────

  /**
   * Loggt den Pipeline-String bei Fehler (aufgeteilt in lesbare Zeilen).
   * Wird automatisch vom Bus-Watch aufgerufen, kann auch manuell gerufen werden.
   */
  dumpOnError(name, pStr, reason = '') {
    if (!this.enabled) return;
    this._dumpPipelineString(name, pStr, reason);
  }

  _dumpPipelineString(name, pStr, reason) {
    if (!pStr) return;
    // Pipeline-String in Segmente aufteilen für Lesbarkeit
    const lines = pStr
      .split(/(?= intervideosrc| interaudiosrc| audiotestsrc| videotestsrc| input-selector| compositor| uridecodebin| appsrc)/)
      .map(l => l.trim())
      .filter(Boolean);

    this.log(`━━━ PIPELINE DUMP [${name}] ${reason ? `(${reason})` : ''} ━━━`, 'warn', 'debugger');
    lines.forEach((l, i) => this.log(`  ${String(i+1).padStart(2,'0')} ${l.slice(0, 200)}`, 'debug', 'debugger'));
    this.log(`━━━ END DUMP [${name}] (${lines.length} Segmente) ━━━`, 'warn', 'debugger');

    // Auch via SSE senden (für UI-Anzeige)
    this.broadcast('debug-pipeline-dump', { name, reason, lines, ts: nowStr() });
  }

  // ── Stats-Broadcast ──────────────────────────────────────────────────────

  _startStatsInterval() {
    if (this._statsTimer) return;
    this._statsTimer = setInterval(() => {
      if (!this.enabled) return;
      this.broadcast('debug-stats', this.getStats());
    }, this.statsIntervalMs);
  }

  /**
   * Gibt aktuellen Debug-Zustand zurück.
   * Enthält: Drop-Frames, Bus-Messages, CPU/Mem, Uptime.
   */
  getStats() {
    const slots = {};
    for (const [name, slot] of this._slots) {
      const upMs = nowMs() - slot.stats.startedAt;
      const dropRate = upMs > 0
        ? ((slot.stats.dropped / Math.max(1, slot.stats.rendered + slot.stats.dropped)) * 100).toFixed(1)
        : '0.0';

      slots[name] = {
        uptime:       upMs,
        dropped:      slot.stats.dropped,
        rendered:     slot.stats.rendered,
        dropRate:     parseFloat(dropRate),    // %
        qosEvents:    slot.stats.qosEvents,
        errorCount:   slot.stats.errors.length,
        lastErrors:   slot.stats.errors.slice(-3),
        recentBus:    slot.stats.busMessages.slice(-20),
      };
    }

    return {
      ts:           nowStr(),
      enabled:      this.enabled,
      verboseBus:   this.verboseBus,
      process:      this._getProcessStats(),
      system:       this._getSystemStats(),
      pipelines:    slots,
    };
  }

  _getProcessStats() {
    const mem  = process.memoryUsage();
    const cpu  = process.cpuUsage();
    return {
      heapUsedMB:  Math.round(mem.heapUsed  / 1048576),
      heapTotalMB: Math.round(mem.heapTotal / 1048576),
      rssMB:       Math.round(mem.rss       / 1048576),
      cpuUserMs:   Math.round(cpu.user   / 1000),
      cpuSysMs:    Math.round(cpu.system / 1000),
      pid:         process.pid,
      uptimeSec:   Math.round(process.uptime()),
    };
  }

  _getSystemStats() {
    const cpus   = os.cpus();
    const loadAvg = os.loadavg();
    const freeMem = os.freemem();
    const totMem  = os.totalmem();
    return {
      cpuCount:    cpus.length,
      loadAvg1:    Math.round(loadAvg[0] * 100) / 100,
      loadAvg5:    Math.round(loadAvg[1] * 100) / 100,
      memFreeMB:   Math.round(freeMem / 1048576),
      memTotalMB:  Math.round(totMem  / 1048576),
      memUsedPct:  Math.round((1 - freeMem / totMem) * 100),
    };
  }

  // ── GST_DEBUG-Filter ──────────────────────────────────────────────────────

  /**
   * Setzt den GST_DEBUG-Filter zur Laufzeit.
   *
   * Wirkt für NEUE Pipelines (GStreamer liest GST_DEBUG beim Pipeline-Start).
   * Laufende Pipelines behalten ihren alten Filter — Master neu starten um
   * den neuen Filter zu aktivieren.
   *
   * Empfohlene Presets: PipelineDebugger.GST_DEBUG_PRESETS
   *
   * @param {string} filter  GST_DEBUG-String, z.B. "intervideosink:5,videorate:4"
   *                         Leerstring = kein GST-Debug-Output
   */
  setGstDebugFilter(filter) {
    const prev = process.env.GST_DEBUG || '';
    if (filter) {
      process.env.GST_DEBUG          = filter;
      process.env.GST_DEBUG_NO_COLOR = '1';   // Farb-Escape-Codes im Log unterdrücken
    } else {
      delete process.env.GST_DEBUG;
      delete process.env.GST_DEBUG_NO_COLOR;
    }
    this.log(
      `GST_DEBUG: "${prev}" → "${filter || '(aus)'}"` +
      (filter ? ' — wirkt für neue Pipelines (Master neu starten für laufende)' : ''),
      'info', 'debugger'
    );
    this.broadcast('debug-gst-filter', {
      filter:  filter || '',
      prev,
      ts: new Date().toISOString().slice(11, 23),
    });
  }

  // ── Drop-Frame-Reset ─────────────────────────────────────────────────────

  resetStats(name) {
    const slot = this._slots.get(name);
    if (!slot) return;
    slot.stats.dropped    = 0;
    slot.stats.rendered   = 0;
    slot.stats.qosEvents  = 0;
    slot.stats.busMessages = [];
    slot.stats.errors      = [];
    slot.stats.startedAt   = nowMs();
    this.log(`Stats reset: ${name}`, 'debug', 'debugger');
  }

  resetAll() {
    for (const [name] of this._slots) this.resetStats(name);
  }
}

// ── GST_DEBUG Preset-Katalog ─────────────────────────────────────────────────
//
// Vordefinierte Filter für die häufigsten Debug-Szenarien.
// Werden via GET /api/debug/gst an die UI geliefert.
//
// Level-Bedeutung (GStreamer):
//   1 = ERROR, 2 = WARNING, 3 = FIXME, 4 = INFO, 5 = DEBUG, 6 = LOG, 7 = TRACE
//
PipelineDebugger.GST_DEBUG_PRESETS = [
  {
    id:          'video-freeze',
    label:       'Video-Freeze (intervideo + videorate + clock)',
    description: 'Diagnostiziert erstes-Frame-dann-schwarz und Pull-Mode/Clock-Probleme bei MXF',
    filter:      'intervideosink:5,intervideosrc:5,videorate:4,GST_CLOCK:4,mxfdemux:4',
  },
  {
    id:          'audio-underflow',
    label:       'Audio-Underflow (pulsesink + interaudio)',
    description: 'Zeigt pulsesink underflow und interaudiosrc/sink Timing-Probleme',
    filter:      'pulsesink:5,interaudiosrc:5,interaudiosink:4,GST_SCHEDULING:4',
  },
  {
    id:          'mxf-demux',
    label:       'MXF-Demux (Pull-Mode + internal data stream error)',
    description: 'Vollständiges MXF-Demux Logging inkl. State-Changes und Pad-Events',
    filter:      'mxfdemux:6,GST_ELEMENT_PADS:4,GST_STATES:4',
  },
  {
    id:          'audio-switch',
    label:       'Audio-Switch (input-selector + caps-negotiation)',
    description: 'Diagnostiziert Pad-Switch und Caps-Verhandlung beim Kanal-Wechsel',
    filter:      'input-selector:5,GST_CAPS:4,GST_NEGOTIATION:5,interaudiosrc:4',
  },
  {
    id:          'pipeline-state',
    label:       'Pipeline-States (alle Elemente)',
    description: 'Alle State-Changes aller Elemente — sehr verbose, nur kurz aktivieren',
    filter:      'GST_STATES:5',
  },
  {
    id:          'clock-sync',
    label:       'Clock & Sync (buffer-Timestamps)',
    description: 'Zeigt Clock-Sync-Probleme und Buffer-Latenz',
    filter:      'GST_CLOCK:5,basesink:5,GST_SCHEDULING:4',
  },
  {
    id:          'off',
    label:       'Aus (kein GST_DEBUG)',
    description: 'GST_DEBUG deaktivieren',
    filter:      '',
  },
];

module.exports = PipelineDebugger;
