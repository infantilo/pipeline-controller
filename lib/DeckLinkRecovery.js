'use strict';
/**
 * DeckLink-Handle-Recovery per Prozess-Neustart.
 *
 * gst-plugins-bad (<= 1.20) gibt einen DeckLink-Output/-Input-Handle nach einem
 * fehlgeschlagenen Stop ("Failed to wait for stop notification") NICHT mehr frei:
 * jeder weitere Start scheitert mit "Output device N in use already" bzw.
 * HRESULT 0x80000009 (E_ACCESSDENIED), egal wie oft/lange man wartet. Den Handle
 * räumt nur das Betriebssystem beim Prozessende auf.
 *
 * Eine In-Process-Isolation (DeckLink in Kindprozess + shm-Brücke) würde die
 * Karten-Clock als Pipeline-Clock (ptp-decklink) verlieren — deshalb stattdessen:
 * kontrollierter Prozess-Neustart durch den Supervisor bzw. systemd
 * (Restart=on-failure). Der Zustand (settings.json, Playlist) wird beim Start
 * wiederhergestellt.
 *
 * Schutz vor Neustart-Schleifen: max. MAX_RESTARTS innerhalb WINDOW_MS, Zähler
 * liegt in einer Datei im Datenverzeichnis (überlebt den Prozess).
 */
const fs = require('fs');

const EXIT_CODE   = 75;                 // EX_TEMPFAIL — != 0, damit systemd Restart=on-failure greift
const MAX_RESTARTS = 2;
const WINDOW_MS   = 15 * 60 * 1000;

// Läuft unter Supervisor (fork mit IPC-Kanal), systemd oder dem AppRun-Neustart-Loop (PC_SUPERVISED=1)? Sonst würde der Exit
// den Server nur beenden statt neu zu starten.
function isSupervised() {
  return typeof process.send === 'function' || !!process.env.INVOCATION_ID || process.env.PC_SUPERVISED === '1';
}

function _load(file) {
  try {
    const a = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(a) ? a.filter(t => Date.now() - t < WINDOW_MS) : [];
  } catch { return []; }
}

/** @returns {{ok:boolean, reason?:string}} ok=true → Neustart ist erlaubt und wurde vermerkt */
function allowRestart(stateFile) {
  if (!isSupervised()) return { ok: false, reason: 'Prozess läuft nicht unter Supervisor/systemd — kein automatischer Neustart möglich' };
  const hist = _load(stateFile);
  if (hist.length >= MAX_RESTARTS) return { ok: false, reason: `bereits ${hist.length} DeckLink-Neustarts in den letzten ${WINDOW_MS / 60000} min — vermutlich echter Hardware-/Konfigurationsfehler` };
  hist.push(Date.now());
  try { fs.writeFileSync(stateFile, JSON.stringify(hist)); } catch {}
  return { ok: true };
}

module.exports = { EXIT_CODE, allowRestart, isSupervised };
