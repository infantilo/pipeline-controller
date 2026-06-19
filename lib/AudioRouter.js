'use strict';
/**
 * AudioRouter
 * ───────────
 * Baut GStreamer-Pipeline-Fragmente für dynamisches Audio-Routing.
 *
 * ─── ARCHITEKTUR ────────────────────────────────────────────────────────────────
 *
 *  PLAYER-SEITE (buildPlayerFragments):
 *
 *   uridecodebin ─► audio-Queue ─► audioconvert ─► audioresample ─► outCaps
 *                                                                    │
 *              ┌───────────────────────────────────────┐             │
 *              │  Pro Gruppe (aus audio_config.json):  │◄────────────┘
 *              │  audiomixmatrix [routing-matrix]      │
 *              │  ─► audioconvert ─► audioresample     │
 *              │  ─► audio/x-raw,F32LE,layout=i        │
 *              │  ─► interaudiosink channel=<slot>_<g> │
 *              └───────────────────────────────────────┘
 *
 *   Nicht gemappte Audio-Pads von uridecodebin → queue ! fakesink sync=false
 *
 *  MASTER-SEITE (buildMasterOutputs):
 *
 *   interaudiosrc channel=player1_<g> ─► queue ─► audioconvert ─► agrp_<g>.sink_0
 *   interaudiosrc channel=player2_<g> ─► queue ─► audioconvert ─► agrp_<g>.sink_1
 *
 *   input-selector name=agrp_<g> ─► audioconvert ─► level ─► pulsesink
 *
 *  SILENCE-SEEDER (buildSilenceSeeders, separate Pipeline):
 *   audiotestsrc wave=silence ─► audio/x-raw,F32LE ─► interaudiosink channel=<slot>_<g>
 *   Für jeden Slot + jede Gruppe. Hält interaudio-Channels aktiv.
 *
 * ─── AUDIO-RULES-ENGINE ─────────────────────────────────────────────────────────
 *
 *  Pro Gruppe wird die Matrix aus dem Preset berechnet:
 *   1. Preset hat routes für diese Gruppe → direkt routen
 *   2. Nicht direkt, aber upmix-Spec vorhanden → Upmix von Quellgruppe
 *   3. Keine Zuordnung → null (Silence-Seeder füllt Channel)
 *
 *  Unterstützte Upmix-Methoden:
 *   "loro"    — LoRo Stereo→5.1: L→L, R→R, C/LFE/Ls/Rs=0
 *   "prosurround" — TODO Phase 2
 *   "dolby"   — TODO Phase 2
 *
 * ─── PRESET-FORMAT ──────────────────────────────────────────────────────────────
 *
 *  {
 *    label: "Stereo",
 *    routes: [                                // Direkte Kanal-Zuordnung
 *      { from: "mxf_ch1", to: ["pgm-stereo:L"] },
 *      { from: "mxf_ch2", to: ["pgm-stereo:R"] }
 *    ],
 *    upmix: [                                 // Optionale Upmix-Regeln
 *      { from: "pgm-stereo", to: "pgm-51", method: "loro" }
 *    ]
 *  }
 *
 *  Kanalbezeichner: L, R, C, LFE, Ls, Rs (5.1), LS/RS (Alias für Ls/Rs)
 *  Quellen:         mxf_ch1..mxf_chN (1-basiert = Track-Nummer in der Datei)
 */

// GStreamer requires channel-mask for >2 channels; 0 = unpositioned (any order)
function _audioCaps(channels, rate = 48000) {
  const mask = channels > 2 ? `,channel-mask=(bitmask)0` : '';
  return `audio/x-raw,format=F32LE,rate=${rate},channels=${channels},layout=interleaved${mask}`;
}

class AudioRouter {
  /**
   * @param {AudioGroupConfig} cfg          — Gruppen + Presets
   * @param {object|null}      preset       — Aktives Preset-Objekt
   * @param {number}           numInChannels — Anzahl Audio-Eingangskanäle (aus Mediafile)
   * @param {string}           slotId       — 'player1' | 'player2' | …
   */
  constructor(cfg, preset, numInChannels, slotId) {
    this._cfg      = cfg;
    this._preset   = preset || cfg.getDefaultPreset() || null;
    this._inCh     = Math.max(1, numInChannels || 2);
    this._slotId   = slotId;
  }

  // ── Kanal-Name ────────────────────────────────────────────────────────────────

  /** interaudio-Kanal-Name für slot + Gruppe, z.B. "player1_pgm-stereo" */
  groupChannel(groupId) {
    return `${this._slotId}_${groupId}`;
  }

  // ── Player-Seite: buildPlayerFragments() ─────────────────────────────────────

  /**
   * Baut GStreamer-Fragmente für EINE Audio-Quelle in der Player-Pipeline.
   *
   * AUFBAU (Strategie 3 / Direkt):
   *   Für jede Gruppe ein Fragment:
   *     audiomixmatrix [matrix] ! audioconvert ! audioresample
   *     ! audio/x-raw,F32LE,rate=48000,channels=N,layout=interleaved
   *     ! interaudiosink channel=<slot>_<groupId> sync=false async=false
   *
   *   Das Fragment wird nach einem gemeinsamen tee eingefügt:
   *     atee. ! <fragment>
   *
   *   Gruppen ohne Mapping: null (Silence-Seeder im Master füllt).
   *
   * @returns {Array<string|null>}  Ein Eintrag pro Gruppe. null = kein Mapping.
   */
  buildPlayerFragments() {
    const rate  = 48000;
    const frags = [];

    for (const group of this._cfg.groups) {
      const ch      = this.groupChannel(group.id);
      const outCaps = _audioCaps(group.channels, rate);
      const matrix  = this._groupMatrix(group);

      if (!matrix) {
        // Kein Mapping für diese Gruppe — Silence-Seeder im Master hält Channel aktiv.
        // KEIN audiotestsrc im Player: crasht ohne Pipeline-Clock beim PLAYING-Übergang.
        frags.push(null);
        continue;
      }

      const actualIn = matrix[0]?.length || this._inCh;
      const matStr   = AudioRouter._matrixToGst(matrix);
      const amxName  = `amx_${this._slotId}_${group.id.replace(/-/g, '_')}`;

      frags.push(
        `queue max-size-buffers=0 max-size-time=200000000 max-size-bytes=0` +
        ` ! audiomixmatrix name=${amxName} in-channels=${actualIn} out-channels=${group.channels} matrix="${matStr}"` +
        ` ! audioconvert ! audio/x-raw,layout=interleaved ! audioresample ! ${outCaps}` +
        // max-lateness=-1: never drop late buffers on PAUSE→PLAY transition.
        // Default GstBaseSink max-lateness=20ms causes first audio frames after go() to be
        // dropped as "late" when the pipeline clock hasn't fully stabilized yet.
        ` ! interaudiosink name=ia_${this._slotId}_${group.id.replace(/-/g,'_')} channel=${ch} sync=true async=false max-lateness=-1`
      );
    }
    return frags;
  }

  /**
   * Computes the routing matrix for a single group under the current preset.
   * Returns null if the group has no mapping (silence seeder takes over).
   *
   * @param {{id: string, channels: number}} group
   * @returns {number[][]|null}
   */
  _groupMatrix(group) {
    const preset      = this._preset;
    const inCh        = this._inCh;
    const hasRoutes   = preset && Array.isArray(preset.routes);
    const hasMappings = preset && preset.mappings && typeof preset.mappings === 'object';

    if (hasRoutes) {
      const upmixTargets = {};
      if (Array.isArray(preset.upmix)) {
        for (const u of preset.upmix) upmixTargets[u.to] = u;
      }
      const matrix = AudioRouter._matrixFromRoutes(preset.routes, inCh, group.id, group.channels);
      if (matrix) return matrix;
      if (upmixTargets[group.id]) {
        return this._buildUpmixMatrix(preset, upmixTargets[group.id], inCh, group.channels);
      }
      return null;
    }

    if (hasMappings) {
      const mapping = preset.mappings[group.id];
      if (mapping) {
        return mapping.matrix || AudioRouter._identityMatrix(Math.min(inCh, group.channels), group.channels);
      }
    }
    return null;
  }

  /**
   * Computes the matrix update map for a new preset without rebuilding pipelines.
   * Returns Map<elementName, number[][]> for every group that has a route in the new preset.
   * The raw number[][] is passed directly to setElementProperty() so gst-kit can build
   * the GST_TYPE_ARRAY value programmatically (avoiding gst_value_deserialize nested-array
   * bug in GStreamer < 1.24).
   *
   * @param {AudioGroupConfig} cfg
   * @param {object}           preset        — New preset object (already compacted/remapped)
   * @param {number}           numInChannels
   * @param {string}           slotId
   * @returns {Map<string, number[][]>}
   */
  static computeMatrixUpdates(cfg, preset, numInChannels, slotId) {
    const router = new AudioRouter(cfg, preset, numInChannels, slotId);
    const result = new Map();
    for (const group of cfg.groups) {
      const matrix = router._groupMatrix(group);
      if (matrix) {
        const name = `amx_${slotId}_${group.id.replace(/-/g, '_')}`;
        result.set(name, matrix);
      }
    }
    return result;
  }

  // ── Upmix-Matrix berechnen ────────────────────────────────────────────────────

  /**
   * Kombiniert: Routes für Quellgruppe → Upmix-Matrix → Zielgruppe.
   * Ergebnis: (outCh × inCh) Matrix direkt anwendbar auf inCh Eingangskanäle.
   *
   * @param {object} preset
   * @param {object} uSpec       { from, to, method }
   * @param {number} inCh
   * @param {number} outCh
   * @returns {number[][]|null}
   */
  _buildUpmixMatrix(preset, uSpec, inCh, outCh) {
    const srcGrp = this._cfg.getGroup(uSpec.from);
    if (!srcGrp) return null;
    const srcCh = srcGrp.channels;

    // Stage 1: inCh → srcCh (Route der Quellgruppe)
    const srcMat = AudioRouter._matrixFromRoutes(
      preset.routes, inCh, uSpec.from, srcCh
    ) || AudioRouter._identityMatrix(Math.min(inCh, srcCh), srcCh);

    // Stage 2: srcCh → outCh (Upmix/Downmix)
    const mixMat = AudioRouter._mixMatrix(uSpec.method, srcCh, outCh);

    // Kombiniert: (outCh × inCh) = mixMat(outCh×srcCh) × srcMat(srcCh×inCh)
    return AudioRouter._multiplyMatrices(mixMat, srcMat);
  }

  // ── Master-Seite: buildMasterOutputs() ───────────────────────────────────────

  /**
   * Baut GStreamer-Fragmente für die Master-Pipeline.
   * Pro Gruppe: alle Slot-Quellen via interaudiosrc → input-selector → Sink.
   *
   * @param {AudioGroupConfig} cfg
   * @param {string[]}         slotIds     — ['player1', 'player2', …]
   * @param {object|null}      sinkCfg     — { type, bufferTime, device }
   * @returns {string[]}
   */
  /**
   * @param {AudioGroupConfig} cfg
   * @param {string[]} slotIds
   * @param {object|null} sinkCfg
   * @param {number} numVoSlots
   * @param {Array<{id:string}>} liveSourceIds  — Live-Quellen-IDs für Audio-Shuffling
   */
  static buildMasterOutputs(cfg, slotIds, sinkCfg = null, numVoSlots = 1, liveSourceIds = []) {
    const frags    = [];
    const rate     = 48000;
    const voSlots  = Array.from({ length: Math.max(1, numVoSlots) }, (_, i) => `vo${i + 1}`);

    for (const [groupIdx, group] of cfg.groups.entries()) {
      const isPrimary = groupIdx === 0;  // Erste Gruppe → Clock-Provider
      const selName   = `agrp_${group.id.replace(/-/g, '_')}`;
      const caps      = _audioCaps(group.channels, rate);
      const sink      = AudioRouter._buildSink(group, sinkCfg, isPrimary);

      // ── Prog-Source-Mixer (selName) ─────────────────────────────────────────────
      // Ersetzt den früheren input-selector.
      // Alle Programm-Quellen (Player, SMPTE, BLACK, IMAGE, IMAGE_PL) laufen parallel
      // in diesen audiomixer — jede mit eigenem volume-Element (default 0.0).
      // Umschalten = Ziel-Volume auf 1.0, alle anderen auf 0.0.
      // Kein input-selector → kein DISCONT-Event → kein Audio-Aussetzer bei jedem Switch.
      // SINGLE audiomixer per group — no chained mixers.
      // Previous two-stage design (selName→duck→mixName→tee) caused:
      //   • 100ms extra latency (mixName latency buffer)
      //   • VO bleed: vo_vol cut on selName, but audio already in mixName's 100ms buffer
      //     continued playing — audible as short repeated VO bursts on every clip boundary
      //   • A/V sync drift: each mixer stage adds scheduling jitter
      // Single mixer: player + static + VO sources all feed selName directly.
      // pulsesink sync=true: audio is submitted to PA at the correct pipeline clock time
      //   (synchronized with ximagesink). Previous sync=false caused PA buffer to fill up
      //   independently, making audio appear up to buffer-time (400ms) late vs video.
      const duckV    = `pgm_duck_${selName}`;
      const teeName  = `tee_${selName}`;
      const adelName = `adel_${group.id.replace(/-/g, '_')}`;
      const progSrcMixer = (
        // latency=20ms: smaller committed buffer → pvol changes take effect within 20ms instead
        // of 100ms, eliminating audible "bleed" of the outgoing source on every cut/transition.
        // Previously 100ms (was 50ms before that) — reduced because MXF decoder CPU spike is
        // absorbed at player.go() preroll time, not at the mixer; and leaky=downstream queues
        // now deliver fresh audio immediately so the mixer no longer needs the large window.
        // min-upstream-latency=100ms: kept conservatively large to avoid the "Latency query
        // failed" startup race (audiomixer queries before all interaudiosrc pads activate).
        `audiomixer name=${selName} latency=20000000 min-upstream-latency=100000000` +
        ` ! audioconvert ! audio/x-raw,layout=interleaved ! audioresample ! ${caps}` +
        ` ! volume name=${duckV} volume=1.0` +
        ` ! tee name=${teeName}` +
        ` ${teeName}. ! queue max-size-buffers=2 leaky=downstream ! appsink name=apslevel_${selName} max-buffers=2 drop=true sync=false async=false` +
        ` ${teeName}. ! queue max-size-buffers=5 leaky=downstream ! interaudiosink channel=rec_pgm_a_${selName} sync=false async=false` +
        // A/V-Sync: identity adel_<groupId> ts-offset=0 — Audio-Delay pro Gruppe,
        // runtime-änderbar via setElementProperty('ts-offset', nanoseconds).
        // Nur im Output-Branch, nicht in Recording/Metering.
        ` ${teeName}. ! identity name=${adelName} ts-offset=0 sync=false ! ${sink}`
      );

      // Single keepalive — prevents GStreamer 1.22 audiomixer EOS bug when all pads are empty.
      const progMixKeepalive = (
        `audiotestsrc wave=silence is-live=true do-timestamp=true` +
        ` ! ${caps}` +
        ` ! queue max-size-buffers=0 max-size-time=200000000 max-size-bytes=0 leaky=downstream` +
        ` ! ${selName}.`
      );

      // Player sources with per-source volume → prog-source-mixer.
      // latency-time=20ms: interaudiosrc reports 20ms upstream latency → audiomixer
      //   latency negotiation settles fast, preventing random group stalling on startup.
      // leaky=downstream: oldest queued buffer dropped when full → transition always delivers
      //   the FRESHEST audio. During pre-cue (player PAUSED, queue filling with seeder silence),
      //   when player.go() fires and fresh MXF audio arrives it immediately displaces old silence.
      //   max 4 buffers × 512 samples @ 48kHz ≈ 42ms max stale audio vs 200ms before.
      const playerSrcs = slotIds.map((slotId) => {
        const ch      = `${slotId}_${group.id}`;
        const volName = `pvol_${slotId.replace(/-/g,'_')}_${selName}`;
        return (
          // Default period-time (25ms): interaudiosrc produces 25ms buffers → 2 per audiomixer
          // cycle (latency=50ms). period-time=5ms was tried but caused crackling/fragmentation:
          // 10 micro-buffers per cycle × 30+ sources = 6000+ audiomixer wakeups/s, exhausting
          // CPU scheduling and causing gaps. Default period-time matches audiomixer latency well.
          // timeout=50ms: when ring buffer has no data (writer paused/stopped),
          // interaudiosrc generates silence instead of stalling for the default 1 s.
          // This prevents audiomixer from hitting its min-upstream-latency wait
          // every time a player's audio pipeline pauses at EOM or is pre-cued,
          // and avoids all-group stall during audio preset hot-swap (reloadAudioPreset).
          `interaudiosrc channel=${ch} do-timestamp=true latency-time=20000000` +
          ` ! queue max-size-buffers=0 max-size-time=200000000 max-size-bytes=0 leaky=downstream` +
          ` ! audioconvert ! audio/x-raw,layout=interleaved ! audioresample ! ${caps}` +
          ` ! volume name=${volName} volume=0.0` +
          ` ! ${selName}.`
        );
      });

      // Static-Quellen mit per-Source-Volume → prog-source-mixer.
      // audiotestsrc meldet auf manchen GStreamer-Builds max_latency=0;
      // Queue stellt sicher, dass latency > 0 für audiomixer-Latenz-Matching.
      const tsQueue = `! queue max-size-buffers=0 max-size-time=40000000 max-size-bytes=0 leaky=downstream`;
      const staticSrcs = [
        [`smpte_vol_${selName}`,   'sine',    1000],
        [`black_vol_${selName}`,   'silence', 0],
        [`image_vol_${selName}`,   'silence', 0],
        [`imagepl_vol_${selName}`, 'silence', 0],
      ].map(([volName, wave, freq]) => {
        const waveParam = wave === 'sine' ? `wave=sine freq=${freq}` : `wave=silence`;
        return (
          `audiotestsrc ${waveParam} is-live=true do-timestamp=true` +
          ` ${tsQueue} ! ${caps}` +
          ` ! volume name=${volName} volume=0.0` +
          ` ! ${selName}.`
        );
      });

      // VO sources → selName directly (no separate mixName audiomixer).
      // VO sources → selName. Default period-time (25ms). Queue max-size-buffers=2 → 50ms max
      // stale VO audio (previously 400ms caused post-stop bleed for 400ms per clip boundary).
      const voGroupFrags = voSlots.map(slotId => {
        const ch         = `${slotId}_${group.id}`;
        const volName    = `vo_vol_${slotId}_${selName}`;
        const vcaps2ch   = `audio/x-raw,format=F32LE,rate=${rate},channels=2,layout=interleaved`;
        const capsNoMask = caps.replace(/,channel-mask=\(bitmask\)\d+/, '');
        const upmixFrag  = group.channels > 2
          ? ` ! audiomixmatrix in-channels=2 out-channels=${group.channels}` +
            ` matrix="${AudioRouter._matrixToGst(AudioRouter._mixMatrix('loro', 2, group.channels))}"`
          : '';
        return (
          `interaudiosrc channel=${ch} do-timestamp=true latency-time=20000000` +
          ` ! ${vcaps2ch}` +
          ` ! queue max-size-buffers=0 max-size-time=200000000 max-size-bytes=0 leaky=downstream` +
          ` ! volume name=${volName} volume=0.0` +
          ` ! audioconvert${upmixFrag} ! audioresample ! ${capsNoMask}` +
          ` ! ${selName}.`
        );
      });

      // Live-Source-Audio-Inputs → prog-source-mixer (Audio-Shuffling für Live-Quellen).
      // Jede Live-Quelle hat einen interaudiosrc-Kanal pro Gruppe (live1_pgm-stereo, etc.).
      // Volume=0.0 → wird on-air auf 1.0 gesetzt wie bei Player-Slots.
      const liveSrcs = (liveSourceIds || []).map(ls => {
        const lsId    = ls.id || ls;
        const ch      = `${lsId}_${group.id}`;
        const volName = `lvol_${lsId.replace(/[^a-z0-9]/gi,'_')}_${selName}`;
        return (
          `interaudiosrc channel=${ch} do-timestamp=true latency-time=20000000` +
          ` ! queue max-size-buffers=0 max-size-time=200000000 max-size-bytes=0 leaky=downstream` +
          ` ! audioconvert ! audio/x-raw,layout=interleaved ! audioresample ! ${caps}` +
          ` ! volume name=${volName} volume=0.0` +
          ` ! ${selName}.`
        );
      });

      frags.push(progSrcMixer, progMixKeepalive, ...playerSrcs, ...staticSrcs, ...voGroupFrags, ...liveSrcs);
    }
    return frags;
  }

  /**
   * Baut Silence-Seeder-Fragmente für die Voiceover-Kanäle (eine separate Pipeline).
   * Hält die interaudio-Kanäle des Mixers aktiv wenn kein VO läuft.
   *
   * @param {AudioGroupConfig} cfg
   * @returns {string[]}
   */
  static buildVoSilenceSeeders(_cfg) {
    // Nicht mehr benötigt: VO läuft via appsrc in der Master-Pipeline (gleiche Clock).
    return [];
  }

  // ── Silence-Seeder (separate Pipeline) ───────────────────────────────────────

  /**
   * Baut Silence-Seeder-Fragmente für eine SEPARATE Pipeline.
   *
   * Warum separate Pipeline?
   *   GStreamer interaudio: intra-pipeline Loops über shared memory erzeugen
   *   Deadlocks/Errors. Seeder-Pipeline ist von Master-Pipeline getrennt.
   *
   * Seeder schreiben Stille auf alle Player-Channels einer oder aller Gruppen.
   * interaudiosrc im Master liest immer → keine not-negotiated Errors.
   * Wenn Player startet überschreibt er die Stille (last-writer-wins).
   *
   * @param {AudioGroupConfig} cfg
   * @param {string[]}         slotIds      — alle Slot-IDs
   * @param {string|null}      forSlotId    — wenn gesetzt: nur für diesen Slot
   * @returns {string[]}
   */
  /**
   * @param {AudioGroupConfig} cfg
   * @param {string[]} slotIds
   * @param {string|null} forSlotId
   * @param {Array<{id:string}>} liveSourceIds  — Live-Quellen-IDs (Silence-Seeder für deren Channels)
   */
  static buildSilenceSeeders(cfg, slotIds, forSlotId = null, liveSourceIds = []) {
    const rate        = 48000;
    const frags       = [];
    const targetSlots = forSlotId ? [forSlotId] : [...slotIds, ...liveSourceIds.map(ls => ls.id || ls)];

    for (const group of cfg.groups) {
      const caps = _audioCaps(group.channels, rate);
      for (const slotId of targetSlots) {
        const ch = `${slotId}_${group.id}`;
        frags.push(
          `audiotestsrc wave=silence is-live=true do-timestamp=true` +
          ` ! ${caps}` +
          ` ! interaudiosink channel=${ch} sync=false async=false`
        );
      }
    }
    return frags;
  }

  /**
   * Baut Silence-Seeder-Fragmente für die Voiceover-Interaudio-Kanäle.
   * Schreibt 2ch-Stille auf vo_<groupId> für jede Gruppe.
   * VoiceoverEngine stoppt diesen Seeder bevor sie die eigene Pipeline startet.
   *
   * @param {AudioGroupConfig} cfg
   * @returns {string[]}
   */
  /**
   * @param {AudioGroupConfig} cfg
   * @param {string} slotId — 'vo1', 'vo2', …
   * @returns {string[]}
   */
  static buildVoSeedFragments(cfg, slotId) {
    const rate  = 48000;
    const caps2 = `audio/x-raw,format=F32LE,rate=${rate},channels=2,layout=interleaved`;
    return cfg.groups.map(group => {
      const ch = `${slotId}_${group.id.replace(/-/g, '_')}`;
      return (
        `audiotestsrc wave=silence is-live=true do-timestamp=true` +
        ` ! ${caps2}` +
        ` ! interaudiosink channel=${ch} sync=false async=false`
      );
    });
  }

  // ── Sink-Builder ──────────────────────────────────────────────────────────────

  /**
   * Baut GStreamer-Sink-String für eine Gruppe.
   *
   * Clock-Regeln:
   *   provide-clock=true nur auf der ERSTEN (primären) Gruppe.
   *   Alle anderen: provide-clock=false.
   *   Begründung: Mehrere Clock-Provider erzeugen Race-Conditions.
   *
   * TODO DeckLink/PTP (Phase 2/3):
   *   Wenn ClockStrategy.provider = 'ptp-decklink':
   *   → pulsesink provide-clock=false (externe Clock per pipeline.setClock())
   *   → pipeline.setClock(new GstPtpClock(...)) nach play()
   *
   * @param {object}      group       — {id, channels}
   * @param {object|null} sinkCfg     — {type, bufferTime, device, audioSink}
   * @param {boolean}     isPrimary   — Clock-Provider?
   * @returns {string}
   */
  static _buildSink(group, sinkCfg, isPrimary = false) {
    const name = `asink_${group.id.replace(/-/g, '_')}`;
    const buf  = sinkCfg?.bufferTime || 400000;
    const pc   = isPrimary ? 'true' : 'false';

    // pulsesink sync=true: audio submitted to PA at the correct GStreamer pipeline clock
    // time (same clock as ximagesink). Previous sync=false let PA fill its buffer
    // independently — audio could lag video by buffer-time (400ms) after source switches.
    // provide-clock=false: pulsesink clock caused ximagesink timestamp conflicts → freeze.
    //   System clock (GstSystemClock) is used by both ximagesink and pulsesink → A/V sync.
    // latency-time=50ms: PA pre-buffer. 100ms caused PA to schedule 100ms-size chunks
    //   which conflicted with audiomixer's 50ms output period → underruns. 50ms matches.
    // sync=false: pulsesink submits to PA immediately. sync=true caused startup stalls.
    // latency-time=200000 (200ms, was 100ms): pulsesink underflows logged in gst_audio.log
    // at T=12s,36s,44s,46s,58s — each immediately preceded by MXF video decoder startup
    // (caps negotiation warnings). Decoder init causes CPU spikes that starve the PA delivery
    // thread. 100ms PA pre-buffer was too small to absorb the spike. 200ms provides enough
    // headroom without exceeding AES/EBU A/V sync tolerance (+125ms/-25ms).
    const _pulseSinkProps = (btUs) =>
      `buffer-time=${btUs} latency-time=200000 provide-clock=false sync=false async=false`;
    const downmix2ch = (group.channels || 2) > 2
      ? `audioconvert ! audio/x-raw,channels=2 ! audioresample ! `
      : '';

    // Per-Gruppe sink überschreibt globalen sinkCfg
    if (group.sink) {
      const gs = group.sink;
      if (gs === 'fakesink') return `fakesink name=${name} sync=false`;
      if (gs === 'alsasink') return `alsasink name=${name} async=false`;
      if (gs === 'autoaudiosink') {
        const pcBuf = sinkCfg?.bufferTime || buf;
        return `${downmix2ch}pulsesink name=${name} ${_pulseSinkProps(pcBuf)}`;
      }
      // DeckLink-Ausgang (von /api/devices/sinks entdeckt, id-Form "decklink-out-<N>").
      // decklinkaudiosink hat keine Channels-Property — Kanalzahl kommt aus den Caps
      // und ist auf {2, 8, 16} beschränkt (Pad-Template-Capabilities).
      const dlMatch = /^decklink-out-(\d+)$/.exec(gs);
      if (dlMatch) {
        const dn  = dlMatch[1];
        const src = group.channels || 2;
        const dst = src <= 2 ? 2 : src <= 8 ? 8 : 16;
        // audioconvert kann Sample-Format ändern, aber keine beliebige Kanalzahl-
        // Änderung "erraten" (z.B. 6→8 schlägt mit "can't handle caps" fehl, weil
        // 5.1 kein Standard-Downmix/Upmix-Layout für 8ch hat). Daher Kanalzahl
        // EXPLIZIT per audiomixmatrix mappen (1:1, überzählige Ziel-Kanäle = Stille),
        // audioconvert macht danach nur noch F32LE→S16LE bei gleicher Kanalzahl.
        const matStr  = AudioRouter._matrixToGst(AudioRouter._identityMatrix(src, dst));
        const amxName = `dlmx_${name}`;
        return `audiomixmatrix name=${amxName} in-channels=${src} out-channels=${dst} matrix="${matStr}"` +
          ` ! audioconvert ! audio/x-raw,format=S16LE,channels=${dst},rate=48000 ! decklinkaudiosink name=${name} device-number=${dn} async=false`;
      }
      return `${downmix2ch}pulsesink name=${name} ${_pulseSinkProps(buf)}`;
    }

    if (!sinkCfg || sinkCfg.type === 'pulse') {
      return `${downmix2ch}pulsesink name=${name} ${_pulseSinkProps(buf)}`;
    }

    if (sinkCfg.type === 'alsa') {
      const dev = sinkCfg.device || 'default';
      return `alsasink name=${name} device="${dev}" buffer-time=${buf} provide-clock=${pc}`;
    }

    if (sinkCfg.type === 'fake') {
      return `fakesink name=${name} sync=false`;
    }

    if (sinkCfg.type === 'auto' || sinkCfg.audioSink === 'autoaudiosink') {
      return `${downmix2ch}pulsesink name=${name} ${_pulseSinkProps(buf)}`;
    }

    if (sinkCfg.type === 'custom') {
      const audioSink = sinkCfg.audioSink || 'pulsesink';
      if (audioSink === 'fakesink') return `fakesink name=${name} sync=false`;
      return isPrimary
        ? `${audioSink} name=${name} async=false`
        : `${audioSink} name=${name} async=false`;
    }

    // Fallback: audioSink-String aus Settings
    const audioSink = sinkCfg.audioSink || 'autoaudiosink';
    if (audioSink === 'fakesink') return `fakesink name=${name} sync=false`;
    if (audioSink === 'autoaudiosink') return isPrimary
      ? `pulsesink name=${name} ${_pulseSinkProps(200000)}`
      : `pulsesink name=${name} ${_pulseSinkProps(200000)}`;
    return `${downmix2ch}pulsesink name=${name} ${_pulseSinkProps(buf)}`;
  }

  // ── Kanal-Kompaktierung ───────────────────────────────────────────────────────

  /**
   * Reduziert den Datei-Kanal-Satz auf genau die Kanäle, die das aktive Preset
   * tatsächlich referenziert (mxf_chN in preset.routes), und liefert ein
   * äquivalentes Preset mit auf 1..M ummappten Indizes.
   *
   * Warum: Player baute bisher IMMER einen interleave-Graph über ALLE
   * Datei-Spuren (z.B. 8 Mono-Essenzen einer MXF), egal ob das Preset nur
   * 1-2 davon nutzt. Das ist der Hauptgrund für Preroll-Stalls (interleave
   * wartet auf Daten von bis zu 8 parallel laufenden Decoder-Ketten) UND
   * verschwendet CPU. Hier wird stattdessen nur das dekodiert, was das
   * Preset wirklich braucht — typischerweise 1 oder 2 Spuren.
   *
   * Kanalindizes sind global 1-basiert über alle Essenzen in Datei-Reihen-
   * folge gezählt (mxf_ch1 = erster Kanal der ersten Essenz, usw.) — exakt
   * wie _matrixFromRoutes sie interpretiert. Da die Sub-Kanäle einer Essenz
   * im globalen Index immer zusammenhängend sind, bleibt jede Essenz auch
   * nach der Sortierung der genutzten Indizes am Stück und in Reihenfolge.
   *
   * @param {Array}  tracks  — audioTracks der Datei ({streamIndex, channels})
   * @param {object} preset  — aktives Preset ({routes, upmix})
   * @returns {{tracks: Array, preset: object}}
   *   tracks — synthetische Essenz-Liste für _buildAudioSource:
   *            {streamIndex, channels, subIndices} — subIndices = welche
   *            Sub-Kanäle dieser Essenz gebraucht werden (Datei-Reihenfolge)
   *   preset — Kopie mit auf kompakte 1..M-Indizes ummappten routes;
   *            upmix bleibt unverändert (referenziert Gruppen, keine Kanäle)
   */
  /**
   * Kompaktiert den Datei-Kanal-Satz auf die UNION der von ALLEN
   * übergebenen Presets referenzierten Kanäle statt nur dem aktiven Preset.
   *
   * Warum: reloadAudioPresetMatrix() (zero-gap Matrix-Hot-Swap) funktioniert nur,
   * wenn die laufende Pipeline bereits die vom NEUEN Preset benötigte Kanalzahl
   * dekodiert — sonst muss reloadAudioPreset() die komplette Pipeline (filesrc!
   * mxfdemux ! interleave) neu aufbauen. Dieser Rebuild öffnet die Datei erneut,
   * indiziert sie neu und prerollt alle benötigten Essenzen parallel — empirisch
   * gemessen: ~50-250ms CPU-Burst über mehrere Threads, der den bereits laufenden
   * Master-Mixer-Pulsesink-Thread kurz verhungern lässt → hörbarer Underrun bei
   * JEDEM Preset-Hotswap, sobald sich die Kanalzahl ändert (z.B. Stereo→2 Ton).
   *
   * Fix: Beim initialen Pipeline-Aufbau (und identisch bei jedem Matrix-Hotswap-
   * Versuch) wird auf die UNION aller konfigurierten Presets kompaktiert — die
   * Essenzauswahl ist damit für die gesamte Clip-Laufzeit fix, jeder Wechsel
   * zwischen konfigurierten Presets bleibt im Matrix-Hotswap-Pfad (kein Rebuild).
   * Kosten: ggf. ein paar zusätzliche Mono-PCM-Essenzen werden durchgehend
   * dekodiert (vernachlässigbar gegenüber Re-Demux+Re-Preroll bei jedem Wechsel).
   *
   * @param {Array}        tracks
   * @param {object[]}     presets — alle Presets, zwischen denen gewechselt werden kann
   * @returns {{tracks: Array, forPreset: (preset:object) => object}}
   *   forPreset(preset) — liefert `preset` mit auf den gemeinsamen kompakten
   *   Kanalraum ummappten routes (Identität, falls keine Kompaktierung möglich war).
   */
  static compactTracksForPresets(tracks, presets) {
    const list = (presets || []).filter(p => p && Array.isArray(p.routes) && p.routes.length);
    const fallback = { tracks, forPreset: (p) => p };
    if (!list.length) return fallback;

    // Globaler 1-basierter Sub-Kanal-Index → physische Essenz + Sub-Position
    const flat = [];
    for (const t of tracks) {
      const ch = Math.max(1, t.channels || 1);
      for (let c = 0; c < ch; c++) flat.push({ streamIndex: t.streamIndex, channels: ch, subIndex: c });
    }

    const used = new Set();
    for (const preset of list) {
      for (const r of preset.routes) {
        const m = /^mxf_ch(\d+)$/.exec(r.from || '');
        if (m) used.add(parseInt(m[1], 10));
      }
    }
    const usedIdx = [...used].filter(n => n >= 1 && n <= flat.length).sort((a, b) => a - b);
    if (!usedIdx.length || usedIdx.length === flat.length) return fallback;
    // Falls ein Preset Kanäle jenseits der Datei-Spurzahl referenziert, nicht
    // partiell kompaktieren — voller Spursatz, damit _matrixFromRoutes diese
    // Outputs gracefully auf 0 setzen kann.
    if (usedIdx.length < used.size) return fallback;

    // Ummapping: globaler Index → kompakte Position (1-basiert) — EIN gemeinsamer
    // Index-Raum für alle Presets.
    const remapIdx = new Map(usedIdx.map((n, i) => [n, i + 1]));
    const remapRoutes = (routes) => (routes || []).map(r => {
      const m = /^mxf_ch(\d+)$/.exec(r.from || '');
      const n = m ? remapIdx.get(parseInt(m[1], 10)) : null;
      return n ? { ...r, from: `mxf_ch${n}` } : null;
    }).filter(Boolean);

    // Essenzen gruppieren — jede physische Essenz wird nur EINMAL dekodiert,
    // auch wenn mehrere ihrer Sub-Kanäle gebraucht werden (z.B. native Stereo).
    const byEssence = new Map();
    for (const n of usedIdx) {
      const f = flat[n - 1];
      let e = byEssence.get(f.streamIndex);
      if (!e) { e = { streamIndex: f.streamIndex, channels: f.channels, subIndices: [] }; byEssence.set(f.streamIndex, e); }
      e.subIndices.push(f.subIndex);
    }

    const compactTracks = [...byEssence.values()];
    return {
      tracks: compactTracks,
      forPreset: (preset) => {
        if (!preset || !Array.isArray(preset.routes) || !preset.routes.length) return preset;
        const compactRoutes = remapRoutes(preset.routes);
        return compactRoutes.length ? { ...preset, routes: compactRoutes } : preset;
      },
    };
  }

  // ── Routing-Matrix Berechnung ─────────────────────────────────────────────────

  /**
   * Leitet eine (outCh × inCh) Matrix aus routes-Array für eine Gruppe ab.
   *
   * routes-Einträge: { from: "mxf_ch1", to: ["pgm-stereo:L", ...] }
   *   mxf_ch1 = Track 1 (1-basiert) → Index 0
   *   pgm-stereo:L = Gruppe pgm-stereo, Kanal L (Index 0)
   *
   * @param {object[]} routes
   * @param {number}   inCh     — Anzahl Eingangskanäle
   * @param {string}   groupId  — Zielgruppe
   * @param {number}   outCh    — Ausgangskanäle der Gruppe
   * @returns {number[][]|null}  null wenn keine Route für diese Gruppe
   */
  static _matrixFromRoutes(routes, inCh, groupId, outCh) {
    // Kanal-Bezeichner → Index (SMPTE-Konvention für 5.1)
    const CHAN = { L: 0, R: 1, C: 2, LFE: 3, Ls: 4, Rs: 5, LS: 4, RS: 5 };
    const mat  = Array.from({ length: outCh }, () => Array(inCh).fill(0));
    let   hit  = false;

    for (const route of (routes || [])) {
      // Quellkanal-Index: mxf_ch1 → 0, mxf_ch2 → 1, …
      const srcIdx = route.from?.startsWith('mxf_ch')
        ? parseInt(route.from.slice(6), 10) - 1
        : 0;
      if (srcIdx < 0 || srcIdx >= inCh) continue;

      const targets = Array.isArray(route.to) ? route.to : [route.to];
      for (const t of targets) {
        // Format: "groupId:ChannelName" oder nur "groupId"
        const [gid, chName = 'L'] = t.includes(':') ? t.split(':', 2) : [t, 'L'];
        if (gid.trim() !== groupId) continue;
        const dstCh = CHAN[chName.trim()] ?? 0;
        if (dstCh < outCh) {
          mat[dstCh][srcIdx] = 1.0;
          hit = true;
        }
      }
    }
    return hit ? mat : null;
  }

  /**
   * Baut eine Upmix/Downmix-Matrix (outCh × srcCh).
   *
   * Methoden:
   *   "loro"      — LoRo: L→L, R→R, C/LFE/Ls/Rs = 0.
   *                 Stereo→5.1: nur Front L+R, keine Surrounds.
   *   "ltrt"      — Passiver Stereo→5.1 Upmix (Pro-Logic-Stil, statische Matrix):
   *                   L   = L_in
   *                   R   = R_in
   *                   C   = (L + R) × 0.707  (Phantomcenter, −3 dBFS)
   *                   LFE = 0                 (kein Tiefpass-Bass-Management)
   *                   Ls  = L × 0.707         (−3 dBFS)
   *                   Rs  = R × 0.707
   *                 Kanalreihenfolge: L R C LFE Ls Rs (SMPTE 5.1)
   *   "sum"       — Summiert alle Eingangs auf alle Ausgangs (normalisiert).
   *
   * @param {string} method
   * @param {number} srcCh
   * @param {number} outCh
   * @returns {number[][]}
   */
  static _mixMatrix(method, srcCh, outCh) {
    const mat = Array.from({ length: outCh }, () => Array(srcCh).fill(0));
    switch (method) {
      case 'loro':
        // L→L, R→R — soweit Dimensionen erlauben
        for (let i = 0; i < Math.min(srcCh, outCh); i++) mat[i][i] = 1.0;
        break;

      case 'ltrt': {
        // Passiver Stereo→5.1 Upmix (statische Matrix, kein Delay/Filter).
        // 5.1-Kanalreihenfolge (SMPTE): 0=L 1=R 2=C 3=LFE 4=Ls 5=Rs
        // Quelle Stereo:               0=L 1=R
        const M = 0.7071067811865476; // 1/√2 ≈ −3 dBFS
        if (srcCh >= 2 && outCh >= 6) {
          mat[0][0] = 1.0;  // L  → L
          mat[1][1] = 1.0;  // R  → R
          mat[2][0] = M;    // L  → C (Phantomcenter L-Anteil)
          mat[2][1] = M;    // R  → C (Phantomcenter R-Anteil)
          // mat[3]  = LFE → 0 (kein Bass-Management ohne Tiefpass)
          mat[4][0] = M;    // L  → Ls
          mat[5][1] = M;    // R  → Rs
        } else {
          // Fallback für andere Dimensionen: L→L, R→R
          for (let i = 0; i < Math.min(srcCh, outCh); i++) mat[i][i] = 1.0;
        }
        break;
      }

      case 'sum':
        // Alle Eingangs summiert auf alle Ausgangs (normalisiert)
        for (let r = 0; r < outCh; r++)
          for (let c = 0; c < srcCh; c++)
            mat[r][c] = 1.0 / srcCh;
        break;

      default:
        // Identitäts-Pass für unbekannte Methoden
        for (let i = 0; i < Math.min(srcCh, outCh); i++) mat[i][i] = 1.0;
    }
    return mat;
  }

  /**
   * Identitäts-Matrix (inCh→outCh), soweit möglich.
   * @param {number} inCh
   * @param {number} outCh
   * @returns {number[][]}
   */
  static _identityMatrix(inCh, outCh) {
    return Array.from({ length: outCh }, (_, r) =>
      Array.from({ length: inCh }, (_, c) => (c === r && r < inCh ? 1 : 0))
    );
  }

  /**
   * LoRo-Upmix-Matrix als GStreamer audiomixmatrix-String.
   * Kopiert L→L, R→R; alle weiteren Ausgangskanäle bleiben 0.
   * Beispiel: 2ch→6ch (5.1): L→FL, R→FR, C/LFE/Ls/Rs = 0.
   */
  static _loroUpmixMatrix(inCh, outCh) {
    const mat = Array.from({ length: outCh }, (_, r) =>
      Array.from({ length: inCh }, (_, c) => (c === r && r < inCh ? 1 : 0))
    );
    return AudioRouter._matrixToGst(mat);
  }

  /**
   * Matrix-Multiplikation C = A × B.
   * A: (m×k), B: (k×n) → C: (m×n)
   */
  static _multiplyMatrices(A, B) {
    const m = A.length, k = B.length, n = B[0].length;
    return Array.from({ length: m }, (_, r) =>
      Array.from({ length: n }, (_, c) =>
        Array.from({ length: k }, (_, i) => A[r][i] * B[i][c]).reduce((s, v) => s + v, 0)
      )
    );
  }

  /**
   * Konvertiert Matrix in GStreamer audiomixmatrix-String.
   * Format: "< < r0c0, r0c1 >, < r1c0, r1c1 > >"
   *
   * @param {number[][]} matrix
   * @returns {string}
   */
  static _matrixToGst(matrix) {
    const rows = matrix.map(row =>
      '< ' + row.map(v => v.toFixed(6)).join(', ') + ' >'
    ).join(', ');
    return `< ${rows} >`;
  }

  // Legacy instance wrapper (für bestehenden Code)
  _matrixToGst(m) { return AudioRouter._matrixToGst(m); }
  _identityMatrix(i, o) { return AudioRouter._identityMatrix(i, o); }
}

module.exports = { AudioRouter };
