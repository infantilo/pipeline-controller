'use strict';
/**
 * PlayerPipeline.js
 * ─────────────────
 * Verwaltet eine einzelne Player-Slot-Pipeline.
 *
 * ARCHITEKTUR:
 *
 *   uridecodebin ──► Video-Branch ──► intervideosink channel=<slotId>
 *             │
 *             └──► Audio-Branch (dynamisch aus audio_config.json):
 *
 *   Strategie 3 (Standard, eine Gruppe):
 *     db. ! queue ! audioconvert ! audioresample ! F32LE,2ch
 *     ! interaudiosink channel=<slot>_pgm-stereo sync=false async=false
 *
 *   Strategie 2 (mehrere Gruppen via tee):
 *     db. ! queue ! audioconvert ! audioresample ! F32LE,NchIn
 *     ! tee name=atee
 *     atee. ! audiomixmatrix [route-matrix] ! interaudiosink channel=<slot>_<g1>
 *     atee. ! audiomixmatrix [route-matrix] ! interaudiosink channel=<slot>_<g2>
 *     …
 *
 *   Strategie 1 (legacy, kein AudioRouter):
 *     db. ! queue ! audioconvert ! audioresample ! pulsesink async=false
 *
 * AUDIO-PRESET:
 *   Wird aus item.audioPreset geladen (z.B. "stereo", "mono-de-en").
 *   AudioGroupConfig + AudioRouter berechnen die Routing-Matrix pro Gruppe.
 *   Nicht zugeordnete Gruppen: Silence-Seeder im Master füllt.
 *
 * CLOCK:
 *   Player-Pipeline hat keine eigene Clock.
 *   intervideosink sync=false + interaudiosink sync=false:
 *   Player schreibt non-blocking in shared memory.
 *   Master-Pipeline taktet via pulsesink provide-clock=true.
 *
 * MXF-BESONDERHEIT:
 *   mxfdemux schickt "Internal data stream error" beim ersten State-Change.
 *   _tryPipeline erkennt diesen an src=mxfdemux* und macht ein zweites play().
 *   Das ist ein bekannter GStreamer-Bug mit mxfdemux (Pull-Mode).
 */

'use strict';
const { Pipeline }     = require('gst-kit');
const { EventEmitter } = require('events');
const { toTC }         = require('./Timecode');
const { AudioRouter }  = require('./AudioRouter');

class PlayerPipeline extends EventEmitter {

  /**
   * @param {string} slotId   — 'player1' | 'player2' | …
   * @param {object} opts
   *   audioGroupConfig  {AudioGroupConfig}  — Gruppen/Presets (null = Legacy)
   *   clockStrategy     {ClockStrategy}     — Clock-Konfiguration
   *   mediaDir          {string}            — Basis-Verzeichnis für Mediendateien
   *   fps               {number}            — Ausgabe-Framerate (default: 25)
   *   width             {number}            — Ausgabe-Breite
   *   height            {number}            — Ausgabe-Höhe
   *   debugger          {PipelineDebugger}  — optional
   */
  constructor(slotId, opts = {}) {
    super();
    this.slotId           = slotId;
    this.opts             = opts;
    this.vPipeline        = null;
    this._item            = null;
    this._cued            = false;
    this._running         = false;
    this._playing         = false;
    this._busLoop         = false;
    this._poller          = null;
    this._loadSeq         = 0;
    this._lastPStr        = null;
    this.audioGroupConfig = opts.audioGroupConfig || null;
    this.clockStrategy    = opts.clockStrategy    || null;
    this._pgmGroupId      = opts.pgmGroupId       || 'pgm-stereo';
  }

  _log(msg, level = 'info') {
    this.emit('log', { level, msg: `[${this.slotId}] ${msg}` });
  }

  get cued()    { return this._cued; }
  get playing() { return this._playing; }

  // ── Load ──────────────────────────────────────────────────────────────────────

  async load(item) {
    await this.stop();
    this._item = item;

    const pathLib = require('path');
    const som = item.som ?? 0;
    const eom = item.eom ?? null;

    // Absoluten Pfad auflösen
    let abs;
    if (item.filePath) {
      abs = item.filePath;
    } else {
      const dir = item.mediaDir || this.opts.mediaDir || process.cwd();
      abs = pathLib.isAbsolute(item.file)
        ? item.file
        : pathLib.join(dir, item.file);
    }

    // URI: Leerzeichen + Sonderzeichen pro Segment encoden
    const uri = 'file://' + abs
      .split('/')
      .map((seg, i) => i === 0 ? seg : encodeURIComponent(seg))
      .join('/');

    const fps = this.opts.fps || 25;

    // Audio-Tracks aus MediaLibrary-Metadaten (für korrekte Matrix-Dimensionierung)
    // MXF kann 2, 4, 8 oder 16 Mono-Tracks haben.
    // Ohne Metadaten: 2 annehmen (funktioniert für Stereo-Content immer).
    const audioTracks    = item.audioTracks || [];
    // Mindestens 2 Kanäle (Stereo) — verhindert Caps-Mismatch mit Master-Seeder (2ch).
    // Media-Metadaten können falsch gezählt sein (z.B. 1 statt 2 für Stereo-AAC).
    const numInChannels  = Math.max(2, audioTracks.length > 0 ? audioTracks.length : 2);

    this._log(
      `Lade: ${pathLib.basename(abs)} ` +
      `SOM=${toTC(som, fps)} EOM=${eom != null ? toTC(eom, fps) : '—'} ` +
      `inCh=${numInChannels}`
    );

    // Preset aus Playlist-Event — Fallback: erstes verfügbares Preset
    const presetId  = item.audioPreset || item.audioConfig?.preset || 'stereo';
    const preset    = this.audioGroupConfig
      ? (this.audioGroupConfig.getPreset(presetId) || this.audioGroupConfig.getDefaultPreset())
      : null;

    if (this.audioGroupConfig && preset) {
      this._log(`Audio-Preset: ${presetId} (${preset.label || presetId})`, 'debug');
    }

    // Pipeline-Strings bauen (Strategie 3 → 2 → 1, fallback video-only)
    const strategies = this.audioGroupConfig
      ? this._buildRouterStrategies(uri, fps, numInChannels, preset)
      : this._buildLegacyStrategies(uri, fps);

    let pipeline = null;
    for (const s of strategies) {
      this._lastPStr = s;
      pipeline = await this._tryPipeline(s, 12000);
      if (pipeline) break;
    }

    if (!pipeline) {
      this._log('Alle Strategien fehlgeschlagen, Video-only Fallback…', 'warn');
      const fallback = this._buildVideoOnlyStr(uri, fps);
      this._lastPStr = fallback;
      pipeline = await this._tryPipeline(fallback, 8000);
    }

    if (!pipeline) {
      const msg = 'Alle Strategien fehlgeschlagen (inkl. Video-only)';
      this._log(msg, 'error');
      if (this.opts.debugger?.enabled) this.opts.debugger.dumpOnError(this.slotId, this._lastPStr, msg);
      this.emit('error', 'load failed');
      return false;
    }

    // SOM-Seek in PLAYING (GStreamer unterstützt seek() im PLAYING-State)
    if (som > 0.01) {
      try {
        await pipeline.seek(som);
        this._log(`Seek → SOM ${toTC(som, fps)}`);
      } catch(e) {
        this._log(`Seek fehlgeschlagen: ${e.message}`, 'warn');
      }
    }

    this.vPipeline = pipeline;
    this._running  = true;
    this._busLoop  = true;
    this._watchBus();

    // Debugger NICHT auf Player-Pipeline starten — würde Bus-Messages stehlen
    // die _watchBus (insb. mxfdemux-Error) braucht.

    this._cued = true;
    this._log('Gecued ✓');
    this.emit('cued', { slotId: this.slotId, som, eom });
    return true;
  }

  // ── Pipeline-Strings: AudioRouter-Modus ──────────────────────────────────────

  /**
   * Baut alle Strategie-Strings für den AudioRouter-Modus.
   *
   * Rückgabe-Reihenfolge: vom einfachsten zum komplexesten.
   *
   * STRATEGIE 3 (Direkt, eine Gruppe):
   *   Funktioniert wenn nur pgm-stereo gemappt ist.
   *   Keine tee/audiomixmatrix — minimale Pipeline-Komplexität.
   *   MXF + MP4 getestet und stabil.
   *
   * STRATEGIE 2 (Mehrere Gruppen via tee):
   *   Pro Gruppe ein Branch nach tee.
   *   audiomixmatrix übernimmt das Channel-Mapping.
   *   Für Multi-Group-Presets (Begleitton, 5.1).
   *
   * STRATEGIE 1 (Legacy audiomixmatrix ohne tee):
   *   Fallback wenn tee-Strategie nicht parsed.
   *   Nur pgm-Gruppe, direkt.
   *
   * @param {string}      uri
   * @param {number}      fps
   * @param {number}      numInChannels
   * @param {object|null} preset
   * @returns {string[]}
   */
  _buildRouterStrategies(uri, fps, numInChannels, preset) {
    const cfg      = this.audioGroupConfig;
    const router   = new AudioRouter(cfg, preset, numInChannels, this.slotId);
    const videoStr = this._videoPath(this.slotId, fps);

    // Gruppen-Fragmente berechnen (null = kein Mapping = Silence-Seeder genügt)
    const groupFrags   = router.buildPlayerFragments();
    const mappedFrags  = groupFrags.filter(f => f !== null);
    const numMapped    = mappedFrags.length;

    const strategies = [];

    // ── STRATEGIE 3: Direkt — nur PGM-Gruppe, keine tee ──────────────────────
    // Voraussetzung: genau eine gemappte Gruppe, und das ist pgm-stereo (2ch).
    // Wenn pgm-Gruppe 2ch hat UND Eingang 2ch → direkt ohne audiomixmatrix.
    // audiomixmatrix würde F32LE erzwingen; audioconvert+capsfilter ist einfacher.
    {
      const pgmGroup = cfg.getGroup(this._pgmGroupId);
      const pgmCh    = pgmGroup?.channels || 2;
      const pgmCh3   = router.groupChannel(this._pgmGroupId);

      // Immer bauen — auch wenn pgmCh != 2 funktioniert audioconvert mit layout=interleaved
      const s3 = [
        `uridecodebin name=db uri="${uri}" expose-all-streams=false`,
        `db. ! ${videoStr}`,
        // Audio → interaudiosink
        `db. ! queue max-size-buffers=0 max-size-time=2000000000 max-size-bytes=0` +
        ` ! audioconvert ! audio/x-raw,layout=interleaved ! audioresample` +
        ` ! audio/x-raw,format=F32LE,rate=48000,channels=${pgmCh},layout=interleaved` +
        ` ! interaudiosink channel=${pgmCh3} sync=false async=false`,
        // Clock-Provider: audiotestsrc is-live=true setzt Pipeline-Clock auf Echtzeit.
        // Ohne Clock: videorate ignoriert Timestamps → alle Frames sofort ausgegeben
        // → intervideosink zeigt statisches Bild. Mit Clock: videorate begrenzt auf 25fps.
        `audiotestsrc is-live=true wave=silence ! fakesink sync=true`,
      ].join(' ');
      strategies.push(s3);
    }

    // ── STRATEGIE 2: tee → mehrere Gruppen ───────────────────────────────────
    // Für Multi-Group-Presets (Begleitton, 5.1, etc.)
    if (numMapped > 1 || (numMapped === 1 && groupFrags[0] !== null && groupFrags[0]?.includes('audiomixmatrix'))) {
      // Gemeinsame Audio-Queue + audioconvert + tee
      // inCaps hält die original-Kanal-Zahl (für audiomixmatrix in-channels)
      const inCaps = `audio/x-raw,format=F32LE,rate=48000,channels=${numInChannels},layout=interleaved`;
      const teeStr = [
        `uridecodebin name=db uri="${uri}" expose-all-streams=false`,
        `db. ! ${videoStr}`,
        `db. ! queue max-size-buffers=0 max-size-time=2000000000 max-size-bytes=0` +
        ` ! audioconvert ! audio/x-raw,layout=interleaved ! audioresample ! ${inCaps}` +
        ` ! tee name=atee_${this.slotId}`,
        // Gemappte Gruppen
        ...mappedFrags.map(f => `atee_${this.slotId}. ! ${f}`),
        // Clock-Provider: setzt Pipeline-Clock → videorate funktioniert korrekt
        `audiotestsrc is-live=true wave=silence ! fakesink sync=true`,
      ].join(' ');
      strategies.push(teeStr);
    }

    // ── STRATEGIE 1: pgm direkt mit audiomixmatrix (Fallback) ────────────────
    {
      const pgmGroup = cfg.getGroup(this._pgmGroupId);
      const pgmCh    = pgmGroup?.channels || 2;
      const pgmChan  = router.groupChannel(this._pgmGroupId);
      const matStr   = AudioRouter._matrixToGst(
        AudioRouter._identityMatrix(Math.min(numInChannels, pgmCh), pgmCh)
      );
      const s1 = [
        `uridecodebin name=db uri="${uri}" expose-all-streams=false`,
        `db. ! ${videoStr}`,
        `db. ! queue max-size-buffers=16 max-size-time=0 max-size-bytes=0` +
        ` ! audioconvert ! audio/x-raw,layout=interleaved ! audioresample` +
        ` ! audio/x-raw,format=F32LE,rate=48000,channels=${numInChannels},layout=interleaved` +
        ` ! audiomixmatrix in-channels=${numInChannels} out-channels=${pgmCh} matrix="${matStr}"` +
        ` ! audio/x-raw,format=F32LE,rate=48000,channels=${pgmCh},layout=interleaved` +
        ` ! interaudiosink channel=${pgmChan} sync=false async=false`,
        // Clock-Provider
        `audiotestsrc is-live=true wave=silence ! fakesink sync=true`,
      ].join(' ');
      strategies.push(s1);
    }

    // Strategie-Reihenfolge:
    // - Wenn mehrere Gruppen gemappt: Strategie 2 (tee) zuerst → alle Gruppen mit Audio
    // - Wenn nur eine Gruppe: Strategie 3 (direkt) zuerst → einfacher, stabiler
    // Strategie 1 (audiomixmatrix direkt) immer als letzter Fallback.
    if (mappedFrags.length > 1 && strategies.length >= 2) {
      // Tee-Strategie (Index 1) vor Direkt-Strategie (Index 0)
      return [strategies[1], strategies[0], ...strategies.slice(2)];
    }
    return strategies;
  }

  // ── Pipeline-Strings: Legacy-Modus ───────────────────────────────────────────

  /**
   * Legacy-Modus ohne AudioRouter: Audio direkt zu pulsesink.
   * provide-clock=false: Master hält die Clock.
   */
  _buildLegacyStrategies(uri, fps) {
    const acaps    = 'audio/x-raw,format=F32LE,rate=48000,channels=2,layout=interleaved';
    const videoStr = this._videoPath(this.slotId, fps);
    const seq      = ++this._loadSeq;
    const audioSink = (
      `audioconvert ! audio/x-raw,layout=interleaved ! audioresample ! ${acaps}` +
      ` ! volume name=avol_${this.slotId}_${seq}` +
      ` ! level name=level_${this.slotId} interval=100000000 post-messages=true` +
      ` ! pulsesink async=false provide-clock=false`
    );

    // Strategie 1: Standard — stereo
    const s1 = [
      `uridecodebin name=db uri="${uri}" expose-all-streams=false`,
      `db. ! ${videoStr}`,
      `db. ! queue max-size-buffers=16 max-size-time=0 max-size-bytes=0 ! ${audioSink}`,
    ].join(' ');

    // Strategie 2: MXF Mono-Spuren → stereo via deinterleave/interleave
    const s2 = [
      `uridecodebin name=db uri="${uri}" expose-all-streams=false`,
      `db. ! ${videoStr}`,
      `db. ! queue max-size-buffers=16 ! audioconvert ! deinterleave name=di`,
      `di.src_0 ! queue ! audioconvert ! audio/x-raw,channels=1 ! interleave name=ip`,
      `di.src_1 ! queue ! audioconvert ! audio/x-raw,channels=1 ! ip.sink_1`,
      `ip. ! audioresample ! ${acaps}` +
      ` ! volume name=avol_${this.slotId}_${seq}s` +
      ` ! level name=level_${this.slotId} interval=100000000 post-messages=true` +
      ` ! pulsesink async=false provide-clock=false`,
    ].join(' ');

    return [s1, s2];
  }

  // ── Video-Only Fallback ───────────────────────────────────────────────────────

  _buildVideoOnlyStr(uri, fps) {
    const videoStr = this._videoPath(this.slotId, fps);
    return [
      `uridecodebin name=db uri="${uri}" expose-all-streams=false`,
      `db. ! ${videoStr}`,
    ].join(' ');
  }

  // ── Video-Pfad ───────────────────────────────────────────────────────────────

  /**
   * Gemeinsamer Video-Branch für alle Strategien.
   *
   * intervideosink sync=false: Player hat keine externe Clock.
   * Master-Pipeline liest via intervideosrc (timeout=2s) und taktet selbst.
   */
  _videoPath(ch, fps) {
    // KEIN leaky auf der Queue — ohne leaky entsteht Backpressure vom Master
    // (intervideosrc sync=true) zurück durch intervideosink zum mxfdemux.
    // Das taktet den Player auf die Master-Clock (25fps).
    // KEIN framerate in den Caps — mit framerate=25/1 werden alle Frames
    // als "zu spät" verworfen weil Player-Clock ≠ Master-Clock.
    const vcaps = `video/x-raw,format=I420,width=${this.opts.width||640},height=${this.opts.height||360}`;
    return [
      `queue max-size-buffers=8 max-size-bytes=0 max-size-time=0`,
      `! videoconvert ! deinterlace mode=interlaced`,
      `! videoscale add-borders=true ! videoconvert`,
      `! ${vcaps}`,
      `! intervideosink channel=${ch} sync=false async=false max-lateness=-1`,
    ].join(' ');
  }

  // ── Pipeline-Try ─────────────────────────────────────────────────────────────

  /**
   * Versucht eine Pipeline zu starten und auf PLAYING zu warten.
   *
   * BUS-SEQUENZ (normal):
   *   latency → state-changed(…) → async-done → [mxfdemux-Error*] → OK
   *
   * MXF-SONDERFALL:
   *   mxfdemux schickt "Internal data stream error" nach async-done.
   *   src-Element = "mxfdemux0". Ein zweites play() behebt das.
   *   KEIN zweites play() bei anderen Errors (würde MP4-Pipeline destabilisieren).
   *
   * @param {string} pStr       — GStreamer Pipeline-String
   * @param {number} timeoutMs  — Timeout in ms
   * @returns {Pipeline|null}   null bei Fehler oder Timeout
   */
  async _tryPipeline(pStr, timeoutMs) {
    let p;
    try {
      p = new Pipeline(pStr);
    } catch(e) {
      this._log(`Parse: ${e.message}`, 'debug');
      return null;
    }

    this._log(`PIPELINE-STR: ${pStr.substring(0, 300)}`, 'debug');

    await p.play();
    this._log('play() → warte auf async-done…', 'debug');

    let ok = false;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const m = await p.busPop(300);
      if (!m) continue;

      const t   = m.type || '';
      const src = m.srcElementName || m.srcName || '';

      this._log(`BUS type=${t} src=${src}${m.errorMessage ? ' err=' + m.errorMessage : ''}`, 'debug');

      if (t === 'error' || m.errorMessage) {
        const txt = m.errorMessage || t;
        // "Internal data stream error" VOR PLAYING: transient, bei allen Elementen
        // möglich (interaudiosink wenn Seeder noch nicht läuft, etc.) → ignorieren.
        if (/internal.data.stream/i.test(txt)) {
          this._log(`Transient-Error ignoriert: src=${src}`, 'debug');
          if (ok) break;
          continue;
        }
        this._log(`Pipeline-Fehler: src=${src}: ${txt.slice(0, 120)}`, 'debug');
        try { await p.stop(); } catch {}
        return null;
      }

      if (src.startsWith('pipeline')) {
        if (t === 'async-done') {
          this._log(`Pipeline PLAYING bestätigt: async-done`, 'debug');
          ok = true;
          // Kein Drain — Switch passiert sofort nach async-done.
          // Sobald intervideosrc im Master liest, wird der Player auf Echtzeit gebremst.
          // mxfdemux/multiqueue "Internal data stream error" werden von _watchBus ignoriert.

          break;
        }
      }
    }

    if (!ok) {
      this._log(`Timeout nach ${timeoutMs}ms — Pipeline hat PLAYING nicht bestätigt`, 'debug');
      try { await p.stop(); } catch {}
      return null;
    }

    this._log('Pipeline OK (PAUSED — wartet auf go())', 'debug');
    return p;
  }

  // ── Playback-Kontrolle ────────────────────────────────────────────────────────

  async go() {
    if (!this.vPipeline) return;
    this._playing = true;
    this._log('PLAYING');
    this.emit('playing', { slotId: this.slotId });
    this._startPositionPoll();
  }

  async pause() {
    if (!this.vPipeline) return;
    try { await this.vPipeline.pause(); } catch {}
    this._log('PAUSED');
  }

  async stop() {
    this._busLoop = false;
    this._cued    = false;
    this._running = false;
    this._playing = false;
    this._stopPositionPoll();
    if (this.opts.debugger?.enabled) this.opts.debugger.stop(this.slotId);
    if (this.vPipeline) {
      const p = this.vPipeline;
      this.vPipeline = null;
      try { await p.pause(); } catch {}
      try { await p.stop();  } catch {}
    }
    this._item = null;
    this._log('Gestoppt');
    this.emit('stopped', { slotId: this.slotId });
  }

  // ── Position-Polling ──────────────────────────────────────────────────────────

  _startPositionPoll(ms = 250) {
    this._stopPositionPoll();
    this._poller = setInterval(() => {
      if (!this.vPipeline || !this._running) return;
      try {
        const pos = this.vPipeline.queryPosition();
        const dur = this.vPipeline.queryDuration();
        this.emit('position', { pos, dur });
        const eom = this._item?.eom;
        if (eom != null && pos != null && pos >= eom - 0.08) {
          this._log(`EOM pos=${toTC(pos, this.opts.fps || 25)} eom=${toTC(eom, this.opts.fps || 25)}`);
          this.emit('eom', { slotId: this.slotId });
          this._stopPositionPoll();
          this.vPipeline?.pause().catch(() => {});
        }
      } catch {}
    }, ms);
  }

  _stopPositionPoll() {
    if (this._poller) { clearInterval(this._poller); this._poller = null; }
  }

  // Legacy API
  startPositionPoll(ms) { return this._startPositionPoll(ms); }
  stopPositionPoll()    { return this._stopPositionPoll(); }

  // ── Bus-Watch ─────────────────────────────────────────────────────────────────

  async _watchBus() {
    while (this._busLoop && this.vPipeline) {
      try {
        const msg = await this.vPipeline.busPop(500);
        if (!msg) continue;

        if (msg.type === 'element' && msg.srcElementName?.startsWith('level_')) {
          this.emit('level', { slot: this.slotId, channel: msg.srcElementName.replace(/^level_/, ''), rms: msg.rms ?? [], peak: msg.peak ?? [] });
          continue;
        }

        if (msg.type === 'error') {
          const txt = msg.errorMessage || msg.message || '';
          const src = msg.srcElementName || '';
          if (/colorimetry|delayed.link|not.linked|could.not.get|wrong.format|The stream is in/i.test(txt)) continue;
          // mxfdemux Pull-Mode Error: Pipeline geht in PAUSED/ERROR.
          // play() holt sie zurück. Immer — queryPosition() ist nicht verlässlich.
          if (/internal.data.stream/i.test(txt)) {
            this._log(`internal.data.stream (${src}) — play() Recovery`, 'debug');
            try { if (this.vPipeline) await this.vPipeline.play(); } catch {}
            continue;
          }
          this._log(`⚠ ${src}: ${txt.slice(0, 120)}`, 'warn');
          continue;
        }

        if (msg.type === 'eos') {
          if (!this._playing) { this._log('EOS vor PLAYING — ignoriert', 'debug'); continue; }
          this._log('EOS');
          this.emit('eos', { slotId: this.slotId });
        }
      } catch { continue; }
    }
  }

  // ── Mute (Legacy-Modus) ───────────────────────────────────────────────────────

  _setMute(mute) {
    if (!this.vPipeline) return;
    if (this.audioGroupConfig) return;  // AudioRouter: kein lokaler Volume
    try {
      const vol = this.vPipeline.getElementByName(`avol_${this.slotId}_${this._loadSeq}`)
               || this.vPipeline.getElementByName(`avol_${this.slotId}`);
      if (vol) vol.setElementProperty('mute', mute);
    } catch(e) {
      this._log(`Mute: ${e.message}`, 'warn');
    }
  }
}

module.exports = PlayerPipeline;
