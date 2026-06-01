'use strict';
/**
 * VoiceoverEngine.js
 *
 * ARCHITEKTUR — Pump-Pipeline (einmal gestartet, nie gestoppt):
 *
 *   Pump-Pipeline (startup, bleibt in PLAYING):
 *     appsrc name=vo_pump is-live=true format=time do-timestamp=true
 *     ! tee ! interaudiosink channel=slotId_groupId (eine pro Gruppe)
 *
 *   Decode: ffmpeg dekodiert außerhalb von GStreamer → F32LE 48kHz Stereo PCM.
 *   Push: _silencePump läuft immer bei 20ms-Takt:
 *         Wenn kein VO aktiv (_isStreaming=false): Stille schieben (Pump bleibt aktiv,
 *           interaudio-Surface frisch, audiomixer im Master stalls nicht).
 *         Wenn VO aktiv (_isStreaming=true): _streamFfmpeg übernimmt den Push-Takt.
 *
 *   Kritisch: appsrc mit is-live=true stellt keine Daten wenn nix pushed → GStreamer-
 *   Stall des Pump-Elements → Master-audiomixer VO-Pad stall → zufällige Gruppe bricht.
 *   Silence-Heartbeat verhindert das.
 */

const EventEmitter = require('events');
const path         = require('path');
const { spawn }    = require('child_process');
const { Pipeline } = require('gst-kit');

const RATE        = 48000;
const CHANNELS    = 2;
const CHUNK_SAMP  = 960;                                // 20ms bei 48kHz
const CHUNK_BYTES = CHUNK_SAMP * CHANNELS * 4;         // F32LE
const SILENCE_BUF = Buffer.alloc(CHUNK_BYTES, 0);      // reused, never mutated
const LOOK_AHEAD  = 5;                                  // chunks pre-buffered ahead of real-time

class VoiceoverEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._slotId    = opts.slotId    || 'vo1';
    this._groupIds  = opts.groupIds  || ['pgm-stereo'];
    this._fadeInMs  = opts.fadeInMs  ?? 500;
    this._fadeOutMs = opts.fadeOutMs ?? 1000;
    this._presets   = opts.presets   || VoiceoverEngine.defaultPresets();
    this._log       = opts.log || ((msg, lvl) => console.log(`[voiceover/${lvl||'info'}] ${msg}`));

    this._pumpPipeline  = null;
    this._pumpSrc       = null;
    this._fadeTimer     = null;
    this._stopTimer     = null;
    this._silenceTimer  = null;
    this._isStreaming   = false;
    this._curVoVol      = 0;
    this._streamSession = 0;
    // Preload state — ffmpeg started early to eliminate startup jitter
    this._preloadFile   = null;   // path of file being pre-decoded
    this._preloadQueue  = [];     // buffered chunks ready to use
    this._preloadDone   = false;  // ffmpeg finished decoding into buffer
    this._preloadProc   = null;   // ffmpeg process

    this._initPump();
  }

  static defaultPresets() {
    const no51 = { 'pgm-51': 0.0 };
    return {
      'AP100': { label: 'Voiceover 100 % (Volleinblendung)', voGain: 1.0, pgmGain: 0.0,  pgmFadeInMs: 0, groupVoGain: no51 },
      'AP75':  { label: 'Voiceover 75 % / Programm 25 %',   voGain: 1.0, pgmGain: 0.25, pgmFadeInMs: 0, groupVoGain: no51 },
      'AP50':  { label: 'Mix 50/50',                         voGain: 1.0, pgmGain: 0.5,  pgmFadeInMs: 0, groupVoGain: no51 },
      'AP25':  { label: 'Voiceover 25 % / Programm 75 %',   voGain: 0.5, pgmGain: 1.0,  pgmFadeInMs: 0, groupVoGain: no51 },
      'ST':    { label: 'Stereo-Mix (kein Ducking)',         voGain: 1.0, pgmGain: 1.0  },
      'ST-ALL':{ label: 'Stereo-Mix alle Gruppen',           voGain: 1.0, pgmGain: 1.0  },
    };
  }

  // ── Pump-Pipeline ──────────────────────────────────────────────────────────────

  _initPump() {
    const groups  = this._groupIds.length ? this._groupIds : ['pgm-stereo'];
    const vcaps   = `audio/x-raw,format=F32LE,rate=${RATE},channels=${CHANNELS},layout=interleaved`;
    const sinks   = groups.map(gid =>
      `vot. ! interaudiosink channel=${this._slotId}_${gid} sync=false async=false`
    ).join(' ');
    const pipeStr = [
      `appsrc name=vo_pump format=time is-live=true do-timestamp=true max-bytes=0`,
      `  caps="${vcaps}"`,
      `! tee name=vot`,
      sinks,
    ].join(' ');

    try {
      this._pumpPipeline = new Pipeline(pipeStr);
      this._pumpPipeline.play().then(() => {
        this._pumpSrc = this._pumpPipeline.getElementByName?.('vo_pump');
        if (this._pumpSrc) {
          this._log(`Pump bereit ✓ (slot=${this._slotId})`, 'info');
          this._startSilencePump();
        } else {
          this._log('WARN: vo_pump appsrc nicht gefunden', 'warn');
        }
      }).catch(e => this._log(`Pump play() Fehler: ${e.message}`, 'warn'));
    } catch (e) {
      this._log(`Pump-Pipeline Fehler: ${e.message}`, 'warn');
    }
  }

  /**
   * Silence heartbeat: pushes 20ms silence chunks to appsrc while VO is idle.
   * Prevents GStreamer appsrc from entering "need-data" stall state, which would
   * cascade to stall the mixName audiomixer VO pads in the master pipeline,
   * randomly breaking one or more audio groups on startup or between VO events.
   */
  _clearRingBuffer() {
    if (!this._pumpSrc) return;
    // Push silence in 5 gradual steps (100ms total) to overwrite any queued VO audio.
    // Pushing all chunks at once causes a timestamp burst that can trigger a SEGMENT
    // event in the audiomixer, causing it to replay buffered program audio briefly.
    let i = 0;
    const step = () => {
      if (i >= 5 || this._isStreaming) return;
      try { this._pumpSrc.push(SILENCE_BUF); } catch {}
      i++;
      if (i < 5) setImmediate(step);
    };
    step();
  }

  _startSilencePump() {
    if (this._silenceTimer) return;
    this._silenceTimer = setInterval(() => {
      if (this._isStreaming) return;  // _streamFfmpeg is pushing — don't interfere
      try { this._pumpSrc?.push(SILENCE_BUF); } catch {}
    }, 20);
  }

  // ── Starten ───────────────────────────────────────────────────────────────────

  async play(opts = {}) {
    await this.stop(true, true);

    const filePath = opts.filePath;
    if (!filePath) throw new Error('VoiceoverEngine.play: filePath fehlt');

    if (!this._pumpSrc) {
      this._log('WARN: Pump nicht bereit — abgebrochen', 'warn');
      this.emit('stopped');
      return;
    }

    const preset      = this._presets[opts.preset] || this._presets['ST'] || { voGain: 1.0, pgmGain: 1.0 };
    const fadeInMs    = opts.fadeInMs  ?? this._fadeInMs;
    const fadeOutMs   = opts.fadeOutMs ?? this._fadeOutMs;
    if (opts.fadeOutMs != null) this._fadeOutMs = fadeOutMs;
    const durationMs  = opts.durationMs ?? null;
    const session     = ++this._streamSession;
    const voGain      = preset.voGain ?? 1.0;

    this._log(`Voiceover start: ${path.basename(filePath)} preset=${opts.preset||'ST'} fadeIn=${fadeInMs}ms fadeOut=${fadeOutMs}ms`, 'info');

    // Apply PCM fade-in gain immediately when audio starts — sample-accurate.
    // GStreamer volume-element approach (setInterval + setElementProperty) is unreliable
    // due to Node.js event-loop jitter. PCM scaling is zero-latency and deterministic.
    this._voFadeInSamples  = Math.max(0, Math.round(fadeInMs  * RATE / 1000));
    this._voFadeOutSamples = Math.max(0, Math.round(fadeOutMs * RATE / 1000));
    this._voGainTarget     = voGain;
    this._voPcmSampleCount = 0;   // reset sample counter for fade calculation
    this._voDurationSamples = durationMs != null
      ? Math.round(durationMs * RATE / 1000) : null;

    // Ensure VO volume element is at target gain so audio can flow through.
    // Never set it to 0 at stop — silence × any_gain = silence, and setting to 0
    // causes a GStreamer DISCONT/SEGMENT that makes the audiomixer replay its buffer.
    if (this._curVoVol !== voGain) this._setVoVol(voGain);

    const pgmFadeInMs = preset.pgmFadeInMs ?? fadeInMs;
    this.emit('pgm-gain', preset.pgmGain, pgmFadeInMs);
    this.emit('group-vo-gain', preset.groupVoGain || null);
    this.emit('playing', { slotId: this._slotId, filePath, preset: opts.preset || 'ST' });

    if (durationMs != null && durationMs > 0) {
      // Compensate for LOOK_AHEAD pre-buffering: push is 100ms ahead of real-time,
      // so stop() must fire 100ms early to avoid a 100ms tail after durationMs.
      const lookAheadMs = Math.round(LOOK_AHEAD * CHUNK_SAMP / RATE * 1000); // 5*960/48000*1000 = 100ms
      const stopAt = Math.max(0, durationMs - fadeOutMs - lookAheadMs);
      this._stopTimer = setTimeout(() => this.stop(), stopAt);
    }

    this._streamFfmpeg(filePath, session).catch(e =>
      this._log(`Stream-Fehler: ${e.message}`, 'warn')
    );
  }

  /**
   * Pre-decode a VO file into an in-memory queue so play() has zero startup latency.
   * Call this when the VO is scheduled but hasn't started yet (e.g. delay > 200ms).
   * Only the first N seconds are buffered; the rest is decoded on demand during play().
   */
  preload(filePath) {
    if (this._preloadFile === filePath && !this._preloadDone) return; // already in progress
    this._cancelPreload();

    this._preloadFile  = filePath;
    this._preloadQueue = [];
    this._preloadDone  = false;

    const MAX_PREBUF_SECS = 5;
    const MAX_CHUNKS = Math.ceil(MAX_PREBUF_SECS * RATE / CHUNK_SAMP);
    let remainder = Buffer.alloc(0);

    const proc = spawn('ffmpeg', [
      '-i', filePath,
      '-f', 'f32le', '-ar', String(RATE), '-ac', String(CHANNELS),
      'pipe:1',
      '-loglevel', 'error',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    this._preloadProc = proc;

    proc.stdout.on('data', raw => {
      if (this._preloadQueue.length >= MAX_CHUNKS) { proc.kill('SIGKILL'); return; }
      const combined = Buffer.concat([remainder, raw]);
      let offset = 0;
      while (offset + CHUNK_BYTES <= combined.length && this._preloadQueue.length < MAX_CHUNKS) {
        this._preloadQueue.push(Buffer.from(combined.subarray(offset, offset + CHUNK_BYTES)));
        offset += CHUNK_BYTES;
      }
      remainder = combined.subarray(offset);
    });
    proc.on('close', () => {
      if (remainder.length > 0 && this._preloadQueue.length < MAX_CHUNKS) {
        const padded = Buffer.concat([remainder, Buffer.alloc(CHUNK_BYTES - remainder.length)]);
        this._preloadQueue.push(padded);
      }
      this._preloadDone = true;
      this._preloadProc = null;
    });
    proc.on('error', () => { this._preloadDone = true; this._preloadProc = null; });
  }

  _cancelPreload() {
    if (this._preloadProc) { try { this._preloadProc.kill('SIGKILL'); } catch {} this._preloadProc = null; }
    this._preloadFile  = null;
    this._preloadQueue = [];
    this._preloadDone  = false;
  }

  // ── Streaming-Dekodierung (ffmpeg → Pump-appsrc, rate-limited) ──────────────

  async _streamFfmpeg(filePath, session) {
    let pushCount = 0;
    const startMs = Date.now();

    this._isStreaming = true;

    // Only use preload when it is FULLY COMPLETE.
    // Partial preload + new ffmpeg from pos 0 causes the first N seconds to play twice
    // (preload chunks first, then new ffmpeg also starts from the beginning).
    const usePreload = this._preloadFile === filePath
                    && this._preloadDone
                    && this._preloadQueue.length > 0;
    const queue = usePreload ? this._preloadQueue.splice(0) : [];
    let ffmpegDone = usePreload;  // complete preload = all data already in queue
    if (usePreload) this._cancelPreload();

    let proc = null;
    let remainder = Buffer.alloc(0);

    if (!ffmpegDone) {
      // Either no preload or preload incomplete — spawn/continue ffmpeg
      proc = spawn('ffmpeg', [
        '-i', filePath,
        '-f', 'f32le', '-ar', String(RATE), '-ac', String(CHANNELS),
        'pipe:1',
        '-loglevel', 'error',
      ], { stdio: ['ignore', 'pipe', 'ignore'] });

      proc.stdout.on('data', raw => {
        if (this._streamSession !== session) { proc.kill('SIGKILL'); return; }
        const combined = Buffer.concat([remainder, raw]);
        let offset = 0;
        while (offset + CHUNK_BYTES <= combined.length) {
          queue.push(Buffer.from(combined.subarray(offset, offset + CHUNK_BYTES)));
          offset += CHUNK_BYTES;
        }
        remainder = combined.subarray(offset);
      });
      proc.on('close', () => {
        ffmpegDone = true;
        if (remainder.length > 0 && this._streamSession === session) {
          const padded = Buffer.concat([remainder, Buffer.alloc(CHUNK_BYTES - remainder.length)]);
          queue.push(padded);
          remainder = Buffer.alloc(0);
        }
      });
      proc.on('error', e => { ffmpegDone = true; this._log(`ffmpeg: ${e.message}`, 'warn'); });
    }

    while (this._streamSession === session) {
      if (queue.length > 0) {
        const elapsed  = Date.now() - startMs;
        const expected = elapsed / (CHUNK_BYTES / (RATE * CHANNELS * 4) * 1000);
        if (pushCount > expected + LOOK_AHEAD) {
          await new Promise(r => setTimeout(r, 20));
          continue;
        }
        const rawChunk = queue.shift();
        const chunk = this._applyPcmFade(rawChunk);
        try { this._pumpSrc?.push(chunk); } catch {}
        pushCount++;
      } else if (ffmpegDone) {
        this._isStreaming = false;
        this._log('Voiceover EOS', 'info');
        this.emit('pgm-gain', 1.0, this._fadeOutMs);
        // PCM fade-out handles the audio ramp when duration was known.
        // For unknown-duration streams, fall back to GStreamer volume fade.
        if (this._voDurationSamples == null && this._voFadeOutSamples > 0) {
          // Duration was not known upfront — apply fade-out by pushing faded silence chunks.
          // GStreamer _fadeVolume is unreliable; PCM on silence gives same result.
          const numChunks = Math.ceil(this._voFadeOutSamples / CHUNK_SAMP) + 1;
          this._voDurationSamples = (this._voPcmSampleCount || 0) + this._voFadeOutSamples;
          for (let i = 0; i < numChunks; i++) {
            if (this._streamSession !== session) break;
            const faded = this._applyPcmFade(SILENCE_BUF);
            try { this._pumpSrc?.push(faded); } catch {}
          }
        }
        // No _setVoVol(0): silence pump takes over, no GStreamer element transition needed.
        this._log('Voiceover gestoppt', 'info');
        this.emit('stopped');
        return;
      } else {
        await new Promise(r => setTimeout(r, 10));
      }
    }

    // Session cancelled by stop()
    this._isStreaming = false;
    if (proc) try { proc.kill('SIGKILL'); } catch {}
  }

  // ── Stoppen ───────────────────────────────────────────────────────────────────

  async stop(immediate = false, suppressPgmRestore = false) {
    if (this._stopTimer) { clearTimeout(this._stopTimer); this._stopTimer = null; }
    // CRITICAL: clear _fadeTimer before anything else. If a _fadeVolume fade is in
    // progress (e.g. natural EOS fadeOut started, then stop() is called immediately
    // from _cancelVoiceover), the fade's closure holds its own local `cur` variable
    // and keeps calling _setVoVol(cur) with positive values on every tick — re-raising
    // the VO volume above 0 after we set it to 0 here, causing audible bleed on every
    // subsequent event until the original fade completes (~fadeOutMs later).
    if (this._fadeTimer) { clearInterval(this._fadeTimer); this._fadeTimer = null; }

    const fadeOutMs = immediate ? 0 : this._fadeOutMs;

    if (!immediate && fadeOutMs > 0 && this._isStreaming) {
      // PCM fade-out: set _voDurationSamples so _applyPcmFade starts ramping down.
      // Stream stays alive for fadeOutSamples more samples, then the _stopTimer fires.
      const fadeOutSamples  = Math.round(fadeOutMs * RATE / 1000);
      const lookAheadSamp   = LOOK_AHEAD * CHUNK_SAMP;  // 5 * 960 = 4800 samples (100ms)
      // _voPcmSampleCount is LOOK_AHEAD ahead of real playback position.
      // Subtract lookAheadSamp so the fade starts at the actual real-time position.
      this._voDurationSamples = Math.max(
        this._voPcmSampleCount || 0,
        (this._voPcmSampleCount || 0) + fadeOutSamples - lookAheadSamp
      );
      this._voFadeOutSamples  = fadeOutSamples;
      if (!suppressPgmRestore) this.emit('pgm-gain', 1.0, fadeOutMs);
      // Cancel stream after fade-out completes
      if (this._stopTimer) clearTimeout(this._stopTimer);
      this._stopTimer = setTimeout(() => {
        this._stopTimer = null;
        this._streamSession++;
        // Do NOT call _setVoVol(0): silence pump takes over (silence × gain = silence),
        // and setting the GStreamer volume element to 0 causes a DISCONT that makes the
        // audiomixer replay its ~250ms buffer — the "heard twice" artifact.
        if (!suppressPgmRestore) this.emit('group-vo-gain', null);
        this._log('Voiceover gestoppt (fade-out)', 'info');
        this.emit('stopped');
      }, fadeOutMs + 60);
      return;
    }

    this._streamSession++;
    this._clearRingBuffer();

    if (!suppressPgmRestore) this.emit('pgm-gain', 1.0, 0);
    // No _setVoVol(0): setting GStreamer volume to 0 causes audiomixer DISCONT → buffer replay.
    // Silence pump provides silence (0 × voGain = 0) without any element transition.
    if (!suppressPgmRestore) this.emit('group-vo-gain', null);
    this._log('Voiceover gestoppt', 'info');
    this.emit('stopped');
  }

  // ── Lautstärke ────────────────────────────────────────────────────────────────

  /**
   * Applies PCM fade envelope to a chunk buffer (F32LE stereo).
   * Handles fade-in at start, fade-out near end (if duration known).
   * Mutates and returns a copy — original is never modified.
   */
  _applyPcmFade(chunk) {
    const fadeIn    = this._voFadeInSamples  || 0;
    const fadeOut   = this._voFadeOutSamples || 0;
    const durSamp   = this._voDurationSamples;  // null = unknown
    const target    = this._voGainTarget ?? 1.0;
    const offset    = this._voPcmSampleCount || 0;

    // Fast path: no fade needed (both 0) AND at steady gain
    const needsFadeIn  = fadeIn  > 0 && offset < fadeIn;
    const needsFadeOut = fadeOut > 0 && durSamp != null && (offset + CHUNK_SAMP) > (durSamp - fadeOut);
    if (!needsFadeIn && !needsFadeOut) {
      this._voPcmSampleCount = offset + CHUNK_SAMP;
      // Apply target gain if not 1.0
      if (Math.abs(target - 1.0) < 0.001) return chunk;
      const out = Buffer.from(chunk);
      for (let i = 0; i < CHUNK_SAMP * CHANNELS; i++) {
        out.writeFloatLE(chunk.readFloatLE(i * 4) * target, i * 4);
      }
      return out;
    }

    const out = Buffer.from(chunk);
    for (let s = 0; s < CHUNK_SAMP; s++) {
      const absS = offset + s;
      let gain = target;
      // Fade-in ramp
      if (fadeIn > 0 && absS < fadeIn) {
        gain = target * (absS / fadeIn);
      }
      // Fade-out ramp (overrides fade-in if they overlap at end)
      if (fadeOut > 0 && durSamp != null) {
        const fadeOutStart = durSamp - fadeOut;
        if (absS >= fadeOutStart) {
          gain = target * Math.max(0, (durSamp - absS) / fadeOut);
        }
      }
      const bytePos = s * CHANNELS * 4;
      for (let c = 0; c < CHANNELS; c++) {
        const p = bytePos + c * 4;
        out.writeFloatLE(chunk.readFloatLE(p) * gain, p);
      }
    }
    this._voPcmSampleCount = offset + CHUNK_SAMP;
    return out;
  }

  _setVoVol(v) {
    const vol = Math.max(0, Math.min(2, isFinite(v) ? v : 0));
    this._curVoVol = vol;
    this.emit('vo-gain', vol);
  }

  _fadeVolume(fromVol, toVol, durationMs, onDone) {
    if (this._fadeTimer) { clearInterval(this._fadeTimer); this._fadeTimer = null; }
    const safeTo = isFinite(toVol) ? toVol : 0;
    if (!durationMs || durationMs <= 0) { this._setVoVol(safeTo); if (onDone) onDone(); return; }
    const safeStart = fromVol ?? this._curVoVol;
    const steps  = Math.max(1, Math.round(durationMs / 50));
    const stepMs = durationMs / steps;
    const delta  = (safeTo - (isFinite(safeStart) ? safeStart : 0)) / steps;
    let cur = isFinite(safeStart) ? safeStart : 0, step = 0;
    this._fadeTimer = setInterval(() => {
      step++;
      cur = Math.max(0, Math.min(2, cur + delta));
      this._setVoVol(cur);
      if (step >= steps) { clearInterval(this._fadeTimer); this._fadeTimer = null; if (onDone) onDone(); }
    }, stepMs);
  }

  updateConfig(opts) {
    if (opts.fadeInMs  != null) this._fadeInMs  = opts.fadeInMs;
    if (opts.fadeOutMs != null) this._fadeOutMs = opts.fadeOutMs;
    if (opts.presets   != null) this._presets   = opts.presets;
    if (opts.groupIds  != null) this._groupIds  = opts.groupIds;
  }
}

module.exports = VoiceoverEngine;
