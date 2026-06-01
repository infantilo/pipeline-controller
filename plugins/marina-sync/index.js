'use strict';

/**
 * marina-sync — Pebble Beach Marina Watchfolder Sync
 *
 * Liest das aktuellste .mpl pro Channel-ID aus einem Watchfolder.
 * Dateien werden NIEMALS gelockt (readFileSync öffnet/liest/schließt sofort).
 * On-Air-Sync: Berechnet Einsteigepunkt wenn unsere Playlist noch nicht läuft
 * aber Marina bereits sendet (state="Running" im MPL).
 */

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Python: Scheduling-State je Event (ms seit Mitternacht, lokale Zeit)
const _STATE_SCRIPT = `
import sys, json, re, xml.etree.ElementTree as ET

def ms_midnight(dt):
    if not dt: return None
    m = re.search(r'T(\\d{2}):(\\d{2}):(\\d{2})', dt)
    if not m: return None
    return int(m.group(1))*3600000 + int(m.group(2))*60000 + int(m.group(3))*1000

try:
    root = ET.fromstring(sys.stdin.read())
except Exception:
    print(json.dumps([])); sys.exit(0)

el = root.find('eventList')
out = []
for ev in (el or []):
    if ev.get('enabled','true').lower() == 'false': continue
    t = ev.get('type','')
    if t not in ('PrimaryVideo','Live','Comment','PlaylistStart','PlaylistEnd'): continue
    s = ev.find('state')
    if s is None: continue
    out.append({
        'uid':   ev.get('uid',''),
        'type':  t,
        'state': s.get('state',''),
        'start': ms_midnight(s.get('schedStartTime')),
        'end':   ms_midnight(s.get('schedEndTime')),
    })
print(json.dumps(out))
`;

// ── Plugin-Manifest ────────────────────────────────────────────────────────────
exports.meta = {
  id:          'marina-sync',
  name:        'Marina Sync',
  version:     '1.0.0',
  description: 'Synchronisiert die Playlist mit dem Pebble Beach Marina System via Watchfolder.',
  hasStatus:   true,
  schema: [
    {
      key: 'watchFolder', label: 'Watchfolder', type: 'string', default: '',
      help: 'Verzeichnis mit Marina .mpl Channel-Manager-Dateien',
    },
    {
      key: 'channelId', label: 'Channel-ID', type: 'string', default: '',
      help: 'z.B. 5024 — aus Dateinamen wie Autosaved_5024_….mpl. Leer = erstes .mpl im Ordner',
    },
    {
      key: 'autoStart', label: 'Auto-Start', type: 'boolean', default: false,
      help: 'Playlist automatisch starten wenn aktuell keine läuft',
    },
    {
      key: 'onAirSync', label: 'On-Air Sync', type: 'boolean', default: true,
      help: 'Einsteigepunkt aus Marina-Status berechnen (state=Running)',
    },
    {
      key: 'pollIntervalSec', label: 'Poll-Intervall (s)', type: 'number', default: 30,
      help: 'Zusätzliches Polling als Fallback für fs.watch (5–3600)',
    },
  ],
  subscribes: ['system:shutdown'],
};

// ── Plugin-State ───────────────────────────────────────────────────────────────
let _api, _cfg = {};
let _watcher    = null;
let _pollTimer  = null;
let _debounce   = null;
let _lastMtime  = 0;
let _lastFile   = null;
let _processing = false;
let _statusData = {};

function _log(msg, level = 'info') { _api?.log?.(level, msg); }
function _setStatus(state, extra = {}) {
  _statusData = { ..._statusData, ...extra };
  _api?.setStatus?.(state, _statusData);
}

// ── Pfad-Auflösung ─────────────────────────────────────────────────────────────

/**
 * Normalisiert den Watchfolder-Pfad.
 * Konvertiert Windows-Backslashes und löst relative Pfade gegen cwd auf.
 * \marina\ → /home/.../PIPELINE CONTROLLER/marina
 */
function _resolveDir(raw) {
  if (!raw) return '';
  // Backslashes → Forward-Slashes (Windows-Pfade im Linux-Config)
  const p = String(raw).trim().replace(/\\/g, '/');
  // Versuch 1: direkt (absolut oder relativ zu cwd)
  const direct = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  if (fs.existsSync(direct)) return direct;
  // Versuch 2: führende Slashes abstreifen (z.B. \marina\ → /marina/ → marina)
  const stripped = p.replace(/^\/+/, '').replace(/\/+$/, '');
  if (stripped && stripped !== p) {
    const alt = path.resolve(process.cwd(), stripped);
    if (fs.existsSync(alt)) return alt;
  }
  // Nicht gefunden → direkten Pfad zurückgeben (Fehler wird in _startWatch gemeldet)
  return direct;
}

// ── Datei-Suche ────────────────────────────────────────────────────────────────

/** Findet die aktuellste .mpl Datei für den konfigurierten Channel (nach mtime). */
function _findLatest() {
  const dir  = _resolveDir(_cfg.watchFolder);
  if (!dir) return null;
  try {
    const chId = String(_cfg.channelId || '').trim();
    return fs.readdirSync(dir)
      .filter(f => {
        if (!f.toLowerCase().endsWith('.mpl')) return false;
        // Filename-Filter: Autosaved_5024_… oder beliebige .mpl wenn keine ID gesetzt
        return chId ? f.includes(`_${chId}_`) : true;
      })
      .map(f => {
        try { return { name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }; }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)[0] || null;
  } catch (e) {
    _log(`Watchfolder-Fehler: ${e.message}`, 'warn');
    return null;
  }
}

// ── On-Air Sync ────────────────────────────────────────────────────────────────

/** Extrahiert State + Timing pro Event aus dem MPL XML (zweiter Python-Pass). */
function _extractState(xmlString) {
  const r = spawnSync('python3', ['-c', _STATE_SCRIPT], {
    input: xmlString, encoding: 'utf8', timeout: 20000,
  });
  if (r.error || r.status !== 0) {
    _log(`State-Extraktion: ${r.error?.message || (r.stderr || '').slice(0, 200)}`, 'warn');
    return [];
  }
  try { return JSON.parse(r.stdout); }
  catch { return []; }
}

/**
 * Bestimmt in welches Event und an welcher Position wir einsteigen müssen.
 * stateItems und events haben dieselbe Reihenfolge (beide filtern disabled=false).
 * Gibt { startIndex, somOffset } zurück oder null.
 */
function _calcOnAirSync(events, stateItems) {
  if (!stateItems.length || !events.length) return null;

  const d   = new Date();
  const now = d.getHours() * 3600000 + d.getMinutes() * 60000 +
              d.getSeconds() * 1000   + d.getMilliseconds();

  // Priorität 1: Marina meldet state="Running"
  let idx = stateItems.findIndex(s => s.state === 'Running');

  // Priorität 2: Zeitfenster enthält jetzt (schedStart ≤ now ≤ schedEnd)
  if (idx < 0) {
    idx = stateItems.findIndex(s =>
      s.start != null && s.end != null && now >= s.start && now <= s.end
    );
  }

  if (idx < 0) return null;

  const si         = stateItems[idx];
  const startIndex = Math.min(idx, events.length - 1);
  const somOffset  = si.start != null ? Math.max(0, (now - si.start) / 1000) : 0;
  return { startIndex, somOffset };
}

// ── Verarbeitung ───────────────────────────────────────────────────────────────

async function _processFile(filePath) {
  if (_processing) return;
  _processing = true;
  try {
    const fname = path.basename(filePath);
    _log(`Lade ${fname}`);
    _setStatus('loading', { file: fname });

    // readFileSync: öffnet, liest, schließt sofort — kein Advisory-Lock, kein flock()
    const xmlString = fs.readFileSync(filePath, 'utf8');
    if (!xmlString.trim()) { _log('Datei leer — übersprungen', 'warn'); return; }

    // Marina-XML → interne Event-Struktur (MarinaParser, spawnSync Python3)
    const { parseMarina } = require('../../lib/MarinaParser');
    const events = parseMarina(xmlString);

    // Manuell hinzugefügte Kinder (Record-Slots, eigene VOs) und Subtitles
    // aus der laufenden Playlist via reconcileKey erhalten
    try {
      const existing = await _api.getPlaylist();
      if (existing.length > 0) {
        const prevMap = new Map();
        for (const ev of existing) {
          if (ev.reconcileKey) prevMap.set(ev.reconcileKey, ev);
        }
        for (const ev of events) {
          if (!ev.reconcileKey) continue;
          const prev = prevMap.get(ev.reconcileKey);
          if (!prev) continue;

          const prevChildren = prev.children || [];

          // Record-Children immer bewahren (Marina kennt diese nicht)
          const prevRecord = prevChildren.filter(c => c.source === 'record');

          // Manuell hinzugefügte VO-Children bewahren (Marina-VOs haben _marinaPreset)
          const prevVO = prevChildren.filter(c => c.source === 'voiceover' && !c._marinaPreset);

          const extra = [...prevRecord, ...prevVO];
          if (extra.length) {
            ev.children = [...(ev.children || []), ...extra];
          }

          // Subtitle nur von vorheriger Playlist übernehmen wenn Marina keines hat
          if (!ev.subtitle && prev.subtitle) {
            ev.subtitle = prev.subtitle;
          }
        }
      }
    } catch (e) {
      _log(`Reconcile-Warnung: ${e.message}`, 'warn');
    }

    if (!events.length) {
      _log('Keine aktivierten Events in Marina-Datei', 'warn');
      _setStatus('warn', { msg: 'Keine Events' });
      return;
    }

    // On-Air Sync: Einsteigepunkt berechnen
    let startIndex = null;
    let somOffset  = null;

    if (_cfg.onAirSync !== false) {
      const stateItems = _extractState(xmlString);
      const sync = _calcOnAirSync(events, stateItems);
      if (sync) {
        startIndex = sync.startIndex;
        somOffset  = sync.somOffset;
        _log(`On-Air Sync: Event ${startIndex + 1}/${events.length}, SOM-Offset ${somOffset.toFixed(2)}s`);
      } else {
        _log('On-Air Sync: kein laufendes Event gefunden — Start ab Event 1');
      }
    }

    // Playout-State: läuft bereits?
    const state     = await _api.getState();
    const isRunning = state?.playlist?.running === true;

    // Playlist an PluginHost → server.js → playlist.set() + ggf. playlist.start()
    _api.setPlaylist(
      events,
      (!isRunning && _cfg.autoStart) ? (startIndex ?? 0) : null,
      (!isRunning && _cfg.autoStart) ? somOffset         : null,
    );

    const summary = `${events.length} Events aus ${fname}`;
    _api.notify(`Marina-Sync: ${summary}`, 'info');
    _setStatus('ok', {
      events:    events.length,
      file:      fname,
      syncEvent: startIndex != null ? startIndex + 1 : null,
      started:   !isRunning && !!_cfg.autoStart,
      ts:        new Date().toISOString(),
    });
    _log(`Importiert: ${summary}`);

  } catch (e) {
    _log(`Verarbeitungsfehler: ${e.message}`, 'error');
    _setStatus('error', { error: e.message });
  } finally {
    _processing = false;
  }
}

// ── Watch-Logik ────────────────────────────────────────────────────────────────

function _scheduleCheck() {
  if (_debounce) { clearTimeout(_debounce); _debounce = null; }
  _debounce = setTimeout(async () => {
    _debounce = null;
    const found = _findLatest();
    if (!found) return;
    // Nur verarbeiten wenn sich Datei oder mtime geändert haben
    if (found.name === _lastFile && found.mtime === _lastMtime) return;
    _lastFile  = found.name;
    _lastMtime = found.mtime;
    const dir  = _resolveDir(_cfg.watchFolder);
    const full = path.join(dir, found.name);
    await _processFile(full).catch(e => _log(`Prozess-Fehler: ${e.message}`, 'warn'));
  }, 500); // 500ms Debounce: warten bis Marina fertig geschrieben hat
}

function _startWatch() {
  _stopWatch();
  const dir = _resolveDir(_cfg.watchFolder);
  if (!dir) {
    _setStatus('idle', { msg: 'Watchfolder nicht konfiguriert' });
    return;
  }
  if (!fs.existsSync(dir)) {
    _setStatus('error', { error: `Verzeichnis nicht gefunden: ${dir} (Eingabe: "${_cfg.watchFolder}")` });
    return;
  }

  // Initialer Scan beim Start
  _scheduleCheck();

  // fs.watch (inotify auf Linux) — sofortige Reaktion ohne Polling-Verzögerung
  try {
    _watcher = fs.watch(dir, (_, filename) => {
      if (filename && !filename.toLowerCase().endsWith('.mpl')) return;
      _scheduleCheck();
    });
    _watcher.on('error', e => {
      _log(`fs.watch Fehler: ${e.message} — weiter via Polling`, 'warn');
      _watcher = null;
    });
  } catch (e) {
    _log(`fs.watch nicht verfügbar (${e.message}) — nur Polling aktiv`, 'warn');
  }

  // Polling als Absicherung (Netzlaufwerke, NFS, SMB)
  const pollMs = Math.max(5000, (parseInt(_cfg.pollIntervalSec) || 30) * 1000);
  _pollTimer = setInterval(_scheduleCheck, pollMs);

  _setStatus('watching', { dir, pollSec: pollMs / 1000 });
  _log(`Watchfolder aktiv: ${dir} | Channel-ID: ${(_cfg.channelId||'(alle)')} | Poll: ${pollMs/1000}s`);
}

function _stopWatch() {
  if (_debounce)  { clearTimeout(_debounce);    _debounce  = null; }
  if (_watcher)   { try { _watcher.close(); } catch {} _watcher   = null; }
  if (_pollTimer) { clearInterval(_pollTimer);  _pollTimer = null; }
}

// ── Plugin-API ─────────────────────────────────────────────────────────────────

exports.init = async function(config, api) {
  _api = api;
  _cfg = config || {};
  _startWatch();
};

exports.onEvent = async function(type) {
  if (type === 'system:shutdown') _stopWatch();
};

exports.destroy = function() { _stopWatch(); };
