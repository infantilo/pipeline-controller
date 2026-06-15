/**
 * PlayerPipeline.js
 *
 * Architektur: GETRENNTE Video- und Audio-Pipelines pro Item.
 *
 *   vPipeline: uridecodebin (video) → intervideosink sync=true
 *     Rate-Kontrolle: System-Clock via intervideosink sync=true.
 *     Kein Leaky-Queue nötig: Video-uridecodebin blockiert unabhängig von Audio.
 *
 *   aPipeline: uridecodebin (audio) → interaudiosink sync=true  (AudioRouter-Modus)
 *           ODER uridecodebin (audio) → pulsesink               (Legacy-Modus)
 *     Rate-Kontrolle: interaudiosink sync=true / pulsesink.
 *
 *   Beide Pipelines nutzen die System-Clock → laufen synchron,
 *   aber ohne gemeinsamen uridecodebin-Multiqueue.
 *
 *   AudioRouter-Modus:
 *     - Pro gemappter Audio-Gruppe ein Branch → interaudiosink
 *     - Nicht gemappte Gruppen: Silence-Seeder im Master versorgt diese
 *     - Master holt Gruppen via interaudiosrc → AudioRouter.buildMasterOutputs()
 *
 *   Legacy-Modus (kein audioGroupConfig):
 *     - pulsesink direkt
 *
 *   MXF-Besonderheit:
 *     mxfdemux sendet "Internal data stream error" auf dem Bus nach PLAYING.
 *     Das ist ein bekannter GStreamer-Bug (Pull-Mode). Die Pipeline läuft aber
 *     weiter — der Fehler wird als WARN geloggt und ignoriert.
 */

'use strict';
const { Pipeline }     = require('gst-kit');
const { EventEmitter } = require('events');
const { toTC }         = require('./Timecode');
const { AudioRouter }  = require('./AudioRouter');

// Graveyard: hält Pipeline-Referenzen am Leben bis gst_element_set_state(NULL)
// bestätigt ist — verhindert dass der JS-GC den C++ unique_ptr freigibt während
// GStreamer den Pipeline-Teardown noch nicht abgeschlossen hat.
const _stopping = new Set();

// stop(-1) = GST_CLOCK_TIME_NONE: gst_element_get_state blockiert UNBEGRENZT
// auf dem libuv-Worker-Thread → Node.js kann nicht via Ctrl+C beendet werden.
// Außerdem: alter und neuer interaudiosink auf demselben Kanal → Ringpuffer-
// Korruption → Master-seitiger interaudiosrc blockiert dauerhaft.
//
// Lösung: stop(waitMs) — begrenzter Timeout auf dem Worker-Thread selbst.
// gst_element_set_state(NULL) wird IMMER aufgerufen (Teardown startet),
// gst_element_get_state wartet max. waitMs ns. Worker beendet sich stets
// innerhalb von waitMs → kein hängender libuv-Thread, Ctrl+C funktioniert.
// Graveyard hält JS-Referenz am Leben bis GStreamer-interne Threads fertig sind.
async function _stopPipeline(p, waitMs = 2000) {
  if (!p) return;
  _stopping.add(p);
  try { await p.stop(waitMs); } catch {}
  _stopping.delete(p);
}

class PlayerPipeline extends EventEmitter {
  constructor(slotId, opts = {}) {
    super();
    this.slotId           = slotId;
    this.opts             = opts;
    this.vPipeline        = null;
    this.aPipeline        = null;  // separate Audio-Pipeline
    this._item            = null;
    this._cued            = false;
    this._running         = false;
    this._busLoop         = false;
    this._playing         = false;
    this._poller          = null;
    this._loadSeq         = 0;
    this._lastPStr        = null;
    this.audioGroupConfig = opts.audioGroupConfig || null;
    this.clockStrategy    = opts.clockStrategy    || null;
    this._pgmGroupId      = opts.pgmGroupId || 'pgm-stereo';
  }

  _log(msg, level = 'info') { this.emit('log', { level, msg: `[${this.slotId}] ${msg}` }); }
  get cued()    { return this._cued; }
  get playing() { return this._playing; }

  // ── Mute ──────────────────────────────────────────────────────────────────

  _setMute(mute) {
    const searchPipeline = this.aPipeline || this.vPipeline;
    if (!searchPipeline) return;
    try {
      const vol = searchPipeline.getElementByName(`avol_${this.slotId}_${this._loadSeq}`);
      if (vol) { vol.setElementProperty('mute', mute); return; }
      const legacyVol = searchPipeline.getElementByName(`avol_${this.slotId}`);
      if (legacyVol) legacyVol.setElementProperty('mute', mute);
    } catch(e) { this._log(`Mute: ${e.message}`, 'warn'); }
  }

  // ── Load ──────────────────────────────────────────────────────────────────

  async load(item) {
    this.emit('loading', { slotId: this.slotId });
    await this.stop();
    this._item = item;

    const pathLib = require('path');
    const som = item.som ?? 0;
    const eom = item.eom ?? null;

    let abs;
    if (item.filePath) {
      abs = item.filePath;
    } else {
      const dir = item.mediaDir || this.opts.mediaDir || process.cwd();
      abs = pathLib.isAbsolute(item.file) ? item.file : pathLib.join(dir, item.file);
    }
    // Store resolved path so reloadAudioPreset / _videoPath can use it without recomputing
    if (!this._item.filePath) this._item = { ...this._item, filePath: abs };

    const uri = `file://${abs}`;
    const ch  = this.slotId;
    const fps = this.opts.fps || 25;

    this._log(`Lade: ${pathLib.basename(abs)} SOM=${toTC(som,fps)} EOM=${eom!=null?toTC(eom,fps):'—'}`);

    // Audio-Spuren aus MediaLibrary-Info (MXF hat bis zu 8 Mono-Spuren)
    const audioTracks = item.audioTracks || [];

    // ── Video-Pipeline (getrennt von Audio) ──────────────────────────────────
    let vPipeline = null;

    // NVDEC-Pfad 1: explizit für MXF MPEG-2 (bekannte Track-Struktur, direkter Demux)
    if (PlayerPipeline._nvdecAvailable) {
      const vNvdec = this._buildVideoPipelineNvdec(uri, ch, fps);
      if (vNvdec) {
        this._log(`Video: NVDEC Hardware-Decode (MXF MPEG-2, codec=${item.video?.codec})`);
        this._lastPStr = vNvdec;
        vPipeline = await this._tryPipeline(vNvdec, 8000);
        if (!vPipeline) this._log('NVDEC MXF-Pfad fehlgeschlagen — Software-Fallback', 'warn');
      } else {
        // Nicht-MXF oder anderer Codec: Rank-Promotion → uridecodebin wählt nvdec automatisch
        this._log(`Video: NVDEC via Rank-Promotion (codec=${item.video?.codec || 'unbekannt'})`);
      }
    }

    // Software-Fallback (uridecodebin) — mit aktivem NVDEC auch via Rank-Promotion
    if (!vPipeline) {
      const vStr = this._buildVideoPipeline(uri, ch, fps);
      this._lastPStr = vStr;
      if (!PlayerPipeline._nvdecAvailable) this._log('Lade Video-Pipeline (Software)', 'info');
      vPipeline = await this._tryPipeline(vStr, 12000);
    }

    if (!vPipeline) {
      const errMsg = 'Video-Pipeline fehlgeschlagen';
      this._log(errMsg, 'error');
      if (this.opts.debugger?.enabled) this.opts.debugger.dumpOnError(this.slotId, this._lastPStr || '', errMsg);
      this.emit('error', 'load failed');
      return false;
    }

    // ── Audio-Pipeline (getrennt von Video) ──────────────────────────────────
    let aPipeline = null;
    const aStrategies = this.audioGroupConfig
      ? this._buildAudioPipeline(uri, ch, fps, audioTracks, item.audioConfig)
      : this._buildLegacyAudioPipeline(uri, ch, fps);

    for (let si = 0; si < aStrategies.length; si++) {
      this._log(`Versuche Audio-Strategie ${si + 1}/${aStrategies.length}`, 'info');
      // Strategien mit explizitem Pro-Spur-Linking (db.src_<N> + interleave)
      // können bei fehlendem Pad für IMMER blockieren ("not-linked" wird sonst
      // als harmlos ignoriert) → strict + kurzes Timeout: in <2s erkennen statt
      // 12s lahmlegen. Andere Strategien (Stille, generische Verlinkung) sind
      // unkritisch und behalten das großzügige Preroll-Timeout.
      const strict = /interleave name=/.test(aStrategies[si]) && /db\.(src_|track_)/.test(aStrategies[si]);
      const ap = await this._tryPipeline(aStrategies[si], strict ? 4000 : 12000, strict);
      if (ap) {
        this._log(`Audio-Strategie ${si + 1} erfolgreich`, 'info');
        aPipeline = ap;
        break;
      }
      this._log(`Audio-Strategie ${si + 1} fehlgeschlagen`, 'warn');
    }

    if (!aPipeline) {
      this._log('Alle Audio-Strategien fehlgeschlagen — Video-only', 'warn');
    }

    // ── Seek zu SOM ──────────────────────────────────────────────────────────
    if (som > 0.01) {
      try {
        await Promise.all([
          vPipeline.seek(som),
          aPipeline ? aPipeline.seek(som) : Promise.resolve(),
        ]);
        this._log(`Seek → SOM ${toTC(som,fps)}`);
      } catch(e) { this._log(`Seek: ${e.message}`, 'warn'); }
    }

    this.vPipeline = vPipeline;
    this.aPipeline = aPipeline;
    this._running  = true;
    this._busLoop  = true;
    this._watchBus();

    if (this.opts.debugger?.enabled) {
      this.opts.debugger.watch(this.slotId, vPipeline, this._lastPStr || null);
    }

    this._cued = true;
    this._log(`Gecued ✓`);
    this.emit('cued', { slotId: this.slotId, som, eom });
    return true;
  }

  // ── Pipeline-Builder ──────────────────────────────────────────────────────

  /**
   * Video-only Pipeline. Rate-Kontrolle via intervideosink sync=true (System-Clock).
   * Da Audio getrennt läuft, blockiert ein voller Video-Queue nur die Video-uridecodebin —
   * kein Leaky nötig.
   */
  _buildVideoPipeline(uri, ch, fps) {
    // caps="video/x-raw": uridecodebin ignoriert Audio-Pads intern →
    // kein "Delayed linking failed"-Warning für unverknüpfte Audio-Streams.
    // Mit aktivem NVDEC (PlayerPipeline._nvdecAvailable): GST_PLUGIN_FEATURE_RANK
    // bevorzugt nvdec:512 → uridecodebin/decodebin wählt nvdec automatisch für
    // alle Container/Codecs (H.264, MPEG-2, H.265…).
    return `uridecodebin name=db uri="${uri}" caps="video/x-raw" db. ! ${this._videoPath(ch, fps)}`;
  }

  /**
   * NVDEC-Explicit-Pfad für MXF MPEG-2: bekannte Track-Struktur → direktes
   * filesrc ! mxfdemux track_2 ! mpegvideoparse ! nvdec ohne uridecodebin-Overhead.
   * Returns null wenn NVDEC nicht anwendbar (kein MXF, kein MPEG-2).
   */
  _buildVideoPipelineNvdec(uri, ch, fps) {
    if (!/\.mxf$/i.test(uri)) return null;
    const codec = this._item?.video?.codec || '';
    if (!/mpeg2video/.test(codec)) return null;
    const filePath = uri.replace(/^file:\/\//, '');
    const Q = 'queue max-size-buffers=8 max-size-bytes=0 max-size-time=0';
    // track_2 = Picture Essence (track_1=Timecode, track_2=Picture — vgl. Audio streamIndex+2)
    return `filesrc location="${filePath}" ! mxfdemux name=vdb vdb.track_2 ! ${Q} ! mpegvideoparse ! nvdec ! ${this._videoPath(ch, fps)}`;
  }

  /**
   * AudioRouter-Modus: Audio-only Pipeline.
   *
   * Genau EINE preset-treue Strategie (tee → je Branch pro gemappter Gruppe,
   * buildPlayerFragments) plus ein Stille-Fallback.
   *
   * Vorher gab es 3 Strategien, wobei #2/#3 das aktive Preset komplett
   * ignorierten und stattdessen eine generische Identity-Matrix (Kanal i→i)
   * bzw. einen rohen Stereo-Downmix anwendeten. Schlug die korrekte
   * Strategie #1 fehl (z.B. Preroll-Timeout), spielte die Pipeline trotzdem
   * scheinbar normal — nur mit FALSCHEM Routing (z.B. "ch1→L, ch2→R" statt
   * des gewählten Presets). Das ist schlimmer als hörbare Stille, weil es
   * unbemerkt falsch klingende Sendungen produziert. Stille ist eindeutig
   * als Fehler erkennbar und signalisiert sofort "Preset konnte nicht
   * geladen werden" statt plausibel-falsches Audio auszuspielen.
   *
   * Nicht gemappte Gruppen werden vom Silence-Seeder des Masters versorgt.
   */
  _buildAudioPipeline(uri, ch, fps, audioTracks, audioConfig) {
    const cfg      = this.audioGroupConfig;
    const presetId = audioConfig?.preset || 'stereo';
    const preset   = cfg.getPreset(presetId) || cfg.getPreset('stereo');

    const fullTracks = (audioTracks && audioTracks.length) ? audioTracks : null;

    // Kompaktierung: nur die vom Preset tatsächlich referenzierten Datei-
    // Kanäle dekodieren/interleaven (statt immer ALLER bis zu 8 Mono-
    // Essenzen). Verkleinert den interleave-Graph auf typischerweise 1-2
    // Spuren.
    const { tracks, preset: routedPreset } = fullTracks
      ? AudioRouter.compactTracksForPreset(fullTracks, preset)
      : { tracks: null, preset };

    // Eingangskanal-Zahl = Summe der tatsächlich verlinkten Sub-Kanäle der
    // KOMPAKTIERTEN Liste (subIndices.length, falls gesetzt — eine
    // kompaktierte Essenz kann NUR EINEN ihrer Sub-Kanäle liefern, z.B. bei
    // "nur den R-Kanal einer nativen Stereo-Spur nutzen"). Gilt einheitlich
    // für 1..N Spuren — _buildAudioSource entscheidet selbst, wie adressiert
    // wird (siehe dort).
    const trackInCh = t => Array.isArray(t.subIndices) ? t.subIndices.length : Math.max(1, t.channels || 1);
    const inCh = tracks ? tracks.reduce((sum, t) => sum + trackInCh(t), 0) : 2;

    const router      = new AudioRouter(cfg, routedPreset, inCh, this.slotId);
    const groupFrags  = router.buildPlayerFragments(); // Array<string|null>
    const activeFrags = groupFrags.filter(f => f !== null);

    // F32LE zwingend: audiomixmatrix akzeptiert nur F32LE/F64LE als Eingang.
    const mask  = inCh > 2 ? ',channel-mask=(bitmask)0' : '';
    const acaps = `audio/x-raw,format=F32LE,rate=48000,channels=${inCh},layout=interleaved${mask}`;

    // tee → je Branch pro gemappter Gruppe (preset-treu)
    const pStrRouted = [
      this._buildAudioSource(uri, tracks, acaps),
      `! tee name=atee_${this.slotId}`,
      ...activeFrags.map(f => {
        if (f.startsWith('audiotestsrc')) return f;
        return `atee_${this.slotId}. ! ${f}`;
      }),
    ].join(' ');

    // Fallback: reine Stille auf den PGM-Kanal — siehe Doku-Kommentar oben
    // (kein preset-ignorierender Identity-Downmix mehr).
    const pgmGroupId  = this._pgmGroupId;
    const pgmGroup    = cfg.getGroup(pgmGroupId);
    const pgmCh       = pgmGroup ? pgmGroup.channels : 2;
    const pgmChannel  = router.groupChannel(pgmGroupId);
    const silenceCaps = `audio/x-raw,format=F32LE,rate=48000,channels=${pgmCh},layout=interleaved${pgmCh > 2 ? ',channel-mask=(bitmask)0' : ''}`;
    const pStrSilence =
      `audiotestsrc wave=silence is-live=true do-timestamp=true ! ${silenceCaps}` +
      ` ! interaudiosink channel=${pgmChannel} sync=true async=false max-lateness=-1`;

    return [pStrRouted, pStrSilence];
  }

  /**
   * Baut die Quell-Decodierung einer Audio-Pipeline: Demux/Decode → ein
   * einzelner interleaved Strom in der gewünschten Kanalzahl (laut `caps`).
   *
   * ───────────────────────────────────────────────────────────────────────
   * WICHTIG — Ergebnis einer Debug-Sitzung (empirisch verifiziert, nicht
   * geraten — siehe gst-launch-1.0-Tests gegen ET270438.mxf/OH20020B.mxf):
   *
   * 1) "db.src_<ffprobe-streamIndex>" auf einem uridecodebin ist GRUNDSÄTZLICH
   *    FALSCH. Die "src_N"-Ghost-Pad-Namen von uridecodebin/decodebin sind
   *    decodebins interner Autoplug-Zähler — KEINE Container-Stream-Indizes.
   *    Beweis: bei expose-all-streams=true erschienen für eine 8-Mono-Track-
   *    MXF nur die Pads src_{0,2,3,4,5,6,8} (src_1 und src_7 fehlten!), bei
   *    expose-all-streams=false sogar nur src_0/src_1. Jede Adressierung
   *    "db.src_<N>" über mehrere Audio-Essenzen ist damit Glückssache — das
   *    erklärte das gemeldete Symptom (Spur 1↔2 vertauscht) UND warum die
   *    erste Korrektur (gleiche Methode, nur weniger Branches) wirkungslos
   *    blieb ("identes Fehlerbild").
   *
   * 2) Korrekte, dateistruktur-basierte Adressierung: "filesrc ! mxfdemux"
   *    exponiert JEDE Essenz als "track_<id>"-Pad, wobei <id> die im MXF-
   *    Header kodierte Track-ID ist (statisch, dateidefiniert — kein
   *    Autoplug-Zähler). Für die MXFs dieses Systems (Vizrt AMF MXF Store):
   *    Track 1 = Timecode, Track 2 = Picture, Track 3..N+2 = Audio 1..N.
   *    ⇒ track_id = ffprobe-streamIndex + 2.
   *    Verifiziert durch Byte-für-Byte-Vergleich von rohem PCM
   *    (ffmpeg -map 0:<streamIndex> vs. gst track_<streamIndex+2>):
   *    0 Bytes Abweichung über 2 Dateien / 3 Spurpaare hinweg, inkl.
   *    Cross-Check (falsche Paarung weicht in >60% der Bytes ab).
   *
   * 3) Die gemeldete Instabilität ("stall", "unresponsive") war NICHT eine
   *    Folge von zu vielen interleave-Branches, sondern fehlender "queue"
   *    nach Demuxer-Pads: mxfdemux pusht alle Essenzen aus EINEM Thread.
   *    Ohne Queue blockiert das Schreiben in einen bereits gefüllten/
   *    geprerollten Sink den gesamten Thread — andere Pads erhalten dann NIE
   *    ihren ersten Buffer → Pipeline hängt für immer in PREROLLING fest
   *    (genau das vom User beschriebene Bild). Reproduziert 1:1 per
   *    gst-launch (fakesink ohne queue ⇒ PREROLLING-Hang; mit queue ⇒
   *    PLAYING in <1s). NICHT verlinkte Track-Pads (z.B. wegkompaktierte
   *    Essenzen) sind dagegen unkritisch — Demuxer droppt deren Daten
   *    klaglos (verifiziert: 1 verlinkter Track + 8 unverlinkte ⇒ läuft
   *    sauber bis EOS durch).
   * ───────────────────────────────────────────────────────────────────────
   *
   * @returns {string} gst-launch-Fragment, dessen letztes Element die
   *                   gewünschten `caps` als interleaved Strom liefert
   *                   (Fortsetzung per " ! …" durch den Aufrufer).
   */
  _buildAudioSource(uri, tracks, caps) {
    const Q = `queue max-size-buffers=0 max-size-time=200000000 max-size-bytes=0`;
    const isMxf  = /\.mxf$/i.test(uri);
    const haveIdx = !!(tracks && tracks.length && tracks.every(t => typeof t.streamIndex === 'number'));

    if (isMxf && haveIdx) {
      const path   = uri.replace(/^file:\/\//, '');
      const ipName = `ip_${this.slotId}`;
      const lines  = [`filesrc location="${path}" ! mxfdemux name=db`, `interleave name=${ipName}`];
      let col = 0;
      tracks.forEach((t, i) => {
        const tCh  = Math.max(1, t.channels || 1);
        // subIndices: von compactTracksForPreset gesetzt — welche Sub-Kanäle
        // dieser Essenz tatsächlich gebraucht werden (Datei-Reihenfolge).
        // Fehlt das Feld (kein Kompaktierungspfad): alle Sub-Kanäle.
        const subs    = Array.isArray(t.subIndices) ? t.subIndices : Array.from({ length: tCh }, (_, c) => c);
        const trackId = t.streamIndex + 2; // siehe Dokblock: streamIndex(1-basiert) + 2 = mxfdemux track_id
        const conv = `db.track_${trackId} ! ${Q} ! audioconvert ! audioresample` +
                     ` ! audio/x-raw,format=F32LE,channels=${tCh},rate=48000,layout=interleaved`;
        if (tCh === 1) {
          lines.push(`${conv} ! ${ipName}.sink_${col}`);
          col += 1;
        } else {
          const di = `di_${this.slotId}_${i}`;
          lines.push(`${conv} ! deinterleave name=${di}`);
          for (const c of subs) {
            lines.push(`${di}.src_${c} ! ${ipName}.sink_${col}`);
            col += 1;
          }
        }
      });
      lines.push(`${ipName}. ! audioconvert ! audioresample ! ${caps}`);
      return lines.join(' ');
    }

    // Generischer Pfad (Nicht-MXF oder kein verifizierter streamIndex):
    // uridecodebin bindet automatisch die erste kompatible Audio-Spur.
    // Pro-Spur-Routing ist hier NICHT möglich/verifiziert — sicherer
    // Fallback ohne Multi-Track-Adressierung.
    return [
      `uridecodebin name=db uri="${uri}" expose-all-streams=false`,
      `db. ! ${Q} ! audioconvert ! audioresample ! ${caps}`,
    ].join(' ');
  }

  /**
   * Legacy-Modus: Audio-only Pipeline → interaudiosink channel=${ch}_audio.
   *
   * Warum interaudiosink statt pulsesink:
   *   Der Master liest im Legacy-Modus via interaudiosrc channel=${ch}_audio aus dem
   *   Shared-Memory-Buffer und leitet das Audio durch seinen level_pgm-Messpunkt
   *   in den eigentlichen Ausgabe-Sink (pulsesink/alsasink).
   *   Dadurch misst level_pgm immer das tatsächlich ausgespielte Signal — egal ob
   *   SMPTE-Idle, Player 1 oder Player 2. Separate Pegel-Handler im Player entfallen.
   *
   *   sync=false async=false: Player-Pipeline läuft auf eigenem Clock, keine
   *   Sync-Negotiation mit dem Shared-Memory-Channel nötig. Master-interaudiosrc
   *   liest mit leaky=upstream-Queue, was Timing-Differenzen abfedert.
   */
  _buildLegacyAudioPipeline(uri, ch, fps) {
    const acaps    = 'audio/x-raw,rate=48000,channels=2';
    const iaSink   = `interaudiosink channel=${ch}_audio sync=false async=false`;

    // Strategie 1: direkte Stereo-Dekodierung → interaudiosink
    const pStr1 = [
      `uridecodebin name=db uri="${uri}"`,
      `db. ! queue max-size-buffers=0 max-size-time=200000000 max-size-bytes=0 ! audioconvert ! audioresample ! ${acaps} ! ${iaSink}`,
    ].join(' ');

    // Strategie 2: MXF Mono-Paar-Interleave → interaudiosink
    const pStr2 = [
      `uridecodebin name=db uri="${uri}"`,
      `db. ! queue max-size-buffers=0 max-size-time=200000000 max-size-bytes=0 ! audioconvert ! deinterleave name=di`,
      `di.src_0 ! queue ! audioconvert ! audio/x-raw,channels=1 ! interleave name=ip`,
      `di.src_1 ! queue ! audioconvert ! audio/x-raw,channels=1 ! ip.sink_1`,
      `ip. ! audioresample ! ${acaps} ! ${iaSink}`,
    ].join(' ');

    return [pStr1, pStr2];
  }

  // ── Video-Pfad ────────────────────────────────────────────────────────────

  /**
   * Video-Pfad für die getrennte Video-Pipeline.
   * intervideosink sync=true wartet auf die System-Clock → natürliche Rate-Kontrolle.
   * Da Audio in einer eigenen Pipeline läuft, blockiert ein voller Queue hier nur
   * die Video-uridecodebin — kein Leaky, kein Stall-Risiko für Audio.
   * max-lateness=80ms: toleriert leichte Verspätung ohne sofortigen Drop.
   */
  _videoPath(ch, fps) {
    const scaleMethod = this.opts.scaleMethod    ?? 1;
    const deinterlace = this.opts.deinterlaceMode || 'auto';
    const afd         = this._item?.afd || 'auto';
    const W           = this.opts.width  || 1920;
    const H           = this.opts.height || 1080;
    const m           = scaleMethod;

    // Deinterlace — vor dem Crop damit Fields korrekt zusammengeführt werden
    const deintEl = deinterlace === 'never'  ? '' :
                    deinterlace === 'always' ? '! deinterlace mode=interlaced' :
                                              '! deinterlace';

    // AFD-Upconversion: Schwarzbalken entfernen UND direkt auf Pipeline-Format skalieren.
    // Kein add-borders nach dem Crop — der Inhalt soll den Frame ausfüllen (aufzoomen).
    //
    // 4:3-pillarbox: Links/Rechts-Balken → 4:3-Inhalt → Zoom auf 16:9 (Mitte zuschneiden)
    // 4:3-letterbox: Oben/Unten-Balken   → 16:9-Inhalt → direkt auf Pipelineformat
    // 14:9-letterbox: kleine Balken       → 14:9-Inhalt → auf Pipelineformat (kleine Balken bleiben)
    // anamorphic: SAR-Korrektur (unsqueeze) → 16:9 → auf Pipelineformat
    let afdEl = '';
    switch (afd) {
      case '4:3-pillarbox':
        // Schritt 1: Links/Rechts-Balken entfernen → 4:3-Inhalt
        // Schritt 2: Mitte auf 16:9 zuschneiden (Center-Crop, Standard-Upconversion)
        // Schritt 3: auf Pipelineformat skalieren (kein add-borders → füllt Frame)
        // videoscale method=0 vor aspectratiocrop: normalisiert GstVideoMeta nach Seek
        // (Assertion info->width > meta->width bei H.264+SPS-Crop nach Mid-Clip-Seek)
        afdEl = `! videoscale method=0 ! aspectratiocrop aspect-ratio=4/3` +
                ` ! aspectratiocrop aspect-ratio=${W}/${H}` +
                ` ! videoscale method=${m} ! video/x-raw,width=${W},height=${H},pixel-aspect-ratio=1/1`;
        break;
      case '4:3-letterbox':
        // Oben/Unten-Balken entfernen → 16:9-Inhalt → auf Pipelineformat
        afdEl = `! videoscale method=0 ! aspectratiocrop aspect-ratio=${W}/${H}` +
                ` ! videoscale method=${m} ! video/x-raw,width=${W},height=${H},pixel-aspect-ratio=1/1`;
        break;
      case '14:9-letterbox':
        // 14:9-Balken entfernen → auf Pipelineformat (kleine Balken bleiben im Master)
        afdEl = `! videoscale method=0 ! aspectratiocrop aspect-ratio=14/9` +
                ` ! videoscale method=${m} add-borders=true ! video/x-raw,width=${W},height=${H},pixel-aspect-ratio=1/1`;
        break;
      case 'anamorphic':
        // SAR-Korrektur: videoscale liest SAR und skaliert auf quadratische Pixel,
        // dann auf Pipelineformat
        afdEl = `! videoscale method=0 ! videoconvert ! video/x-raw,pixel-aspect-ratio=1/1` +
                ` ! videoscale method=${m} ! video/x-raw,width=${W},height=${H},pixel-aspect-ratio=1/1`;
        break;
      // 'auto', '16:9', default → kein Eingriff, globale scaleMode-Einstellung greift
    }

    // Nur wenn kein AFD aktiv: globale Skalierungseinstellung anwenden
    const scaleEl = afdEl ? '' : (
      (this.opts.scaleMode || 'fit') === 'stretch'
        ? `! videoscale method=${m}`
        : `! videoscale method=${m} add-borders=true`
    );

    return [
      `queue max-size-buffers=8 max-size-bytes=0 max-size-time=0`,
      `! videoconvert ! video/x-raw,format=I420`,
      deintEl,
      afdEl,
      scaleEl,
      `! videorate`,
      `! video/x-raw,framerate=${fps}/1`,
      `! intervideosink channel=${ch} sync=true max-lateness=-1`,
    ].filter(Boolean).join(' ');
  }

  // ── Pipeline Try ──────────────────────────────────────────────────────────

  async _tryPipeline(pStr, timeoutMs, strictLinking = false) {
    let p;
    try { p = new Pipeline(pStr); }
    catch(e) { this._log(`Parse: ${e.message}`, 'debug'); return null; }

    this._log(`PIPELINE-STR: ${pStr.substring(0, 300)}`, 'debug');

    const rv = await p.pause();
    this._log(`pause() → ${rv.result} state=${rv.finalState}`, 'debug');

    // Preroll in PAUSED: mxfdemux/decodebin pushen genau 1 Frame pro Sink dann stoppen.
    // So wird der PLAYING→PAUSED Deadlock vermieden (Queues füllen sich nicht).
    // 'async' = Pipeline wartet noch auf Preroll (normal).
    // 'failure' = echter Fehler.
    // 'success' (synchrones Preroll, z.B. async=false Sinks): Bus-Loop ebenfalls
    // ausführen und auf stream-start warten. Dadurch ist sichergestellt, dass der
    // Pull-Mode-Streaming-Task (mxfdemux → filesrc) tatsächlich gestartet hat und
    // GST_PAD_IS_ACTIVE(filesrc.srcpad)=TRUE ist, bevor seek() aufgerufen wird.
    // Ohne dieses Wait schlägt seek(som>0) mit "pad not activated yet" fehl →
    // gst_base_src_stop() wird aufgerufen → Pipeline stumm.
    const needsWait = rv.result === 'async' || rv.result === 'failure' ||
                      rv.result === 'success' ||
                      (rv.finalState != null && rv.finalState < 3);
    // Async-Preroll (rv.result === 'async'): Nur async-done bestätigt volles Preroll.
    // stream-start und new-clock feuern zu früh — audiotestsrc/Clock-Setup passiert
    // vor mxfdemux-Streaming-Task. Wartet man nur auf stream-start, können sich
    // async=true interaudiosinks noch nicht pregerollt haben → neues Pipeline produziert
    // noch kein Audio → Channel-Switch auf leere neue Pipeline → All-Group Stall.
    // Synchrones Preroll (success): stream-start / state-changed genügen.
    const asyncPreroll = rv.result === 'async';
    if (needsWait) {
      let ok = false;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const m = await p.busPop(300);
        if (!m) { await new Promise(r => setTimeout(r, 80)); continue; }
        const t = m.type || '';
        const txt = m.errorMessage || m.message || '';
        const isLinkMsg = /delayed.link|not.linked/i.test(txt);
        if ((t === 'error' || t === 'warning') && isLinkMsg) {
          // Generische "db. ! …"-Verlinkung: harmlos (uridecodebin bietet mehr
          // Pads an als gebraucht) → ignorieren. Bei strictLinking (explizite
          // db.src_<N>/db.track_<N>-Adressierung über mehrere Essenzen +
          // interleave) bedeutet es: ein erwarteter Stream-Pad fehlt →
          // interleave wartet für IMMER auf diesen Sink-Pad → Stall bis zum
          // Timeout. Dann sofort als Fehler werten = Strategie bricht in <1s
          // ab statt die Pipeline bis zu 12s lahmzulegen.
          if (!strictLinking) continue;
          this._log(`Preroll: Pad-Link fehlgeschlagen (${txt}) — Strategie abgebrochen`, 'warn');
          await _stopPipeline(p);
          return null;
        }
        // Harmlose Warnungen während Preroll ignorieren
        if ((t === 'error' || t === 'warning') &&
            /colorimetry|could.not.get|internal.data.stream|buffer.time|period.time|pad not activated|Invalid channel positions/i.test(txt)) {
          continue;
        }
        if (t === 'error' || m.errorMessage) {
          this._log(`Preroll-Fehler: ${txt||t}`, 'warn');
          // await: verhindert Channel-Race mit der nächsten Strategie (z.B.
          // Stille-Fallback) — beide würden sonst kurzzeitig denselben
          // interaudiosink channel=<slot>_<groupId> beanspruchen.
          await _stopPipeline(p);
          return null;
        }
        // EOS während Preroll = Quelle konnte nicht geöffnet werden → Strategie fehlgeschlagen
        if (t === 'eos') {
          this._log(`Preroll-EOS — Strategie fehlgeschlagen`, 'warn');
          await _stopPipeline(p);
          return null;
        }
        if (t === 'async-done') { ok = true; break; }
        if (!asyncPreroll && (t === 'stream-start' || t === 'new-clock' ||
            (t === 'state-changed' && m.newState >= 3))) {
          ok = true; break;
        }
      }
      if (!ok) {
        this._log(`Preroll Timeout (${timeoutMs}ms)`, 'warn');
        await _stopPipeline(p);
        return null;
      }
    }
    this._log(`Pipeline OK`, 'debug');
    return p;
  }

  /**
   * Hot-swap audio routing by updating only the audiomixmatrix.matrix property on
   * the running pipeline.  Zero gap, zero seek.
   *
   * Works only when the running element's in-channels matches the new matrix column
   * count.  Returns false otherwise so the caller falls back to reloadAudioPreset.
   *
   * IMPORTANT: changeOnAirPreset overwrites player._item.audioConfig.preset with the
   * NEW preset before calling here, so we cannot read the old preset from _item.
   * Instead we read in-channels from the live GStreamer element — that is the ground
   * truth for what the currently-running pipeline was built with.
   */
  async reloadAudioPresetMatrix(presetId) {
    if (!this._item || !this.vPipeline || !this._playing) return false;
    const cfg = this.audioGroupConfig;
    if (!cfg || !this.aPipeline) return false;

    const audioTracks = this._item.audioTracks || [];
    const fullTracks  = audioTracks.length ? audioTracks : null;

    const newPreset  = cfg.getPreset(presetId) || cfg.getPreset('stereo');
    const newCompact = fullTracks
      ? AudioRouter.compactTracksForPreset(fullTracks, newPreset)
      : { tracks: null, preset: newPreset };

    const trackInCh = t => Array.isArray(t.subIndices) ? t.subIndices.length : Math.max(1, t.channels || 1);
    const newInCh = newCompact.tracks ? newCompact.tracks.reduce((s, t) => s + trackInCh(t), 0) : 2;

    const updates = AudioRouter.computeMatrixUpdates(cfg, newCompact.preset, newInCh, this.slotId);
    if (updates.size === 0) {
      this._log(`reloadAudioPresetMatrix: no routes in preset ${presetId}`, 'warn');
      return false;
    }

    // First pass: resolve elements and verify that each running element's in-channels
    // matches the new matrix column count.  Do NOT write yet — if any element
    // has the wrong dimension we need a full rebuild, not a partial update.
    const elems = new Map();
    for (const [name, matrix] of updates) {
      const el = this.aPipeline.getElementByName(name);
      if (!el) {
        this._log(`reloadAudioPresetMatrix: element ${name} missing — rebuild needed`, 'info');
        return false;
      }
      let actualInCh;
      try {
        const prop = el.getElementProperty('in-channels');
        // gst-kit wraps primitives as { type, value }; plain number is also possible.
        actualInCh = (prop !== null && typeof prop === 'object' && 'value' in prop)
          ? prop.value
          : prop;
      } catch (e) {
        this._log(`reloadAudioPresetMatrix: ${name}: getProperty failed — rebuild needed`, 'info');
        return false;
      }
      const needCols = matrix[0]?.length ?? 0;
      if (actualInCh !== needCols) {
        this._log(
          `reloadAudioPresetMatrix: ${name} in-channels=${actualInCh} but matrix needs ${needCols} cols — rebuild needed`,
          'info',
        );
        return false;
      }
      elems.set(name, { el, matrix });
    }

    // Second pass: all dimensions match — update matrices.
    let allOk = true;
    for (const [name, { el, matrix }] of elems) {
      try {
        el.setElementProperty('matrix', matrix);
      } catch (e) {
        this._log(`reloadAudioPresetMatrix: ${name}: ${e.message}`, 'warn');
        allOk = false;
      }
    }

    if (!allOk) return false;

    this._item = {
      ...this._item,
      audioConfig: { ...(this._item.audioConfig || {}), preset: presetId },
    };
    this._log(`Audio-Matrix hot-swap → ${presetId}`);
    return true;
  }

  /**
   * Hot-swap audio routing preset while video continues uninterrupted.
   * Rebuilds the audio pipeline directly on real channels (temp-channel approach
   * is unusable: setElementProperty('channel') does not redirect the surface pointer).
   * No seek is attempted — seeking through the interleave element (mxf pull-mode)
   * leaves queues in FLUSHING state when it fails, causing permanent silence.
   * The new pipeline plays from position 0; a brief content mismatch with video is
   * acceptable. Use reloadAudioPresetMatrix() first for the no-gap path.
   */
  async reloadAudioPreset(presetId) {
    if (!this._item || !this.vPipeline || !this._playing) return false;
    const cfg = this.audioGroupConfig;
    if (!cfg) return false;

    // Keep old pipeline PLAYING throughout preroll so real channels never go silent.
    const oldAp = this.aPipeline;
    this.aPipeline = null;  // causes _watchAudioBus to exit on next busPop

    this._item = {
      ...this._item,
      audioConfig: { ...(this._item.audioConfig || {}), preset: presetId },
    };

    const uri = `file://${this._item.filePath}`;
    const ch  = this.slotId;
    const fps = this.opts.fps || 25;

    const strategies = this._buildAudioPipeline(uri, ch, fps, this._item.audioTracks || [], this._item.audioConfig);
    for (const aStr of strategies) {
      const strict = /interleave name=/.test(aStr) && /db\.(src_|track_)/.test(aStr);

      // Build directly on real channels. setElementProperty('channel') does NOT
      // redirect the GstInterSurface pointer cached by start() — so temp-channel
      // approaches always leave the new pipeline silent after the switch.
      // Instead: preroll on real channels (old pipeline still writing), play new
      // pipeline, then fire-and-forget stop old. Old's stop() clears the surface
      // at PAUSED→READY (~100ms from now); new pipeline fills within one render
      // period (~20ms), covered by audiomixer's 100ms min-upstream-latency buffer.
      const ap = await this._tryPipeline(aStr, strict ? 4000 : 10000, strict);
      if (!ap) continue;

      const playRes = await ap.play(3000).catch(e => {
        this._log(`Audio play: ${e.message}`, 'warn');
        return { result: 'failure' };
      });
      if (playRes?.result === 'failure') { await _stopPipeline(ap); continue; }

      if (playRes?.result === 'async') {
        const deadline = Date.now() + 500;
        while (Date.now() < deadline && !ap.playing()) {
          await new Promise(r => setTimeout(r, 20));
        }
      }

      if (oldAp) _stopPipeline(oldAp).catch(() => {});

      this.aPipeline = ap;
      this._watchAudioBus().catch(() => {});
      this._log(`Audio-Preset rebuild → ${presetId}`);
      return true;
    }

    if (oldAp) _stopPipeline(oldAp).catch(() => {});
    this._log(`Audio-Preset rebuild fehlgeschlagen: ${presetId}`, 'warn');
    return false;
  }

  /**
   * Hot-swap AFD setting while audio continues uninterrupted.
   * Stops the video pipeline, rebuilds it with the new AFD, seeks to the
   * current position, and restarts. Causes a brief video freeze (~200ms).
   */
  async reloadAfd(newAfd) {
    if (!this._item || !this.vPipeline || !this._playing) return false;

    // queryPosition() already returns absolute file position (includes SOM offset)
    let absPos = 0;
    try { absPos = this.vPipeline.queryPosition() ?? 0; } catch {}

    this._item = { ...this._item, afd: newAfd };

    const oldVp = this.vPipeline;
    this.vPipeline = null;
    // Must await full teardown: both old and new use intervideosink channel=<slot>
    // (single shared ring buffer). Setting vPipeline=null first prevents the
    // _watchVideoBus loop from forwarding EOS from the stopping pipeline.
    if (oldVp) await _stopPipeline(oldVp);

    const uri = `file://${this._item.filePath}`;
    const ch  = this.slotId;
    const fps = this.opts.fps || 25;

    let vp = null;
    if (PlayerPipeline._nvdecAvailable) {
      const vNvdec = this._buildVideoPipelineNvdec(uri, ch, fps);
      if (vNvdec) vp = await this._tryPipeline(vNvdec, 8000);
    }
    if (!vp) {
      const vStr = this._buildVideoPipeline(uri, ch, fps);
      vp = await this._tryPipeline(vStr, 12000);
    }
    if (!vp) {
      this._log(`AFD hot-swap fehlgeschlagen: ${newAfd}`, 'warn');
      return false;
    }
    if (absPos > 0.01) {
      try { await vp.seek(absPos); } catch(e) { this._log(`Video seek: ${e.message}`, 'warn'); }
    }
    await vp.play().catch(e => this._log(`Video play: ${e.message}`, 'warn'));
    this.vPipeline = vp;
    // _watchVideoBus exits when vPipeline was null — restart it for the new pipeline
    this._watchVideoBus().catch(() => {});
    this._log(`AFD hot-swap → ${newAfd}`);
    return true;
  }

  // ── Playback-Kontrolle ────────────────────────────────────────────────────

  async go() {
    if (!this.vPipeline) return;
    this._playing = true;
    this._setMute(false);
    await Promise.all([
      this.vPipeline.play().catch(e => this._log(`go video: ${e.message}`, 'warn')),
      this.aPipeline ? this.aPipeline.play().catch(e => this._log(`go audio: ${e.message}`, 'warn')) : Promise.resolve(),
    ]);
    this._log('PLAYING');
    this.emit('playing', { slotId: this.slotId });
    this.startPositionPoll();
  }

  async pause() {
    if (!this.vPipeline) return;
    this._setMute(true);
    await Promise.all([
      this.vPipeline.pause().catch(() => {}),
      this.aPipeline ? this.aPipeline.pause().catch(() => {}) : Promise.resolve(),
    ]);
    this._log('PAUSED');
  }

  async stop() {
    this._busLoop = false;
    this._cued    = false;
    this._running = false;
    this._playing = false;
    this.stopPositionPoll();
    if (this.opts.debugger?.enabled) this.opts.debugger.stop(this.slotId);
    // Join any already-running stop (e.g. from _stopAll's fire-and-forget p.stop()).
    // Without this guard, load() sees null pipelines and skips the GStreamer teardown,
    // so the old pipeline keeps writing to the interaudio ring buffer while the new
    // one starts → concurrent writers → ring-buffer corruption / audio bleed.
    if (this._pendingStop) { await this._pendingStop; return; }
    const vp = this.vPipeline;
    const ap = this.aPipeline;
    this.vPipeline = null;
    this.aPipeline = null;
    this._pendingStop = Promise.all([_stopPipeline(vp), _stopPipeline(ap)])
      .finally(() => { this._pendingStop = null; });
    await this._pendingStop;
    this._item = null;
    this._log('Gestoppt');
    this.emit('stopped', { slotId: this.slotId });
  }

  startPositionPoll(ms = 250) {
    this.stopPositionPoll();
    this._poller = setInterval(() => {
      if (!this.vPipeline || !this._running) return;
      try {
        const pos = this.vPipeline.queryPosition();
        const dur = this.vPipeline.queryDuration();
        this.emit('position', { pos, dur });
        const eom = this._item?.eom;
        const eomTol = 1.5 / (this.opts.fps || 25);  // 1.5 frames tolerance
        if (eom != null && pos != null && pos >= eom - eomTol) {
          this._log(`EOM pos=${toTC(pos, this.opts.fps||25)} eom=${toTC(eom, this.opts.fps||25)}`);
          this.emit('eom', { slotId: this.slotId });
          this.stopPositionPoll();
          // Pause BOTH pipelines at EOM. Pausing audio prevents it from running past EOM
          // and triggering an interaudiosink EOS flush (which wipes the ring buffer and
          // causes a 200 ms audiomixer stall — heard as choppy audio at every clip end).
          this.vPipeline?.pause().catch(() => {});
          this.aPipeline?.pause().catch(() => {});
        }
      } catch {}
    }, ms);
  }

  stopPositionPoll() {
    if (this._poller) { clearInterval(this._poller); this._poller = null; }
  }

  // Legacy API aliases
  _startPositionPoll(ms) { return this.startPositionPoll(ms); }
  _stopPositionPoll()    { return this.stopPositionPoll(); }

  async _watchBus() {
    // Video-Bus: EOS + Fehler (Haupt-Bus)
    this._watchVideoBus();
    // Audio-Bus: Fehler loggen (EOS wird von Video-Bus getriggert)
    this._watchAudioBus();
  }

  async _watchVideoBus() {
    while (this._busLoop && this.vPipeline) {
      try {
        const msg = await this.vPipeline.busPop(500);
        if (!msg) continue;

        if (msg.type === 'element' && msg.srcElementName?.startsWith('level_')) {
          const rms  = msg.rms  ?? [];
          const peak = msg.peak ?? [];
          const ch   = msg.srcElementName.replace(/^level_/, '');
          this.emit('level', { slot: this.slotId, channel: ch, rms, peak });

        } else if (msg.type === 'element' && /decklink/i.test(msg.srcElementName || '')) {
          // DeckLink IP/SDI signal status — structureName indicates signal validity
          const ok = !/error|lost|invalid|no.?signal/i.test(msg.structureName || '');
          this.emit('decklink-signal', {
            slot: this.slotId, ok,
            structure: msg.structureName || '',
            src:       msg.srcElementName || '',
          });

        } else if (msg.type === 'error' || msg.type === 'warning') {
          const txt = msg.errorMessage || msg.warningMessage || msg.message || '';
          if (/colorimetry|delayed.link|not.linked|could.not.get|internal.data.stream|buffer.time|period.time|No decoder available|audio\/x-raw/i.test(txt)) continue;
          this._log(`⚠ video ${msg.srcElementName}: ${txt.slice(0,120)}`, 'warn');

        } else if (msg.type === 'eos') {
          if (!this._playing || !this.vPipeline) {
            // vPipeline===null means reloadAfd is in progress — EOS is from the
            // old pipeline being stopped, not a real end-of-content signal.
            this._log('EOS ignoriert (nicht playing oder Pipeline-Rebuild)', 'debug');
            continue;
          }
          this._log('EOS');
          this.emit('eos', { slotId: this.slotId });
        }
      } catch { break; }
    }
  }

  async _watchAudioBus() {
    while (this._busLoop && this.aPipeline) {
      try {
        const msg = await this.aPipeline.busPop(500);
        if (!msg) continue;

        if (msg.type === 'element' && msg.srcElementName?.startsWith('level_')) {
          const rms  = msg.rms  ?? [];
          const peak = msg.peak ?? [];
          const ch   = msg.srcElementName.replace(/^level_/, '');
          this.emit('level', { slot: this.slotId, channel: ch, rms, peak });

        } else if (msg.type === 'error' || msg.type === 'warning') {
          const txt = msg.errorMessage || msg.warningMessage || msg.message || '';
          if (/colorimetry|delayed.link|not.linked|could.not.get|internal.data.stream|buffer.time|period.time/i.test(txt)) continue;
          this._log(`⚠ audio ${msg.srcElementName}: ${txt.slice(0,120)}`, 'warn');
        }
        // EOS auf Audio-Bus ignorieren — Video-Bus ist maßgeblich
      } catch { break; }
    }
  }
}

// Gesetzt von server.js (applyNvdecRankEarly) BEVOR gst_init().
// true  → GST_PLUGIN_FEATURE_RANK enthält nvdec:512 — uridecodebin bevorzugt NVDEC.
// Außerdem: expliziter MXF-NVDEC-Pfad (filesrc!mxfdemux!nvdec) als erste Video-Strategie.
PlayerPipeline._nvdecAvailable = false;

module.exports = PlayerPipeline;
