/**
 * PlaylistEngine.js — 24/7 Broadcast Automation
 * ═══════════════════════════════════════════════
 *
 * Fix-Start: Sofort bei start()/jump() werden für ALLE startType=fixtime Events
 * parallele Wall-Clock-Timer registriert. Diese feuern UNABHÄNGIG vom Sequenz-Timer.
 * Garantierte ms-Genauigkeit. Kein Polling, kein Interrupt-Check.
 *
 * Event-States: pending → playing → done | skipped
 * File-Resolution: mit oder ohne Extension (.mxf .mp4 .mov .ts .mts)
 * Idle-Source: nach Playlist-Ende → opts.idleSource ('smpte'|'black')
 * Loop: opts.loop=true → Playlist wiederholen
 */

'use strict';
const { EventEmitter } = require('events');
const { toTC, fromTC } = require('./Timecode');
const path = require('path');
const fs   = require('fs');

const PRE_CUE_MS   = 5000;
const GRACE_MS     = 30000;    // 30s Grace-Fenster: innerhalb 30s sofort feuern (als 50ms interrupt), danach morgen
const VIDEO_EXTS   = ['.mxf','.mp4','.mov','.ts','.mts'];

// Safely parse fps strings like "25", "25/1", "30000/1001" without eval().
function _parseFps(str) {
  if (typeof str === 'number') return str > 0 ? str : null;
  const m = String(str).trim().match(/^(\d+)(?:\/(\d+))?$/);
  if (!m) return null;
  const v = parseInt(m[1]) / (parseInt(m[2]) || 1);
  return v > 0 ? v : null;
}
const IMAGE_EXTS   = ['.jpg','.jpeg','.png','.webp'];
const FALLBACK_DUR  = 10800;    // 3h Fallback (wenn queryDuration wirklich nichts liefert)
const MAX_SANE_DUR  = 3600;     // 1h Cap: queryDuration-Wert über 1h → Datei-Container-Bug ignorieren

// ── Datei-Auflösung ──────────────────────────────────────────────────────────
function resolveFile(file, mediaDir, isImage = false) {
  if (!file) return null;
  const try_ = p => { try { return fs.existsSync(p) ? p : null; } catch { return null; } };
  const hasExt = /\.[a-zA-Z0-9]{2,5}$/.test(file);
  const exts = isImage ? IMAGE_EXTS : VIDEO_EXTS;

  if (path.isAbsolute(file)) {
    return hasExt ? try_(file) : exts.map(e => try_(file+e)).find(Boolean) || null;
  }

  // Suchpfade: imagesDir hat Priorität bei Bildern, dann mediaDir
  const searchDirs = [];
  if (mediaDir) {
    if (isImage) {
      // Bilder: erst images/ Unterordner, dann channelbranding/, dann mediaDir direkt
      searchDirs.push(
        path.join(mediaDir, '..', 'images'),
        path.join(mediaDir, '..', 'channelbranding'),
        mediaDir,
      );
    } else {
      searchDirs.push(mediaDir);
    }
  }

  for (const dir of searchDirs) {
    const a = path.join(dir, file);
    const found = hasExt ? try_(a) : exts.map(e => try_(a+e)).find(Boolean) || null;
    if (found) return found;
  }
  return null;
}

// ── Wall-Clock ───────────────────────────────────────────────────────────────
function msUntilWallClock(str, fps = 25) {
  if (!str || typeof str !== 'string') return null;
  const p = str.trim().split(':').map(Number);
  if (p.length < 2 || p.some(isNaN)) return null;
  const [hh=0,mm=0,ss=0,ff=0] = p;
  const frameMs = Math.round(ff / fps * 1000);
  const now = Date.now();
  const d   = new Date();
  const t   = new Date(d.getFullYear(),d.getMonth(),d.getDate(),hh,mm,ss,frameMs).getTime();
  const diff = t - now;
  if (diff >= 0)         return diff;
  if (diff >= -GRACE_MS) return 0;
  return t + 86400000 - now;
}

// ══════════════════════════════════════════════════════════════════════════════
class PlaylistEngine extends EventEmitter {

  constructor(master, players, transition, opts = {}) {
    super();
    this.setMaxListeners(50);
    this.master     = master;
    this.players    = players;
    this.transition = transition;
    this.opts       = opts;

    this.playlist     = [];
    this.currentIndex = -1;
    this._running     = false;
    this._paused      = false;
    this._onAirSlot      = null;
    this._onAirLiveSlot  = null;  // aktuell on-air befindlicher Live-Slot (live1/live2/…)
    this._cueQueue       = {};

    this._fixTimers  = new Map();
    this._mainTimer  = null;
    this._prTimer    = null;
    this._eosCheck   = null;
    this._precTimers = [];
    this._childCleanup = null;       // Cleanup-Fn für aktive Grafik-Child-Events
    this._blockChildCleanup = null;  // Cleanup-Fn für Block-Span-Grafiken (block_start → block_end)
    this._gapEvent   = null;         // gesetzt während Fixtime-Gap wartet: { idx, event }
    this._gapLoopCleanup = null;     // EOS-Listener des Gap-Clips entfernen
    this._preChildCleanups = new Map();  // slot → cleanup-fn für negative-delay Children aus _doCue
    this._swappedSlots = new Set();     // Slots die via swapOnAirVariant gewechselt wurden — EOM dieser Slots ignorieren
    this._execGeneration = 0;           // Incremented by jumpInterrupt to abort stale _executeEvent calls

    // GrafixEngine (optional — wird via opts.grafixEngine übergeben)
    this.grafixEngine = opts.grafixEngine || null;

    // VoiceoverEngine (optional)
    this.voiceoverEngine = opts.voiceoverEngine || null;

    // RecordEngine (optional)
    this.recordEngine = opts.recordEngine || null;
    this._recordCleanup = null;  // Cleanup-Fn für aktive Record-Child-Events

    // ChannelBus (optional) — Cross-Channel/Cross-Host Trigger (siehe ChannelBus.js)
    this.channelBus = opts.channelBus || null;
    this._triggerCleanup = null;  // Cleanup-Fn für aktive Trigger-Child-Events
    if (this.channelBus) this.channelBus.on('message', m => this._onRemoteMessage(m));

    // Dynamische Live-Quellen (gespiegelt von MasterPipeline._liveSources)
    this._liveSources = opts.liveSources || [];
    // Konfigurierbarer Player-Slot-Array (player1, player2, ..., playerN)
    this._slotIds = opts.slotIds || ['player1', 'player2'];
    // Backup-Player
    this._backupSlot      = opts.backupSlot      || null;  // z.B. 'player3'
    this._backupMediaDirs = opts.backupMediaDirs  || [];   // Fallback-Verzeichnisse
    this._backupActive    = false;    // läuft gerade der Backup on-air?
    this._backupCleanup   = null;    // Error-Listener cleanup fn

    for (const [id, p] of Object.entries(this.players)) {
      p.on('eom', (d) => this.emit('eom', id, d || {}));
      // EOS (GStreamer End-of-Stream) → wie EOM behandeln wenn kein EOM definiert
      p.on('eos', (d) => {
        const item = p._item;
        if (!item?.eom) this.emit('eom', id, d || {});  // kein EOM gesetzt → EOS ist Ende
      });
      p.on('position', (d) => this.emit('player-position', { slotId: id, ...d }));
    }
  }

  get fps()     { return this.opts.fps || 25; }
  get _N()       { return this._slotIds.length; }
  get idlePad()  {
    const src = this.opts.idleSource || (this.opts.idleImagePath ? 'image' : 'smpte');
    if (src === 'black') return this._N + 1;
    if (src === 'image') return this._N + 2;
    return this._N;  // smpte default
  }
  get gapPad()   {
    const src = this.opts.gapSource || 'black';
    if (src === 'smpte')  return this._N;
    if (src === 'black')  return this._N + 1;
    if (src === 'image')  return this._N + 2;
    if (src === 'idle')   return this.idlePad;
    if (src === 'clip')   return this._N + 4; // playerIdle pad
    return this._N + 1;
  }
  get paused()  { return this._paused; }
  get running() { return this._running; }

  _log(msg, level='info') { this.emit('log', { level, msg: `[playlist] ${msg}` }); }

  // ── API ────────────────────────────────────────────────────────────────────

  async start(fromIndex = 0) {
    this._stopAll();
    this._running = true; this._paused = false;
    this.currentIndex = fromIndex - 1;
    this._log(`▶ START ab Event ${fromIndex+1}/${this.playlist.length}`);
    this._markRange(fromIndex, this.playlist.length, 'pending');
    const firstSlot = await this._earlyPreCue(fromIndex);
    this._armFixTimers(fromIndex);
    this._advance(firstSlot);
  }

  /**
   * Cue-First Start: pre-cues the target event before stopping current output.
   * Prevents the idle frame flash that occurs when stop() switches to idle pad
   * before the new clip is ready. Only interrupts current output once cued.
   */
  async startCueFirst(fromIndex = 0) {
    const prevOnAirSlot = this._onAirSlot;
    let precuedSlot = null;
    let smoothTransition = false;   // true = keep on-air alive, let _executeEvent transition

    const firstPlayerEv = this.playlist.slice(fromIndex).find(ev => this._isPlayer(ev));
    if (firstPlayerEv) {
      const targetIdx = this.playlist.indexOf(firstPlayerEv, fromIndex);
      const slot = this._slotFor(targetIdx);
      if (slot !== prevOnAirSlot) {
        precuedSlot = slot;
        // leadMs=0: dieses Event geht gleich direkt on-air (kein PRE_CUE_MS-Vorlauf).
        try { await this._doCue(firstPlayerEv, slot, undefined, undefined, undefined, 0); } catch { precuedSlot = null; }
        if (precuedSlot && !this.players[precuedSlot]?.cued) precuedSlot = null;
        if (precuedSlot) smoothTransition = true;
      }
    }

    if (smoothTransition) {
      // Pre-cue succeeded on the free slot — keep current on-air output alive so
      // _executeEvent can apply the configured transition (v-fade, xfade, …) FROM it.
      // Only stop slots that are neither on-air nor target.
      this._clearEventTimers();
      for (const [,h] of this._fixTimers) clearTimeout(h);
      this._fixTimers.clear();
      this._cancelChildEvents(precuedSlot);
      for (const [id, p] of Object.entries(this.players)) {
        if (id === prevOnAirSlot || id === precuedSlot) continue;
        try { p.stop(); } catch {}
      }
      for (const p of Object.values(this.players)) try { p.stopPositionPoll?.(); } catch {}
    } else {
      // Fallback (same slot or pre-cue failed): original cut-through-black path.
      if (precuedSlot) {
        try {
          if (this.master?.padBlack !== undefined) this.master.switchTo(this.master.padBlack);
          await this.players[precuedSlot].go();
          await new Promise(r => setTimeout(r, Math.round(4000 / this.fps)));
          this.master?.switchTo(this._padFor(precuedSlot));
        } catch (e) {
          this._log(`startCueFirst go/switch: ${e.message}`, 'warn');
          precuedSlot = null;
        }
      }
      if (!precuedSlot && firstPlayerEv == null) {
        const firstEv = this.playlist[fromIndex];
        let targetPad = null;
        if      (firstEv?.source === 'smpte') targetPad = this._N;
        else if (firstEv?.source === 'black') targetPad = this._N + 1;
        else if (firstEv?.source === 'image') targetPad = this._N + 2;
        if (targetPad !== null) try { this.master?.switchTo(targetPad); } catch {}
      }
      this._stopAll(precuedSlot);
      for (const p of Object.values(this.players)) try { p.stopPositionPoll?.(); } catch {}
    }

    const savedQueue = {};
    if (precuedSlot && firstPlayerEv) savedQueue[precuedSlot] = firstPlayerEv.file;
    this._cueQueue = savedQueue;
    this._running = true; this._paused = false;
    this.currentIndex = fromIndex - 1;
    this._log(`▶ START (cue-first${smoothTransition?' smooth':''}) ab Event ${fromIndex+1}/${this.playlist.length}`);
    this._markRange(fromIndex, this.playlist.length, 'pending');
    await this._earlyPreCue(fromIndex);
    this._armFixTimers(fromIndex);
    this._advance(precuedSlot);
  }

  async stop() {
    this._stopAll();
    this._running = false; this._paused = false;
    for (const p of Object.values(this.players)) try { p.stopPositionPoll?.(); } catch {}
    try { this.master.switchTo(this.idlePad); } catch {}
    this._log('■ STOP → Idle');
    this.emit('stopped');
  }

  async jump(toIndex) {
    this._stopAll();
    for (const p of Object.values(this.players)) try { p.stopPositionPoll?.(); } catch {}
    this._cueQueue = {};
    this._running = true; this._paused = false;
    this.currentIndex = toIndex - 1;
    this._markRange(toIndex, this.playlist.length, 'pending');
    const firstSlot = await this._earlyPreCue(toIndex);
    this._armFixTimers(toIndex);
    this._advance(firstSlot, 'user-jump');
  }

  // Like jump() but bypasses startType=fixtime — starts event immediately.
  async forceJump(toIndex) {
    const prevOnAirSlot = this._onAirSlot;
    const targetEv = this.playlist[toIndex];
    let precuedSlot = null;
    let smoothTransition = false;

    // Pre-cue on the free slot so _executeEvent can apply the event's transition FROM
    // the currently-running output — no idle flash, no duplicate go()/transition.
    if (targetEv && this._isPlayer(targetEv)) {
      const targetSlot = this._slotFor(toIndex);
      const candidateSlot = targetSlot !== prevOnAirSlot
        ? targetSlot
        : this._slotIds.find(s => s !== prevOnAirSlot) || null;
      if (candidateSlot) {
        precuedSlot = candidateSlot;
        // leadMs=0: forceJump schaltet quasi-sofort auf dieses Event um.
        try { await this._doCue(targetEv, candidateSlot, undefined, undefined, undefined, 0); } catch { precuedSlot = null; }
        if (precuedSlot && !this.players[precuedSlot]?.cued) precuedSlot = null;
        if (precuedSlot) smoothTransition = true;
      }
    }

    if (smoothTransition) {
      // Keep on-air slot alive; stop everything else.
      this._clearEventTimers();
      for (const [,h] of this._fixTimers) clearTimeout(h);
      this._fixTimers.clear();
      this._cancelChildEvents(precuedSlot);
      for (const [id, p] of Object.entries(this.players)) {
        if (id === prevOnAirSlot || id === precuedSlot) continue;
        try { p.stop(); } catch {}
      }
    } else {
      // Fallback (no free slot / pre-cue failed): stop all, transition from idle.
      this._stopAll();
    }
    for (const p of Object.values(this.players)) try { p.stopPositionPoll?.(); } catch {}

    const savedQueue = {};
    if (precuedSlot && targetEv) savedQueue[precuedSlot] = targetEv.file;
    this._cueQueue = savedQueue;
    this._running = true; this._paused = false;
    this.currentIndex = toIndex - 1;
    this._markRange(toIndex, this.playlist.length, 'pending');
    this._forceNextImmediate = true;
    await this._earlyPreCue(toIndex);
    this._armFixTimers(toIndex);
    this._advance(precuedSlot, 'user-jump');
  }

  async playNext() {
    if (!this._paused) return;
    this._paused = false;
    this._log('▶▶ PLAY NEXT');
    this._clearEventTimers();
    for (const p of Object.values(this.players)) try { p.stopPositionPoll?.(); } catch {}
    this._setState(this.currentIndex, 'done');
    this._advance(null, 'user-next');
  }

  set(events) {
    const prev = new Map(this.playlist.map(e => [e.id, e._state]));
    this.playlist = (events||[]).map((e,i) => ({
      ...e,
      id:     e.id     || `ev-${i}-${Date.now()}`,
      _state: prev.has(e.id) ? prev.get(e.id) : (e._state||'pending'),
    }));
    this.emit('updated', this.playlist);

    if (this._running) {
      if (this._gapEvent) {
        // Gap wartet: Fixzeit des Gap-Events prüfen und ggf. neu planen
        this._rescheduleGap();
      } else {
        // Playlist läuft normal: Fix-Timer für alle zukünftigen Events neu setzen
        // (Fixzeit könnte geändert worden sein)
        const fromIdx = Math.max(0, this.currentIndex);
        this._armFixTimers(fromIdx);
        // Timeline-Update ans UI
        this.emit('updated', this.playlist);
      }
    }
  }

  // Entfernt abgespielte (done/skipped) Events VOR currentIndex.
  // Behält die letzten `keep` solcher Events. Passt currentIndex an.
  // Gibt die Anzahl der entfernten Events zurück.
  pruneDone(keep = 3) {
    const pl  = this.playlist;
    const cur = this.currentIndex;
    const doneIndices = [];
    for (let i = 0; i < Math.max(0, cur); i++) {
      const st = pl[i]._state || 'pending';
      if (st === 'done' || st === 'skipped') doneIndices.push(i);
    }
    const toRemove = Math.max(0, doneIndices.length - keep);
    if (toRemove === 0) return 0;
    const removeSet = new Set(doneIndices.slice(0, toRemove));
    this.playlist = pl.filter((_, i) => !removeSet.has(i));
    if (cur >= 0) this.currentIndex -= toRemove;
    this.emit('updated', this.playlist);
    return toRemove;
  }

  // Wird nach set() aufgerufen wenn _gapEvent aktiv ist.
  // Berechnet neue Wartezeit und ersetzt _mainTimer + _fixTimers neu.
  _rescheduleGap() {
    const { idx, event } = this._gapEvent;
    // Aktuelles Event aus der (neuen) Playlist holen — Fixzeit könnte geändert sein
    const fresh = this.playlist[idx];
    if (!fresh || fresh.startType !== 'fixtime' || !fresh.startTime) {
      // Event wurde entfernt oder ist kein Fix mehr → Gap abbrechen, weiterschalten
      this._log('Gap-Reschedule: Event entfernt oder kein Fix mehr → abbrechen');
      this._gapEvent = null; this._gapLoopCleanup?.(); this._gapLoopCleanup = null;
      clearTimeout(this._mainTimer); this._mainTimer = null;
      this._advance();
      return;
    }

    const msUntil = msUntilWallClock(fresh.startTime, this.fps);
    if (msUntil === null) return;

    const GRACE = 500;
    if (msUntil <= GRACE) {
      // Fixzeit ist jetzt erreicht → sofort starten
      this._log(`Gap-Reschedule: @${fresh.startTime} jetzt erreicht → sofort`);
      this._gapEvent = null; this._gapLoopCleanup?.(); this._gapLoopCleanup = null;
      clearTimeout(this._mainTimer); this._mainTimer = null;
      this._clearEventTimers();
      this._cancelChildEvents();
      this._setState(idx, 'playing');
      this.emit('current', { index: idx, event: fresh });
      this._executeEvent(fresh).catch(err => {
        this._log(`Event-Fehler [${idx+1}]: ${err.message}`, 'error');
        this._setState(idx, 'skipped');
        this._advance();
      });
      return;
    }

    this._log(`Gap-Reschedule: @${fresh.startTime} in ${Math.round(msUntil/1000)}s (vorverlegt)`);

    // _mainTimer neu setzen
    clearTimeout(this._mainTimer);
    this._mainTimer = setTimeout(() => {
      if (!this._running || !this._gapEvent) return;
      if (this.currentIndex !== idx) return;
      this._log(`⏰ Fixtime-Gap abgelaufen → Event ${idx+1}/${this.playlist.length}: ${fresh.file||fresh.source||'?'}`);
      this._gapEvent = null; this._gapLoopCleanup?.(); this._gapLoopCleanup = null;
      this._clearEventTimers();
      this._cancelChildEvents();
      this._setState(idx, 'playing');
      this.emit('current', { index: idx, event: fresh });
      this._executeEvent(fresh).catch(err => {
        this._log(`Event-Fehler [${idx+1}]: ${err.message}`, 'error');
        this._setState(idx, 'skipped');
        this._advance();
      });
    }, msUntil);

    // _gapEvent auf fresh event aktualisieren (Fixzeit könnte sich geändert haben)
    this._gapEvent = { idx, event: fresh };
    // FixStart-Timer neu planen (alte löschen, neue setzen)
    for (const [,h] of this._fixTimers) clearTimeout(h);
    this._fixTimers.clear();
    this._armFixTimers(idx);

    // UI über neue Dauer informieren (Counter neu starten)
    this.emit('playing', {
      event: fresh, slotId: null,
      clipDur: msUntil / 1000, postrollSec: 0, fixEnd: fresh.startTime,
    });
  }

  validate() {
    return this.playlist.map(ev => {
      if (!this._isPlayer(ev)) return { id:ev.id, ok:true };
      if (!ev.file)            return { id:ev.id, ok:false, error:'Kein Dateiname' };
      const abs = resolveFile(ev.file, this.opts.mediaDir);
      if (!abs) return { id:ev.id, ok:false, resolvedPath:null, error:`Nicht gefunden: ${ev.file}` };
      const warn = ev._durationWarning || null;
      return { id:ev.id, ok:true, resolvedPath:abs, warn };
    });
  }

  async cueManual(slotId, file, som=0, eom=null, audioConfig={}) {
    const player = this.players[slotId];
    if (!player) return { ok:false, error:'Kein Player' };
    const abs = resolveFile(file, this.opts.mediaDir) || file;
    try { await player.load({ filePath:abs, som, eom, audioConfig }); return { ok:true }; }
    catch (e) { return { ok:false, error:e.message }; }
  }

  async cutTo(slotId) {
    const p = this.players[slotId];
    if (!p?.cued) return false;
    await p.go(); this.master.switchTo(this._padFor(slotId)); this._onAirSlot = slotId;
    return true;
  }

  calcTimeline(startTime = new Date()) {
    const fps = this.fps; const result = []; let t = startTime.getTime();
    for (let i = 0; i < this.playlist.length; i++) {
      const ev = this.playlist[i];
      if (ev.startType === 'fixtime' && ev.startTime) {
        const p = ev.startTime.split(':').map(Number);
        const r = new Date(t);
        let ft = new Date(r.getFullYear(),r.getMonth(),r.getDate(),p[0]||0,p[1]||0,p[2]||0,0).getTime();
        const evSt = ev._state || 'pending';
        const evDone = evSt === 'done' || evSt === 'skipped' || evSt === 'playing';
        if (evDone) {
          if (ft > t) t = ft;  // snap forward only; never snap back or roll 24h for done events
        } else {
          if (ft <= t) ft += 86400000;
          t = ft;
        }
      }
      const start = new Date(t);
      let durMs = this._calcDurMs(ev, fps);
      const isManual = ev.endType==='manual';
      let gapMs=0, overlapMs=0;
      if (ev.endType==='fixtime' && ev.fixTime) {
        const p = ev.fixTime.split(':').map(Number);
        let ft = new Date(start.getFullYear(),start.getMonth(),start.getDate(),p[0]||0,p[1]||0,p[2]||0,0).getTime();
        if (ft <= start.getTime()) ft += 86400000;
        const ftMs = ft - start.getTime();
        if (ftMs > durMs) gapMs = ftMs-durMs;
        else if (ftMs < durMs) overlapMs = durMs-ftMs;
        durMs = ftMs;
      }
      // Xfade look-ahead: when the NEXT event starts with xfade, this event's effective
      // timeline duration is shorter by the transition time (both clips play simultaneously).
      // The next event's start time in the playlist column must reflect the earlier start.
      const nextEvTl = this.playlist[i + 1];
      const xfadeOverlapMs = (!isManual && nextEvTl?.transition === 'xfade' && this._isPlayer(nextEvTl))
        ? Math.min(
            this.transition?.durationMs?.(nextEvTl.transitionSpeed || 'fast') ?? 500,
            Math.max(0, durMs - 500)  // never overlap more than durMs-500ms
          )
        : 0;
      // effectiveDurMs: on-screen time this event occupies in the timeline.
      // For events followed by xfade: shorter than durMs by the overlap.
      // Use this for playlist column duration display and timeline total calculation.
      const effectiveDurMs = durMs - xfadeOverlapMs;
      result.push({ index:i, event:ev, start, durMs, effectiveDurMs, gapMs, overlapMs, xfadeOverlapMs, isManual });
      if (!isManual) t += effectiveDurMs;
    }
    return result;
  }

  // ── Fix-Timer ─────────────────────────────────────────────────────────────

  _armFixTimers(fromIndex) {
    for (const [,h] of this._fixTimers) clearTimeout(h);
    this._fixTimers.clear();

    for (let i = fromIndex; i < this.playlist.length; i++) {
      const ev = this.playlist[i];
      if (ev.startType !== 'fixtime' || !ev.startTime) continue;

      const ms = msUntilWallClock(ev.startTime, this.fps);
      if (ms === null) {
        this._log(`FixStart: Event ${i+1} ungültige Zeit "${ev.startTime}"`, 'warn');
        continue;
      }
      if (ms === 0) {
        // Innerhalb 30s Grace-Fenster: sofort feuern via Timer
        const _ti = i;
        const _tt = ev.startTime;
        this._log(`⏰ FixStart: Event ${_ti+1} "@${_tt}" im Grace-Fenster → sofort`);
        const _th = setTimeout(() => {
          this._fixTimers.delete(_ti);
          if (!this._running) return;
          if (this.currentIndex >= _ti) return; // schon dort
          this._clearEventTimers();
          if (this._onAirSlot) try { this.players[this._onAirSlot]?.stopPositionPoll?.(); } catch {}
          if (this.currentIndex >= 0) this._setState(this.currentIndex, 'done');
          this.currentIndex = _ti - 1;
          this._advance(null, 'fixtime-cutoff');
        }, 50); // 50ms: kurze Verzögerung damit start() vollständig ist
        this._fixTimers.set(_ti, _th);
        continue;
      }

      const targetIdx  = i;
      const targetTime = ev.startTime;
      const arrivalAt  = new Date(Date.now() + ms).toLocaleTimeString('de');
      const mins = Math.floor(ms/60000), secs = Math.round((ms%60000)/1000);
      this._log(`⏰ FixStart-Timer: Event ${targetIdx+1} "@${targetTime}" in ${mins>0?`${mins}m ${secs}s`:`${secs}s`} (${arrivalAt})`);

      // Pre-Cue 5s vorher; falls Fix-Event zu nah ist, sofort cuen
      if (this._isPlayer(ev)) {
        if (ms > PRE_CUE_MS + 500) {
          // Timer feuert PRE_CUE_MS vor der Fixzeit → leadMs = PRE_CUE_MS.
          const pt = setTimeout(() => {
            if (!this._running) return;
            this._doCue(ev, this._slotFor(targetIdx), undefined, undefined, undefined, PRE_CUE_MS).catch(()=>{});
          }, ms - PRE_CUE_MS);
          this._precTimers.push(pt);
        } else {
          // Fix event fires in <5.5s → start cue immediately so it's ready in time.
          // leadMs = ms (die tatsächlich verbleibende Zeit bis On-Air, < PRE_CUE_MS).
          this._doCue(ev, this._slotFor(targetIdx), undefined, undefined, undefined, ms).catch(()=>{});
        }
      }

      // Haupt-Interrupt
      const handle = setTimeout(() => {
        this._fixTimers.delete(targetIdx);
        if (!this._running) return;
        this._log(`⏰ FixStart: EXAKT @${targetTime} → Event ${targetIdx+1}`);
        this._clearEventTimers();
        if (this._onAirSlot) try { this.players[this._onAirSlot]?.stopPositionPoll?.(); } catch {}
        if (this.currentIndex >= 0) this._setState(this.currentIndex, 'done');
        this.currentIndex = targetIdx - 1;
        this._advance(null, 'fixtime-cutoff');
      }, ms);

      this._fixTimers.set(targetIdx, handle);
    }
    if (this._fixTimers.size > 0)
      this._log(`${this._fixTimers.size} Fix-Timer aktiv`);
  }

  // ── Timer ──────────────────────────────────────────────────────────────────

  _clearEventTimers() {
    if (this._mainTimer) { clearTimeout(this._mainTimer);  this._mainTimer = null; }
    if (this._prTimer)   { clearTimeout(this._prTimer);    this._prTimer   = null; }
    if (this._eosCheck)  { clearInterval(this._eosCheck);  this._eosCheck  = null; }
    for (const t of this._precTimers) clearTimeout(t);
    this._precTimers = [];
    // Backup Error-Listener aufräumen + Zustand zurücksetzen
    this._backupCleanup?.(); this._backupCleanup = null;
    this._backupActive = false;
  }

  _stopAll(exceptSlot = null) {
    this._clearEventTimers();
    for (const [,h] of this._fixTimers) clearTimeout(h);
    this._fixTimers.clear();
    this._cancelChildEvents(exceptSlot);
    for (const [id, p] of Object.entries(this.players)) {
      if (id === exceptSlot) continue;
      try { p.stop(); } catch {}
    }
  }

  /**
   * Interrupt-safe jump: pre-cues the target event on the non-on-air slot
   * while the current clip continues playing, then interrupts and switches.
   * Falls back to normal jump() if pre-cue is impossible (same slot or failed).
   */
  async jumpInterrupt(toIndex) {
    // Cancel any _executeEvent that is mid-_doCue: load() survives _stopAll() because
    // it awaits _pendingStop and then continues building new pipelines.  Without this
    // guard the stale event calls go() + switchFn(pad), overriding the interrupt's pad
    // switch and overwriting _mainTimer.
    this._execGeneration++;
    let precuedSlot = null;

    // Always attempt pre-cue regardless of _running state.
    // This covers: playlist stopped (showing idle), and same-slot edge cases.
    const firstEv = this.playlist[toIndex];
    if (firstEv && this._isPlayer(firstEv)) {
      const targetSlot = this._slotFor(toIndex);
      // Use a free slot; if target equals on-air use the other slot
      const candidateSlot = (targetSlot !== this._onAirSlot)
        ? targetSlot
        : this._slotIds.find(s => s !== this._onAirSlot) || targetSlot;
      precuedSlot = candidateSlot;
      this._log(`Interrupt pre-cue: ${path.basename(firstEv.file||'')} → ${candidateSlot}`, 'debug');
      // leadMs=0: Interrupt schaltet quasi-sofort (go+switch) auf dieses Event um.
      try { await this._doCue(firstEv, candidateSlot, undefined, undefined, undefined, 0); } catch { precuedSlot = null; }
      if (precuedSlot && !this.players[precuedSlot]?.cued) precuedSlot = null;
    }

    // go() + switchTo() BEFORE stopping current output — direct cut, no black/idle.
    if (precuedSlot) {
      const pp  = this.players[precuedSlot];
      const pad = this._padFor(precuedSlot);
      try {
        await pp.go();
        // 4 frames: ensures decoder has filled the intervideosink ring buffer before switch
        await new Promise(r => setTimeout(r, Math.round(4000 / this.fps)));
        this.master?.switchTo(pad);
        this._log(`Interrupt switch: → ${precuedSlot} pad ${pad}`, 'debug');
      } catch (e) {
        this._log(`Interrupt go/switch: ${e.message}`, 'warn');
        precuedSlot = null;
      }
    }

    if (!precuedSlot) {
      // Non-player first event (smpte/black/live): switch master to correct pad now.
      let targetPad = null;
      if      (firstEv?.source === 'smpte')   targetPad = this._N;
      else if (firstEv?.source === 'black')   targetPad = this._N + 1;
      else if (firstEv?.source === 'image')   targetPad = this._N + 2;
      else if (this._isLiveSource(firstEv))   targetPad = this._padForSource(firstEv.source);
      else if (this._isGenericLive(firstEv)) {
        const ls = this._liveSlotFor(toIndex);
        if (ls) targetPad = this._padForSource(ls);
      }
      if (targetPad !== null) try { this.master?.switchTo(targetPad); } catch {}
    }

    // Stop after switch — old output is now irrelevant
    this._stopAll(precuedSlot);
    for (const p of Object.values(this.players)) try { p.stopPositionPoll?.(); } catch {}

    const savedCueQueue = {};
    if (precuedSlot) savedCueQueue[precuedSlot] = firstEv?.file || null;
    this._cueQueue = savedCueQueue;

    this._running = true; this._paused = false;
    this.currentIndex = toIndex - 1;
    this._markRange(toIndex, this.playlist.length, 'pending');

    // Pre-cue subsequent events asynchronously — don't block _advance() on loading.
    // Loading the return copy (next event) takes 1-2s and would delay the visible switch.
    this._earlyPreCue(toIndex).catch(() => {});  // fire-and-forget after the switch
    this._armFixTimers(toIndex);
    this._advancing = false;  // jumpInterrupt takes explicit control — clear any stale EOM guard
    this._advance(precuedSlot);
  }

  /**
   * Wechselt Audio-Preset und/oder AFD des laufenden On-Air-Clips ohne Unterbrechung:
   * cued denselben Clip auf dem freien Slot an der aktuellen Position neu (mit den
   * geänderten Einstellungen — das baut Audio- UND Video-Pipeline frisch auf, daher
   * funktioniert das für AFD genauso wie für Audio-Presets) und blendet per xFade
   * synchron über. Das vermeidet sowohl den Audio-Gap von In-Place-Pipeline-Swaps
   * als auch eine dauerhaft verdoppelte Routing-Graph ("zweiter Branch").
   */
  /**
   * Wechselt das Audio-Preset des laufenden On-Air-Clips.
   *
   * Strategie:
   *   1. Versuche Matrix-Update (reloadAudioPresetMatrix) — kein Gap, kein Seek.
   *      Funktioniert wenn das neue Preset dieselbe Spur-Konfiguration (inCh) hat.
   *   2. Fallback: Pipeline-Rebuild (reloadAudioPreset) — kurzer ~250ms Gap,
   *      aber kein Seek durch interleave → kein FLUSHING-State → keine Stille.
   */
  async changeOnAirPreset(presetId, audioConfig) {
    if (this._swapping) return false;
    this._swapping = true;
    try {
      const curEv = this.playlist[this.currentIndex];

      // Live-Quelle: keine separate Player-Audio-Pipeline — Hot-Swap läuft direkt
      // gegen die in der Master-Pipeline laufenden audiomixmatrix-Elemente.
      if (curEv && (this._isLiveSource(curEv) || this._isGenericLive(curEv))) {
        const lsId = curEv.liveSource || curEv.source;
        const ok = lsId && this.master?.reloadLiveAudioPresetMatrix?.(lsId, presetId);
        if (!ok) {
          this._log(`changeOnAirPreset: Live-Audio-Preset-Wechsel für ${lsId} fehlgeschlagen`, 'warn');
          return false;
        }
        curEv.audioPreset = presetId;
        if (!curEv.audioConfig) curEv.audioConfig = {};
        curEv.audioConfig.preset = presetId;
        this.emit('onair-variant', { slotId: null, liveSource: lsId, audioPreset: presetId, afd: curEv.afd ?? 'auto' });
        return true;
      }

      const slotId = this._onAirSlot;
      const player = slotId ? this.players[slotId] : null;
      if (!slotId || !player?.playing || !curEv || !this._isPlayer(curEv)) {
        this._log(`changeOnAirPreset: übersprungen — slotId=${slotId} playing=${player?.playing}`, 'warn');
        return false;
      }

      const mergedCfg = { ...(curEv.audioConfig ?? {}) };
      if (audioConfig && typeof audioConfig === 'object') Object.assign(mergedCfg, audioConfig);
      mergedCfg.preset = presetId;

      if (player._item) {
        player._item = { ...player._item, audioConfig: mergedCfg };
      }

      // Try zero-gap matrix update first; fall back to pipeline rebuild if tracks differ.
      let ok = await player.reloadAudioPresetMatrix(presetId);
      if (!ok) ok = await player.reloadAudioPreset(presetId);
      if (!ok) return false;

      curEv.audioPreset = presetId;
      if (!curEv.audioConfig) curEv.audioConfig = {};
      Object.assign(curEv.audioConfig, mergedCfg);

      this.emit('onair-variant', { slotId, audioPreset: presetId, afd: curEv.afd ?? 'auto' });
      return true;
    } finally {
      this._swapping = false;
    }
  }

  async swapOnAirVariant({ audioPreset, afd, audioConfig } = {}) {
    if (this._swapping) return false;
    this._swapping = true;
    try { return await this._doSwapOnAirVariant({ audioPreset, afd, audioConfig }); }
    finally { this._swapping = false; }
  }

  async _doSwapOnAirVariant({ audioPreset, afd, audioConfig } = {}) {
    const slotId = this._onAirSlot;
    const player = slotId ? this.players[slotId] : null;
    const curEv  = this.playlist[this.currentIndex];
    if (!slotId || !player?.playing || !curEv || !this._isPlayer(curEv)) {
      this._log(`swapOnAirVariant: übersprungen — slotId=${slotId} playing=${player?.playing} curEv=${!!curEv} isPlayer=${this._isPlayer(curEv)}`, 'warn');
      return false;
    }

    const altSlot   = this._slotIds.find(s => s !== slotId);
    const altPlayer = altSlot ? this.players[altSlot] : null;
    if (!altPlayer || altPlayer.playing) {
      this._log(`swapOnAirVariant: übersprungen — altSlot=${altSlot} altPlaying=${altPlayer?.playing}`, 'warn');
      return false;
    }

    const fps = this.fps;
    let pos = 0;
    try { pos = player.vPipeline?.queryPosition?.() ?? 0; } catch {}
    const absPos = (player._item?.som ?? 0) + pos;

    const newPreset = audioPreset !== undefined ? audioPreset
      : (curEv.audioConfig?.preset || curEv.audioPreset || null);
    const newAfd = afd !== undefined ? afd : (curEv.afd || 'auto');

    // eom ist relativ zu som gespeichert (Dauer) — absolute eom-Position bleibt
    // unverändert, NICHT relativ zu absPos neu berechnen (sonst zu früh/spät).
    const origSom = fromTC(curEv.som ?? 0, fps) || 0;
    const ed      = curEv.eom != null ? (fromTC(curEv.eom, fps) || 0) : null;
    const eomAbs  = ed != null ? origSom + ed : null;

    const baseAudioCfg = { ...(curEv.audioConfig ?? {}) };
    if (audioConfig && typeof audioConfig === 'object') Object.assign(baseAudioCfg, audioConfig);
    baseAudioCfg.preset = newPreset;

    const altEvent = {
      ...curEv,
      afd: newAfd,
      audioPreset: newPreset,
      audioConfig: baseAudioCfg,
    };

    // leadMs=null: keine Negativ-Delay-Grafik-Children neu planen — der Clip läuft
    // ja bereits, ein erneutes Scheduling würde sie ein zweites Mal feuern lassen.
    await this._doCue(altEvent, altSlot, undefined, absPos, eomAbs, null);
    if (!altPlayer.cued) {
      this._log(`On-Air-Wechsel: Pre-Cue auf ${altSlot} fehlgeschlagen`, 'warn');
      try { await altPlayer.stop(); } catch {}
      return false;
    }

    try {
      await altPlayer.go();
    } catch (e) {
      this._log(`On-Air-Wechsel: altPlayer.go() ${altSlot} Fehler: ${e.message}`, 'warn');
      try { await altPlayer.stop(); } catch {}
      return false;
    }
    // 4 Frames Vorlauf, bis der Decoder den intervideosink-Ringpuffer gefüllt hat.
    await new Promise(r => setTimeout(r, Math.round(4000 / fps)));
    await this.master.xFadeTo(this._padFor(altSlot), 400, curEv.branding ?? null).catch(() => {});

    // State VOR player.stop() umhängen, damit das EOS-Event des gestoppten Slots
    // den EOM-Handler in _executeEvent nicht vorzeitig zum Advance bringt.
    this._onAirSlot = altSlot;
    this._cueQueue  = { [altSlot]: curEv.file };
    this._swappedSlots.add(slotId);

    curEv.afd = newAfd;
    curEv.audioPreset = newPreset;
    if (!curEv.audioConfig) curEv.audioConfig = {};
    if (audioConfig && typeof audioConfig === 'object') Object.assign(curEv.audioConfig, audioConfig);
    curEv.audioConfig.preset = newPreset;

    try { await player.stop(); } catch {}

    // slotId is now idle — the canonical pre-cue target for clip N+1 was altSlot (now on-air),
    // so _schedulePreCues timers for N+1 see _onAirSlot===altSlot and skip it.
    // Proactively pre-cue the next player event on the idle slot so EOM advance has no gap.
    this._precueNextOnIdleSlot(slotId);

    this.emit('onair-variant', { slotId: altSlot, audioPreset: newPreset, afd: newAfd });
    return true;
  }

  _precueNextOnIdleSlot(idleSlot) {
    const player = this.players[idleSlot];
    if (!player || player.playing || player.cued) return;
    for (let i = this.currentIndex + 1; i < this.playlist.length; i++) {
      const ev = this.playlist[i];
      if (!this._isPlayer(ev)) continue;
      this._doCue(ev, idleSlot, undefined, undefined, undefined, 0).catch(() => {});
      return;
    }
  }

  /**
   * Bricht laufende Grafik-Child-Events ab (beim Event-Wechsel).
   * @param {string|null} keepSlot  Slot, dessen gerade frisch via _doCue() vorgeplante
   *   negative-delay Children NICHT abgebrochen werden sollen — sonst killt der direkt
   *   auf _doCue() folgende _cancelChildEvents()-Aufruf (smoothTransition / _advance)
   *   den eben erst angelegten Pre-Schedule, bevor dessen Show-Timer feuert
   *   (→ "vor Start"-Children werden nie angezeigt).
   */
  _cancelChildEvents(keepSlot = null) {
    if (this._childCleanup) {
      try { this._childCleanup(); } catch {}
      this._childCleanup = null;
    }
    // Negative-delay pre-child-cleanups (aus _doCue) ebenfalls abbrechen — außer für
    // den Slot, auf den wir gerade umschalten (dessen Pre-Schedule soll feuern und
    // dessen bereits angezeigtes "vor Start"-Grafik über den Clip-Wechsel hinweg
    // sichtbar bleiben muss).
    for (const [slot, fn] of this._preChildCleanups.entries()) {
      if (slot === keepSlot) continue;
      try { fn(); } catch {}
      this._preChildCleanups.delete(slot);
    }
    // Compositor-Grafik-Layer nur ausblenden, wenn wirklich nichts mehr aktiv ist —
    // sonst killt hideGrafik() (alpha=0) das gerade sichtbare "vor Start"-Grafik des
    // kommenden Events im selben Moment, in dem es erscheinen sollte.
    if (!this.grafixEngine?._activeGrafiks?.size) this.master?.hideGrafik?.();
    this._cancelVoiceover();
    this._cancelRecord();
    this._cancelTriggerChildren();
  }

  _cancelRecord() {
    if (this._recordCleanup) {
      try { this._recordCleanup(); } catch {}
      this._recordCleanup = null;
    }
  }

  /** Löst den Dateipfad eines Bild-Child-Events (source:'image') auf — siehe resolveFile(). */
  _resolveImagePath(file) {
    return this.opts.resolveFilePath?.(file) || resolveFile(file, this.opts.mediaDir, true);
  }

  /**
   * DVE/Squeeze: Grafik-Children mit child.dve squeezen nicht nur sich selbst
   * (Overlay-Layer, siehe GrafixEngine), sondern auch das eigentliche Programm-
   * /Live-Video über MasterPipeline.setDveSqueeze() — siehe scheduleChildEvents()
   * onGrafik-Callback (info.dve = px-Box bei 'show', bool bei 'hide').
   * Mehrere gleichzeitige DVE-Children: letzte Box gewinnt; erst wenn KEIN
   * DVE-Child mehr aktiv ist, wird auf Vollbild zurückgesetzt.
   */
  _handleGrafikDve(info) {
    if (!this.master || !info.dve) return;
    if (!this._activeDveIds) this._activeDveIds = new Set();
    if (info.action === 'show') {
      this._activeDveIds.add(info.id);
      this.master.setDveSqueeze?.(info.dve);
    } else if (info.action === 'hide') {
      this._activeDveIds.delete(info.id);
      if (this._activeDveIds.size === 0) this.master.clearDveSqueeze?.();
    }
  }

  _scheduleRecordChildren(event, clipDurSec, fps) {
    this._cancelRecord();
    if (!this.recordEngine) return;
    const recChildren = (event.children || []).filter(c => c.source === 'record' && c.record);
    if (!recChildren.length) return;
    this._recordCleanup = this.recordEngine.scheduleChildren(event, clipDurSec, fps, (info) => {
      this.emit('record', info);
    });
  }

  _cancelTriggerChildren() {
    if (this._triggerCleanup) {
      try { this._triggerCleanup(); } catch {}
      this._triggerCleanup = null;
    }
  }

  /**
   * Plant Trigger-Child-Events für ein Event — feuert beim Ablauf eines Delays
   * einen Befehl an einen anderen Channel/eine Channel-Gruppe über this.channelBus
   * (siehe ChannelBus.js). Timing-Modell identisch zu Grafik-Children:
   *   trigger.delayFrames / trigger.delay      — relativ zu Clip-Start, negativ = Pre-Roll
   *   trigger.endOffsetFrames / trigger.endOffset — relativ zu Clip-Ende, negativ = davor
   *   trigger.targetGroup / trigger.target     — ChannelBus-Adressierung (Gruppe oder Channel-ID)
   *   trigger.type                             — Befehl, siehe executeRemoteTrigger()
   *
   * @param {object}  event
   * @param {?number} clipDurSec  – null während Negative-Delay-Pre-Arm (Dauer noch unbekannt)
   * @param {number}  fps
   * @param {object}  [opts]
   *   opts.leadMs      — ms bis zum tatsächlichen Clip-Start (nur im Pre-Arm-Fall, siehe _armNegChildSchedule)
   *   opts.negativeOnly — nur Children mit (start-relativem) negativem Delay schedulen
   * @returns {Function} cleanup()  (nur relevant für negativeOnly-Aufrufe, siehe _armNegChildSchedule)
   */
  _scheduleTriggerChildren(event, clipDurSec, fps, { leadMs = 0, negativeOnly = false } = {}) {
    if (!negativeOnly) this._cancelTriggerChildren();
    const children = (event.children || []).filter(c => c.source === 'trigger' && c.trigger);
    if (!this.channelBus || !children.length) return () => {};

    const frameDur = 1000 / fps;
    const timers = [];
    for (const child of children) {
      const tg = child.trigger;
      let nativeDelayMs = tg.delayFrames != null
        ? Math.round(tg.delayFrames * frameDur)
        : Math.round((tg.delay ?? 0) * 1000);
      if (clipDurSec != null) {
        const clipMs = clipDurSec * 1000;
        if (tg.endOffsetFrames != null) nativeDelayMs = Math.round(clipMs + tg.endOffsetFrames * frameDur);
        else if (tg.endOffset != null)  nativeDelayMs = Math.round(clipMs + tg.endOffset * 1000);
      }

      if (negativeOnly && nativeDelayMs >= 0) continue;
      if (!negativeOnly && nativeDelayMs < 0) continue;  // bereits in der Pre-Arm-Phase geschedult

      const effDelayMs = negativeOnly ? Math.max(0, nativeDelayMs + leadMs) : nativeDelayMs;
      const target = tg.targetGroup || tg.target;
      const timer = setTimeout(() => {
        const sent = this.channelBus.send(target, tg.type, tg.payload || {});
        this._log(`Trigger-Child: ${tg.type} → ${target} (${sent} Peer${sent === 1 ? '' : 's'})`, 'debug');
        this.emit('trigger-sent', { type: tg.type, target, payload: tg.payload });
      }, effDelayMs);
      timers.push(timer);
    }
    const cleanup = () => { for (const t of timers) clearTimeout(t); };
    if (negativeOnly) return cleanup;
    this._triggerCleanup = cleanup;
    return cleanup;
  }

  _cancelVoiceover() {
    if (this._voTimers) {
      for (const t of this._voTimers) clearTimeout(t);
      this._voTimers = null;
    }
    if (this.voiceoverEngine) {
      // immediate=true: cuts VO and restores pgm gain instantly.
      // stop(false) starts a 1s async fadeout that bleeds into the next clip's audio.
      this.voiceoverEngine.stop(true).catch(() => {});
    }
  }

  /**
   * Pre-applies pgm duck for any VO child with delay=0 that is not start-relative.
   * Called BEFORE player.go()+switchTo() so the duck is in place when clip audio
   * first becomes audible. The VO audio itself starts via _scheduleVoiceoverChildren
   * after effClip is known (needed for relative-end children).
   */
  _preDuckImmediateVO(event) {
    if (!this.voiceoverEngine || !this.master) return;
    const children = (event.children || [])
      .map(c => (c.source === 'grafik' && c.grafik?.type === 'voiceover')
        ? { ...c.grafik, source: 'voiceover' } : c)
      .filter(c => c.source === 'voiceover');

    for (const child of children) {
      const vo = child.voiceover || child;
      if ((vo._startRelEnd) || (vo.delay ?? 0) > 0) continue;  // not immediate

      const presets = this.voiceoverEngine._presets || {};
      const preset  = presets[vo.preset] || presets['ST'] || { voGain: 1.0, pgmGain: 1.0 };
      if (preset.pgmGain >= 1.0) continue;  // no ducking needed

      const fadeInMs    = vo.fadeInMs ?? this.voiceoverEngine._fadeInMs ?? 500;
      const pgmFadeInMs = preset.pgmFadeInMs ?? fadeInMs;
      this.master.setVoiceoverPgmGain?.(preset.pgmGain, pgmFadeInMs);
      if (preset.groupVoGain) this.master.setVoGroupOverrides?.(preset.groupVoGain, 'vo1');
      break;  // only the first immediate VO drives the duck
    }
  }

  /**
   * DVE/Squeeze, dve.target='video', Child startet AB CLIP-BEGINN (delay≈0):
   * muss VOR dem Cut/Switch angewendet werden, sonst läuft das erste Frame des
   * neuen Clips noch unkomprimiert raus — siehe _preDuckImmediateVO für exakt
   * dasselbe Timing-Problem bei Voiceover-Ducking. scheduleChildEvents() (danach
   * aufgerufen) erkennt per child._dvePreApplied, dass dieses Child schon live ist,
   * und überspringt den Re-Show (übernimmt aber Hide-Timer/Cleanup normal).
   * Nur Bild-Children unterstützt (der dokumentierte Chroma-Key/Rahmen-Use-Case) —
   * HTML/oGraf-Children mit dve.target='video' haben dieses Pre-Apply noch nicht.
   */
  async _preApplyImmediateDve(event) {
    if (!this.grafixEngine || !this.master) return;
    for (const child of (event.children || [])) {
      // dve.zone (Box aus Sibling-Template-DOM) ist vor dem Switch noch nicht auflösbar
      // (Sibling rendert ja erst durch denselben scheduleChildEvents()-Aufruf danach) —
      // ohne Box würde prepareImmediateDveSqueeze() auf Vollbild zurückfallen (No-Op-Squeeze).
      if (child.source !== 'image' || !child.src || child.dve?.target !== 'video' || child.dve?.zone) continue;
      const delaySec = child.delayFrames != null ? child.delayFrames / this.fps : (child.delay ?? 0);
      if (delaySec > 0) continue;  // nur "ab Clip-Start" — andere Delays nimmt der normale Pfad
      try {
        const result = await this.grafixEngine.prepareImmediateDveSqueeze(child, {
          resolveImagePath: f => this._resolveImagePath(f),
        });
        if (result) {
          this.master.setDveSqueeze(result.box);
          if (!this._activeDveIds) this._activeDveIds = new Set();
          this._activeDveIds.add(result.id);
        }
      } catch(e) { this._log(`_preApplyImmediateDve: ${e.message}`, 'warn'); }
      break;  // nur das erste passende Child — mehrere simultane Squeezes nicht unterstützt
    }
  }

  /**
   * Plant Voiceover-Child-Events für ein Event.
   * Voiceover-Children haben source='voiceover' und ein voiceover-Objekt mit:
   *   file, preset, delay, duration, endOffset, _startRelEnd, _endRelEnd, fadeInMs, fadeOutMs
   */
  _scheduleVoiceoverChildren(event, clipDurSec, fps, alreadyElapsedMs = 0) {
    this._cancelVoiceover();
    const voChildren = (event.children || [])
      .map(c => (c.source === 'grafik' && c.grafik?.type === 'voiceover') ? { ...c.grafik, source: 'voiceover' } : c)
      .filter(c => c.source === 'voiceover');
    const marinaVo = event._marinaAudioMix;
    if (!voChildren.length && !marinaVo) return;

    this._voTimers = [];
    const scheduleOne = (vo) => {
      const delay    = vo.delay ?? 0;
      const durSec   = vo.duration ?? null;
      const startRel = !!vo._startRelEnd;
      const endRel   = !!vo._endRelEnd;
      const endOff   = vo.endOffset ?? 0;

      // Subtract time already elapsed since go() so timers fire at the correct
      // wall-clock moment regardless of how long duration-query/setup took.
      const rawStartMs = startRel
        ? Math.max(0, (clipDurSec - delay) * 1000)
        : delay * 1000;
      const startMs = Math.max(0, rawStartMs - alreadyElapsedMs);

      let durationMs = null;
      if (durSec != null)  durationMs = durSec * 1000;
      else if (endRel)     durationMs = Math.max(0, (clipDurSec - delay - endOff) * 1000);
      else                 durationMs = Math.max(0, (clipDurSec - delay) * 1000);

      const mediaDir = this.opts.mediaDir || process.cwd();
      const absFile  = vo.filePath || require('path').join(mediaDir, vo.file || '');

      // Preload: start ffmpeg decoding now if VO starts in >200ms, so audio
      // is ready when the timer fires (eliminates 50-200ms ffmpeg startup jitter).
      const PRELOAD_MIN_MS = 200;
      if (rawStartMs > PRELOAD_MIN_MS && require('fs').existsSync(absFile)) {
        this.voiceoverEngine.preload(absFile);
      }

      const startTimer = setTimeout(async () => {
        if (!require('fs').existsSync(absFile)) {
          this._log(`Voiceover: Datei nicht gefunden: ${absFile}`, 'warn');
          return;
        }
        try {
          await this.voiceoverEngine.play({
            filePath:   absFile,
            preset:     vo.preset,
            durationMs: durationMs,
            fadeInMs:   vo.fadeInMs,
            fadeOutMs:  vo.fadeOutMs,
          });
        } catch (e) {
          this._log(`Voiceover play-Fehler: ${e.message}`, 'warn');
        }
      }, startMs);
      this._voTimers.push(startTimer);
    };

    for (const child of voChildren) {
      scheduleOne(child.voiceover || child);
    }
    if (marinaVo && marinaVo.mediaName) {
      // Marina AudioMix: sofort starten, bis Clip-Ende
      scheduleOne({ file: marinaVo.mediaName, preset: marinaVo.preset, delay: 0, duration: clipDurSec });
    }
  }

  /**
   * Startet sofort einen Voiceover auf dem laufenden Event, ohne Video zu unterbrechen.
   * @param {object} opts  file, preset, duration (sec), fadeInMs, fadeOutMs
   */
  voiceoverNow(opts = {}) {
    if (!this.voiceoverEngine) return;
    const { file, preset, duration, fadeInMs, fadeOutMs } = opts;
    const mediaDir = this.opts.mediaDir || process.cwd();
    const absFile  = require('path').isAbsolute(file || '') ? file : require('path').join(mediaDir, file || '');
    this.voiceoverEngine.play({
      filePath:   absFile,
      preset,
      durationMs: duration ? duration * 1000 : null,
      fadeInMs:   fadeInMs  ?? this.voiceoverEngine._fadeInMs  ?? 500,
      fadeOutMs:  fadeOutMs ?? this.voiceoverEngine._fadeOutMs ?? 1000,
    }).catch(e => this._log(`voiceoverNow: ${e.message}`, 'warn'));
  }

  // ── Block helpers ─────────────────────────────────────────────────────────

  _blockDurSec(startIdx) {
    let total = 0;
    for (let i = startIdx + 1; i < this.playlist.length; i++) {
      const ev = this.playlist[i];
      if (ev.source === 'block_end') break;
      if (ev.source === 'comment' || ev.source === 'block_start' || ev.source === 'block_end') continue;
      if (ev.source === 'smpte' || ev.source === 'black' || ev.source === 'image' || ev.source === 'live' || this._isLiveSource(ev)) {
        total += fromTC(ev.duration ?? 5, this.fps) || 5;
      } else {
        if (ev.eom != null)           total += (fromTC(ev.eom, this.fps) || 0) + (fromTC(ev.postroll ?? 0, this.fps) || 0);
        else if (ev.duration != null) total += (fromTC(ev.duration, this.fps) || 0) + (fromTC(ev.postroll ?? 0, this.fps) || 0);
        else if (ev._clipDur != null) total += ev._clipDur + (fromTC(ev.postroll ?? 0, this.fps) || 0);
      }
    }
    return total;
  }

  // ── Slot/Pad ───────────────────────────────────────────────────────────────

  // Gibt true wenn ev eine explizit konfigurierte Live-Quelle ist (source = live1/live2/…)
  _isLiveSource(ev) {
    if (!ev || !this._liveSources.length) return false;
    return this._liveSources.some(ls => ls.id === ev.source);
  }

  // Gibt true wenn ev ein generisches Live-Event ist (source = 'live', Auto-Slot-Zuweisung)
  _isGenericLive(ev) { return ev?.source === 'live'; }

  /**
   * Wendet ein im Event hinterlegtes audioPreset auf eine Live-Quelle an, bevor sie
   * on-air geht (Per-Event-Override des in Live-Tab konfigurierten Standard-Presets).
   * Zero-Gap-Matrix-Update — kein Pipeline-Rebuild, läuft auch fehl, wenn die Quelle
   * keine konfigurierte Audio-Quelle hat (dann bleibt Stille/Default, kein Hard-Fail).
   */
  _applyLiveAudioPreset(lsId, event) {
    if (!event.audioPreset || !lsId) return;
    const ok = this.master?.reloadLiveAudioPresetMatrix?.(lsId, event.audioPreset);
    if (!ok) this._log(`Live-Audio-Preset "${event.audioPreset}" für "${lsId}" konnte nicht angewendet werden`, 'warn');
  }

  /** Erster Live-Event-Index ab `fromIndex` in der EIGENEN Playlist (für NEXT_LIVE ohne explizites payload.index). */
  _nextLiveIndex(fromIndex = this.currentIndex + 1) {
    for (let i = fromIndex; i < this.playlist.length; i++) {
      if (this._isGenericLive(this.playlist[i]) || this._isLiveSource(this.playlist[i])) return i;
    }
    return -1;
  }

  /**
   * Empfängt Remote-Trigger über this.channelBus (siehe ChannelBus.js) und setzt sie
   * auf die eigene Playlist um. `index`/`slotId` im payload referenzieren IMMER die
   * EIGENE Playlist/Slots des Empfänger-Channels, nicht die des Senders — jeder
   * Channel hat eine eigenständige Item-Indizierung. NEXT_LIVE ohne payload.index
   * sucht das nächste eigene Live-Event ab der aktuellen Position (typischer Fall:
   * Hauptliste signalisiert nur "jetzt Live", der Follower kennt seinen eigenen
   * Live-Slot selbst).
   */
  _onRemoteMessage({ from, type, payload = {} }) {
    this._log(`Remote-Trigger empfangen: ${type} von ${from}`, 'debug');
    try {
      switch (type) {
        case 'NEXT':       this.playNext().catch(() => {}); break;
        case 'JUMP':       this.jump(payload.index ?? 0).catch(() => {}); break;
        case 'FORCE_JUMP': this.forceJump(payload.index ?? 0).catch(() => {}); break;
        case 'NEXT_LIVE': {
          const idx = payload.index ?? this._nextLiveIndex();
          if (idx >= 0) this.jumpInterrupt(idx).catch(() => {});
          else this._log(`NEXT_LIVE von ${from}: kein Live-Event in eigener Playlist gefunden`, 'warn');
          break;
        }
        case 'CUT':  if (payload.slotId) this.cutTo(payload.slotId).catch(() => {}); break;
        case 'STOP': this.stop().catch(() => {}); break;
        case 'PLAY': this.start(payload.index ?? 0).catch(() => {}); break;
        default: this.emit('remote-trigger', { from, type, payload });  // unbekannter Typ → Host-App entscheidet
      }
    } catch (e) { this._log(`Remote-Trigger ${type} fehlgeschlagen: ${e.message}`, 'warn'); }
  }

  _isPlayer(ev) {
    if (!ev) return false;
    const NON_PLAYER = ['smpte','black','image','live','comment','block_start','block_end'];
    return !NON_PLAYER.includes(ev.source) && !this._isLiveSource(ev);
  }

  _padForSource(sourceId) {
    const idx = this._liveSources.findIndex(ls => ls.id === sourceId);
    return idx >= 0 ? this._N + 5 + idx : -1;
  }

  /**
   * Behandelt eine Live-Quelle ohne gültiges DeckLink-Eingangssignal genauso wie
   * eine fehlende Datei: je nach opts.missingBehavior ('skip'|'idle') überspringen
   * oder auf die Idle-Quelle ausweichen. Liefert true wenn der Aufrufer (der dann
   * KEINEN Pad-Switch mehr ausführen darf) sofort returnen soll.
   *
   * master.getLiveSignalStatus() liefert null für nicht-DeckLink-Quellen oder
   * solange noch nicht gepollt wurde — in beiden Fällen normal fortfahren.
   */
  async _handleInvalidLiveSignal(sourceId, event, tr, trSp, br, fps) {
    const sig = this.master?.getLiveSignalStatus?.(sourceId);
    if (sig !== false) return false;

    if (this.opts.missingBehavior === 'idle') {
      this._log(`Live-Quelle "${sourceId}": kein DeckLink-Signal → Idle-Quelle`, 'warn');
      this._setState(this.currentIndex, 'idle-fallback');
      const durSec = fromTC(event.duration ?? 5, fps) || 5;
      await this.transition.transition(this.idlePad, tr, trSp);
      try { this.master.setBranding?.(br, true); } catch {}
      this.emit('playing', { event, slotId: null, clipDur: durSec, postrollSec: 0, subReason: 'no-signal' });
      this._schedulePreCues(this.currentIndex, durSec * 1000);
      this._mainTimer = setTimeout(() => {
        this._setState(this.currentIndex, 'done'); this._advance();
      }, durSec * 1000);
    } else {
      this._log(`Live-Quelle "${sourceId}": kein DeckLink-Signal → übersprungen`, 'warn');
      this._setState(this.currentIndex, 'skipped');
      this.emit('not-played', { event, reason: 'no-signal', plannedSec: fromTC(event.duration ?? 5, fps) || 5 });
      this._advancing = false;
      this._advance();
    }
    return true;
  }

  // Weist einen Live-Slot für ein generisches Live-Event zu (alternierend wie _slotFor).
  _liveSlotFor(idx) {
    if (!this._liveSources.length) return null;
    let n = 0;
    for (let i = 0; i <= idx; i++)
      if (this._isGenericLive(this.playlist[i])) n++;
    return this._liveSources[(n - 1) % this._liveSources.length]?.id || this._liveSources[0].id;
  }

  // Sendet Routing-Befehl an Broadcast-Controller (Cerebrum/IPATH via BC-Plugin).
  // Wird beim Pre-Cue (vor dem Übergang) aufgerufen damit der Upstream-Router
  // die Quelle auf den Decklink-Input schalten kann (NMOS).
  _emitLivePrecue(idx, liveSlot) {
    const ev = this.playlist[idx];
    if (!ev) return;
    const ls = this._liveSources.find(l => l.id === liveSlot);
    const upstreamSource = ev.liveSource || ev.source || '';
    this._log(`Live-Precue: ${liveSlot} ← "${upstreamSource}" (inputId: ${ls?.inputId || liveSlot})`);
    this.emit('live-precue', {
      index:          idx,
      liveSlot,
      inputId:        ls?.inputId || liveSlot,
      upstreamSource,
      upstreamLabel:  ev.liveSourceLabel || upstreamSource,
    });
  }

  _slotFor(idx) {
    // Backup-Slot aus regulärer Rotation ausschließen
    const slots = this._backupSlot
      ? this._slotIds.filter(id => id !== this._backupSlot)
      : this._slotIds;
    const pool = slots.length ? slots : this._slotIds;
    let n = 0;
    for (let i = 0; i <= idx; i++) if (this._isPlayer(this.playlist[i])) n++;
    return pool[(n - 1) % pool.length];
  }

  /** Löst eine Datei in den konfigurierten Backup-Verzeichnissen auf (erstes Match gewinnt). */
  _resolveBackupFile(file) {
    if (!file || !this._backupMediaDirs.length) return null;
    for (const dir of this._backupMediaDirs) {
      const abs = resolveFile(file, dir);
      if (abs) return abs;
    }
    return null;
  }

  /** Failover: Backup-Player sofort on-air schalten (er muss bereits gecued sein). */
  async _triggerFailover(fromSlotId, event) {
    if (this._backupActive) return;
    const bp = this._backupSlot ? this.players[this._backupSlot] : null;
    if (!bp?.cued) {
      this._log(`⚠ FAILOVER: Backup-Player "${this._backupSlot}" nicht bereit`, 'error');
      this.emit('backup-unavailable', { fromSlot: fromSlotId, event });
      return;
    }
    this._backupActive = true;
    this._log(`⚠ FAILOVER: ${fromSlotId} → ${this._backupSlot} (${event?.file || '?'})`, 'warn');
    try {
      await bp.go();
      this.master.switchTo(this._padFor(this._backupSlot));
      this._onAirSlot = this._backupSlot;
      this.emit('backup-active', { fromSlot: fromSlotId, toSlot: this._backupSlot, event });
    } catch (e) {
      this._log(`FAILOVER go() Fehler: ${e.message}`, 'error');
      this._backupActive = false;
    }
  }

  _padFor(slotId) {
    const i = this._slotIds.indexOf(slotId);
    if (i >= 0) return i;
    if (slotId === (this.opts.idleSlot || 'playerIdle')) return this._N + 4;
    return 0;
  }

  // ── State ──────────────────────────────────────────────────────────────────

  _markRange(from, to, state) {
    for (let i = from; i < to && i < this.playlist.length; i++)
      this.playlist[i]._state = state;
    this.emit('updated', this.playlist);
  }

  _setState(idx, state) {
    if (idx >= 0 && idx < this.playlist.length) {
      this.playlist[idx]._state = state;
      this.emit('updated', this.playlist);
    }
  }

  // ── Advance ────────────────────────────────────────────────────────────────

  // keepChildSlot: Slot, dessen frisch via _doCue() vorgeplante negative-delay
  // Child-Events NICHT verworfen werden sollen (= der Slot, auf den wir gerade
  // pre-cued umschalten — siehe startCueFirst/forceJump/jumpInterrupt).
  _advance(keepChildSlot = null, reason = 'natural') {
    if (!this._running) return;
    if (reason !== 'natural') this.emit('advance-reason', { reason });
    // Guard gegen Doppel-Advance (z.B. gleichzeitiger EOS + fallbackTimer)
    if (this._advancing) {
      this._log('_advance: doppelter Aufruf ignoriert', 'debug');
      return;
    }
    this._advancing = true;
    setTimeout(() => { this._advancing = false; }, 500);  // Reset nach 500ms

    this._clearEventTimers();
    // Kein expliziter keepChildSlot (normaler EOS-/Timer-Vorlauf, nicht über
    // startCueFirst/forceJump/jumpInterrupt): Slot des kommenden Events ermitteln,
    // damit dessen frisch angezeigtes "vor Start"-Grafik (Pre-Schedule aus _doCue,
    // schon ein paar Sekunden vor diesem Moment angezeigt) nicht sofort wieder
    // versteckt wird — sonst verschwindet es genau im Moment des Clip-Wechsels.
    if (keepChildSlot === null) {
      const nextEvent = this.playlist[this.currentIndex + 1];
      if (nextEvent && this._isPlayer(nextEvent)) keepChildSlot = this._slotFor(this.currentIndex + 1);
    }
    this._cancelChildEvents(keepChildSlot);  // Grafik-Child-Events des vorigen Events abbrechen
    this.currentIndex++;

    if (this.currentIndex >= this.playlist.length) {
      this._log('Playlist ENDE');
      this._running = false;
      if (this.opts.loop) {
        this._log('Loop → restart in 500ms');
        setTimeout(() => this.start(0), 500);
        return;
      }
      try { this.master.switchTo(this.idlePad); } catch {}
      this.emit('ended');
      return;
    }

    const event = this.playlist[this.currentIndex];

    // Fix-Timer für jetzt erreichtes Event löschen
    if (this._fixTimers.has(this.currentIndex)) {
      clearTimeout(this._fixTimers.get(this.currentIndex));
      this._fixTimers.delete(this.currentIndex);
    }

    this._setState(this.currentIndex, 'playing');
    this.emit('current', { index:this.currentIndex, event });
    this._log(`Event ${this.currentIndex+1}/${this.playlist.length}: ${event.file||event.source||'?'}`);

    this._executeEvent(event).catch(err => {
      this._log(`Event-Fehler [${this.currentIndex+1}]: ${err.message}`, 'error');
      this._setState(this.currentIndex, 'skipped');
      this.emit('not-played', { event, reason: 'error', detail: err.message, plannedSec: fromTC(event.eom, this.fps) || fromTC(event.duration, this.fps) || 0 });
      this._advancing = false;
      this._advance();
    });
  }

  // ── Execute ────────────────────────────────────────────────────────────────

  async _executeEvent(event) {
    const fps  = this.fps;
    const src  = event.source || 'player';

    // ── startType=fixtime (auch für Meta-Events wie block_start) ─────────────
    const _skipFixtime = this._forceNextImmediate;
    this._forceNextImmediate = false;
    if (!_skipFixtime && event.startType === 'fixtime' && event.startTime) {
      const msUntil = msUntilWallClock(event.startTime, this.fps);
      const GRACE = 500;
      if (msUntil !== null && msUntil > GRACE) {
        const frozenIdx = this.currentIndex;
        this._gapEvent = { idx: frozenIdx, event };
        this._log(`⏳ Fixtime-Gap: warte ${Math.round(msUntil/1000)}s bis @${event.startTime} → ${this.opts.gapSource||'black'}`);
        // Clip-Gap: Gap-Datei im dedizierten Idle-Player abspielen (loopend)
        if (this.opts.gapSource === 'clip' && this.opts.gapFile) {
          const gapSlot = this.opts.idleSlot || 'playerIdle';
          const gapPlayer = this.players[gapSlot];
          const absGap = this.opts.resolveFilePath?.(this.opts.gapFile) || resolveFile(this.opts.gapFile, this.opts.mediaDir);
          if (gapPlayer && absGap) {
            try {
              await gapPlayer.load({ filePath: absGap, som: 0, eom: null, audioConfig: {} });
              await gapPlayer.go();
              this.master.switchTo(this._padFor(gapSlot));
              this._log(`Gap-Clip: ${path.basename(absGap)} auf ${gapSlot}`);
              // Loop: bei EOS neu laden solange Gap noch aktiv
              const loopEos = async () => {
                if (!this._gapEvent) return;
                try {
                  await gapPlayer.load({ filePath: absGap, som: 0, eom: null, audioConfig: {} });
                  await gapPlayer.go();
                } catch (e) { this._log(`Gap-Clip Loop Fehler: ${e.message}`, 'warn'); }
              };
              gapPlayer.on('eos', loopEos);
              this._gapLoopCleanup = () => gapPlayer.removeListener('eos', loopEos);
            } catch (e) {
              this._log(`Gap-Clip Fehler: ${e.message}`, 'warn');
              try { this.master.switchTo(this.gapPad); } catch {}
            }
          } else {
            this._log(`Gap-Clip: Datei nicht gefunden: ${this.opts.gapFile}`, 'warn');
            try { this.master.switchTo(this._N + 1); } catch {}  // padBlack
          }
        } else {
          try { this.master.switchTo(this.gapPad); } catch {}
        }
        this.emit('playing', {
          event, slotId: null,
          clipDur: msUntil / 1000, postrollSec: 0, fixEnd: event.startTime,
        });
        this._preCueBeforeTime(msUntil);
        this._mainTimer = setTimeout(() => {
          if (!this._running || !this._gapEvent) return;
          if (this.currentIndex !== frozenIdx) return;
          this._log(`⏰ Fixtime-Gap abgelaufen → Event ${frozenIdx+1}: ${event.source}`);
          this._gapEvent = null;
          this._gapLoopCleanup?.(); this._gapLoopCleanup = null;
          this._clearEventTimers();
          this._cancelChildEvents();
          this._setState(frozenIdx, 'playing');
          this.emit('current', { index: frozenIdx, event });
          this._executeEvent(event).catch(err => {
            this._log(`Event-Fehler [${frozenIdx+1}]: ${err.message}`, 'error');
            this._setState(frozenIdx, 'skipped');
            this._advance();
          });
        }, msUntil);
        return;
      }
    }

    // Meta-Events: reine Playlist-Marker — sofort weiter
    if (src === 'comment') {
      this._setState(this.currentIndex, 'done');
      this._advancing = false;
      this._advance();
      return;
    }

    if (src === 'block_start') {
      // Grafik-Children über gesamte Blockdauer schedulen
      if (this.grafixEngine && event.children?.length) {
        const blockDur = this._blockDurSec(this.currentIndex);
        this._blockChildCleanup?.();  // vorherigen Block-Cleanup sicherheitshalber aufräumen
        const _plCtxBlock = { playlist: this.playlist, currentIndex: this.currentIndex, fps };
        this._blockChildCleanup = this.grafixEngine.scheduleChildEvents(
          event, blockDur > 0 ? blockDur : null, fps,
          (info) => {
            this.emit('grafik', info);
            this._handleGrafikDve(info);
            if (this.master) {
              if (info.action === 'show') this.master.showGrafik?.();
              else if (info.action === 'hide') {
                if (!this.grafixEngine._activeGrafiks?.size) this.master.hideGrafik?.();
              }
            }
          },
          _plCtxBlock,
          { latencyMs: this.opts.grafikLatencyMs || 0, resolveImagePath: f => this._resolveImagePath(f) }
        );
      }
      const blockDurForEmit = this._blockDurSec(this.currentIndex);
      this.emit('block-start', { event, blockDur: blockDurForEmit });
      this._setState(this.currentIndex, 'done');
      this._advancing = false;
      this._advance();
      return;
    }

    if (src === 'block_end') {
      this._blockChildCleanup?.();
      this._blockChildCleanup = null;
      this.emit('block-end', { event });
      this._setState(this.currentIndex, 'done');
      this._advancing = false;
      this._advance();
      return;
    }

    const endT = event.endType || 'sequential';
    const tr   = event.transition || 'cut';
    const trSp = event.transitionSpeed || 'fast';
    const br   = event.branding || null;
    const trMs = this.transition?.durationMs?.(trSp) ?? 500;

    // Datei auflösen (Plugin-Override hat Priorität vor mediaDir-Suche)
    let absFile = null;
    if (this._isPlayer(event)) {
      absFile = this.opts.resolveFilePath?.(event.file) || resolveFile(event.file, this.opts.mediaDir);
      if (!absFile) {
        // Primäre Quelle nicht gefunden → Backup-Verzeichnisse versuchen
        const backupAbs = this._resolveBackupFile(event.file);
        if (backupAbs) {
          this._log(`⚠ Primär-Datei nicht gefunden — Backup-Pfad: ${path.basename(backupAbs)}`, 'warn');
          this.emit('backup-active', { fromSlot: null, toSlot: null, reason: 'file-missing', event, backupFile: backupAbs });
          absFile = backupAbs;
        } else if (this.opts.missingBehavior === 'idle') {
          this._log(`Event ${this.currentIndex+1}: "${event.file||'?'}" nicht gefunden → Idle-Quelle`, 'warn');
          this._setState(this.currentIndex, 'idle-fallback');
          const durSec = (fromTC(event.eom, this.fps) || fromTC(event.duration, this.fps)) || 5;
          await this.transition.transition(this.idlePad, tr, trSp);
          try { this.master.setBranding?.(br, true); } catch {}
          this.emit('playing', { event, slotId: null, clipDur: durSec, postrollSec: 0, subReason: 'missing-media' });
          this._schedulePreCues(this.currentIndex, durSec * 1000);
          this._mainTimer = setTimeout(() => {
            this._setState(this.currentIndex, 'done'); this._advance();
          }, durSec * 1000);
          return;
        } else {
          this._log(`Event ${this.currentIndex+1}: "${event.file||'?'}" nicht gefunden → übersprungen`, 'warn');
          this._setState(this.currentIndex, 'skipped');
          const _durSec = (fromTC(event.eom, this.fps) || fromTC(event.duration, this.fps)) || 0;
          this.emit('not-played', { event, reason: 'missing-media', plannedSec: _durSec });
          this._advancing = false;
          this._advance(); return;
        }
      }
    }

    // ── Statische Quellen ─────────────────────────────────────────────────
    if (src === 'smpte' || src === 'black' || src === 'image') {
      let pad = src === 'smpte' ? this._N : src === 'black' ? this._N + 1 : this._N + 2;

      // Bei image: Playlist-Bild laden (padImagePl) — Idle-Bild (padImage) bleibt unberührt
      if (src === 'image' && event.file) {
        const imgPath = resolveFile(event.file, this.opts.mediaDir, true);
        if (imgPath) {
          await this.master.showPlaylistImage(imgPath);
          pad = this._N + 3;  // padImagePl
        } else {
          this._log(`Image: "${event.file}" nicht gefunden (gesucht in images/, channelbranding/, media/) → black`, 'warn');
          pad = this._N + 1;  // padBlack
        }
      }
      const durSec = fromTC(event.duration ?? 5, fps) || 5;
      await this.transition.transition(pad, tr, trSp);
      try { this.master.setBranding?.(br, true); } catch {}  // instant für statische Quellen
      this.emit('playing', { event, slotId:null, clipDur:durSec, postrollSec:0,
        fixEnd: endT==='fixtime' ? event.fixTime : null });
      if (endT === 'manual') {
        this._paused = true;
        this.emit('manual-hold', { index:this.currentIndex, event });
        this._log('Manual hold');
        return;
      }
      if (endT === 'fixtime' && event.fixTime) {
        this._holdToFixtime(event.fixTime, null, durSec); return;
      }
      this._schedulePreCues(this.currentIndex, durSec*1000);
      this._mainTimer = setTimeout(() => {
        this._setState(this.currentIndex, 'done'); this._advance();
      }, durSec*1000);
      return;
    }

    // ── Generisches Live-Event (source='live', auto-Slot-Zuweisung) ──────
    if (this._isGenericLive(event)) {
      const liveSlot = this._liveSlotFor(this.currentIndex);
      if (!liveSlot) {
        this._log('Keine Live-Quellen konfiguriert → übersprungen', 'warn');
        this._setState(this.currentIndex, 'skipped');
        this.emit('not-played', { event, reason: 'no-live-source', plannedSec: fromTC(event.duration ?? 5, fps) || 5 });
        this._advancing = false; this._advance(); return;
      }
      // Routing-Befehl falls Precue-Timer ihn noch nicht gefeuert hat
      if (this._onAirLiveSlot !== liveSlot) {
        this._emitLivePrecue(this.currentIndex, liveSlot);
      }
      this._onAirLiveSlot = liveSlot;
      const pad = this._padForSource(liveSlot);
      if (pad < 0) {
        this._log(`Live-Slot "${liveSlot}" hat keinen GStreamer-Pad → übersprungen`, 'warn');
        this._setState(this.currentIndex, 'skipped');
        this.emit('not-played', { event, reason: 'no-pad', plannedSec: fromTC(event.duration ?? 5, fps) || 5 });
        this._advancing = false; this._advance(); return;
      }
      this._applyLiveAudioPreset(liveSlot, event);
      if (await this._handleInvalidLiveSignal(liveSlot, event, tr, trSp, br, fps)) return;
      const durSec = fromTC(event.duration ?? 5, fps) || 5;
      await this.transition.transition(pad, tr, trSp);
      try { this.master.setBranding?.(br, true); } catch {}
      this.emit('playing', {
        event, slotId: null, liveSlot, upstreamSource: event.liveSource || '',
        clipDur: durSec, postrollSec: 0,
        fixEnd: endT === 'fixtime' ? event.fixTime : null,
      });
      if (endT === 'manual') {
        this._paused = true;
        this.emit('manual-hold', { index: this.currentIndex, event }); return;
      }
      if (endT === 'fixtime' && event.fixTime) {
        this._holdToFixtime(event.fixTime, null, durSec); return;
      }
      this._schedulePreCues(this.currentIndex, durSec * 1000);
      this._mainTimer = setTimeout(() => {
        this._onAirLiveSlot = null;
        this._setState(this.currentIndex, 'done'); this._advance();
      }, durSec * 1000);
      return;
    }

    // ── Dynamische Live-Quelle (explizit, source = live1/live2/…) ────────
    if (this._isLiveSource(event)) {
      const pad = this._padForSource(src);
      if (pad < 0) {
        this._log(`Live-Quelle "${src}" nicht konfiguriert → übersprungen`, 'warn');
        this._setState(this.currentIndex, 'skipped');
        this.emit('not-played', { event, reason: 'no-pad', plannedSec: fromTC(event.duration ?? 5, fps) || 5 });
        this._advancing = false; this._advance(); return;
      }
      // Emit live-precue so server starts the on-demand feeder pipeline (no-op for embedded sources).
      // Needed when this is the first/current event — pre-cue timers from prior events won't fire.
      this._emitLivePrecue(this.currentIndex, src);
      this._applyLiveAudioPreset(src, event);
      if (await this._handleInvalidLiveSignal(src, event, tr, trSp, br, fps)) return;
      const durSec = fromTC(event.duration ?? 5, fps) || 5;
      await this.transition.transition(pad, tr, trSp);
      try { this.master.setBranding?.(br, true); } catch {}
      this.emit('playing', { event, slotId: null, clipDur: durSec, postrollSec: 0,
        fixEnd: endT === 'fixtime' ? event.fixTime : null });

      // Grafik-Child-Events schedulen — fehlte bisher für Live-Quellen-Events
      // (nur der Player-Event-Pfad rief scheduleChildEvents() auf), weshalb Bild-/
      // HTML-Children inkl. DVE/Squeeze bei source=<liveId> nie aktiv wurden.
      // (Vorheriges Event wurde bereits in _advance()/startCueFirst() via
      // _cancelChildEvents() aufgeräumt — hier nur neu schedulen.)
      if (this.grafixEngine && event.children?.length) {
        // endType='manual' (Hold): durSec ist nur die GEPLANTE Dauer — das Event hält
        // tatsächlich beliebig lange an, bis der Operator manuell weiterschaltet. Children
        // mit endOffset ("X Sekunden vor Ende") dürfen sich daher NICHT relativ zu durSec
        // berechnen (sonst verschwinden sie zur geplanten Zeit, während das Hold weiterläuft)
        // — null clipDurationSec lässt GrafixEngine sie bis zum echten Cleanup (Event-Wechsel)
        // offen halten.
        const childClipDur = endT === 'manual' ? null : durSec;
        const _plCtxLive = { playlist: this.playlist, currentIndex: this.currentIndex, fps,
                             currentClipRemainingSec: durSec };
        this._childCleanup = this.grafixEngine.scheduleChildEvents(event, childClipDur, fps, (info) => {
          this.emit('grafik', info);
          this._handleGrafikDve(info);
          if (this.master) {
            if (info.action === 'show') this.master.showGrafik?.();
            else if (info.action === 'hide') {
              if (!this.grafixEngine._activeGrafiks?.size) this.master.hideGrafik?.();
            }
          }
        }, _plCtxLive, { latencyMs: this.opts.grafikLatencyMs || 0, resolveImagePath: f => this._resolveImagePath(f) });
      }

      if (endT === 'manual') {
        this._paused = true;
        this.emit('manual-hold', { index: this.currentIndex, event });
        this._log('Manual hold');
        return;
      }
      if (endT === 'fixtime' && event.fixTime) {
        this._holdToFixtime(event.fixTime, null, durSec); return;
      }
      this._schedulePreCues(this.currentIndex, durSec * 1000);
      this._mainTimer = setTimeout(() => {
        this._setState(this.currentIndex, 'done'); this._advance();
      }, durSec * 1000);
      return;
    }

    // ── Player-Event ──────────────────────────────────────────────────────
    const slotId = this._slotFor(this.currentIndex);
    this._swappedSlots.delete(slotId);  // neues Event auf diesem Slot — Swap-Guard zurücksetzen
    const player = this.players[slotId];
    if (!player) {
      this._log(`Kein Player für Slot "${slotId}" → übersprungen`, 'error');
      this._setState(this.currentIndex, 'skipped');
      this.emit('not-played', { event, reason: 'no-player', plannedSec: (fromTC(event.eom, this.fps) || fromTC(event.duration, this.fps)) || 0 });
      this._advancing = false; this._advance(); return;
    }

    // Frame-genaue Zeitwerte (auf Frame-Grenze runden)
    // somMode: 'media' = full clip, 'segment' = named segment, 'user' = manual som/eom (default)
    let _som = event.som ?? 0, _eom = event.eom;
    if (event.somMode === 'media') {
      _som = 0; _eom = null;
    } else if (event.somMode === 'segment' && event.segmentName) {
      const seg = this.opts.getSegment?.(event.file, event.segmentName);
      if (seg) { _som = seg.som ?? 0; _eom = seg.eom ?? null; }
    }
    const somSec  = Math.round((fromTC(_som ?? 0, fps) || 0) * fps) / fps;
    const eomRaw  = _eom != null ? (fromTC(_eom, fps)||0) : null;
    const eomDur  = eomRaw != null ? Math.round(eomRaw * fps) / fps : null;
    const eomAbs  = eomDur != null ? somSec + eomDur : null;
    const prSec   = Math.round((fromTC(event.postroll ?? 0, fps) || 0) * fps) / fps;
    const clipDur = eomDur ?? 0;

    // Capture generation so we can detect if jumpInterrupt fired while _doCue was running.
    const _execGen = this._execGeneration;

    // Skip _doCue if the player is already cued or already running the correct file
    // (the latter happens when startCueFirst/forceJump pre-cued on this slot and the
    // player transitioned to running state before _executeEvent was called).
    const alreadyReady = this._cueQueue[slotId] === event.file &&
                         (player.cued || player.running);
    if (!alreadyReady)
      // leadMs=0: Cue läuft hier direkt am On-Air-Wechsel — kein Vorlauf mehr übrig.
      await this._doCue(event, slotId, absFile, somSec, eomAbs, 0);

    // jumpInterrupt() increments _execGeneration and calls _stopAll() before our _doCue
    // finished.  load() inside _doCue survives the stop (it awaits _pendingStop, then
    // continues) so the player ends up cued — but we must NOT call go() or switchFn(),
    // which would override the interrupt's pad switch and _mainTimer.
    if (this._execGeneration !== _execGen) return;

    // Pre-apply pgm duck for immediate VO (delay=0) BEFORE player audio becomes audible.
    // Without this, duck/fadeIn fires after switchTo() → clip plays at full level briefly.
    this._preDuckImmediateVO(event);
    // Gleiches Timing-Problem wie oben, nur für DVE/Squeeze (dve.target='video', delay≈0):
    // muss VOR switchFn() angewendet sein, sonst läuft das erste Frame des neuen Clips noch
    // unkomprimiert raus (scheduleChildEvents() unten feuert immer NACH dem Switch — egal
    // wie kurz effDelayMs ist, der Aufruf selbst kommt erst danach).
    await this._preApplyImmediateDve(event);
    // Zweite Generation-Guard: jumpInterrupt() kann während _preApplyImmediateDve awaitet
    // feuern (nach dem ersten Check oben). Falls das passiert, hat _cancelChildEvents()
    // schon gelaufen BEVOR _preApplyImmediateDve den DVE angewendet hat → kein Cleanup.
    if (this._execGeneration !== _execGen) {
      if (this._activeDveIds?.size && this.master) {
        this._activeDveIds.clear();
        this.master.clearDveSqueeze?.();
      }
      return;
    }

    // Transition + Play
    // WICHTIG: go() muss VOR switchTo() kommen damit der Player bereits
    // Frames liefert wenn der Master-Switch passiert → kein Schwarzbild.
    // setBranding mit 1-Frame-Delay (40ms@25fps) damit Logo nicht vor
    // dem ersten Videobild erscheint.
    const frameMs = Math.round(1000 / fps);
    // Warten bis der Player sicher Frames liefert.
    // Bei Slot-Wechsel (anderer Slot war on-air): 2 Frame-Delays für Decoder-Anlauf.
    // Bei gleichem Slot (z.B. nach Gap): 1 Frame genügt.
    const slotChanging = this._onAirSlot !== slotId;
    const switchDelayMs = slotChanging ? frameMs * 2 : frameMs;

    const switchFn = event._offClipMode && this.master.switchVideoOnly
      ? (pad) => this.master.switchVideoOnly(pad)
      : (pad) => this.master.switchTo(pad);

    // Record timestamp right after go() so VO timers can compensate for
    // the elapsed time between go() and _scheduleVoiceoverChildren().
    let _voGoMs = 0;

    if (tr === 'cut') {
      await player.go(); _voGoMs = Date.now();
      await new Promise(r => setTimeout(r, switchDelayMs));
      switchFn(this._padFor(slotId));
      if (br) setTimeout(() => { try { this.master.setBranding?.(br, false); } catch {} }, frameMs);
      else    try { this.master.setBranding?.(null, true); } catch {}
    } else if (tr === 'fade-cut') {
      if (event._offClipMode) {
        await player.go(); _voGoMs = Date.now();
        await new Promise(r => setTimeout(r, switchDelayMs));
        switchFn(this._padFor(slotId));
      } else {
        // Defer go() until just before the actual switch (not the start of the
        // fade-out) so the cut lands on the incoming clip's first frame instead
        // of a frame `trMs` into it — see fadeCutTo's preSwitch/leadMs handling.
        const preSwitch = async () => { await player.go(); _voGoMs = Date.now(); };
        await this.master.fadeCutTo(this._padFor(slotId), trMs, br, preSwitch, switchDelayMs);
      }
    } else if (tr === 'v-fade') {
      if (event._offClipMode) {
        await player.go(); _voGoMs = Date.now();
        await new Promise(r => setTimeout(r, switchDelayMs));
        switchFn(this._padFor(slotId));
      } else {
        // Same reasoning as fade-cut: start the incoming clip right before the
        // switch at the black point, not at the top of the fade-out.
        const preSwitch = async () => { await player.go(); _voGoMs = Date.now(); };
        await this.master.vFadeTo(this._padFor(slotId), trMs, br, preSwitch, switchDelayMs);
      }
    } else if (tr === 'cut-fade') {
      await player.go(); _voGoMs = Date.now();
      await new Promise(r => setTimeout(r, switchDelayMs));
      event._offClipMode ? switchFn(this._padFor(slotId)) : await this.master.cutFadeTo(this._padFor(slotId), trMs, br);
    } else if (tr === 'xfade') {
      await player.go(); _voGoMs = Date.now();
      event._offClipMode ? switchFn(this._padFor(slotId)) : this.master.xFadeTo(this._padFor(slotId), trMs, br).catch(() => {});
    } else {
      await player.go(); _voGoMs = Date.now();
      await new Promise(r => setTimeout(r, switchDelayMs));
      switchFn(this._padFor(slotId));
      if (br) setTimeout(() => { try { this.master.setBranding?.(br, false); } catch {} }, frameMs);
      else    try { this.master.setBranding?.(null, true); } catch {}
    }

    player.startPositionPoll?.(Math.round(1000 / fps));  // 1 Frame pro Poll-Intervall
    this._onAirSlot = slotId;
    this._cueQueue[slotId] = null;

    // ── Backup-Player pre-cuen + Failover-Listener ────────────────────────────
    if (this._backupSlot && this._backupSlot !== slotId) {
      this._backupCleanup?.(); this._backupCleanup = null;
      this._backupActive = false;
      const backupFile = this._resolveBackupFile(event.file) || absFile; // Fallback: gleicher Pfad
      const bp = this.players[this._backupSlot];
      if (bp) {
        // leadMs=null: Backup-Slot geht (normalerweise) nicht selbst on-air —
        // kein "vor Start"-Pre-Schedule hierfür anlegen (würde mit dem des
        // Primär-Slots kollidieren/falsch feuern, falls derselbe Slot später
        // regulär gecued wird).
        this._doCue(event, this._backupSlot, backupFile, somSec, eomAbs, null)
          .then(() => this._log(`Backup gecued: ${path.basename(backupFile)}`, 'debug'))
          .catch(e => this._log(`Backup-Cue Fehler: ${e.message}`, 'warn'));
        // Failover bei Playback-Fehler des Primär-Players
        const onErr = () => this._triggerFailover(slotId, event);
        player.once('error', onErr);
        this._backupCleanup = () => player.removeListener('error', onErr);
      }
    }

    // Grafik-Child-Events schedulen (mit clip-Dauer für relative Endpunkte)
    // effClip wird unten ermittelt — Schedule NACH Dauer-Ermittlung
    // Hier erst die effektive Clip-Dauer berechnen, dann schedulen

    // Effektive Clip-Dauer (frame-genau auf Frame-Grenze runden)
    // queryDuration() braucht evtl. einen Moment nach go() — bis zu 3 Versuche
    let effClip = clipDur;
    if (effClip <= 0) {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 80));
        try {
          const q = player.vPipeline?.queryDuration?.();
          if (q > 0 && q <= MAX_SANE_DUR) {
            effClip = Math.round(q * fps) / fps;
            event._clipDur = effClip;
            this._log(`Dauer: ${toTC(effClip, fps)}`);
            break;
          } else if (q > MAX_SANE_DUR) {
            // Container-Dauer-Bug (z.B. BBB 720p meldet 3h) → ignorieren, auf EOS warten
            this._log(`queryDuration=${toTC(q,fps)} > ${MAX_SANE_DUR/3600}h → ignoriert, EOS-gesteuert`, 'warn');
            break;
          }
        } catch {}
      }
    }
    // Use library-cached duration before falling back to FALLBACK_DUR.
    // queryDuration() often fails on MXF immediately after go() — the inter-pipeline
    // separation means the video pipeline hasn't negotiated the duration yet.
    // event._clipDur is set by MediaLibrary analysis and is always reliable.
    if (effClip <= 0 && event._clipDur > 0 && event._clipDur < MAX_SANE_DUR) {
      effClip = Math.round(event._clipDur * fps) / fps;
    }
    // effClip=0 → Dauer unbekannt → EOS steuert das Ende, Timer nur als langer Sicherheitsfallback
    if (effClip <= 0) effClip = FALLBACK_DUR;

    if (this.grafixEngine && event.children?.length) {
      // endType='manual' (Hold): effClip ist nur die GEPLANTE/gemessene Clip-Dauer — bei
      // Hold läuft das Event nach Clip-Ende beliebig lange weiter (letztes Bild steht).
      // Children mit endOffset ("X Sekunden vor Ende") dürfen sich nicht relativ zu
      // effClip berechnen, sonst verschwinden sie zur geplanten Zeit statt mit dem
      // tatsächlichen (durch den Operator bestimmten) Event-Ende.
      const childClipDur = endT === 'manual' ? null : effClip;
      const _plCtx = { playlist: this.playlist, currentIndex: this.currentIndex, fps,
                       currentClipRemainingSec: effClip };
      this._childCleanup = this.grafixEngine.scheduleChildEvents(event, childClipDur, fps, (info) => {
        this.emit('grafik', info);
        this._handleGrafikDve(info);
        if (this.master) {
          if (info.action === 'show') this.master.showGrafik?.();
          else if (info.action === 'hide') {
            if (!this.grafixEngine._activeGrafiks?.size) this.master.hideGrafik?.();
          }
        }
      }, _plCtx, { latencyMs: this.opts.grafikLatencyMs || 0, resolveImagePath: f => this._resolveImagePath(f) });
      // Pre-child cleanup für diesen Slot nicht mehr nötig — wurde in _cancelChildEvents aufgeräumt
      this._preChildCleanups.delete(slotId);
    }

    // Voiceover-Children planen — subtract elapsed since go() for accurate timing
    if (this.voiceoverEngine) {
      const _voElapsed = _voGoMs > 0 ? Math.max(0, Date.now() - _voGoMs) : 0;
      this._scheduleVoiceoverChildren(event, effClip, fps, _voElapsed);
    }

    // Record-Children planen
    this._scheduleRecordChildren(event, effClip, fps);

    // Trigger-Children planen (Cross-Channel-Befehle, siehe ChannelBus.js)
    this._scheduleTriggerChildren(event, effClip, fps);

    // Postroll ebenfalls frame-genau runden
    const prSecAligned = Math.round(prSec * fps) / fps;
    const totalSec = effClip + prSecAligned;

    // Xfade look-ahead — declare early: used by effClipForClient, _schedulePreCues, and timer.
    // If the NEXT sequential player event uses xfade, we must advance `xfadeEarlyMs` before
    // this clip's natural end so both clips overlap for the transition duration.
    const _nextEv = this.playlist[this.currentIndex + 1];
    const xfadeEarlyMs = (endT === 'sequential' && _nextEv?.transition === 'xfade' && this._isPlayer(_nextEv))
      ? Math.min(
          this.transition?.durationMs?.(_nextEv.transitionSpeed || 'fast') ?? 500,
          Math.max(0, Math.round(totalSec * 1000) - 1000)
        )
      : 0;

    // Wenn effClip der Fallback ist (Dauer unbekannt), dem Client 0 melden → Counter zeigt "--:--:--"
    // For xfade: subtract the overlap so the countdown reflects actual on-air time.
    const effClipForClient = (effClip === FALLBACK_DUR && clipDur <= 0)
      ? 0
      : Math.max(0, effClip - xfadeEarlyMs / 1000);

    this._log(`▶ ${slotId}: ${event.file} SOM=${toTC(somSec,fps)} clip=${effClip===FALLBACK_DUR&&clipDur<=0?'?':toTC(effClip,fps)} pr=${toTC(prSecAligned,fps)}`);
    this.emit('playing', { event, slotId, clipDur: effClipForClient, postrollSec: prSecAligned,
      clipDurTC: effClipForClient > 0 ? toTC(effClipForClient,fps) : '?:??:??:??',
      postrollTC: toTC(prSecAligned,fps),
      fixEnd: endT==='fixtime' ? event.fixTime : null });

    // Postroll — frame-genauer Timer
    if (prSecAligned > 0) {
      this._prTimer = setTimeout(async () => {
        try { await player.pause(); } catch {}
        this._log(`Postroll: ${toTC(prSecAligned,fps)}`);
        this.emit('postroll-start', { slotId });
      }, Math.round(effClip * 1000));  // ms-genau
    }

    // For xfade: use effective duration so pre-cue timers for subsequent events fire
    // relative to the actual advance time, not the natural clip end.
    this._schedulePreCues(this.currentIndex, Math.max(1000, totalSec*1000 - xfadeEarlyMs));

    // End-Type
    if (endT === 'fixtime' && event.fixTime) {
      this._holdToFixtime(event.fixTime, slotId, effClip); return;
    }
    if (endT === 'manual') {
      this._waitManual(slotId, player, eomAbs, effClip); return;
    }

    // Shared one-shot advance — safe to call from either the xfade timer or the eom guard.
    let _advanceFired = false;
    const _doAdvance = () => {
      if (_advanceFired) return;
      _advanceFired = true;
      try { player.stopPositionPoll?.(); } catch {}
      this._setState(this.currentIndex, 'done');
      this._advance();
    };

    if (xfadeEarlyMs > 0) {
      // Frame-accurate xfade advance: fire when position crosses the threshold rather
      // than using setTimeout. setTimeout-based timing drifts by the xFadeTo() await
      // duration (trMs), causing a gap equal to the crossfade duration after the event.
      const xfadeThresholdSec = effClip - xfadeEarlyMs / 1000;
      const eomTol = 1.5 / fps;
      this._log(`Xfade: advance at pos>=${xfadeThresholdSec.toFixed(3)}s (${xfadeEarlyMs}ms early)`, 'debug');

      const xfadeEomGuard = (sid) => {
        if (sid !== slotId) return;
        if (this._swappedSlots.has(slotId)) { this.removeListener('eom', xfadeEomGuard); return; }
        this.removeListener('eom', xfadeEomGuard);
        this.removeListener('player-position', posWatcher);
        if (this._mainTimer) { clearTimeout(this._mainTimer); this._mainTimer = null; }
        _doAdvance();
      };

      const posWatcher = ({ slotId: sid, pos }) => {
        if (sid !== slotId || pos == null) return;
        if (this._swappedSlots.has(slotId)) return;
        if (pos >= xfadeThresholdSec - eomTol) {
          this.removeListener('player-position', posWatcher);
          this.removeListener('eom', xfadeEomGuard);
          if (this._mainTimer) { clearTimeout(this._mainTimer); this._mainTimer = null; }
          _doAdvance();
        }
      };

      this.on('eom', xfadeEomGuard);
      this.on('player-position', posWatcher);

      // Fallback only — fires if position poll never reaches threshold (unknown duration)
      const fallbackMs = Math.max(1000, Math.round(totalSec * 1000) - xfadeEarlyMs + 500);
      this._mainTimer = setTimeout(() => {
        this.removeListener('eom', xfadeEomGuard);
        this.removeListener('player-position', posWatcher);
        _doAdvance();
      }, fallbackMs);
    } else {
      // Sequential — primär über EOM-Event des Players gesteuert (frame-genau),
      // sekundär setTimeout als Sicherheits-Fallback (+2 Frames Toleranz).
      const eomHandler = (sid, _posData) => {
        if (sid !== slotId) return;
        if (this._swappedSlots.has(slotId)) { this.removeListener('eom', eomHandler); return; }
        this.removeListener('eom', eomHandler);
        if (this._mainTimer) { clearTimeout(this._mainTimer); this._mainTimer = null; }
        _doAdvance();
      };
      this.on('eom', eomHandler);
      const fallbackMs = Math.round((totalSec + 2/fps) * 1000);
      this._mainTimer = setTimeout(() => {
        this.removeListener('eom', eomHandler);
        _doAdvance();
      }, fallbackMs);
    }
  }

  // ── Fix-End ────────────────────────────────────────────────────────────────

  _holdToFixtime(fixTime, slotId, clipDur) {
    const ms = msUntilWallClock(fixTime, this.fps);
    if (ms === null || ms === 0) {
      this._log(`FixEnd @${fixTime}: ${ms===0?'Grace-Fenster':'ungültig'} → sofort weiter`);
      this._setState(this.currentIndex, 'done'); this._advance(); return;
    }
    this._log(`FixEnd: warte ${Math.round(ms/1000)}s bis @${fixTime}`);
    this.emit('playing', {
      event: this.playlist[this.currentIndex], slotId,
      clipDur: ms/1000, postrollSec:0, fixEnd: fixTime,
    });
    // Gap-Füller falls Clip endet vor Fixtime (nur für File-Player, nicht für statische/Live-Quellen)
    if (slotId && clipDur > 0 && clipDur*1000 < ms-500) {
      this._precTimers.push(setTimeout(() => {
        if (!this._running) return;
        if (slotId) try { this.players[slotId]?.stopPositionPoll?.(); } catch {}
        try { this.master.switchTo(this.gapPad); } catch {}
        this._log(`FixEnd Gap → ${this.opts.gapSource||'black'}`);
      }, clipDur*1000));
    }
    this._preCueBeforeTime(ms);
    this._mainTimer = setTimeout(() => {
      if (slotId) try { this.players[slotId]?.stopPositionPoll?.(); } catch {}
      this._setState(this.currentIndex, 'done');
      this._log(`⏰ FixEnd EXAKT @${fixTime} → nächstes Event`);
      this._advance();
    }, ms);
  }

  // ── Manual Hold ────────────────────────────────────────────────────────────

  _waitManual(slotId, player, eomAbs, clipDur) {
    const onEom = () => {
      if (this._mainTimer) { clearTimeout(this._mainTimer); this._mainTimer = null; }
      try { player.stopPositionPoll?.(); } catch {}
      this._paused = true;
      this._log('Manual hold — letztes Frame');
      this.emit('manual-hold', { index:this.currentIndex, event:this.playlist[this.currentIndex] });
    };
    if (clipDur > 0) this._mainTimer = setTimeout(onEom, (clipDur+0.5)*1000);
    const eomHandler = (sid, _d) => {
      if (sid !== slotId) return;
      this.removeListener('eom', eomHandler); onEom();
    };
    this.on('eom', eomHandler);
    if (eomAbs == null && clipDur <= 0) {
      let last=-1, stalled=0;
      this._eosCheck = setInterval(() => {
        try {
          const pos = player.vPipeline?.queryPosition?.() ?? null;
          if (pos==null||Math.abs(pos-last)<0.05) stalled++; else { stalled=0; last=pos; }
          if (stalled>=5) { clearInterval(this._eosCheck); this._eosCheck=null; this.removeListener('eom',eomHandler); onEom(); }
        } catch {}
      }, 300);
    }
  }

  // ── Pre-Cue ────────────────────────────────────────────────────────────────

  async _earlyPreCue(fromIndex) {
    // SEQUENTIAL loading — must NOT be parallelised with Promise.all.
    //
    // Parallel loading caused all three problems reported:
    //   1. Video/audio dropouts: 3 MXF pipelines prerolling simultaneously saturate
    //      CPU and the Node.js event loop, starving the already-running master pipeline.
    //   2. EOS detection delayed: event-loop saturation delays busPop() in _watchVideoBus;
    //      player2's EOS at T=18s is missed, the fallback timer at T=20s fires instead
    //      → event[2] starts exactly xfadeEarlyMs (2s) too late.
    //
    // Sequential loading keeps only one MXF decoder active at a time. The startup
    // wait is longer (numSlots × ~12s) but the running system is stable.
    // Pre-cuing all numSlots events ensures player3 is ready before it is needed,
    // even on slow machines where loading takes >PRE_CUE_MS.
    let n = 0;
    let firstSlot = null;  // Slot des ersten (= als nächstes startenden) Player-Events
    for (let i = fromIndex; i < this.playlist.length && n < this._slotIds.length; i++) {
      const ev = this.playlist[i];
      if (!this._isPlayer(ev)) continue;
      const slot = this._slotFor(i);
      if (firstSlot === null) firstSlot = slot;
      // Never cue into the on-air slot during smooth-transition start — the on-air
      // player must keep running so _executeEvent can fade FROM it.
      if (slot === this._onAirSlot && this.players[slot]?.running) { n++; continue; }
      if (this._cueQueue[slot] === ev.file &&
          (this.players[slot]?.cued || this.players[slot]?.running)) { n++; continue; }
      // Nur für firstSlot ist die Lead-Zeit bekannt (≈0 — wird direkt im Anschluss
      // per _advance(firstSlot) on-air geschaltet). Für die übrigen vorab-gecuten
      // Slots ist die tatsächliche Vorlaufzeit hier unbekannt (hängt von der noch
      // nicht laufenden Wiedergabe ab) — leadMs=null überspringt deren "vor Start"-
      // Pre-Schedule; _schedulePreCues legt ihn später mit korrektem Wert an.
      await this._doCue(ev, slot, undefined, undefined, undefined, slot === firstSlot ? 0 : null);
      n++;
    }
    // Slot des ersten Player-Events zurückgeben, damit der Aufrufer dessen frisch
    // angelegten negative-delay Pre-Schedule vor _advance()/_cancelChildEvents schützen kann
    // (sonst werden "vor Start"-Children nie angezeigt — siehe _cancelChildEvents).
    return firstSlot;
  }

  _schedulePreCues(curIdx, curDurMs) {
    // ── Clip-Player Pre-Cue ─────────────────────────────────────────────────
    // startOffsetMs = kumulierte Dauer aller Events zwischen "jetzt" (Start des
    // laufenden curIdx-Events) und dem Start von Event i — also die Zeit, die
    // tatsächlich vom jetzigen Moment bis zum On-Air-Wechsel von Event i vergeht.
    // Daraus lässt sich die reale Vorlaufzeit (leadMs) zum Zeitpunkt des Timer-
    // Feuerns exakt bestimmen: leadMs = startOffsetMs - delay.
    const targets = [];
    const maxTargets = this._slotIds.length;  // pre-cue as many events as we have player slots
    let cum = curDurMs;
    for (let i=curIdx+1; i<this.playlist.length && targets.length<maxTargets; i++) {
      const ev = this.playlist[i];
      if (this._isPlayer(ev)) targets.push({ i, ev, startOffsetMs: cum });
      cum += this._calcDurMs(ev, this.fps);
    }
    for (let t=0; t<targets.length; t++) {
      const { i, ev, startOffsetMs } = targets[t];
      const slot   = this._slotFor(i);
      const delay  = Math.max(200, curDurMs - PRE_CUE_MS*(t+1));
      const leadMs = Math.max(0, Math.round(startOffsetMs - delay));
      const timer = setTimeout(async () => {
        if (!this._running) return;
        if (this._onAirSlot === slot) return;
        if (this._cueQueue[slot]===ev.file && this.players[slot]?.cued) {
          // Bereits gecued (z.B. via _earlyPreCue mit unbekannter/übersprungener
          // Lead-Zeit) — "vor Start"-Pre-Schedule trotzdem mit der jetzt bekannten,
          // korrekten Lead-Zeit (neu) aufsetzen statt eine evtl. falsch getimte
          // Alt-Planung stehen zu lassen.
          this._armNegChildSchedule(ev, slot, leadMs);
          return;
        }
        await this._doCue(ev, slot, undefined, undefined, undefined, leadMs);
      }, delay);
      this._precTimers.push(timer);
    }

    // ── Live-Quellen Pre-Cue (Routing-Befehl an Broadcast-Controller) ──────
    // liveCueMode='asap': sofort cueen sobald der Live-Slot frei ist (kein Routing-Delay)
    // liveCueMode='timed' (default): liveCueLeadSec Sekunden vor dem Live-Event cueen
    const liveCueMode    = this.opts.liveCueMode    || 'timed';
    const liveCueLeadSec = this.opts.liveCueLeadSec ?? 5;

    const liveTargets = [];
    for (let i=curIdx+1; i<this.playlist.length && liveTargets.length<2; i++)
      if (this._isGenericLive(this.playlist[i]) || this._isLiveSource(this.playlist[i])) liveTargets.push(i);

    for (let t=0; t<liveTargets.length; t++) {
      const i        = liveTargets[t];
      const ev       = this.playlist[i];
      const liveSlot = this._isGenericLive(ev) ? this._liveSlotFor(i) : ev.source;
      if (!liveSlot) continue;

      let delay;
      if (liveCueMode === 'asap') {
        // So früh wie möglich: sofort wenn der vorherige Live-Clip nicht mehr on-air
        delay = 500;
      } else {
        // timed: liveCueLeadSec Sekunden vor Live-Event-Start
        const leadMs = Math.round(liveCueLeadSec * 1000);
        delay = Math.max(200, curDurMs - leadMs * (t + 1));
      }

      const timer = setTimeout(() => {
        if (!this._running) return;
        if (this._onAirLiveSlot === liveSlot) return; // bereits on-air
        this._emitLivePrecue(i, liveSlot);
      }, delay);
      this._precTimers.push(timer);
    }
  }

  _preCueBeforeTime(ms) {
    for (let i=this.currentIndex+1; i<this.playlist.length; i++) {
      const ev = this.playlist[i];

      if (this._isPlayer(ev)) {
        const slot  = this._slotFor(i);
        const delay = Math.max(200, ms-PRE_CUE_MS);
        const timer = setTimeout(async () => {
          if (!this._running) return;
          if (this._onAirSlot === slot) return;
          if (this._cueQueue[slot]===ev.file && this.players[slot]?.cued) return;
          this._gapLoopCleanup?.(); this._gapLoopCleanup = null;
          await this._doCue(ev, slot);
        }, delay);
        this._precTimers.push(timer);
        break;
      }

      if (this._isGenericLive(ev)) {
        const liveSlot = this._liveSlotFor(i);
        if (!liveSlot) break;
        const delay = Math.max(200, ms-PRE_CUE_MS);
        const timer = setTimeout(() => {
          if (!this._running) return;
          if (this._onAirLiveSlot === liveSlot) return;
          this._emitLivePrecue(i, liveSlot);
        }, delay);
        this._precTimers.push(timer);
        break;
      }
    }
  }

  // leadMs: geschätzte Zeit (ms) von "jetzt" (Aufruf von _doCue) bis das Event
  // tatsächlich on-air geht — bestimmt preStartMs für negative-delay Pre-Schedules
  // ("vor Start"-Children). Default PRE_CUE_MS passt für den Standard-Fall
  // (_schedulePreCues, t=0: Timer feuert PRE_CUE_MS vor Clip-Ende = vor nächstem Start).
  // Pfade die sofort/quasi-sofort auf Air gehen (start/jump/forceJump/cueFirst) MÜSSEN
  // 0 übergeben — sonst wird der Pre-Schedule auf "Start in 5s" geplant, obwohl das
  // Event in <100ms on-air geht → "vor Start"-Grafik feuert Sekunden NACH dem Start
  // statt davor (→ "wird nicht ein-/ausgeblendet").
  async _doCue(event, slot, absFile, somSec, eomAbs, leadMs = PRE_CUE_MS) {
    const player = this.players[slot];
    if (!player) return;
    const fps = this.fps;
    if (!absFile) absFile = this.opts.resolveFilePath?.(event.file) || resolveFile(event.file, this.opts.mediaDir);
    if (!absFile) { this._log(`Cue: ${event.file} nicht gefunden`, 'warn'); return; }
    if (somSec==null) somSec = fromTC(event.som??0,fps)||0;
    if (eomAbs==null) { const ed=event.eom!=null?(fromTC(event.eom,fps)||0):null; eomAbs=ed!=null?somSec+ed:null; }

    // AudioTracks aus MediaLibrary holen (für MXF Mono-Paar-Routing)
    const libInfo    = this.opts.library?.get?.(event.file);
    const audioTracks = libInfo?.audio || null;
    const fileFps    = _parseFps(libInfo?.video?.fps) || fps;

    this._log(`Cue ${slot}: ${path.basename(absFile)}`, 'debug');
    this._cueQueue[slot] = event.file;
    // Merge audioPreset / _marinaPreset into audioConfig.preset so PlayerPipeline
    // picks the correct routing matrix. event.audioConfig.preset takes priority.
    let resolvedPreset = event.audioConfig?.preset || event.audioPreset || event._marinaPreset;

    // Static audio preset fallback: if the chosen preset requires more channels than
    // the file has, try the fallback chain before cueing.
    if (resolvedPreset && audioTracks) {
      const agc   = this.opts.audioGroupConfig;
      const chain = (event.audioPresetFallback && event.audioPresetFallback.length)
        ? event.audioPresetFallback
        : (this.opts.audioPresetFallbackChain || []);
      if (agc && chain.length) {
        const presetDef = agc.getPreset?.(resolvedPreset);
        if (presetDef?.routes) {
          // highest mxf_chN index in the preset routes = channels needed
          let needed = 0;
          for (const route of presetDef.routes) {
            const m = /^mxf_ch(\d+)$/i.exec(route.from || '');
            if (m) needed = Math.max(needed, parseInt(m[1], 10));
          }
          const fileChannels = audioTracks.reduce((s, t) => s + (t.channels || 0), 0);
          if (needed > 0 && fileChannels > 0 && fileChannels < needed) {
            const fallback = chain.find(fb => {
              const fd = agc.getPreset?.(fb);
              if (!fd?.routes) return true; // preset with no routes = always compatible
              let fn = 0;
              for (const r of fd.routes) {
                const m2 = /^mxf_ch(\d+)$/i.exec(r.from || '');
                if (m2) fn = Math.max(fn, parseInt(m2[1], 10));
              }
              return fn <= fileChannels;
            });
            if (fallback && fallback !== resolvedPreset) {
              this._log(`Audio-Fallback: Preset "${resolvedPreset}" → "${fallback}" (benötigt ${needed}ch, Datei hat ${fileChannels}ch)`, 'warn');
              this.emit('audio-preset-fallback', { eventId: event.id, from: resolvedPreset, to: fallback });
              resolvedPreset = fallback;
            }
          }
        }
      }
    }

    const mergedAudioConfig = resolvedPreset
      ? { ...(event.audioConfig ?? {}), preset: resolvedPreset }
      : (event.audioConfig ?? {});
    await player.load({
      filePath:    absFile,
      som:         somSec,
      eom:         eomAbs,
      audioConfig: mergedAudioConfig,
      audioTracks,
      fps:         fileFps,
      afd:         event.afd || 'auto',
    }).catch(e => { this._cueQueue[slot]=null; this._log(`Cue-Fehler ${slot}: ${e.message}`, 'warn'); });

    // Pre-schedule negative-delay grafik children (delay < 0 = sollen VOR Clip-Start
    // erscheinen). leadMs == null bedeutet "hier noch nicht planen" (z.B. _earlyPreCue
    // für nicht-unmittelbar-nächste Slots, deren tatsächliche Lead-Zeit hier noch
    // unbekannt ist — _schedulePreCues plant sie später mit korrektem Wert nach).
    if (leadMs != null) this._armNegChildSchedule(event, slot, leadMs);
  }

  // (Re-)plant die negative-delay Grafik-Children eines Events für `slot`, unter der
  // Annahme dass das Event in ca. `leadMs` ms tatsächlich on-air geht. NICHT hartkodiert
  // auf PRE_CUE_MS — sonst feuert der Show-Timer relativ zur falschen Referenz (z.B.
  // Sekunden NACH dem tatsächlichen Start statt davor), wenn die reale Vorlaufzeit von
  // der PRE_CUE_MS-Annahme abweicht (start()/jump()/forceJump()/cueFirst() gehen
  // quasi-sofort auf Air; _earlyPreCue cued mehrere Slots weit im Voraus).
  _armNegChildSchedule(event, slot, leadMs) {
    const prevCleanup = this._preChildCleanups.get(slot);
    if (prevCleanup) try { prevCleanup(); } catch {}
    const cleanups = [];

    const _hasNegGrafikDelay = (event.children || []).some(c => {
      const g = c.source === 'grafik' && c.grafik ? c.grafik : (c.source === 'image' && c.src ? c : null);
      if (!g) return false;
      return g.delayFrames != null ? g.delayFrames < 0 : (g.delay ?? 0) < 0;
    });
    if (this.grafixEngine && _hasNegGrafikDelay) {
      const _plCtxPre = { playlist: this.playlist, currentIndex: this.currentIndex, fps: this.fps };
      cleanups.push(this.grafixEngine.scheduleChildEvents(
        event, null, this.fps, (info) => {
          this.emit('grafik', info);
          this._handleGrafikDve(info);
          if (this.master) {
            if (info.action === 'show') this.master.showGrafik?.();
            else if (info.action === 'hide' && !this.grafixEngine._activeGrafiks?.size) this.master.hideGrafik?.();
          }
        }, _plCtxPre,
        { latencyMs: this.opts.grafikLatencyMs || 0, preStartMs: leadMs, negativeOnly: true, resolveImagePath: f => this._resolveImagePath(f) }
      ));
    }

    const _hasNegTriggerDelay = (event.children || []).some(c => {
      if (c.source !== 'trigger' || !c.trigger) return false;
      const t = c.trigger;
      return t.delayFrames != null ? t.delayFrames < 0 : (t.delay ?? 0) < 0;
    });
    if (this.channelBus && _hasNegTriggerDelay) {
      cleanups.push(this._scheduleTriggerChildren(event, null, this.fps, { leadMs, negativeOnly: true }));
    }

    if (cleanups.length) this._preChildCleanups.set(slot, () => { for (const fn of cleanups) try { fn(); } catch {} });
  }

  _calcDurMs(ev, fps) {
    const toFrameMs = secs => Math.round(Math.round(secs * fps) / fps * 1000);
    if (ev.source==='smpte'||ev.source==='black'||ev.source==='live'||this._isLiveSource(ev)) return toFrameMs(fromTC(ev.duration??5,fps)||5);
    if (ev.eom!=null) return toFrameMs((fromTC(ev.eom,fps)||0)+(fromTC(ev.postroll??0,fps)||0));
    if (ev.duration!=null) return toFrameMs((fromTC(ev.duration,fps)||0)+(fromTC(ev.postroll??0,fps)||0));
    return 0;
  }

  // ── Gap-Fill ──────────────────────────────────────────────────────────────

  /**
   * Füllt Lücken zwischen Events in der Playlist.
   * - Analysiert Timeline via calcTimeline()
   * - Fügt schwarze Pause-Events (oder gapFile) an Stellen mit gapMs > 0 ein
   * - Gibt Anzahl eingefügter Events zurück
   *
   * @param {string|null} gapFile  — Dateiname für Gap-Clip (null = schwarz)
   * @param {number|null} gapDur   — Maximale Gap-Dauer in ms (null = exakt)
   */
  fillGaps(gapFile = null, gapDur = null) {
    const timeline = this.calcTimeline();
    const fps = this.fps;
    let inserted = 0;

    // Von hinten einfügen, damit Indizes stimmen
    for (let i = timeline.length - 1; i >= 0; i--) {
      const { gapMs, index } = timeline[i];
      if (!gapMs || gapMs < 40) continue; // < 2 Frames ignorieren

      const durMs = gapDur != null ? Math.min(gapMs, gapDur) : gapMs;
      const durSec = durMs / 1000;
      const durFrames = Math.round(durSec * fps);
      const durTC = `${String(Math.floor(durFrames/fps/3600)).padStart(2,'0')}:${String(Math.floor(durFrames/fps/60)%60).padStart(2,'0')}:${String(Math.floor(durFrames/fps)%60).padStart(2,'0')}:${String(durFrames%fps).padStart(2,'0')}`;

      let gapEvent;
      if (gapFile) {
        gapEvent = {
          id: `gap-${Date.now()}-${i}`,
          type: 'player',
          file: gapFile,
          duration: durTC,
          label: `[Gap: ${durTC}]`,
          _isGapFill: true,
        };
      } else {
        gapEvent = {
          id: `gap-${Date.now()}-${i}`,
          type: 'player',
          source: this.opts.gapSource || 'black',
          duration: durTC,
          label: `[Gap: ${durTC}]`,
          _isGapFill: true,
        };
      }
      // Nach Event i einfügen (also an index+1)
      this.playlist.splice(index + 1, 0, gapEvent);
      inserted++;
    }

    if (inserted > 0) {
      this._log(`Gap-Fill: ${inserted} Events eingefügt`);
      this.emit('updated', this.playlist);
    }
    return inserted;
  }

  /**
   * Gibt Overlap-Warnungen zurück: Events bei denen fixedTime mit Laufzeit kollidiert.
   */
  overlapWarnings() {
    return this.calcTimeline()
      .filter(e => e.overlapMs > 0)
      .map(e => ({
        index:      e.index,
        event:      e.event?.label || e.event?.file || `Event ${e.index+1}`,
        overlapMs:  e.overlapMs,
        start:      e.start,
      }));
  }
}

module.exports = PlaylistEngine;
