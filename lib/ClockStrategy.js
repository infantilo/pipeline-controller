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
 *   "ptp-decklink" (implementiert):
 *     Clock-Domäne = DeckLink-Karte via GStreamer Sink-Clock-Auto-Selection.
 *     gst-kit hat KEINE Clock-API (kein setClock/useClock) — externe GstPtpClock
 *     ist unmöglich. Stattdessen: der DeckLink-Sink in der Master-Pipeline
 *     (decklinkvideosink im PGM-Pfad und/oder decklinkaudiosink der primären
 *     Audiogruppe) wird zum EINZIGEN Clock-Provider gemacht — alle pulsesinks
 *     laufen provide-clock=false (siehe AudioRouter._pulseSinkProps), alsasink
 *     erzwingt in diesem Mode ebenfalls provide-clock=false (noProvideClock).
 *     → GStreamer wählt automatisch die DeckLink-Karten-Clock (auf der IP100
 *       PTP-locked) als Pipeline-Clock. Kein setClock nötig.
 *     clockConfig.decklinkDevice gesetzt → Audio der primären Gruppe geht auf
 *     decklinkaudiosink dieses Devices (type:'decklink'); sonst bleibt Audio auf
 *     Pulse und der PGM-Video-Sink (decklinkvideosink) liefert die Clock.
 *
 *   "ptp-generic":
 *     Linux PTP (phc2sys + ptp4l). GstPtpClock synct auf NIC PTP-Hardware-Clock.
 *     Requires: gst-plugins-bad >= 1.14, PTP-fähige NIC, ptpInterface konfiguriert.
 *     TODO: bleibt Stub — gst-kit bietet keine Clock-API, GstPtpClock kann nicht
 *     gesetzt werden. Erst umsetzbar wenn gst-kit setClock/useClock exponiert.
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
    // "gesetzt" vs. Default 0 unterscheiden: nur bei explizitem decklinkDevice
    // geht das Audio der primären Gruppe auf decklinkaudiosink (siehe masterSinkConfig)
    this.decklinkDeviceExplicit = clockConfig.decklinkDevice != null;
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
        // Clock-Domäne = DeckLink-Karte via Sink-Auto-Selection (siehe Kopfkommentar):
        // der DeckLink-Sink in der Master-Pipeline ist der einzige Clock-Provider →
        // GStreamer wählt automatisch die Karten-Clock (PTP-locked). Kein setClock nötig.
        if (this.decklinkDeviceExplicit) {
          // Primäre Gruppe → decklinkaudiosink (liefert die Karten-Clock, auch wenn
          // der Video-Sink kein DeckLink ist). Siehe AudioRouter._buildSink type 'decklink'.
          return { type: 'decklink', device: this.decklinkDevice, bufferTime: this.bufferTime };
        }
        // Kein Audio-Device konfiguriert: Audio bleibt auf Pulse (provide-clock ohnehin
        // false) — die Clock liefert der PGM-Video-Sink (decklinkvideosink).
        // noProvideClock: erzwingt provide-clock=false auch im alsasink-Pfad.
        console.warn('[ClockStrategy] ptp-decklink: kein decklinkDevice konfiguriert — DeckLink-Video-Sink liefert die Pipeline-Clock, Audio bleibt auf Pulse');
        return { type: 'pulse', bufferTime: this.bufferTime, noProvideClock: true };

      case 'ptp-generic':
        // TODO bleibt Stub: gst-kit hat keine Clock-API (setClock/useClock fehlt) —
        // GstPtpClock kann nicht auf die Pipeline gesetzt werden. Erst umsetzbar
        // wenn gst-kit die Clock exponiert. Bis dahin Fallback auf Standard-Pfad.
        console.warn('[ClockStrategy] ptp-generic: nicht implementiert (gst-kit ohne Clock-API), fallback → audiotestsrc');
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
        // Keine externe Clock nötig: DeckLink-Sink ist Clock-Provider in der Pipeline
        // (Sink-Clock-Auto-Selection) — gst-kit-setClock existiert ohnehin nicht.
        return { needsExternalClock: false, clockType: 'pipeline', clockParams: {} };

      case 'ptp-generic':
        // TODO: GstPtpClock via NIC — blockiert durch fehlende gst-kit-Clock-API.
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
