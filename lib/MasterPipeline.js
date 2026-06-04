'use strict';
/**
 * MasterPipeline.js
 *
 * ARCHITEKTUR:
 *   isel (fg) → alpha(fg) → compositor.sink_0 (zorder=2)  — incoming / normal source
 *   isel_bg   → alpha(bg) → compositor.sink_1 (zorder=1)  — outgoing source during xfade
 *   compositor background=black                            — base layer (no extra element)
 *   branding (gdkpixbufoverlay) after compositor output
 *   appsrc (grafikSrc)         → compositor.sink_2 (zorder=3)
 *
 * TRANSITIONS:
 *   cut:       hard switch, no animation
 *   v-fade:    fg 1→0 (+ audio out), switch, fg 0→1 (+ audio in)  — goes through black
 *   fade-cut:  fg 1→0 (+ audio out), switch, fg instant-to-1
 *   cut-fade:  fg instant-to-0, switch + audio cut, fg 0→1
 *   xfade:     isel_bg=outgoing, isel=incoming, fg 0→1 while bg=1
 *              audio: outgoing 1→0, incoming 0→1, simultaneously
 *
 * X-Fade eligible pads: players (0..N-1), smpte (N), black (N+1)
 * Other pads fall back to v-fade for xfade requests.
 *
 * AUDIO FRAME ACCURACY (AudioRouter mode):
 *   Volume changes apply at the next audiomixer buffer boundary (~20ms).
 *   The animation loop is driven by elapsed wall-clock with per-step correction,
 *   giving sub-frame audio alignment relative to video alpha steps (STEP_MS=40ms @25fps).
 */

const { Pipeline }     = require('gst-kit');
const { EventEmitter } = require('events');
const path             = require('path');
const fs               = require('fs');
const { AudioRouter }  = require('./AudioRouter');

const LABELS  = { 0: 'PLAYER1', 1: 'PLAYER2', 2: 'SMPTE', 3: 'BLACK', 4: 'IMAGE', 5: 'IMAGE_PL', 6: 'PLAYER_IDLE' };
const STEP_MS = 40;  // one video frame @ 25 fps

const sleep = ms => new Promise(r => setTimeout(r, ms));

class MasterPipeline extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts              = opts;
    this.pipeline          = null;
    this.isel              = null;
    this.isel_bg           = null;  // background isel for x-fade
    this.fg                = null;
    this.bg                = null;  // background alpha element for x-fade
    this.aisel_pgm         = null;
    this.aisel_sec         = null;
    this._audioGroupSelectors = {};
    this._audioGroupProgVols  = {};
    this._pgmDuckLevel        = 1.0;
    this._pgmDuckFadeTimer    = null;
    this._voGroupOverrides    = {};
    this._voCurrentVol        = {};
    this._brandingEl          = null;
    this._transparentFrame    = null;
    this._fading              = false;
    this._running             = false;
    this._busLoop             = false;
    this._currentBranding     = null;
    this._fadeBrandingWithFg  = false;
    this.audioGroupConfig     = opts.audioGroupConfig || null;
    this.clockStrategy        = opts.clockStrategy    || null;
    this._slotIds             = opts.slotIds || ['player1', 'player2'];
    this._activePad           = this.padSmpte;
    this._liveSources         = opts.liveSources || [];
    this._levelUnsubs         = [];
  }

  get padSmpte()      { return this._slotIds.length; }
  get padBlack()      { return this._slotIds.length + 1; }
  get padImage()      { return this._slotIds.length + 2; }
  get padImagePl()    { return this._slotIds.length + 3; }
  get padPlayerIdle() { return this._slotIds.length + 4; }
  get padLiveBase()   { return this._slotIds.length + 5; }

  _log(msg, level = 'info') { this.emit('log', { level, msg: `[master] ${msg}` }); }

  _ensureTransparentPng() {
    const p = '/tmp/bcast_transparent.png';
    if (!fs.existsSync(p)) {
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
      fs.writeFileSync(p, Buffer.from(b64, 'base64'));
    }
    return p;
  }

  _detectVideoSink() {
    if (this.opts.videoSink) return this.opts.videoSink;
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return 'fakesink sync=false';
    const { execSync } = require('child_process');
    const sinks = process.env.WAYLAND_DISPLAY
      ? ['waylandsink', 'ximagesink', 'xvimagesink']
      : ['ximagesink', 'xvimagesink', 'waylandsink'];
    for (const sink of sinks) {
      try { execSync(`gst-inspect-1.0 ${sink} 2>/dev/null`, { timeout: 2000 }); return sink; } catch {}
    }
    return 'autovideosink';
  }

  _scaleToFit() {
    const m = this.opts.scaleMethod ?? 1;
    switch (this.opts.scaleMode || 'fit') {
      case 'stretch': return `videoscale method=${m}`;
      case 'crop':    return `aspectratiocrop aspect-ratio=${this.opts.width||1920}/${this.opts.height||1080} ! videoscale method=${m}`;
      default:        return `videoscale method=${m} add-borders=true`;
    }
  }

  build() {
    const {
      width = 1920, height = 1080, fps = 25,
    } = this.opts;

    const videoSink = this._detectVideoSink();
    this._log(`Video-Sink: ${videoSink}`);

    const vcaps      = `video/x-raw,width=${width},height=${height},framerate=${fps}/1,colorimetry=bt601`;
    const rgba       = `video/x-raw,format=RGBA,width=${width},height=${height},framerate=${fps}/1`;
    const acaps      = 'audio/x-raw,rate=48000,channels=2';
    const ivTimeout  = 2000000000;
    const transPng   = this._ensureTransparentPng();
    const brandingEl = `gdkpixbufoverlay name=branding location="${transPng}" overlay-width=1 overlay-height=1 alpha=0.0`;

    const pipe = [
      // ── Video main path ──────────────────────────────────────────────────────
      // compositor background=black: replaces static black videotestsrc at sink_1.
      // sink_0::zorder=2 = fg/incoming, sink_1::zorder=1 = bg/outgoing (xfade), sink_2::zorder=3 = grafik
      `compositor background=black name=comp sink_0::zorder=2 sink_1::zorder=1 sink_2::zorder=3`,
      `! videoconvert ! ${vcaps}`,
      // rec_pgm_v: post-grafik, pre-branding — tee before branding overlay
      `! tee name=rec_pgm_tee`,
      `rec_pgm_tee. ! queue leaky=downstream max-size-buffers=5 ! intervideosink channel=rec_pgm_v sync=false async=false`,
      `rec_pgm_tee. ! ${brandingEl}`,
      // A/V-Sync: identity name=vdel ts-offset erlaubt Video-Delay-Korrektur zur Laufzeit
      // ohne Pipeline-Neustart. Positiver ts-offset = Video erscheint später (delay).
      `! identity name=vdel ts-offset=0 sync=false`,
      `! tee name=vtee`,
      `vtee. ! queue leaky=downstream max-size-buffers=8 ! ${videoSink} name=vsink`,
      `vtee. ! queue leaky=downstream max-size-buffers=1`,
      `! videoconvert ! videoscale ! video/x-raw,format=I420,width=640,height=360`,
      `! videorate ! video/x-raw,framerate=5/1`,
      `! intervideosink channel=preview sync=false`,

      // Foreground chain: isel → tee(rec_clean) → fg alpha → comp.sink_0
      // rec_clean_v: pre-grafik/compositor — reines Quellsignal
      `input-selector name=isel sync-streams=false`,
      `! ${this._scaleToFit()} ! videorate ! ${vcaps}`,
      `! tee name=rec_clean_tee`,
      `rec_clean_tee. ! queue leaky=downstream max-size-buffers=5 ! intervideosink channel=rec_clean_v sync=false async=false`,
      `rec_clean_tee. ! videoconvert ! ${rgba}`,
      `! alpha name=fg method=set alpha=1.0`,
      `! queue leaky=downstream max-size-buffers=3 ! comp.sink_0`,

      // Background chain: isel_bg → bg alpha → comp.sink_1 (outgoing source during xfade)
      // bg.alpha=0.0 during normal play (transparent) → compositor shows background=black
      // bg.alpha=1.0 during xfade → outgoing source visible beneath incoming
      // No scaleToFit/videorate here: all isel_bg inputs are already at vcaps (scaled by per-pad chain).
      `input-selector name=isel_bg sync-streams=false`,
      `! videoconvert ! ${rgba}`,
      `! alpha name=bg method=set alpha=0.0`,
      `! queue leaky=downstream max-size-buffers=3 ! comp.sink_1`,

      // Grafik overlay appsrc → comp.sink_2
      `appsrc name=grafikSrc is-live=true format=time do-timestamp=true caps="video/x-raw,format=RGBA,width=${width},height=${height},framerate=${fps}/1"`,
      `! queue leaky=downstream max-size-buffers=2 ! comp.sink_2`,

      // ── Audio section ────────────────────────────────────────────────────────
      ...this._buildAudioSection(acaps, ivTimeout),

      // ── Foreground isel source pads ──────────────────────────────────────────
      ...this._slotIds.flatMap((slotId, i) => [
        `intervideosrc channel=${slotId} timeout=${ivTimeout} do-timestamp=true ! queue max-size-buffers=5 max-size-time=200000000 max-size-bytes=0 leaky=downstream ! videoconvert ! ${this._scaleToFit()} ! videorate ! ${vcaps} ! queue leaky=downstream max-size-buffers=3 ! isel.sink_${i}`,
        ...this._videoSourceAudioPads(i, acaps),
      ]),

      // ── Background isel_bg source pads (mirror of isel for xfade) ───────────
      // Multiple intervideosrc on same channel: gst-inter ring-buffer supports multiple readers.
      ...this._slotIds.map((slotId, i) =>
        `intervideosrc channel=${slotId} timeout=${ivTimeout} do-timestamp=true ! queue max-size-buffers=5 max-size-time=200000000 max-size-bytes=0 leaky=downstream ! videoconvert ! ${this._scaleToFit()} ! videorate ! ${vcaps} ! queue leaky=downstream max-size-buffers=3 ! isel_bg.sink_${i}`
      ),
      `videotestsrc is-live=true pattern=smpte ! ${vcaps} ! queue leaky=upstream max-size-buffers=1 ! isel_bg.sink_${this.padSmpte}`,
      `videotestsrc is-live=true pattern=black  ! ${vcaps} ! queue leaky=upstream max-size-buffers=1 ! isel_bg.sink_${this.padBlack}`,

      // ── SMPTE isel pad ───────────────────────────────────────────────────────
      `videotestsrc is-live=true pattern=smpte ! ${vcaps} ! queue leaky=upstream max-size-buffers=1 ! isel.sink_${this.padSmpte}`,
      ...(!this.audioGroupConfig ? [`audiotestsrc is-live=true wave=sine freq=1000 do-timestamp=true ! ${acaps} ! queue max-size-buffers=0 max-size-time=500000000 max-size-bytes=0 ! aisel_pgm.sink_${this.padSmpte}`] : []),
      ...(!this.audioGroupConfig ? [`audiotestsrc is-live=true wave=sine freq=1000 do-timestamp=true ! ${acaps} ! queue max-size-buffers=0 max-size-time=500000000 max-size-bytes=0 ! aisel_sec.sink_${this.padSmpte}`] : []),

      // ── Black isel pad ───────────────────────────────────────────────────────
      `videotestsrc is-live=true pattern=black ! ${vcaps} ! queue leaky=upstream max-size-buffers=1 ! isel.sink_${this.padBlack}`,
      ...(!this.audioGroupConfig ? [`audiotestsrc is-live=true wave=silence do-timestamp=true ! ${acaps} ! queue max-size-buffers=0 max-size-time=500000000 max-size-bytes=0 ! aisel_pgm.sink_${this.padBlack}`] : []),
      ...(!this.audioGroupConfig ? [`audiotestsrc is-live=true wave=silence do-timestamp=true ! ${acaps} ! queue max-size-buffers=0 max-size-time=500000000 max-size-bytes=0 ! aisel_sec.sink_${this.padBlack}`] : []),

      // ── Image Idle isel pad ──────────────────────────────────────────────────
      ...(this.opts.idleImagePath && fs.existsSync(this.opts.idleImagePath)
        ? [`${this._buildImageSrc(this.opts.idleImagePath, vcaps, 'imgIdle')} ! queue leaky=upstream max-size-buffers=1 ! isel.sink_${this.padImage}`]
        : [`videotestsrc is-live=true pattern=black ! ${vcaps} ! queue leaky=upstream max-size-buffers=1 ! isel.sink_${this.padImage}`]
      ),
      ...(!this.audioGroupConfig ? [`audiotestsrc is-live=true wave=silence do-timestamp=true ! ${acaps} ! queue max-size-buffers=0 max-size-time=500000000 max-size-bytes=0 ! aisel_pgm.sink_${this.padImage}`] : []),
      ...(!this.audioGroupConfig ? [`audiotestsrc is-live=true wave=silence do-timestamp=true ! ${acaps} ! queue max-size-buffers=0 max-size-time=500000000 max-size-bytes=0 ! aisel_sec.sink_${this.padImage}`] : []),

      // ── Image Playlist isel pad ──────────────────────────────────────────────
      `videotestsrc is-live=true pattern=black ! ${vcaps} ! gdkpixbufoverlay name=imgOverlay location="${this._ensurePlaceholderImage()}" overlay-width=${width} overlay-height=${height} alpha=1.0 ! queue leaky=upstream max-size-buffers=1 ! isel.sink_${this.padImagePl}`,
      ...(!this.audioGroupConfig ? [`audiotestsrc is-live=true wave=silence do-timestamp=true ! ${acaps} ! queue max-size-buffers=0 max-size-time=500000000 max-size-bytes=0 ! aisel_pgm.sink_${this.padImagePl}`] : []),
      ...(!this.audioGroupConfig ? [`audiotestsrc is-live=true wave=silence do-timestamp=true ! ${acaps} ! queue max-size-buffers=0 max-size-time=500000000 max-size-bytes=0 ! aisel_sec.sink_${this.padImagePl}`] : []),

      // ── Player Idle isel pad ─────────────────────────────────────────────────
      `intervideosrc channel=playerIdle timeout=${ivTimeout} do-timestamp=true ! queue max-size-buffers=5 max-size-time=200000000 max-size-bytes=0 leaky=downstream ! videoconvert ! ${this._scaleToFit()} ! videorate ! ${vcaps} ! queue leaky=downstream max-size-buffers=3 ! isel.sink_${this.padPlayerIdle}`,
      ...this._videoSourceAudioPads(this.padPlayerIdle, acaps),

      // ── Dynamic live sources ─────────────────────────────────────────────────
      ...this._liveSources.flatMap((ls, i) => {
        const padIdx = this.padLiveBase + i;
        return [
          `${ls.gstSrc} ! videoconvert ! ${this._scaleToFit()} ! videorate ! ${vcaps} ! queue leaky=downstream max-size-buffers=3 ! isel.sink_${padIdx}`,
          ...this._liveSourceAudioPads(padIdx, ls, acaps),
        ];
      }),
    ].join(' ');

    this._pipeStr = pipe;
    return this;
  }

  _buildAudioSection(acaps, _ivTimeout) {
    if (this.audioGroupConfig) {
      const sinkConfig = this.clockStrategy
        ? this.clockStrategy.masterSinkConfig(this.audioGroupConfig)
        : null;
      const frags = AudioRouter.buildMasterOutputs(
        this.audioGroupConfig,
        this._slotIds,
        sinkConfig,
        this.opts.numVoSlots || 1,
        this._liveSources,
      );
      const dummyParts = [];
      const nPads = this._slotIds.length + 4 + 1 + this._liveSources.length;
      for (let i = 0; i < nPads; i++) {
        dummyParts.push(
          `audiotestsrc wave=silence is-live=true ! ${acaps} ! queue max-size-buffers=0 max-size-time=500000000 max-size-bytes=0 ! aisel_pgm.sink_${i}`
        );
      }
      return [
        `input-selector name=aisel_pgm sync-streams=false ! fakesink sync=false`,
        ...dummyParts,
        ...frags,
      ];
    }

    const pgmSink = (this.clockStrategy?.type === 'alsa')
      ? `alsasink name=asink_pgm buffer-time=${this.clockStrategy.bufferTime} provide-clock=true`
      : `pulsesink name=asink_pgm buffer-time=400000`;
    const secSink = (this.clockStrategy?.type === 'alsa')
      ? `alsasink name=asink_sec buffer-time=${this.clockStrategy.bufferTime} provide-clock=false`
      : `pulsesink name=asink_sec buffer-time=400000`;

    return [
      `input-selector name=aisel_pgm sync-streams=false`,
      `! queue max-size-buffers=0 max-size-time=2000000000 max-size-bytes=0`,
      `! audioconvert ! audioresample`,
      `! audio/x-raw,format=F32LE,rate=48000,channels=2`,
      `! level name=level_pgm interval=100000000 post-messages=true`,
      `! ${pgmSink}`,

      `input-selector name=aisel_sec sync-streams=false`,
      `! queue max-size-buffers=0 max-size-time=2000000000 max-size-bytes=0`,
      `! audioconvert ! audioresample`,
      `! audio/x-raw,format=F32LE,rate=48000,channels=2`,
      `! ${secSink}`,
    ];
  }

  _videoSourceAudioPads(padIdx, acaps, isSine = false) {
    const wave = isSine ? 'wave=sine freq=1000' : 'wave=silence';
    if (this.audioGroupConfig) return [];
    const playerSlot = padIdx < this._slotIds.length ? this._slotIds[padIdx]
                     : padIdx === this.padPlayerIdle  ? (this.opts.idleSlot || 'playerIdle')
                     : null;
    if (playerSlot) {
      const audioCh = `${playerSlot}_audio`;
      return [
        `interaudiosrc channel=${audioCh} do-timestamp=true ! queue max-size-buffers=0 max-size-time=500000000 max-size-bytes=0 leaky=upstream ! ${acaps} ! aisel_pgm.sink_${padIdx}`,
        `interaudiosrc channel=${audioCh} do-timestamp=true ! queue max-size-buffers=0 max-size-time=500000000 max-size-bytes=0 leaky=upstream ! ${acaps} ! aisel_sec.sink_${padIdx}`,
      ];
    }
    return [
      `audiotestsrc ${wave} is-live=true ! ${acaps} ! queue max-size-buffers=0 max-size-time=500000000 max-size-bytes=0 ! aisel_pgm.sink_${padIdx}`,
      `audiotestsrc ${wave} is-live=true ! ${acaps} ! queue max-size-buffers=0 max-size-time=500000000 max-size-bytes=0 ! aisel_sec.sink_${padIdx}`,
    ];
  }

  _liveSourceAudioPads(padIdx, ls, acaps) {
    if (this.audioGroupConfig) {
      // In AudioGroupConfig-Modus: Live-Audio via interaudio routen (Audio-Shuffling).
      // Jede Gruppe bekommt einen dedizierten interaudiosink-Kanal.
      // buildMasterOutputs liest diese via interaudiosrc als Live-Source-Inputs.
      if (ls.hasAudio && ls.gstAudioSrc) {
        const pads = [];
        for (const group of this.audioGroupConfig.groups) {
          const ch     = `${ls.id}_${group.id}`;
          const gCaps  = `audio/x-raw,format=F32LE,rate=48000,channels=${group.channels},layout=interleaved`;
          const matrix = group.channels === 2
            ? ''  // stereo: 1:1 (audioconvert handles downmix if needed)
            : '';
          pads.push(
            `${ls.gstAudioSrc} ! audioconvert ! audioresample ! ${gCaps}` +
            ` ! queue max-size-buffers=0 max-size-time=200000000 max-size-bytes=0 leaky=downstream` +
            ` ! interaudiosink channel=${ch} sync=false async=false`
          );
        }
        return pads;
      }
      return [];  // kein gstAudioSrc → Stille (Silence-Seeder aus buildMasterOutputs hält Channel aktiv)
    }
    // Ohne AudioGroupConfig: direkt in aisel
    if (ls.hasAudio && ls.gstAudioSrc) {
      const q = `queue max-size-buffers=0 max-size-time=500000000 max-size-bytes=0`;
      return [
        `${ls.gstAudioSrc} ! audioconvert ! audioresample ! ${acaps} ! ${q} ! aisel_pgm.sink_${padIdx}`,
        `${ls.gstAudioSrc} ! audioconvert ! audioresample ! ${acaps} ! ${q} ! aisel_sec.sink_${padIdx}`,
      ];
    }
    return [
      `audiotestsrc wave=silence is-live=true ! ${acaps} ! queue max-size-buffers=0 max-size-time=500000000 max-size-bytes=0 ! aisel_pgm.sink_${padIdx}`,
      `audiotestsrc wave=silence is-live=true ! ${acaps} ! queue max-size-buffers=0 max-size-time=500000000 max-size-bytes=0 ! aisel_sec.sink_${padIdx}`,
    ];
  }

  padForLiveSource(sourceId) {
    const idx = this._liveSources.findIndex(ls => ls.id === sourceId);
    return idx >= 0 ? this.padLiveBase + idx : -1;
  }

  // ── Audio helpers ─────────────────────────────────────────────────────────

  /** Maps a video pad index to the AudioRouter source key string. */
  _padToKey(padIndex) {
    if (padIndex < this.padSmpte)      return this._slotIds[padIndex] ?? null;
    if (padIndex === this.padSmpte)    return 'smpte';
    if (padIndex === this.padBlack)    return 'black';
    if (padIndex === this.padImage)    return 'image';
    if (padIndex === this.padImagePl)  return 'imagepl';
    // Live-Quellen: padLiveBase + idx → live source id
    if (padIndex >= this.padLiveBase) {
      const liveIdx = padIndex - this.padLiveBase;
      return this._liveSources[liveIdx]?.id ?? null;
    }
    return null;
  }

  /** Set all prog-source volumes: activeKey → duck level, all others → 0. */
  _setAllSourceVolumes(activeKey) {
    const duck = this._pgmDuckLevel;
    for (const vols of Object.values(this._audioGroupProgVols)) {
      for (const [key, el] of Object.entries(vols)) {
        try { el?.setElementProperty('volume', key === activeKey ? duck : 0.0); } catch {}
      }
    }
  }

  /** Set a single source's volume across all groups. */
  _setSourceVolume(key, vol) {
    if (!key) return;
    const v = Math.max(0, Math.min(2, vol));
    for (const vols of Object.values(this._audioGroupProgVols)) {
      if (vols[key]) try { vols[key].setElementProperty('volume', v); } catch {}
    }
  }

  _switchAudio(padIndex) {
    if (this.audioGroupConfig) {
      this._setAllSourceVolumes(this._padToKey(padIndex));
    } else {
      const pad = `sink_${padIndex}`;
      try { this.aisel_pgm?.setPad('active-pad', pad); } catch {}
      try { this.aisel_sec?.setPad('active-pad', pad); } catch {}
    }
  }

  // ── A/V-Sync Delay-Korrektur ─────────────────────────────────────────────────

  /**
   * Setzt einen Video-Delay (ts-offset auf identity element "vdel").
   * Positiver Wert: Video erscheint later → kompensiert wenn Video schneller als Audio ist.
   * @param {number} ms  — Millisekunden (0–2000, negativ = advance)
   */
  setVideoDelay(ms) {
    this._videoDelayMs = ms;
    if (!this._vdelEl) return;
    const ns = Math.round(ms * 1_000_000);
    try { this._vdelEl.setElementProperty('ts-offset', ns); }
    catch(e) { this._log(`setVideoDelay: ${e.message}`, 'warn'); }
    this._log(`Video-Delay: ${ms}ms (${ns}ns)`);
  }

  /**
   * Setzt einen Audio-Delay für eine bestimmte Gruppe (ts-offset auf "adel_<group>").
   * Positiver Wert: Audio erscheint später → kompensiert wenn Audio schneller als Video ist.
   * @param {string} groupId  — z.B. 'pgm-stereo', 'pgm-51'
   * @param {number} ms
   */
  setAudioDelay(groupId, ms) {
    if (!this._audioDelayMs) this._audioDelayMs = {};
    this._audioDelayMs[groupId] = ms;
    const el = this._adelEls?.[groupId];
    if (!el) { this._log(`setAudioDelay: adel für ${groupId} nicht gefunden`, 'warn'); return; }
    const ns = Math.round(ms * 1_000_000);
    try { el.setElementProperty('ts-offset', ns); }
    catch(e) { this._log(`setAudioDelay(${groupId}): ${e.message}`, 'warn'); }
    this._log(`Audio-Delay ${groupId}: ${ms}ms (${ns}ns)`);
  }

  /**
   * Gibt aktuelle Delay-Werte zurück.
   * @returns {{ videoMs: number, audioMs: Object<string,number> }}
   */
  getDelays() {
    return {
      videoMs:  this._videoDelayMs || 0,
      audioMs:  { ...(this._audioDelayMs || {}) },
    };
  }

  /**
   * Misst den A/V-Sync-Offset durch einen Referenz-Signal-Test:
   *   1. Umschalten auf Schwarz (Stille) → Level-Meter liest ~-90 dBFS
   *   2. Umschalten auf SMPTE (1kHz Sinus) → Level-Meter erkennt Audio-Onset
   *   3. Delta zwischen Switch-Zeitpunkt und Audio-Onset = Audio-Pfad-Latenz
   *   4. Video-Latenz = geschätzt aus Pipeline-Elementen (audiomixer-latency + Sink)
   *   5. Differenz → Empfehlung welchen Pfad zu verzögern
   *
   * @param {number} [timeoutMs=1500]  — max Wartezeit für Audio-Onset
   * @returns {Promise<object>}
   */
  async measureAvSync(timeoutMs = 1500) {
    if (!this._running) return { error: 'Pipeline nicht aktiv' };

    const prevPad = this._activePad ?? 0;
    const SILENCE_DB = -70;
    const ONSET_DB   = -50;

    // Hilfsfunktion: wartet auf bestätigte Stille (padBlack muss fließen)
    const _waitSilence = (limitMs = 700) => new Promise(resolve => {
      const t = setTimeout(() => { this.removeListener('level', fn); resolve(); }, limitMs);
      const fn = ({ rms }) => {
        if (Array.isArray(rms) && rms.length && Math.max(...rms) < SILENCE_DB) {
          clearTimeout(t); this.removeListener('level', fn); resolve();
        }
      };
      this.on('level', fn);
    });

    // Hilfsfunktion: eine Onset-Messung (Switch → erstes Level-Event über Schwelle)
    const _measure = (perRunTimeout) => new Promise(resolve => {
      const T0 = Date.now();
      this.switchTo(this.padSmpte);
      const t = setTimeout(() => { this.removeListener('level', fn); resolve(null); }, perRunTimeout);
      const fn = ({ rms }) => {
        if (Array.isArray(rms) && rms.length && Math.max(...rms) > ONSET_DB) {
          clearTimeout(t); this.removeListener('level', fn); resolve(Date.now() - T0);
        }
      };
      this.on('level', fn);
    });

    // 3 Messungen → Median verhindert Jitter durch 100ms Level-Intervall-Granularität
    this.switchTo(this.padBlack);
    const samples = [];
    const perRun  = Math.min(Math.round(timeoutMs * 0.6), 900);
    for (let i = 0; i < 3; i++) {
      await _waitSilence(700);
      const v = await _measure(perRun);
      if (v !== null) samples.push(v);
      if (i < 2) this.switchTo(this.padBlack);
    }

    // Zurück auf vorherigen Pad
    this.switchTo(prevPad);

    const audioOnsetMs = samples.length
      ? samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]
      : null;

    // Video-Latenz: GStreamer-Query falls verfügbar, sonst Schätzung
    let videoLatencyMs = null;
    try {
      const q = this.pipeline?.queryLatency?.();
      if (q?.minLatencyNs > 0) videoLatencyMs = Math.round(q.minLatencyNs / 1_000_000);
    } catch {}
    if (!videoLatencyMs) {
      // Schätzung: queue(2 Frames @25fps) + branding + compositor + sink
      const fps = this.opts.fps || 25;
      videoLatencyMs = Math.round(2000 / fps + 20);
    }

    // Audio-Latenz theoretisch: audiomixer(100ms) + interaudiosrc latency-time(50ms) + queue
    const audioLatencyEstMs = 150;

    const offsetMs = audioOnsetMs != null ? audioOnsetMs - videoLatencyMs : null;
    const recommendation = offsetMs != null ? {
      delayPath:    offsetMs > 0 ? 'video' : 'audio',
      delayMs:      Math.abs(offsetMs),
      settingKey:   offsetMs > 0 ? 'videoDelayMs' : 'audioDelayMs',
      description:  offsetMs > 0
        ? `Audio kommt ${Math.abs(offsetMs)}ms früher als Video → Video um ${Math.abs(offsetMs)}ms verzögern`
        : `Video kommt ${Math.abs(offsetMs)}ms früher als Audio → Audio um ${Math.abs(offsetMs)}ms verzögern`,
    } : null;

    return {
      audioOnsetMs,
      videoLatencyMs,
      audioLatencyEstMs,
      offsetMs,
      recommendation,
      current: this.getDelays(),
    };
  }

  async start() {
    this.build();
    this._log('Starte Master-Pipeline...');
    try { this.pipeline = new Pipeline(this._pipeStr); }
    catch(e) { this._log(`Parse-Fehler: ${e.message}`, 'error'); this.emit('error', e.message); return false; }

    // Prime grafikSrc appsrc with one transparent frame BEFORE play().
    // Without this the compositor blocks on sink_2 (live appsrc, no data) during PLAYING
    // transition — async-done never fires within the 3s deadline → "Async-Timeout" and
    // the preview channel starves. getElementByName works on any pipeline state.
    const W = this.opts.width || 1920, H = this.opts.height || 1080;
    const _primeSrc = this.pipeline.getElementByName('grafikSrc');
    if (_primeSrc) {
      try { _primeSrc.push(Buffer.alloc(W * H * 4, 0), 0); } catch {}
    }

    const r = await this.pipeline.play();
    this._log(`play: ${r.result} / state=${r.finalState}`);

    if ((r.result === 'failure' && (r.finalState == null || r.finalState < 3)) ||
        (r.result !== 'success' && r.result !== 'async' && r.result !== 'failure' && r.finalState < 3)) {
      const msgs = [];
      for (let i = 0; i < 15; i++) {
        const m = await this.pipeline.busPop(300);
        if (!m) break;
        if (m.errorMessage || m.type === 'error') msgs.push(`${m.srcElementName}: ${m.errorMessage || m.type}`);
        this._log(`Bus[${i}]: type=${m.type} src=${m.srcElementName} err=${m.errorMessage||''}`, 'debug');
      }
      const errText = msgs.length ? msgs.join(' | ') : `play() result=${r.result} state=${r.finalState}`;
      this._log(`Fehler: ${errText}`, 'error');
      this.emit('error', errText);
      return false;
    }
    if (r.result === 'async' || r.result === 'failure' || r.finalState === 3) {
      this._log('Pipeline ASYNC — warte auf PLAYING...', 'debug');
      const deadline = Date.now() + 3000;
      let reached = false;
      while (Date.now() < deadline) {
        const m = await this.pipeline.busPop(200);
        if (!m) { await new Promise(r => setTimeout(r, 50)); continue; }
        if (m.type === 'error' || m.errorMessage) { this._log(`Async-Fehler: ${m.errorMessage || m.type}`, 'warn'); break; }
        if (m.type === 'async-done' || (m.type === 'state-changed' && m.newState >= 4) || m.type === 'stream-start') {
          this._log('ASYNC → PLAYING ✓', 'debug'); reached = true; break;
        }
      }
      if (!reached) this._log('Async-Timeout — Pipeline läuft möglicherweise noch nicht stabil', 'warn');
    }

    this.isel        = this.pipeline.getElementByName('isel');
    this.isel_bg     = this.pipeline.getElementByName('isel_bg');
    this.aisel_pgm   = this.pipeline.getElementByName('aisel_pgm');
    this.aisel_sec   = this.pipeline.getElementByName('aisel_sec');
    this.fg          = this.pipeline.getElementByName('fg');
    this.bg          = this.pipeline.getElementByName('bg');
    this._brandingEl = this.pipeline.getElementByName('branding');
    this._comp       = this.pipeline.getElementByName('comp');
    this._grafikSrc  = this.pipeline.getElementByName('grafikSrc');
    this._grafikAlpha = 0.0;
    this._transparentFrame = null;
    this._grafikFrameN = 0;

    // isel_bg defaults to black pad (transparent during normal play)
    if (this.isel_bg) {
      try { this.isel_bg.setPad('active-pad', `sink_${this.padBlack}`); } catch {}
    }
    if (this.bg) {
      try { this.bg.setElementProperty('alpha', 0.0); } catch {}
    }

    if (this._comp) {
      try { this._comp.setElementProperty('sink_1::max-lateness', -1); } catch {}
      try { this._comp.setElementProperty('sink_2::max-lateness', -1); } catch {}
    }
    if (this._grafikSrc) this._log('grafikSrc appsrc OK ✓');
    else                 this._log('WARN: grafikSrc nicht gefunden', 'warn');

    if (this.audioGroupConfig) {
      this._audioGroupSelectors = {};
      this._audioGroupProgVols  = {};
      this._levelUnsubs = [];

      for (const group of this.audioGroupConfig.groups) {
        const selName = `agrp_${group.id.replace(/-/g,'_')}`;
        const el = this.pipeline.getElementByName(selName);
        if (el) { this._audioGroupSelectors[group.id] = el; this._log(`Audio-Gruppe: ${group.id} ✓`); }
        else      this._log(`Audio-Gruppe: ${selName} nicht gefunden`, 'warn');

        const vols = {};
        for (const slotId of this._slotIds) {
          const n  = `pvol_${slotId.replace(/-/g,'_')}_${selName}`;
          const ev = this.pipeline.getElementByName(n);
          if (ev) vols[slotId] = ev;
          else    this._log(`WARN: ${n} nicht gefunden`, 'warn');
        }
        for (const label of ['smpte', 'black', 'image', 'imagepl']) {
          const n  = `${label}_vol_${selName}`;
          const ev = this.pipeline.getElementByName(n);
          if (ev) vols[label] = ev;
          else    this._log(`WARN: ${n} nicht gefunden`, 'warn');
        }
        this._audioGroupProgVols[group.id] = vols;

        const apsName = `apslevel_${selName}`;
        const apsSink = this.pipeline.getElementByName(apsName);
        if (apsSink?.onSample) {
          const channels = group.channels || 2;
          const channel  = selName;
          let _lastLevelMs = 0;
          const unsub = apsSink.onSample(sample => {
            if (!sample?.buffer) return;
            const now = Date.now();
            if (now - _lastLevelMs < 80) return;
            _lastLevelMs = now;
            try {
              const buf    = sample.buffer;
              const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
              const spCh   = Math.floor(floats.length / channels);
              if (spCh === 0) return;
              const rms  = [], peak = [];
              for (let ch = 0; ch < channels; ch++) {
                let sumSq = 0, maxAbs = 0;
                for (let s = 0; s < spCh; s++) {
                  const v = floats[s * channels + ch];
                  sumSq += v * v;
                  if (v > maxAbs) maxAbs = v; else if (-v > maxAbs) maxAbs = -v;
                }
                const rmsLin = sumSq  > 0     ? Math.sqrt(sumSq / spCh) : 0;
                rms.push( rmsLin  > 1e-10 ? Math.max(-90, 20 * Math.log10(rmsLin))  : -90);
                peak.push(maxAbs  > 1e-10 ? Math.max(-90, 20 * Math.log10(maxAbs))  : -90);
              }
              this.emit('level', { channel, rms, peak });
            } catch {}
          });
          this._levelUnsubs.push(unsub);
          this._log(`Level-appsink: ${apsName} ✓`);
        } else {
          this._log(`Level-appsink: ${apsName} nicht gefunden`, 'warn');
        }
      }
    }

    this._duckEls = {};
    if (this.audioGroupConfig) {
      for (const group of this.audioGroupConfig.groups) {
        const selName = `agrp_${group.id.replace(/-/g,'_')}`;
        const el = this.pipeline.getElementByName(`pgm_duck_${selName}`);
        if (el) { this._duckEls[group.id] = el; this._log(`Duck el ${group.id} ✓`); }
        else      this._log(`Duck el ${group.id} nicht gefunden`, 'warn');
      }
    }

    // A/V-Sync Delay-Elemente (identity ts-offset)
    this._vdelEl    = this.pipeline.getElementByName('vdel');
    this._adelEls   = {};  // groupId → element
    this._videoDelayMs   = 0;
    this._audioDelayMs   = {};  // groupId → ms
    if (this._vdelEl) this._log('vdel (Video-Delay) ✓');
    else              this._log('WARN: vdel nicht gefunden', 'warn');
    if (this.audioGroupConfig) {
      for (const group of this.audioGroupConfig.groups) {
        const safeId = group.id.replace(/-/g, '_');
        const el = this.pipeline.getElementByName(`adel_${safeId}`);
        if (el) { this._adelEls[group.id] = el; this._log(`adel ${group.id} ✓`); }
        else      this._log(`WARN: adel_${safeId} nicht gefunden`, 'warn');
        this._audioDelayMs[group.id] = 0;
      }
    }
    // Konfigurierte Startwerte sofort anwenden
    if (this.opts.videoDelayMs) this.setVideoDelay(this.opts.videoDelayMs);
    if (this.opts.audioDelayMs) {
      for (const [gid, ms] of Object.entries(this.opts.audioDelayMs)) {
        this.setAudioDelay(gid, ms);
      }
    }

    this._voVols = {};
    if (this.audioGroupConfig) {
      const numVoSlots = this.opts.numVoSlots || 1;
      const voSlots    = Array.from({ length: Math.max(1, numVoSlots) }, (_, i) => `vo${i + 1}`);
      for (const slotId of voSlots) {
        this._voVols[slotId] = {};
        for (const group of this.audioGroupConfig.groups) {
          const selName = `agrp_${group.id.replace(/-/g,'_')}`;
          const vol = this.pipeline.getElementByName(`vo_vol_${slotId}_${selName}`);
          if (vol) { this._voVols[slotId][group.id] = vol; this._log(`VO vol ${slotId}/${group.id} ✓`); }
          else       this._log(`WARN: vo_vol_${slotId}_${selName} nicht gefunden`, 'warn');
        }
      }
    }

    if (this.fg) this._log('alpha element OK ✓');
    else          this._log('WARN: alpha element fehlt', 'warn');

    this._running = true;
    this._busLoop = true;
    this._watchBus();
    this._setAlpha(1.0);

    if (this.opts.debugger?.enabled) {
      this.opts.debugger.watch('master', this.pipeline, this._pipeStr, this);
      this.on('level-bus-msg', msg => this._parseLevelMsg(msg));
    }

    const idlePad = this._idlePadFromOpts();
    this.switchTo(idlePad);
    this._log('Master-Pipeline läuft ✓');
    this.emit('started');
    return true;
  }

  _idlePadFromOpts() {
    const src = this.opts.idleSource || (this.opts.idleImagePath ? 'image' : 'smpte');
    if (src === 'black') return this.padBlack;
    if (src === 'image') return this.padImage;
    return this.padSmpte;
  }

  _ensurePlaceholderImage() {
    const p = '/tmp/bcast_pl_image.jpg';
    if (!fs.existsSync(p)) {
      try {
        const { execSync } = require('child_process');
        execSync(`ffmpeg -y -f lavfi -i color=black:s=1920x1080 -frames:v 1 "${p}" 2>/dev/null`, { timeout: 5000 });
      } catch { try { fs.copyFileSync(this._ensureTransparentPng(), p); } catch {} }
    }
    return p;
  }

  _buildImageSrc(imgPath, vcaps, name = 'imgSrc') {
    return [
      `multifilesrc name=${name} location="${imgPath}" loop=true`,
      `! decodebin ! videoconvert ! ${this._scaleToFit()} ! videorate ! ${vcaps} ! imagefreeze is-live=true`,
    ].join(' ');
  }

  async showPlaylistImage(absPath) {
    this._log(`Playlist-Bild: ${path.basename(absPath)}`);
    if (!this.pipeline) return;
    try {
      const overlay = this.pipeline.getElementByName('imgOverlay');
      if (overlay) { overlay.setElementProperty('location', absPath); this._log(`Playlist-Bild gewechselt ✓`); }
      else          this._log(`imgOverlay nicht gefunden`, 'warn');
    } catch(e) { this._log(`showPlaylistImage: ${e.message}`, 'warn'); }
  }

  async setIdleImage(absPath) {
    this.opts.idleImagePath = absPath;
    this.opts.idleSource    = 'image';
    this._log(`Idle-Bild: ${path.basename(absPath)}`);
    if (!this.pipeline) return;
    if (this._activePad < this._slotIds.length) { this._log(`Idle-Bild gespeichert`); return; }
    await this.stop(); await this.start();
    this._log(`Idle-Bild geladen ✓`);
  }

  setIdleSource(source) { this.opts.idleSource = source; this._log(`Idle-Quelle: ${source}`); }

  // ── Grafik ────────────────────────────────────────────────────────────────

  pushGrafikFrame(pngBuf) {
    if (!this._grafikSrc) return;
    if (!this._grafikPtsBase) this._grafikPtsBase = Date.now();
    const ptsNs = Math.round((Date.now() - this._grafikPtsBase) * 1e6);
    let frameBuf = pngBuf;
    if (this._grafikAlpha === 0) {
      if (!this._transparentFrame) {
        const w = this.opts.width || 1920, h = this.opts.height || 1080;
        this._transparentFrame = Buffer.alloc(w * h * 4, 0);
      }
      frameBuf = this._transparentFrame;
    }
    if (!frameBuf) return;
    try { this._grafikSrc.push(frameBuf, ptsNs); }
    catch(e) { this._log(`pushGrafikFrame: ${e.message}`, 'warn'); }
  }

  showGrafik()  { this._grafikAlpha = 1.0; this._log('Grafik: ein', 'debug'); }
  hideGrafik()  { this._grafikAlpha = 0.0; this._log('Grafik: aus', 'debug'); }
  get grafikVisible() { return this._grafikAlpha > 0; }

  async stop() {
    this._busLoop = false;
    this._running = false;
    if (this._duckFadeTimer)    { clearInterval(this._duckFadeTimer);    this._duckFadeTimer = null; }
    if (this._pgmDuckFadeTimer) { clearInterval(this._pgmDuckFadeTimer); this._pgmDuckFadeTimer = null; }
    this._pgmDuckLevel = 1.0;
    if (this.opts.debugger?.enabled) this.opts.debugger.stop('master');
    if (this.pipeline) { try { await this.pipeline.stop(); } catch {} this.pipeline = null; }
    if (this._grafikProbeUnsub) { try { this._grafikProbeUnsub(); } catch {} this._grafikProbeUnsub = null; }
    this._grafikPtsBase    = null;
    this._transparentFrame = null;
    this.isel = this.isel_bg = this.fg = this.bg = this.aisel_pgm = this.aisel_sec = null;
    this._brandingEl = this._comp = this._grafikSrc = null;
    this._voVols = {};
    this._voGroupOverrides = {};
    this._voCurrentVol    = {};
    this._audioGroupSelectors = {};
    this._audioGroupProgVols  = {};
    for (const unsub of this._levelUnsubs) { try { unsub(); } catch {} }
    this._levelUnsubs = [];
    this.removeAllListeners('level-bus-msg');
    this._log('Gestoppt');
    this.emit('stopped');
  }

  // ── Alpha ─────────────────────────────────────────────────────────────────

  _setAlpha(a) {
    if (!this.fg) return;
    const v = Math.max(0, Math.min(1, a));
    try { this.fg.setElementProperty('alpha', v); } catch {}
    if (this._fadeBrandingWithFg && this._brandingEl && this._currentBranding) {
      try { this._brandingEl.setElementProperty('alpha', v); } catch {}
    }
  }

  /**
   * Animates alpha from `from` to `to` over `durationMs`.
   * Uses elapsed-time correction each step to prevent cumulative drift.
   * One step per video frame (STEP_MS = 40ms @ 25fps).
   */
  async _animateAlpha(from, to, durationMs) {
    const steps  = Math.max(2, Math.round(durationMs / STEP_MS));
    const startT = Date.now();
    for (let i = 1; i <= steps; i++) {
      const targetT = startT + durationMs * i / steps;
      const wait    = targetT - Date.now();
      if (wait > 0) await sleep(wait);
      const t = Math.min(1, (Date.now() - startT) / durationMs);
      this._setAlpha(from + (to - from) * t);
    }
    this._setAlpha(to);
  }

  // ── Switch (hard cut) ─────────────────────────────────────────────────────

  _switchIsel(padIndex) {
    try {
      this.isel?.setPad('active-pad', `sink_${padIndex}`);
      this._switchAudio(padIndex);
      this._activePad = padIndex;
    } catch(e) { this._log(`Switch-Fehler: ${e.message}`, 'warn'); }
    // Mirror isel_bg to the new pad so xfade always finds frames already flowing —
    // avoids the one-frame black gap that occurs when isel_bg switches cold from padBlack.
    if (this.isel_bg && this._xFadeEligible(padIndex)) {
      try { this.isel_bg.setPad('active-pad', `sink_${padIndex}`); } catch {}
    }
  }

  /** Switch video isel only (audio handled separately in fade paths). */
  _switchIselVideoOnly(padIndex) {
    try {
      this.isel?.setPad('active-pad', `sink_${padIndex}`);
      this._activePad = padIndex;
    } catch(e) { this._log(`Switch-Fehler: ${e.message}`, 'warn'); }
  }

  switchTo(padIndex) {
    if (this._fading) return false;
    this._switchIsel(padIndex);
    this._setAlpha(1.0);
    this._log(`Switch → sink_${padIndex} (${LABELS[padIndex] ?? padIndex})`);
    this.emit('switched', { pad: padIndex, label: LABELS[padIndex] });
    return true;
  }

  /** Off-Clip: nur Video umschalten, Audio-Isel bleibt auf vorheriger Quelle. */
  switchVideoOnly(padIndex) {
    if (this._fading) return false;
    this._switchIselVideoOnly(padIndex);
    this._setAlpha(1.0);
    this._log(`VideoOnly → sink_${padIndex} (${LABELS[padIndex] ?? padIndex})`);
    this.emit('switched', { pad: padIndex, label: LABELS[padIndex] });
    return true;
  }

  // ── Fades ─────────────────────────────────────────────────────────────────

  /**
   * V-Fade: fg 1→0, hard audio cut at black, fg 0→1.
   * Audio cuts at the black frame (broadcast-standard for V-Fade).
   * Smooth audio animation is NOT done here — rapid property changes from the
   * Node.js event loop cause jitter on slow machines. Hard cut is reliable.
   */
  async vFadeTo(targetPad, durationMs, branding = null) {
    if (!this.fg) { this.switchTo(targetPad); if (branding !== null) this.setBranding(branding); return; }
    if (this._fading) { this._switchIsel(targetPad); this._setAlpha(1.0); if (branding !== null) this.setBranding(branding); return; }
    this._fading = true;
    this._fadeBrandingWithFg = true;
    const half = Math.round(durationMs / 2);
    this._log(`v-fade → ${LABELS[targetPad]??targetPad} (${durationMs}ms)`);

    await this._animateAlpha(1.0, 0.0, half);

    // At black: hard switch video + audio (single atomic block, no async gaps)
    this._switchIsel(targetPad);
    if (branding !== null) this._loadBrandingInvisible(branding);
    this.emit('switched', { pad: targetPad, label: LABELS[targetPad] });

    await this._animateAlpha(0.0, 1.0, half);

    if (branding !== null && this._currentBranding === branding) {
      try { this._brandingEl?.setElementProperty('alpha', 1.0); } catch {}
    } else if (branding !== null) {
      this.setBranding(branding, true);
    }
    this._fadeBrandingWithFg = false;
    this._fading = false;
    this._log('v-fade fertig', 'debug');
  }

  /**
   * Fade-Cut: fg 1→0, hard switch, instant fg→1.
   * Audio cuts at the black point.
   */
  async fadeCutTo(targetPad, durationMs, branding = null) {
    if (!this.fg) { this.switchTo(targetPad); if (branding !== null) this.setBranding(branding); return; }
    if (this._fading) { this._switchIsel(targetPad); this._setAlpha(1.0); if (branding !== null) this.setBranding(branding); return; }
    this._fading = true;
    this._log(`fade-cut → ${LABELS[targetPad]??targetPad} (${durationMs}ms)`);

    await this._animateAlpha(1.0, 0.0, durationMs);
    this._switchIsel(targetPad);
    if (branding !== null) this._loadBrandingInvisible(branding);
    this._setAlpha(1.0);
    this.emit('switched', { pad: targetPad, label: LABELS[targetPad] });
    if (branding !== null) { this._currentBranding = branding; this._log(`Branding: ${branding}`); }

    this._fading = false;
    this._log('fade-cut fertig', 'debug');
  }

  /**
   * Cut-Fade: hard switch + audio cut at alpha=0, fg 0→1.
   */
  async cutFadeTo(targetPad, durationMs, branding = null) {
    if (!this.fg) { this.switchTo(targetPad); if (branding !== null) this.setBranding(branding); return; }
    if (this._fading) { this._switchIsel(targetPad); this._setAlpha(1.0); if (branding !== null) this.setBranding(branding); return; }
    this._fading = true;
    this._log(`cut-fade → ${LABELS[targetPad]??targetPad} (${durationMs}ms)`);

    this._setAlpha(0.0);
    this._switchIsel(targetPad);
    if (branding !== null) { this._loadBrandingInvisible(branding); this._currentBranding = branding; }
    this.emit('switched', { pad: targetPad, label: LABELS[targetPad] });

    await this._animateAlpha(0.0, 1.0, durationMs);

    if (branding !== null) { this._log(`Branding: ${branding}`); this.emit('branding', { file: branding }); }
    this._fading = false;
    this._log('cut-fade fertig', 'debug');
  }

  /**
   * X-Fade: incoming fades in over outgoing simultaneously (both visible at once).
   * Video: isel_bg=outgoing (bg.alpha=1), isel=incoming (fg.alpha 0→1).
   * Audio (AudioRouter): outgoing volume 1→0, incoming volume 0→1, same animation loop.
   * Audio (Legacy): hard cut at midpoint.
   * Falls back to vFadeTo if isel_bg/bg not available or pads not xfade-eligible.
   */
  async xFadeTo(targetPad, durationMs, branding = null) {
    if (!this.fg || !this.bg || !this.isel_bg) {
      await this.vFadeTo(targetPad, durationMs, branding); return;
    }
    if (!this._xFadeEligible(this._activePad) || !this._xFadeEligible(targetPad)) {
      await this.vFadeTo(targetPad, durationMs, branding); return;
    }
    if (this._fading) { this._switchIsel(targetPad); this._setAlpha(1.0); if (branding !== null) this.setBranding(branding); return; }
    this._fading = true;

    const fromPad = this._activePad;
    const fromKey = this._padToKey(fromPad);
    const toKey   = this._padToKey(targetPad);
    this._log(`xfade → ${LABELS[targetPad]??targetPad} (${durationMs}ms)`);

    // Hold outgoing source in background layer (visible)
    try { this.isel_bg.setPad('active-pad', `sink_${fromPad}`); } catch {}
    try { this.bg.setElementProperty('alpha', 1.0); } catch {}

    // Switch foreground to incoming (starts invisible).
    // Alpha must be 0 BEFORE the isel switches so the compositor never renders
    // player2 at full alpha during the one-frame gap between the two property sets.
    this._setAlpha(0.0);
    this._switchIselVideoOnly(targetPad);

    // Ensure incoming source starts at 0 volume before fade begins
    if (this.audioGroupConfig && toKey) this._setSourceVolume(toKey, 0.0);

    // Unified animation: video fg 0→1 + audio crossfade simultaneously.
    // _pgmDuckLevel is read per-step (not captured) so ducking changes during
    // xfade are correctly tracked.
    const steps  = Math.max(2, Math.round(durationMs / STEP_MS));
    const startT = Date.now();
    let legacyAudioCut = false;

    for (let i = 1; i <= steps; i++) {
      const targetT = startT + durationMs * i / steps;
      const wait    = targetT - Date.now();
      if (wait > 0) await sleep(wait);
      const t    = Math.min(1, (Date.now() - startT) / durationMs);
      const duck = this._pgmDuckLevel;  // read dynamically each step

      this._setAlpha(t);

      if (this.audioGroupConfig) {
        if (fromKey) this._setSourceVolume(fromKey, (1 - t) * duck);
        if (toKey)   this._setSourceVolume(toKey,   t * duck);
      } else if (!legacyAudioCut && t >= 0.5) {
        this._switchAudio(targetPad);
        legacyAudioCut = true;
      }
    }

    // Clean end state
    this._setAlpha(1.0);
    if (this.audioGroupConfig) {
      if (fromKey) this._setSourceVolume(fromKey, 0.0);
      if (toKey)   this._setSourceVolume(toKey, this._pgmDuckLevel);
    } else if (!legacyAudioCut) {
      this._switchAudio(targetPad);
    }

    // Hide background layer; keep isel_bg mirroring the new on-air pad so the
    // next xfade finds frames already flowing (no cold-switch one-frame black gap).
    try { this.bg.setElementProperty('alpha', 0.0); } catch {}
    try {
      this.isel_bg.setPad('active-pad',
        `sink_${this._xFadeEligible(targetPad) ? targetPad : this.padBlack}`);
    } catch {}

    if (branding !== null) this.setBranding(branding, true);
    this.emit('switched', { pad: targetPad, label: LABELS[targetPad] });
    this._fading = false;
    this._log('xfade fertig', 'debug');
  }

  /** Returns true if padIndex has an isel_bg source (players, smpte, black). */
  _xFadeEligible(padIndex) {
    return padIndex <= this.padBlack;
  }

  // ── Branding ──────────────────────────────────────────────────────────────

  _resolveBrandingPath(file) {
    const brandingDir = this.opts.brandingDir || path.join(process.cwd(), 'channelbranding');
    return path.isAbsolute(file) ? file : path.join(brandingDir, file);
  }

  _loadBrandingInvisible(file) {
    if (!this._brandingEl || !file) return;
    const abs = this._resolveBrandingPath(file);
    if (!fs.existsSync(abs)) return;
    const bW = this.opts.width  || 1920;
    const bH = this.opts.height || 1080;
    try {
      this._brandingEl.setElementProperty('alpha', 0.0);
      this._brandingEl.setElementProperty('location', abs);
      this._brandingEl.setElementProperty('overlay-width',  bW);
      this._brandingEl.setElementProperty('overlay-height', bH);
      this._brandingEl.setElementProperty('offset-x', 0);
      this._brandingEl.setElementProperty('offset-y', 0);
      this._currentBranding = file;
    } catch {}
  }

  setBranding(file, instant = false) {
    this.emit('branding', { file });
    if (!this._brandingEl) { this._currentBranding = file || null; return; }
    if (!file) {
      try { this._brandingEl.setElementProperty('alpha', 0.0); } catch {}
      this._currentBranding = null;
      this._log('Branding: aus');
      return;
    }
    if (file === this._currentBranding && !instant) return;
    const abs = this._resolveBrandingPath(file);
    if (!fs.existsSync(abs)) { this._log(`Branding nicht gefunden: ${abs}`, 'warn'); return; }
    const bW = this.opts.width  || 1920;
    const bH = this.opts.height || 1080;
    try {
      if (file !== this._currentBranding) {
        this._brandingEl.setElementProperty('alpha', 0.0);
        this._brandingEl.setElementProperty('location', abs);
        this._brandingEl.setElementProperty('overlay-width',  bW);
        this._brandingEl.setElementProperty('overlay-height', bH);
        this._brandingEl.setElementProperty('offset-x', 0);
        this._brandingEl.setElementProperty('offset-y', 0);
      }
      this._currentBranding = file;
    } catch(e) { this._log(`Branding-Fehler: ${e.message}`, 'debug'); return; }
    const delay = instant ? 0 : (this._fading ? 0 : 40);
    const targetFile = file;
    setTimeout(() => {
      if (this._currentBranding !== targetFile) return;
      if (this._fading) return;
      try { this._brandingEl.setElementProperty('alpha', 1.0); } catch {}
      this._log(`Branding: ${targetFile}`);
    }, delay);
  }

  toggleBranding(file) {
    if (!file || file === this._currentBranding) this.setBranding(null);
    else this.setBranding(file, true);
  }

  static parseFormat(str) {
    return ({
      '1080p25': { w: 1920, h: 1080, fps: 25 },
      '1080p50': { w: 1920, h: 1080, fps: 50 },
      '1080i50': { w: 1920, h: 1080, fps: 25 },
      '720p50':  { w: 1280, h: 720,  fps: 50 },
      '720p25':  { w: 1280, h: 720,  fps: 25 },
      'UHD25':   { w: 3840, h: 2160, fps: 25 },
    }[str]) || { w: 1920, h: 1080, fps: 25 };
  }

  _parseLevelMsg(msg) {
    const s = msg.structure || msg;
    const srcEl = msg.srcElementName || s.srcElementName || '';
    const name  = s.name || s['structure-name'] || s['element-message'] || '';
    if (name !== 'level' && !srcEl.startsWith('level_')) return;
    const channel = srcEl.replace(/^level_/, '') || 'pgm';
    const toArr = v => v == null ? [] : Array.isArray(v) ? v : [v];
    this.emit('level', { channel, rms: toArr(s.rms ?? null), peak: toArr(s.peak ?? null) });
  }

  async _watchBus() {
    while (this._busLoop && this.pipeline) {
      try {
        const msg = await this.pipeline.busPop(500);
        if (!msg) continue;
        if (msg.type === 'element') { this._parseLevelMsg(msg); continue; }
        if (msg.type === 'error') {
          const txt = msg.errorMessage || msg.message || '';
          if (!txt || /colorimetry|delayed|not\.linked|Internal data stream/i.test(txt)) continue;
          this._log(`⚠ ${msg.srcElementName}: ${txt.slice(0, 100)}`, 'warn');
        }
      } catch { break; }
    }
  }

  get pipelineString() { return this._pipeStr || ''; }
  get running()        { return this._running; }
  get activePad()      { return this._activePad; }

  setVoVolume(v, slotId = 'vo1') {
    const vol      = Math.max(0, Math.min(2, v));
    this._voCurrentVol[slotId] = vol;
    const els      = this._voVols[slotId] || {};
    const overrides = this._voGroupOverrides[slotId] || {};
    for (const [id, el] of Object.entries(els)) {
      const effective = overrides.hasOwnProperty(id)
        ? Math.max(0, Math.min(2, overrides[id])) : vol;
      try { el.setElementProperty('volume', effective); }
      catch(e) { this._log(`setVoVolume ${slotId}/${id}: ${e.message}`, 'warn'); }
    }
  }

  setVoGroupOverrides(overrides, slotId = 'vo1') {
    this._voGroupOverrides[slotId] = overrides || {};
    this.setVoVolume(this._voCurrentVol[slotId] ?? 0, slotId);
  }

  setVoiceoverGain(_gain) {}

  setVoiceoverPgmGain(gain, fadeMs = 0) {
    const target = Math.max(0, Math.min(2, gain));
    if (this._pgmDuckFadeTimer) { clearInterval(this._pgmDuckFadeTimer); this._pgmDuckFadeTimer = null; }
    if (this._duckFadeTimer)    { clearInterval(this._duckFadeTimer);    this._duckFadeTimer = null; }

    if (this.audioGroupConfig && Object.keys(this._audioGroupProgVols).length > 0) {
      if (!fadeMs || fadeMs <= 0) {
        this._pgmDuckLevel = target;
        this._applyDuckToSources();
        return;
      }
      const start = this._pgmDuckLevel;
      const steps  = Math.max(1, Math.round(fadeMs / 50));
      const stepMs = fadeMs / steps;
      const delta  = (target - start) / steps;
      let step = 0;
      this._pgmDuckLevel = Math.max(0, Math.min(2, start + delta));
      this._applyDuckToSources();
      step++;
      this._pgmDuckFadeTimer = setInterval(() => {
        step++;
        this._pgmDuckLevel = Math.max(0, Math.min(2, this._pgmDuckLevel + delta));
        this._applyDuckToSources();
        if (step >= steps) { clearInterval(this._pgmDuckFadeTimer); this._pgmDuckFadeTimer = null; }
      }, stepMs);
    } else {
      if (!fadeMs || fadeMs <= 0) {
        for (const [gid, el] of Object.entries(this._duckEls || {})) {
          try { el.setElementProperty('volume', target); }
          catch(e) { this._log(`Duck ${gid}: ${e.message}`, 'warn'); }
        }
        return;
      }
      const firstEl = Object.values(this._duckEls || {})[0];
      let cur = firstEl ? (firstEl.getElementProperty('volume')?.value ?? 1.0) : 1.0;
      const steps  = Math.max(1, Math.round(fadeMs / 50));
      const stepMs = fadeMs / steps;
      const delta  = (target - cur) / steps;
      let step = 0;
      this._duckFadeTimer = setInterval(() => {
        step++;
        cur = Math.max(0, Math.min(2, cur + delta));
        for (const [gid, el] of Object.entries(this._duckEls || {})) {
          try { el.setElementProperty('volume', cur); }
          catch(e) { this._log(`Duck ${gid}: ${e.message}`, 'warn'); }
        }
        if (step >= steps) { clearInterval(this._duckFadeTimer); this._duckFadeTimer = null; }
      }, stepMs);
    }
  }

  _applyDuckToSources() {
    this._setAllSourceVolumes(this._padToKey(this._activePad));
  }
}

MasterPipeline.LABELS = LABELS;
module.exports = MasterPipeline;
