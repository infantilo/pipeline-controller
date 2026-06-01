'use strict';
/**
 * ClockStrategy
 * ─────────────
 * Kapselt die Clock-Konfiguration für Master- und Player-Pipelines.
 *
 * PROVIDER-TYPEN:
 *
 *   "audiotestsrc" (Standard):
 *     Pipeline-Clock kommt vom pulsesink der Master-Pipeline.
 *     pulsesink provide-clock=true → stabile Hardware-Taktung via PulseAudio.
 *     Für Player: provide-clock=false, sync=false.
 *     → Keine externe Abhängigkeit. Funktioniert immer.
 *
 *   "system":
 *     GstSystemClock (Monotone Systemzeit). Kein PTP, kein Hardware-Sync.
 *     Für Tests ohne Audio-Ausgabe (fakesink).
 *     → sync=false auf allen Sinks.
 *
 *   "ptp-decklink":
 *     DeckLink-Karte als PTP-Master/Slave. Clock via GstPtpClock.
 *     decklinkvideosrc muss laufen (bringt HW-Clock).
 *     TODO: Aktivierung wenn DeckLink-SDK integriert.
 *     → DeckLink-Integration Phase 2.
 *
 *   "ptp-generic":
 *     Linux PTP (phc2sys + ptp4l). GstPtpClock synct auf NIC PTP-Hardware-Clock.
 *     Requires: gst-plugins-bad >= 1.14, PTP-fähige NIC, ptpInterface konfiguriert.
 *     TODO: Aktivierung wenn SMPTE 2110 Infrastruktur vorhanden.
 *     → Phase 3.
 *
 * MASTER-SINK-CONFIG:
 *   masterSinkConfig() gibt ein Objekt zurück das AudioRouter._buildSink() versteht:
 *   { type: 'pulse'|'alsa'|'fake', bufferTime, device }
 *
 * PLAYER-CLOCK-SETUP:
 *   playerClockSetup() gibt GStreamer-Properties für Player-Sinks zurück.
 *   Im AudioRouter-Modus: interaudiosink sync=false async=false (immer).
 *   Im Legacy-Modus: pulsesink provide-clock=false async=false.
 */

class ClockStrategy {
  /**
   * @param {object} clockConfig  — aus AudioGroupConfig.clock
   *   provider: "audiotestsrc"|"ptp-decklink"|"ptp-generic"|"system"
   *   decklinkDevice: 0
   *   ptpDomain: 127
   *   ptpInterface: "eth0"
   *   fallbackToSystem: true
   */
  constructor(clockConfig = {}) {
    this.provider         = clockConfig.provider || 'audiotestsrc';
    this.decklinkDevice   = clockConfig.decklinkDevice ?? 0;
    this.ptpDomain        = clockConfig.ptpDomain ?? 127;
    this.ptpInterface     = clockConfig.ptpInterface || 'eth0';
    this.fallbackToSystem = clockConfig.fallbackToSystem !== false;

    // Legacy compat
    this.type             = this.provider;
    this.bufferTime       = clockConfig.bufferTime || 400000;
    this.device           = clockConfig.device || 'default';
  }

  // ── Master-Sink-Konfiguration ─────────────────────────────────────────────────

  /**
   * Gibt die Sink-Konfiguration für AudioRouter._buildSink() zurück.
   * @param {AudioGroupConfig} [cfg]  — für gruppenspezifische Einstellungen
   * @returns {{ type, bufferTime, device, audioSink } | null}
   */
  masterSinkConfig(cfg) {
    switch (this.provider) {

      case 'audiotestsrc':
        // Standard: pulsesink, provide-clock=true auf erster Gruppe
        return { type: 'pulse', bufferTime: this.bufferTime };

      case 'system':
        // System-Clock: fakesink (kein Audio-Device nötig)
        return { type: 'fake', audioSink: 'fakesink' };

      case 'ptp-decklink':
        // TODO Phase 2: DeckLink-PTP
        // DeckLink-Karte liefert Hardware-Clock via decklinkvideosrc.
        // Master-Sink: pulsesink (Audio-Ausgabe bleibt auf Pulse).
        // Clock wird über pipeline.useClock(decklink_clock) gesetzt.
        // Aktivierung: wenn gst-decklink verfügbar (gst-inspect-1.0 decklinkvideosrc).
        console.warn('[ClockStrategy] ptp-decklink: noch nicht implementiert, fallback → audiotestsrc');
        return { type: 'pulse', bufferTime: this.bufferTime };

      case 'ptp-generic':
        // TODO Phase 3: Linux PTP
        // GstPtpClock liest Hardware-Timestamp vom NIC (PHC).
        // Aktivierung: wenn gst_ptp_init() und Interface verfügbar.
        // Benötigt: gst-plugins-bad, PTP-fähige NIC, ptpDomain konfiguriert.
        console.warn('[ClockStrategy] ptp-generic: noch nicht implementiert, fallback → audiotestsrc');
        return { type: 'pulse', bufferTime: this.bufferTime };

      default:
        return null;
    }
  }

  // ── Pipeline-Clock-Setup ──────────────────────────────────────────────────────

  /**
   * Gibt ein Objekt mit GStreamer-Pipeline-Clock-Einstellungen zurück.
   * Wird nach pipeline.play() auf die Pipeline angewendet (falls nötig).
   *
   * @returns {{ needsExternalClock, clockType, clockParams }}
   */
  pipelineClockInfo() {
    switch (this.provider) {
      case 'ptp-decklink':
        // TODO: GstPtpClock via decklink
        // pipeline.setExternalClock(new GstPtpClock(`ptp-decklink-${this.decklinkDevice}`, this.ptpDomain))
        return { needsExternalClock: false, clockType: 'pipeline', clockParams: {} };

      case 'ptp-generic':
        // TODO: GstPtpClock via NIC
        // pipeline.setExternalClock(new GstPtpClock('ptp-generic', this.ptpDomain))
        return { needsExternalClock: false, clockType: 'pipeline', clockParams: {} };

      default:
        return { needsExternalClock: false, clockType: 'pipeline', clockParams: {} };
    }
  }

  // ── Sink-Properties für Player-Pipeline ──────────────────────────────────────

  /**
   * Gibt interaudiosink-Properties für Player-Pipelines zurück.
   * Im AudioRouter-Modus immer: sync=false async=false.
   * (Clock-Sync läuft über Master-pulsesink, nicht über Player-Sinks)
   */
  get interAudioSinkProps() {
    return 'sync=false async=false';
  }

  /** Gibt pulsesink-Properties für Legacy-Player zurück */
  get legacyPulseSinkProps() {
    // provide-clock=false: Master hält die Clock
    // async=false: kein Preroll-Deadlock beim State-Change
    return 'async=false provide-clock=false';
  }

  /** String-Repr für Logging */
  toString() {
    return `ClockStrategy(${this.provider})`;
  }
}

module.exports = ClockStrategy;
