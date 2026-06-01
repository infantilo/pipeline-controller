'use strict';
/**
 * AudioGroupConfig
 * ────────────────
 * Verwaltet Audio-Gruppen, Presets und Clock-Konfiguration.
 *
 * GRUPPEN-KONZEPT:
 *   Jede Gruppe ist ein unabhängiger Audio-Bus der via interaudiosink/interaudiosrc
 *   zwischen Player und Master transportiert wird.
 *   Beispielgruppen:
 *     pgm-stereo   — Programm Stereo (2ch)
 *     pgm-51       — Programm 5.1 (6ch)
 *     begl-stereo  — Begleitton Stereo (2ch)
 *
 * PRESET-FORMAT (neu, routes-basiert):
 *   {
 *     label: "Stereo",
 *     routes: [
 *       { from: "mxf_ch1", to: ["pgm-stereo:L"] },
 *       { from: "mxf_ch2", to: ["pgm-stereo:R"] }
 *     ],
 *     upmix: [                              // optional
 *       { from: "pgm-stereo", to: "pgm-51", method: "loro" }
 *     ]
 *   }
 *
 *   "mxf_ch1" = erster Audio-Track des Mediums (1-basiert).
 *   "pgm-stereo:L" = Kanal L der Gruppe pgm-stereo.
 *   Kanalbezeichner: L, R, C, LFE, Ls, Rs (5.1), LS, RS (Alias)
 *
 * CLOCK-KONFIGURATION (in config.json unter "clock"):
 *   {
 *     "provider": "audiotestsrc" | "ptp-decklink" | "ptp-generic" | "system",
 *     "decklinkDevice": 0,          // für ptp-decklink
 *     "ptpDomain": 127,             // für ptp-*
 *     "ptpInterface": "eth0",       // für ptp-generic
 *     "fallbackToSystem": true      // bei Clock-Verlust auf Systemclock fallen
 *   }
 *
 *   "audiotestsrc" → Pipeline-Clock vom pulsesink (Standard, stabil)
 *   "ptp-decklink"  → DeckLink-Hardware-PTP (SMPTE 2110)
 *   "ptp-generic"   → Linux PTP-Hardware-Clock via ptpclock
 *   "system"        → GstSystemClock (kein sync, für Tests)
 */

const fs   = require('fs');
const path = require('path');

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_GROUPS = [
  { id: 'pgm-stereo', label: 'Stereo Programmton', channels: 2 },
];

const DEFAULT_PRESETS = {
  stereo: {
    label: 'Stereo (CH1=L, CH2=R)',
    routes: [
      { from: 'mxf_ch1', to: ['pgm-stereo:L'] },
      { from: 'mxf_ch2', to: ['pgm-stereo:R'] },
    ],
  },
};

const DEFAULT_CLOCK = {
  provider: 'audiotestsrc',
  decklinkDevice: 0,
  ptpDomain: 127,
  ptpInterface: 'eth0',
  fallbackToSystem: true,
};

// ── Klasse ────────────────────────────────────────────────────────────────────

class AudioGroupConfig {
  /**
   * @param {string|null} configPath  Pfad zur JSON-Konfigurationsdatei
   */
  constructor(configPath = null) {
    this._configPath = configPath;
    this._groups     = [...DEFAULT_GROUPS];
    this._presets    = JSON.parse(JSON.stringify(DEFAULT_PRESETS));
    this._clock      = { ...DEFAULT_CLOCK };

    if (configPath) this._load();
  }

  // ── Getters ──────────────────────────────────────────────────────────────────

  /** Alle Gruppen als Array von {id, label, channels} */
  get groups() { return this._groups; }

  /** Alle Presets als {id → preset} */
  get presets() { return this._presets; }

  /** Clock-Konfiguration */
  get clock() { return this._clock; }

  /** Gibt eine Gruppe nach ID zurück, oder null */
  getGroup(id) {
    return this._groups.find(g => g.id === id) || null;
  }

  /** Gibt ein Preset nach ID zurück, oder null */
  getPreset(id) {
    return this._presets[id] || null;
  }

  /** Gibt das erste verfügbare Preset zurück (Fallback) */
  getDefaultPreset() {
    const first = Object.keys(this._presets)[0];
    return first ? this._presets[first] : null;
  }

  /** Gibt alle Gruppen-IDs zurück */
  get groupIds() { return this._groups.map(g => g.id); }

  // ── Mutators ─────────────────────────────────────────────────────────────────

  setGroups(groups) {
    if (!Array.isArray(groups) || !groups.length) return;
    const prevMap = new Map(this._groups.map(g => [g.id, g]));
    this._groups = groups.map(g => {
      const id  = String(g.id).replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
      const obj = {
        id,
        label:    g.label || g.name || id,
        channels: Number(g.channels) || 2,
      };
      if (g.sink) obj.sink = g.sink;
      // Preserve / merge r128 settings
      const prev = prevMap.get(id);
      const r128 = g.r128 || prev?.r128 || null;
      if (r128) obj.r128 = r128;
      return obj;
    });
    this._save();
  }

  setGroupR128(groupId, r128) {
    const g = this._groups.find(x => x.id === groupId);
    if (!g) return false;
    g.r128 = { enabled: false, target: -23, maxGain: 12, smoothRate: 0.5, ...r128 };
    this._save();
    return true;
  }

  setPreset(id, preset) {
    if (!id || !preset) return;
    // Unterstützt sowohl routes- als auch legacy mappings-Format
    this._presets[id] = {
      label:    preset.label    || id,
      routes:   preset.routes   || [],
      upmix:    preset.upmix    || [],
      mappings: preset.mappings || undefined,  // Legacy, falls vorhanden
    };
    this._save();
  }

  deletePreset(id) {
    if (id === 'stereo') return;
    delete this._presets[id];
    this._save();
  }

  setClock(clock) {
    this._clock = { ...DEFAULT_CLOCK, ...clock };
    this._save();
  }

  // ── Serialisierung ────────────────────────────────────────────────────────────

  toJSON() {
    return { groups: this._groups, presets: this._presets, clock: this._clock };
  }

  _load() {
    if (!this._configPath) return;
    try {
      if (!fs.existsSync(this._configPath)) return;
      const data = JSON.parse(fs.readFileSync(this._configPath, 'utf8'));

      if (Array.isArray(data.groups) && data.groups.length) {
        this._groups = data.groups.map(g => {
          const obj = {
            id:       g.id,
            label:    g.label || g.name || g.id,
            channels: Number(g.channels) || 2,
          };
          if (g.sink) obj.sink = g.sink;
          if (g.r128)  obj.r128 = g.r128;
          return obj;
        });
      }
      if (data.presets && typeof data.presets === 'object') {
        // Neue Presets mergen — routes-Format hat Vorrang
        this._presets = { ...DEFAULT_PRESETS, ...data.presets };
      }
      if (data.clock && typeof data.clock === 'object') {
        this._clock = { ...DEFAULT_CLOCK, ...data.clock };
      }
    } catch(e) {
      console.warn(`[AudioGroupConfig] Laden fehlgeschlagen: ${e.message}`);
    }
  }

  _save() {
    if (!this._configPath) return;
    try {
      fs.mkdirSync(path.dirname(this._configPath), { recursive: true });
      fs.writeFileSync(this._configPath, JSON.stringify(this.toJSON(), null, 2), 'utf8');
    } catch(e) {
      console.warn(`[AudioGroupConfig] Speichern fehlgeschlagen: ${e.message}`);
    }
  }
}

module.exports = AudioGroupConfig;
