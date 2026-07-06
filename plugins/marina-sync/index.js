'use strict';

/**
 * marina-sync — Pebble Beach Marina Watchfolder Sync
 *
 * Liest das aktuellste .mpl pro Channel-ID aus einem Watchfolder.
 * Dateien werden NIEMALS gelockt (readFileSync öffnet/liest/schließt sofort).
 * On-Air-Sync: Berechnet Einsteigepunkt/Resync-Ziel aus Marina-Status
 * (state="Running" im MPL, per parseMarina — reine JS, kein python3 mehr).
 *
 * Stabile IDs: Events werden über reconcileKey mit der laufenden Playlist
 * gematcht — bekommen bei Übereinstimmung deren `id`. Dadurch bleibt in
 * PlaylistEngine.set() der _state (playing/done/…) erhalten und das
 * On-Air-Event behält seine Identität (kein Re-Cue nötig).
 *
 * Resync statt Blind-Setzen: Läuft unsere Playlist bereits synchron zum
 * Marina-Running-Event (innerhalb syncToleranceSec), wird NICHT gesprungen —
 * das laufende On-Air-Signal bleibt ungestört. Nur bei echter Abweichung
 * (Umstieg auf anderes Event oder Zeit-Drift > Toleranz) sendet der Server
 * einen forceJump (siehe server.js pluginHost.on('playlist-set')).
 */

const fs   = require('fs');
const path = require('path');

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
      help: 'Einsteigepunkt/Resync-Ziel aus Marina-Status berechnen (state=Running)',
    },
    {
      key: 'syncToleranceSec', label: 'Sync-Toleranz (s)', type: 'number', default: 2,
      help: 'Solange unsere Playlist innerhalb dieser Toleranz synchron zu Marina läuft, wird das On-Air-Event NICHT unterbrochen. Erst bei größerer Abweichung oder Event-Wechsel wird gesprungen.',
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
let _watcher      = null;
let _pollTimer    = null;
let _debounce     = null;
let _lastMtime    = 0;
let _lastFile     = null;
let _processing   = false;
let _recheckAfter = false;   // Datei änderte sich während _processing lief → danach erneut prüfen
const MAX_RETRIES = 5;       // Parse-Retries bei abgeschnittener/unvollständiger Datei (2s Abstand)
let _statusData   = {};

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

/**
 * Bestimmt das Marina-Event, das gerade "on air" ist (source player/live).
 * Priorität 1: _marinaState === 'Running'. Priorität 2: Zeitfenster
 * (_schedStartMs ≤ now ≤ _schedEndMs) — Fallback falls Marina den State
 * nicht rechtzeitig aktualisiert hat.
 */
function _findRunningEvent(events) {
  const candidates = events.filter(e => e.source === 'player' || e.source === 'live');
  if (!candidates.length) return null;

  let hit = candidates.find(e => e._marinaState === 'Running');
  if (hit) return hit;

  const d   = new Date();
  const now = d.getHours() * 3600000 + d.getMinutes() * 60000 +
              d.getSeconds() * 1000   + d.getMilliseconds();
  hit = candidates.find(e =>
    e._schedStartMs != null && e._schedEndMs != null && now >= e._schedStartMs && now <= e._schedEndMs
  );
  return hit || null;
}

// ── Verarbeitung ───────────────────────────────────────────────────────────────

// Liest + parsed die Datei, mit Retry bei Parse-Fehler (abgeschnittene Datei, Marina
// noch nicht fertig geschrieben). Bleibt innerhalb EINES _processFile-Aufrufs — _processing
// bleibt währenddessen durchgehend true (keine parallele Re-Verarbeitung derselben Datei).
async function _readAndParse(filePath, fps) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // readFileSync: öffnet, liest, schließt sofort — kein Advisory-Lock, kein flock()
    const xmlString = fs.readFileSync(filePath, 'utf8');
    if (!xmlString.trim()) return { empty: true };
    const { parseMarina } = require('../../lib/MarinaParser');
    try {
      return { events: parseMarina(xmlString, fps) };
    } catch (e) {
      if (attempt >= MAX_RETRIES) {
        _log(`Parse-Fehler: ${e.message} — Maximalzahl Retries (${MAX_RETRIES}) erreicht, Datei übersprungen`, 'error');
        return { error: e };
      }
      _log(`Parse-Fehler (Versuch ${attempt + 1}/${MAX_RETRIES}): ${e.message} — Retry in 2s`, 'warn');
      _setStatus('warn', { msg: `Parse-Fehler, Retry ${attempt + 1}/${MAX_RETRIES}` });
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return { error: new Error('unreachable') };
}

/** Gibt true zurück wenn die Datei erfolgreich verarbeitet wurde (für _lastFile/_lastMtime). */
async function _processFile(filePath, fname) {
  _processing = true;
  try {
    _log(`Lade ${fname}`);
    _setStatus('loading', { file: fname });

    const state0 = await _api.getState();
    const fps    = state0?.config?.fps || 25;

    // Marina-XML → interne Event-Struktur (reines JS, ein Parse-Pass inkl. State/Timing)
    const parsed = await _readAndParse(filePath, fps);
    if (parsed.empty) { _log('Datei leer — übersprungen', 'warn'); return false; }
    if (parsed.error) { _setStatus('error', { error: parsed.error.message }); return false; }
    const events = parsed.events;

    // Stabile IDs + Zusatzdaten aus der laufenden Playlist via reconcileKey übernehmen.
    // Dadurch bleibt _state (playing/done/…) in PlaylistEngine.set() erhalten und das
    // On-Air-Event behält seine id (kein ungewollter Re-Cue).
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
          if (!prev) {
            // Kein Vorgänger — Marina meldet dieses Event evtl. schon als "Done"
            if (ev._marinaState === 'Done') ev._state = 'done';
            continue;
          }

          // Stabile id übernehmen → _state bleibt in playlist.set() erhalten
          ev.id = prev.id;

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

          // Benutzerdefinierte Felder erhalten (nicht im Marina-Format vorhanden)
          const USER_FIELDS = ['audioConfig', 'classification', 'segment', 'segmentName', 'somMode', 'chLabel', 'playMode', '_somBase'];
          for (const f of USER_FIELDS) {
            if (ev[f] === undefined && prev[f] !== undefined) ev[f] = prev[f];
          }
        }
      }
    } catch (e) {
      _log(`Reconcile-Warnung: ${e.message}`, 'warn');
    }

    if (!events.length) {
      _log('Keine aktivierten Events in Marina-Datei', 'warn');
      _setStatus('warn', { msg: 'Keine Events' });
      return false;
    }

    // On-Air Sync: Ziel-Event (Marina "Running") bestimmen
    let syncPayload = null;
    let runningLabel = null;

    if (_cfg.onAirSync !== false) {
      const running = _findRunningEvent(events);
      if (running && running._schedStartMs != null) {
        syncPayload = {
          targetEventId: running.id,
          schedStartMs:  running._schedStartMs,
          toleranceSec:  Math.max(0, parseFloat(_cfg.syncToleranceSec) || 2),
        };
        runningLabel = running.title || running.file || running.liveSource || '(unbenannt)';
        _log(`On-Air Sync: Ziel-Event "${runningLabel}" (schedStart ${running._schedStartMs}ms)`);
      } else {
        _log('On-Air Sync: kein laufendes Event gefunden — kein Sync-Ziel');
      }
    }

    // Playout-State: läuft bereits?
    const isRunning = state0?.playlist?.running === true;
    // Auto-Start-Index/Offset (nur relevant wenn NICHT running) — Server berechnet den
    // exakten SOM-Offset zum Ausführungszeitpunkt selbst aus sync.schedStartMs (framegenauer,
    // kompensiert Debounce/Parse-Latenz seit hier).
    let startIndex = null;
    if (!isRunning && _cfg.autoStart) {
      startIndex = syncPayload ? events.findIndex(e => e.id === syncPayload.targetEventId) : 0;
      if (startIndex < 0) startIndex = 0;
    }

    // Playlist an PluginHost → server.js → playlist.set() + ggf. Start/Resync
    _api.setPlaylist(events, startIndex, null, syncPayload);

    const summary = `${events.length} Events aus ${fname}`;
    _api.notify(`Marina-Sync: ${summary}`, 'info');
    _setStatus('ok', {
      events:     events.length,
      file:       fname,
      syncTarget: runningLabel,
      started:    !isRunning && !!_cfg.autoStart,
      ts:         new Date().toISOString(),
    });
    _log(`Importiert: ${summary}`);
    return true;

  } catch (e) {
    _log(`Verarbeitungsfehler: ${e.message}`, 'error');
    _setStatus('error', { error: e.message });
    return false;
  } finally {
    _processing = false;
    if (_recheckAfter) {
      _recheckAfter = false;
      _scheduleCheck();
    }
  }
}

// ── Watch-Logik ────────────────────────────────────────────────────────────────

function _scheduleCheck() {
  if (_debounce) { clearTimeout(_debounce); _debounce = null; }
  _debounce = setTimeout(async () => {
    _debounce = null;

    if (_processing) {
      // Kein Verlust von Änderungen: nach Abschluss der laufenden Verarbeitung erneut prüfen
      _recheckAfter = true;
      return;
    }

    const found = _findLatest();
    if (!found) return;
    // Nur verarbeiten wenn sich Datei oder mtime geändert haben
    if (found.name === _lastFile && found.mtime === _lastMtime) return;

    const dir  = _resolveDir(_cfg.watchFolder);
    const full = path.join(dir, found.name);

    const ok = await _processFile(full, found.name).catch(e => {
      _log(`Prozess-Fehler: ${e.message}`, 'warn');
      return false;
    });

    // _lastFile/_lastMtime erst NACH erfolgreicher Verarbeitung setzen (nicht bei Parse-Fehler),
    // sonst würde eine noch unvollständige Datei beim nächsten fs.watch-Event ignoriert.
    if (ok) {
      _lastFile  = found.name;
      _lastMtime = found.mtime;
    }
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
  if (_debounce)  { clearTimeout(_debounce);   _debounce  = null; }
  if (_watcher)   { try { _watcher.close(); } catch {} _watcher = null; }
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  _recheckAfter = false;
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
