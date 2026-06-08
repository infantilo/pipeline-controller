#!/usr/bin/env node
'use strict';
process.env.GST_GL_API = 'none';

// ── GStreamer debug filter muss VOR dem ersten require('gst-kit') gesetzt sein,
// da gst_init() beim Laden des nativen Addons aufgerufen wird.
(function applyGstDebugEarly() {
  if (process.env.GST_DEBUG) return; // bereits via Env gesetzt → nicht überschreiben
  const fs   = require('fs');
  const path = require('path');
  const settingsPath = path.join(__dirname, 'settings.json');
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (s.gstDebugFilter) {
      process.env.GST_DEBUG = s.gstDebugFilter;
      process.env.GST_DEBUG_NO_COLOR = '1';
    }
  } catch {}
})();

const http           = require('http');
const fs             = require('fs');
const path           = require('path');
const MasterPipeline = require('./lib/MasterPipeline');
const PlayerPipeline = require('./lib/PlayerPipeline');
const PlaylistEngine = require('./lib/PlaylistEngine');
const { fromTC: _fromTC, toTC: _toTC } = require('./lib/Timecode');
const MediaLibrary   = require('./lib/MediaLibrary');
const { PreviewPipeline } = require('./lib/PreviewPipeline');
const PipelineDebugger   = require('./lib/PipelineDebugger');
const GrafixEngine       = require('./lib/GrafixEngine');

// ── AppImage: schreibbares Arbeitsverzeichnis (außerhalb des read-only squashfs) ─
const _appImageWorkDir = process.env.APPDIR
  ? path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME || '~', '.local', 'share'), 'pipeline-controller')
  : null;
function _writablePath(relPath) {
  return _appImageWorkDir ? path.join(_appImageWorkDir, relPath) : path.join(__dirname, relPath);
}

const PORT           = parseInt(process.env.PORT       || '3000');
const IMAGES_DIR     = path.join(__dirname, 'images');
const VIDEO_SINK     = process.env.VIDEO_SINK || null;
const DB_PATH        = _writablePath('library.json');
const SETTINGS_PATH  = _writablePath('settings.json');
const AUDIO_CFG_PATH = _writablePath('audio_config.json');
const W              = parseInt(process.env.WIDTH  || '1920');
const H              = parseInt(process.env.HEIGHT || '1080');
const FPS            = parseInt(process.env.FPS    || '25');

// ── Settings persistence ───────────────────────────────────────────────────────
// Settings are loaded BEFORE path constants so user-configured paths can override env defaults.
function loadSettings() {
  try { if (fs.existsSync(SETTINGS_PATH)) return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch {}
  return {};
}
function saveSettings(s) {
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2)); } catch(e) { console.error('saveSettings:', e.message); }
}
const _settings = loadSettings();

// ── Configurable paths (persisted in settings.json, take effect after restart) ─
// In AppImage mode: a configured path is only used if it actually exists on this machine.
// Stale dev-machine paths in an existing settings.json are ignored and fall through to defaults.
// Paths matching /tmp/.mount_* are FUSE AppImage mounts — they don't persist across runs and
// must never be honoured in AppImage mode even if the directory happens to still be accessible.
function _resolveDir(configured, envVar, fallback) {
  const isFuseMount = _appImageWorkDir && configured && /^\/tmp\/\.mount_/.test(configured);
  if (!isFuseMount && configured && (!_appImageWorkDir || fs.existsSync(configured))) return configured;
  const fromEnv = envVar && process.env[envVar];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  return fallback;
}
let MEDIA_DIR     = _resolveDir(_settings.mediaDir,     'MEDIA_DIR',     _writablePath('media'));
let PLAYLISTS_DIR = _resolveDir(_settings.playlistsDir, 'PLAYLISTS_DIR', _writablePath('playlists'));
let GRAFIK_DIR    = _resolveDir(_settings.grafixDir,    null,            _writablePath('templates/grafik'));
let ASRUN_DIR     = _resolveDir(_settings.asRunDir,     null,            _writablePath('asrun'));
let ASRUN_ENABLED = !!_settings.asRunEnabled;

// ── Segments persistence ───────────────────────────────────────────────────────
const SEGMENTS_PATH = _writablePath('segments.json');
function loadSegments() {
  try { if (fs.existsSync(SEGMENTS_PATH)) return JSON.parse(fs.readFileSync(SEGMENTS_PATH, 'utf8')); } catch {}
  return {};
}
function saveSegments(s) {
  try { fs.writeFileSync(SEGMENTS_PATH, JSON.stringify(s, null, 2)); } catch(e) { console.error('saveSegments:', e.message); }
}
let _segments = loadSegments();

// ── User management & auth ────────────────────────────────────────────────────
const crypto     = require('crypto');
const USERS_PATH = _writablePath('users.json');

function _hashPw(pw) {
  return crypto.createHash('sha256').update('pctrl:' + pw).digest('hex');
}
function _loadUsers() {
  try { if (fs.existsSync(USERS_PATH)) return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8')); } catch {}
  return null; // null = file doesn't exist = auth not configured
}
function _saveUsers(u) {
  fs.writeFileSync(USERS_PATH, JSON.stringify(u, null, 2));
}
let _users = _loadUsers();

// Sessions: token → { userId, username, roles, ip }
const _sessions = new Map();
function _genToken() { return crypto.randomBytes(24).toString('hex'); }

function _getSession(req) {
  const auth  = (req.headers['authorization'] || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7)
              : new URL(req.url, 'http://x').searchParams.get('token') || '';
  return token ? (_sessions.get(token) || null) : null;
}

/**
 * Returns session object if authorised (or {} when auth is disabled).
 * Returns false and writes the HTTP error response when auth fails.
 * roles: array of role strings, any match is sufficient. 'admin' always passes.
 */
function _requireAuth(req, res, roles) {
  if (!_settings.authEnabled || !_users) return {}; // auth disabled
  const sess = _getSession(req);
  if (!sess) {
    res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }
  if (roles && !sess.roles.includes('admin') && !roles.some(r => sess.roles.includes(r))) {
    res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Forbidden' }));
    return false;
  }
  return sess;
}

// ── User log ──────────────────────────────────────────────────────────────────
function _userLog(sess, action, detail) {
  const logPath = _settings.userLogPath;
  if (!logPath) return;
  try {
    const entry = JSON.stringify({
      ts:     new Date().toISOString(),
      user:   sess?.username || 'system',
      ip:     sess?.ip      || '-',
      action,
      detail: detail || ''
    }) + '\n';
    fs.appendFileSync(logPath, entry);
  } catch(e) { console.error('[userlog]', e.message); }
}

/**
 * Löst einen Idle-Bild-Dateinamen zu einem absoluten Pfad auf.
 * Sucht in: images/ → channelbranding/ → absolut
 */
function resolveIdleImage(nameOrPath) {
  if (!nameOrPath) return null;
  if (path.isAbsolute(nameOrPath) && fs.existsSync(nameOrPath)) return nameOrPath;
  const candidates = [
    path.join(__dirname, 'images', nameOrPath),
    path.join(__dirname, 'channelbranding', nameOrPath),
    path.join(__dirname, nameOrPath),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

// ── AudioGroupConfig ───────────────────────────────────────────────────────────
const AudioGroupConfig = require('./lib/AudioGroupConfig');
const { AudioRouter }  = require('./lib/AudioRouter');
const { Pipeline }     = require('gst-kit');
const audioGroupConfig = new AudioGroupConfig(AUDIO_CFG_PATH);

// ── Silence-Seeder ─────────────────────────────────────────────────────────────
// Pro Player-Slot eine eigene Seeder-Pipeline, die Stille auf alle interaudio-Kanäle
// schreibt, solange kein Player aktiv ist.
// → interaudiosrc im Master bekommt sofort gültige TIME-Format-Segmente,
//   verhindert GStreamer-CRITICAL-Assertions und pulsesink-Fehler beim Start.
// Lifecycle: start vor Master-Start → stop wenn Player cued → restart wenn Player stoppt.
const _seeders = {};

async function startSeeder(slotId) {
  await stopSeeder(slotId);
  let pipeStr;
  if (audioGroupConfig?.groups?.length) {
    // AudioRouter-Modus: Stille auf alle Gruppen-Kanäle
    const frags = AudioRouter.buildSilenceSeeders(audioGroupConfig, [slotId]);
    if (!frags.length) return;
    pipeStr = frags.join(' ');
  } else {
    // Legacy-Modus: Stille auf den einzigen interaudio-Kanal des Slots
    const acaps = 'audio/x-raw,rate=48000,channels=2';
    pipeStr = `audiotestsrc wave=silence is-live=true do-timestamp=true ! ${acaps} ! interaudiosink channel=${slotId}_audio sync=false async=false`;
  }
  try {
    const p = new Pipeline(pipeStr);
    await p.play();
    _seeders[slotId] = p;
    console.log(`[DEBUG][seeder] Seeder ${slotId}: gestartet`);
  } catch(e) {
    console.warn(`[WARN][seeder] Seeder ${slotId}: ${e.message}`);
  }
}

async function stopSeeder(slotId) {
  const p = _seeders[slotId];
  if (!p) return;
  _seeders[slotId] = null;
  try { await p.stop(); } catch {}
}


// ── State ──────────────────────────────────────────────────────────────────────
const clients = new Set();
// DeckLink signal status: slotId → { ok, ts, structure }
const _dlSignalStatus = {};
const logs    = [];

// ── Hotkeys (persistiert in settings.json) ────────────────────────────────────
const HOTKEYS_KEY = 'grafik_hotkeys';
const HOTKEYS_PATH = _writablePath('grafik_hotkeys.json');
function loadHotkeys() {
  try { return JSON.parse(fs.readFileSync(HOTKEYS_PATH, 'utf8')); }
  catch { return []; }
}
function saveHotkeys(arr) {
  fs.writeFileSync(HOTKEYS_PATH, JSON.stringify(arr, null, 2));
}
let hotkeys = loadHotkeys();

// ── Playlist Auto-Persistenz ──────────────────────────────────────────────────
const CURRENT_PLAYLIST_PATH = path.join(PLAYLISTS_DIR, '_current.json');
function _autoSavePlaylist() {
  try {
    fs.writeFileSync(CURRENT_PLAYLIST_PATH, JSON.stringify({ events: playlist.playlist }, null, 2));
  } catch(e) { /* ignore */ }
}

/** Playlist-Array mit Library-Dauer anreichern (für Timeline-Anzeige in der UI) */
function _enrichPlaylist(pl) {
  return pl.map(ev => {
    if (ev._clipDur || ev.duration || ev.eom) return ev;
    const info = library.get(ev.file);
    const dur = info?.duration ?? null;
    if (dur > 0) return { ...ev, _clipDur: dur };
    return ev;
  });
}
function _autoLoadPlaylist() {
  try {
    if (fs.existsSync(CURRENT_PLAYLIST_PATH)) {
      const data = JSON.parse(fs.readFileSync(CURRENT_PLAYLIST_PATH, 'utf8'));
      const events = data.events || data || [];
      if (events.length) {
        playlist.set(events);
        log(`Playlist wiederhergestellt: ${events.length} Events`, 'info', 'system');
      }
    }
  } catch(e) { log(`Playlist-Restore fehlgeschlagen: ${e.message}`, 'warn', 'system'); }
}

function genId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

// ── Event-Klassifikation ──────────────────────────────────────────────────────
const _DEFAULT_CLASSIFICATIONS = [
  { id: 'program',    label: 'Programm',   color: '#3b82f6', icon: '📺' },
  { id: 'movie',      label: 'Film',       color: '#8b5cf6', icon: '🎬' },
  { id: 'series',     label: 'Serie',      color: '#ec4899', icon: '🎞' },
  { id: 'news',       label: 'News',       color: '#ef4444', icon: '📰' },
  { id: 'commercial', label: 'Werbung',    color: '#f59e0b', icon: '💰' },
  { id: 'promo',      label: 'Promotion',  color: '#10b981', icon: '📣' },
];
function _getClassifications() {
  return _settings.classifications || _DEFAULT_CLASSIFICATIONS;
}

// ── Asset-Panel ───────────────────────────────────────────────────────────────
const ASSETS_PATH = _writablePath('assets.json');
function _loadAssets() {
  try { if (fs.existsSync(ASSETS_PATH)) return JSON.parse(fs.readFileSync(ASSETS_PATH, 'utf8')); } catch {}
  return [];
}
function _saveAssets(a) {
  try { fs.writeFileSync(ASSETS_PATH, JSON.stringify(a, null, 2)); } catch {}
}
let _assets = _loadAssets();

// Asset-Panel Interrupt-State
let _assetState = {
  active:            false,
  returnMode:        'break',
  returnEventIndex:  -1,
  returnSom:         0,
  returnEventId:     null,
  returnCopyId:      null,
  assetEventIds:     new Set(),
  insertedAtIndex:   -1,
  returnLiveSource:  null,
  startMs:           0,
};

function _assetCut(assetId, overrideReturnMode) {
  const asset = _assets.find(a => a.id === assetId);
  if (!asset || !asset.events?.length) return { ok: false, error: 'Asset nicht gefunden' };

  const returnMode = overrideReturnMode || asset.returnMode || 'break';
  const pl         = playlist.playlist;
  const curIdx     = Math.max(0, playlist.currentIndex ?? 0);
  const insertAt   = Math.max(0, playlist._running ? curIdx + 1 : curIdx);

  if (_assetState.active) _assetCleanupInserted();

  // Für Interrupt: exakte Position / verbleibende Dauer des unterbrochenen Events merken
  let resumeSom      = 0;
  let resumeEventId  = null;
  let resumeElapsed  = 0;  // elapsed seconds since event started (for non-player duration calc)
  if (returnMode === 'interrupt' && playlist._running) {
    const curEv = pl[curIdx];
    if (curEv && curEv.source !== 'comment' && curEv.source !== 'block_start' && curEv.source !== 'block_end') {
      resumeEventId = curEv.id;
      // Elapsed time since event started (wall-clock fallback for all types)
      const startMs = _anyEventStartMs || _clipStartMs || (_ar.lastPlay?.startMs) || 0;
      resumeElapsed = startMs > 0 ? Math.max(0, (Date.now() - startMs) / 1000) : 0;

      if (playlist._isPlayer(curEv)) {
        const fps = playlist.fps || 25;
        const origSomSec = _fromTC(curEv.som ?? 0, fps) || 0;
        const onAirPlayer = playlist._onAirSlot ? playlist.players[playlist._onAirSlot] : null;
        try {
          const gstPos = onAirPlayer?.vPipeline?.queryPosition?.();
          if (gstPos != null && gstPos > 0.01) {
            resumeSom = origSomSec + gstPos;
          } else {
            throw new Error('queryPosition unavailable');
          }
        } catch {
          resumeSom = origSomSec + resumeElapsed;
        }
      }
      // For non-player events: resumeSom stays 0; resumeElapsed is used for duration trim
    }
  }

  // Alle Asset-Events in Playlist einfügen (off-clip events bekommen VO-Child für Audio)
  const newIds = new Set();
  const newEvs = asset.events.map(ev => {
    const newId  = genId();
    newIds.add(newId);
    const evCopy = JSON.parse(JSON.stringify(ev));
    // Legacy _voMode → _offClipMode migrieren
    if (evCopy._voMode) { evCopy._offClipMode = true; evCopy.offClipPreset = evCopy.voPreset || 'AP50'; }
    // Off-Clip: Video normal schalten, Audio via VO-Child im PlaylistEngine
    if (evCopy._offClipMode && evCopy.file) {
      evCopy.children = [...(evCopy.children || []), {
        source: 'voiceover', file: evCopy.file,
        preset: evCopy.offClipPreset || 'AP50', delay: 0,
      }];
    }
    return { ...evCopy, id: newId, _isAsset: true, _assetId: assetId, _assetLabel: asset.label || '' };
  });

  // Interrupt: Return-Copy des unterbrochenen Events ans Ende hängen
  let returnCopyId = null;
  if (returnMode === 'interrupt' && resumeEventId) {
    const curEv = pl.find(e => e.id === resumeEventId);
    if (curEv) {
      const fps = playlist.fps || 25;
      const isPlayer = playlist._isPlayer(curEv);

      if (isPlayer) {
        // Player clip: resume at exact file position with trimmed EOM
        const origSomSec    = _fromTC(curEv.som ?? 0, fps) || 0;
        const origEomDurSec = curEv.eom != null ? (_fromTC(curEv.eom, fps) || 0) : null;
        const origEomAbsSec = origEomDurSec != null ? origSomSec + origEomDurSec : null;
        let returnEom = null;
        if (origEomAbsSec != null && origEomAbsSec > resumeSom) {
          returnEom = origEomAbsSec - resumeSom;
        }
        const origClipDur  = curEv._clipDur ?? origEomDurSec ?? null;
        const returnClipDur = origClipDur != null ? Math.max(0, origClipDur - (resumeSom - origSomSec)) : null;
        returnCopyId = genId();
        newIds.add(returnCopyId);
        newEvs.push({
          ...JSON.parse(JSON.stringify(curEv)),
          id: returnCopyId, som: resumeSom, eom: returnEom,
          _clipDur: returnClipDur ?? undefined,
          startType: 'sequential', transition: 'cut',
          _isAsset: true, _isAssetReturn: true, _assetId: assetId, _assetLabel: asset.label || '',
        });
      } else {
        // Non-player event (smpte/black/image/live): trim duration by elapsed time
        const origDurSec = _fromTC(curEv.duration ?? 0, fps) || 0;
        const remainingSec = Math.max(0, origDurSec - resumeElapsed);
        // Only add return copy if meaningful duration remains (> 0.5s)
        if (remainingSec > 0.5) {
          returnCopyId = genId();
          newIds.add(returnCopyId);
          newEvs.push({
            ...JSON.parse(JSON.stringify(curEv)),
            id: returnCopyId, duration: remainingSec,
            startType: 'sequential', transition: 'cut',
            _isAsset: true, _isAssetReturn: true, _assetId: assetId, _assetLabel: asset.label || '',
          });
        }
      }
    }
  }

  // Live-Rückkehr-Event
  if (returnMode === 'live' && asset.liveSource) {
    const retId = genId();
    newIds.add(retId);
    newEvs.push({ id: retId, source: asset.liveSource, duration: 5,
                  _isAsset: true, _isAssetReturn: true, _assetId: assetId });
  }

  const newPl = [...pl];
  newPl.splice(insertAt, 0, ...newEvs);
  playlist.set(newPl);

  _assetState = {
    active:           true,
    returnMode,
    assetId,
    assetLabel:       asset.label || '',
    returnEventIndex: curIdx,
    returnSom:        resumeSom,
    returnEventId:    resumeEventId,
    returnCopyId,
    assetEventIds:    newIds,
    insertedAtIndex:  insertAt,
    returnLiveSource: asset.liveSource || null,
    startMs:          Date.now(),
  };

  // Interrupt: pre-cue on non-on-air slot while current clip plays, then interrupt.
  // Break/other: immediate jump (current event already at natural end).
  // Always use jumpInterrupt for cue-first behavior — prevents idle flash.
  // jumpInterrupt pre-cues the first asset event before stopping current output.
  playlist.jumpInterrupt(insertAt).catch(() => {});
  log(`Asset-Cut: "${asset.label}" (${newEvs.length} Events, return=${returnMode})`, 'info', 'playlist');
  _arOnAssetCut(assetId, asset.label || '');
  broadcast('asset-state', _assetStatePublic());
  return { ok: true };
}

// Quickcut: sofort zu Live/Black/Source schneiden ohne Asset
function _quickCut(source, opts = {}) {
  const pl      = playlist.playlist;
  const curIdx  = playlist.currentIndex ?? 0;
  const insertAt = playlist._running ? curIdx + 1 : curIdx;
  const newId   = genId();
  const ev = {
    id:          newId,
    source:      source,
    liveSource:  opts.liveSource || (source !== 'black' && source !== 'smpte' && source !== 'image' ? source : undefined),
    title:       opts.title || source,
    duration:    opts.endType === 'manual' ? (opts.duration || 5) : (opts.duration || 10),
    endType:     opts.endType  || 'sequential',
    transition:  opts.transition || 'cut',
    branding:    opts.branding   || null,
    audioPreset: opts.audioPreset || null,
    audioConfig: opts.audioConfig || undefined,
    children:    opts.children   || undefined,
    _isQuickCut: true,
  };
  // Remove undefined keys to keep events clean
  Object.keys(ev).forEach(k => ev[k] === undefined && delete ev[k]);

  const newPl = [...pl];
  newPl.splice(insertAt, 0, ev);
  playlist.set(newPl);
  // Use cue-first interrupt for seamless transitions
  playlist.jumpInterrupt(insertAt).catch(() => {});
  log(`Quickcut: ${source} (endType=${ev.endType})`, 'info', 'playlist');
  return { ok: true, id: newId };
}

function _assetStatePublic() {
  return {
    active:     _assetState.active,
    assetId:    _assetState.active ? _assetState.assetId : null,
    assetLabel: _assetState.active ? _assetState.assetLabel : null,
    returnMode: _assetState.returnMode,
    startMs:    _assetState.active ? _assetState.startMs : null,
  };
}

function _assetCleanupInserted() {
  // Asset-Events aus Playlist entfernen
  const newPl = playlist.playlist.filter(ev => !_assetState.assetEventIds.has(ev.id));
  _suppressPlaylistUpdatedBroadcast += 2;
  playlist.set(newPl);
}

// playlist.on('playing') → Asset-Return-Copy erkennen → State clearen
function _onPlayingCheckAsset(d) {
  if (!_assetState.active) return;
  const ev = d.event;
  if (!ev || !_assetState.assetEventIds.has(ev.id)) return;

  if (ev._isAssetReturn) {
    // Return-Copy oder Live-Return läuft jetzt — Playlist übernimmt den Rest
    _assetState.active = false;
    broadcast('asset-state', _assetStatePublic());
  }
  // Normale Asset-Events: Playlist fließt automatisch weiter
}

// ── URI-basierte Live-Quellen (RTSP, HLS, UDP, HTTP, SRT) ─────────────────────
// Generiert einen GStreamer-Source-String aus einer URI.
// RTSP: rtspsrc → rtph264depay/rtpjpegdepay → decoder → videoconvert
// HLS:  souphttpsrc → hlsdemux → decoder
// UDP:  udpsrc → tsdemux → decoder
// Allgemein: uridecodebin (für HTTP-progressive, Dateien, etc.)
function _buildUriLiveSrc(uri, latencyMs = 200) {
  if (!uri) return null;
  if (/^rtsp:\/\//i.test(uri)) {
    return `rtspsrc location="${uri}" latency=${latencyMs} ! rtph264depay ! h264parse ! avdec_h264 ! videoconvert`;
  }
  if (/^srt:\/\//i.test(uri)) {
    return `srtsrc uri="${uri}" ! tsdemux ! h264parse ! avdec_h264 ! videoconvert`;
  }
  if (/^udp:\/\//i.test(uri)) {
    const m = uri.match(/^udp:\/\/([^:]+):(\d+)/i);
    const host = m?.[1] || '0.0.0.0', port = m?.[2] || '1234';
    return `udpsrc address="${host}" port=${port} ! tsdemux ! h264parse ! avdec_h264 ! videoconvert`;
  }
  // Allgemein (HTTP-HLS, Datei, etc.)
  return `uridecodebin uri="${uri}" ! videoconvert`;
}

function _buildUriLiveAudioSrc(uri, latencyMs = 200) {
  if (!uri) return null;
  if (/^rtsp:\/\//i.test(uri)) {
    return `rtspsrc location="${uri}" latency=${latencyMs} ! rtppcmadepay ! alawdec ! audioconvert ! audioresample`;
  }
  if (/^srt:\/\//i.test(uri)) {
    return `srtsrc uri="${uri}" ! tsdemux ! aacparse ! avdec_aac ! audioconvert`;
  }
  if (/^udp:\/\//i.test(uri)) {
    const m = uri.match(/^udp:\/\/([^:]+):(\d+)/i);
    const host = m?.[1] || '0.0.0.0', port = m?.[2] || '1234';
    return `udpsrc address="${host}" port=${port} ! tsdemux ! aacparse ! avdec_aac ! audioconvert`;
  }
  return `uridecodebin uri="${uri}" ! audioconvert ! audioresample`;
}

// ── Pipeline-Latenz-Messung ────────────────────────────────────────────────────
// Misst die aktuelle GStreamer-Pipeline-Latenz (min/max) und gibt Empfehlungen.
// GStreamer-Pipelines propagieren Latenz-Queries von Senken zu Quellen.
// Das Ergebnis hilft beim Kalibrieren von grafikLatencyMs.
function _measurePipelineLatency() {
  const result = {
    timestamp: new Date().toISOString(),
    measured: {},
    recommendation: {},
    note: '',
  };

  // GStreamer-Latenz-Query über gst-kit Pipeline-Objekt
  // queryLatency() gibt { minLatencyNs, maxLatencyNs, live } zurück (falls implementiert)
  try {
    if (master?.pipeline?.queryLatency) {
      const q = master.pipeline.queryLatency();
      if (q) {
        result.measured.masterMinMs = Math.round((q.minLatencyNs || 0) / 1e6);
        result.measured.masterMaxMs = Math.round((q.maxLatencyNs || 0) / 1e6);
        result.measured.live        = !!q.live;
      }
    }
  } catch {}

  // Grafik-Latenz: Puppeteer-Screenshot + RGBA-Konvertierung + GStreamer-appsrc
  // Schätzung: 1 Render-Zyklus (40ms@25fps) + appsrc→compositor (1-2 Frames) + Sink-Buffer
  const fps = masterOpts.fps || FPS;
  const frameDurMs = Math.round(1000 / fps);
  const estimatedGrafikLatencyMs = frameDurMs * 2 + 20;  // 2 Frames + 20ms Overhead

  result.recommendation.grafikLatencyMs = estimatedGrafikLatencyMs;
  result.recommendation.note = `Empfohlen: grafikLatencyMs=${estimatedGrafikLatencyMs} (${fps}fps, 2 Frames + Overhead). Fein-Kalibrierung mit Testgrafik auf Frame-Monitor empfohlen.`;

  if (result.measured.masterMaxMs > 0) {
    result.note = `GStreamer-Pipeline: min=${result.measured.masterMinMs}ms max=${result.measured.masterMaxMs}ms`;
  } else {
    result.note = `GStreamer queryLatency nicht verfügbar. Schätzung basiert auf ${fps}fps Framerate.`;
  }

  return result;
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); }
    catch { clients.delete(res); }
  }
}

// SSE heartbeat: detect and clean dead connections every 30s
setInterval(() => {
  if (!clients.size) return;
  const ping = ':heartbeat\n\n';
  for (const res of clients) {
    try { res.write(ping); }
    catch { clients.delete(res); }
  }
}, 30000);

// Sources whose INFO-level logs are internal pipeline noise — suppressed when debug is off.
const _PIPELINE_SOURCES = new Set(['master','playlist','trans','grafik','preview']);

function log(msg, level = 'info', source = 'system') {
  if (level === 'debug' && !debugger_?.verboseBus) return;
  // When debug disabled: suppress INFO from internal pipeline sources.
  // player1/player2/… are matched by prefix. warn/error always pass through.
  if (level === 'info' && !_settings.debugEnabled) {
    const isPipeline = _PIPELINE_SOURCES.has(source) ||
                       /^player\d*$|^playerIdle$|^vo-/.test(source);
    if (isPipeline) return;
  }
  const entry = { level, msg, source, ts: Date.now() };
  logs.push(entry); if (logs.length > 800) logs.shift();
  broadcast('log', entry);
  console.log(`[${level.toUpperCase()}][${source}] ${msg}`);
}

// ── PipelineDebugger (optional, per API ein-/ausschaltbar) ────────────────────
const debugger_ = new PipelineDebugger({
  enabled:         _settings.debugEnabled ?? false,
  broadcast,
  log,
  statsIntervalMs: 2000,
  busPollingMs:    200,
  verboseBus:      _settings.debugVerbose ?? false,
});


const library = new MediaLibrary(MEDIA_DIR, DB_PATH).load();
if (!fs.existsSync(PLAYLISTS_DIR)) fs.mkdirSync(PLAYLISTS_DIR, { recursive: true });
if (!fs.existsSync(IMAGES_DIR))    fs.mkdirSync(IMAGES_DIR,    { recursive: true });

// ── Duration-mismatch revalidation (runs after library scan or playlist save) ──
function _revalidateDurations() {
  const { fromTC: _ftc } = require('./lib/Timecode');
  const globalPolicy = _settings.durationMismatch || 'warn';
  let changed = false;
  for (const ev of (playlist?.playlist || [])) {
    if (!ev.file) continue;
    const info = library.get(ev.file) || library.getAll().find(m => {
      const bn = m.fileName.replace(/\.[^.]+$/, '');
      const en = ev.file.replace(/\.[^.]+$/, '');
      return bn === en;
    });
    const perEv = ev.durationMismatch || globalPolicy;
    if (!info || info.error || perEv === 'ignore') {
      if (ev._durationWarning) { delete ev._durationWarning; changed = true; }
      continue;
    }
    if (info.duration > 0 && ev.eom != null) {
      const fps = info.video?.fps ? (()=>{ const p=(info.video.fps+'').split('/'); return p.length===2?+p[0]/+p[1]:+p[0]; })() : 25;
      const somSec  = _ftc(ev.som  ?? 0, fps) || 0;
      const eomSec  = _ftc(ev.eom, fps) || 0;
      const clipEnd = somSec + eomSec;
      if (clipEnd > info.duration + 0.08) {
        const overBy = (clipEnd - info.duration).toFixed(2);
        if (perEv === 'adapt') {
          if (somSec >= info.duration) {
            // SOM is past EOF — reset both to play full file
            ev.som = 0;
            ev.eom = info.duration;
            log(`⏱ Dauer angepasst ${ev.file}: SOM past EOF, zurückgesetzt auf SOM=0 EOM=${ev.eom.toFixed(2)}s`, 'warn', 'library');
          } else {
            ev.eom = Math.max(0, info.duration - somSec);
            log(`⏱ Dauer angepasst ${ev.file}: EOM auf ${ev.eom.toFixed(2)}s`, 'warn', 'library');
          }
          if (ev._durationWarning) { delete ev._durationWarning; }
          changed = true;
        } else {
          const w = `EOM überschreitet Dateidauer um ${overBy}s`;
          if (ev._durationWarning !== w) { ev._durationWarning = w; changed = true; }
        }
      } else {
        if (ev._durationWarning) { delete ev._durationWarning; changed = true; }
      }
    } else {
      if (ev._durationWarning) { delete ev._durationWarning; changed = true; }
    }
  }
  return changed;
}

function _enrichLibrary(items) {
  const defTc = _settings.defaultStartTimecode || '00:00:00:00';
  return items.map(m => m.startTimecode ? m : { ...m, startTimecode: defTc });
}

library.on('analyzed', ({ fileName, info }) => {
  log(`📼 Analysiert: ${fileName} (${info.duration != null ? info.duration.toFixed(1)+'s' : '?'}, ${info.format})`, 'info', 'library');
  broadcast('library', _enrichLibrary(library.getAll()));
  if (_revalidateDurations()) {
    broadcast('playlist', _enrichPlaylist(playlist.playlist));
    _autoSavePlaylist();
  }
});
library.on('error',   ({ fileName, error }) => log(`⚠ Analyse-Fehler ${fileName}: ${error}`, 'warn', 'library'));
library.on('removed', ({ fileName }) => { log(`🗑 Entfernt: ${fileName}`, 'info', 'library'); broadcast('library', _enrichLibrary(library.getAll())); });
library.setAudioConfig(audioGroupConfig.groups, audioGroupConfig.presets);
// dead.dir: korrupte/nicht-analysierbare Dateien werden automatisch verschoben
library.setDeadDir(_settings.deadDir || null);  // null = Standardpfad <media>/../dead
library.startWatching();

// ── Master + Players ───────────────────────────────────────────────────────────
// ── Dynamische Player-Slots (player1..playerN) ────────────────────────────────
const _numPlayers = Math.max(1, Math.min(8, parseInt(_settings.numPlayers || '2')));
const _slotIds    = Array.from({ length: _numPlayers }, (_, i) => `player${i + 1}`);

const masterOpts = {
  width:            _settings.width      || W,
  height:           _settings.height     || H,
  fps:              _settings.fps        || FPS,
  videoSink:        _settings.videoSink  || VIDEO_SINK || undefined,
  audioSink:        _settings.audioSink  || process.env.AUDIO_SINK || 'pulsesink',
  idleSource:       _settings.idleSource    || 'smpte',
  idleImagePath:    resolveIdleImage(_settings.idleImagePath) || null,
  scaleMode:        _settings.scaleMode        || 'fit',
  scaleMethod:      _settings.scaleMethod      ?? 1,
  deinterlaceMode:  _settings.deinterlaceMode  || 'auto',
  debugger:         debugger_,
  audioGroupConfig: audioGroupConfig.groups.length ? audioGroupConfig : null,
  liveSources:      _settings.liveSources || [],
  slotIds:          _slotIds,
  numVoSlots:       Math.max(1, Math.min(4, parseInt(_settings.numVoSlots || '2'))),
  // A/V-Sync Delay-Korrektur (runtime-änderbar via /api/pipeline/av-sync)
  videoDelayMs:     _settings.videoDelayMs  ?? 0,
  audioDelayMs:     _settings.audioDelayMs  || {},
};

// ── VoiceoverEngine ───────────────────────────────────────────────────────────
const VoiceoverEngine  = require('./lib/VoiceoverEngine');
const _voGroupIds      = audioGroupConfig.groups.length ? audioGroupConfig.groups.map(g => g.id) : ['pgm-stereo'];
const _voGroupChannels = Object.fromEntries(audioGroupConfig.groups.map(g => [g.id, g.channels || 2]));
const _numVoSlots      = Math.max(1, Math.min(4, parseInt(_settings.numVoSlots || '2')));
const _voSlotIds       = Array.from({ length: _numVoSlots }, (_, i) => `vo${i + 1}`);

// ── VO-Engines (eine pro Slot) — interaudio-basiert (gleiche Clock wie Clip-Player) ──
const _makeVoEngine = (slotId) => {
  const eng = new VoiceoverEngine({
    slotId,
    groupIds:  _voGroupIds,
    fadeInMs:  parseInt(_settings.voFadeInMs  ?? 500),
    fadeOutMs: parseInt(_settings.voFadeOutMs ?? 1000),
    presets:   Object.assign({}, VoiceoverEngine.defaultPresets(), _settings.voPresets || {}),
    log:       (msg, lvl) => log(msg, lvl || 'info', `vo-${slotId}`),
  });
  eng.on('pgm-gain', (gain, fadeMs) => {
    if (master?.running) master.setVoiceoverPgmGain(gain, fadeMs);
  });
  eng.on('vo-gain', (vol) => {
    if (master?.running) master.setVoVolume(vol, slotId);
  });
  eng.on('group-vo-gain', (groupVoGain) => {
    if (master?.running) master.setVoGroupOverrides(groupVoGain, slotId);
  });
  eng.on('playing', ({ slotId: sid, filePath, preset }) => {
    const file = path.relative(MEDIA_DIR, filePath);
    broadcast('vo-playing', { slotId: sid, file, preset: preset || 'ST' });
    _arOnVo('playing', sid, file);
  });
  eng.on('stopped', () => {
    if (master?.running) master.setVoiceoverPgmGain(1.0, 0);
    broadcast('vo-stopped', { slotId });
    _arOnVo('stopped', slotId, '');
  });
  return eng;
};

const voEngines = Object.fromEntries(_voSlotIds.map(id => [id, _makeVoEngine(id)]));
// Backward-compat alias used by existing playlist/plugin code
const voiceoverEngine = voEngines['vo1'];

// ── GrafixEngine (oGraf HTML5-Grafik via Puppeteer) ───────────────────────────
const grafixEngine = new GrafixEngine({
  templatesDir: GRAFIK_DIR,
  port:         parseInt(process.env.GRAFIK_PORT || '3101'),
  width:        masterOpts.width,
  height:       masterOpts.height,
  fps:          masterOpts.fps,
});
grafixEngine.on('log', ({ level, msg }) => log(msg, level, 'grafik'));

const master = new MasterPipeline(masterOpts);
master.on('log',      ({ level, msg }) => log(msg, level, 'master'));
// Audio-Pegel vom Master-Ausgang.
// Pegel-Throttle pro Kanal (max ~12/s pro Gruppe).
// AudioRouter-Modus: level-Elemente liegen im Master (nach dem group-input-selector).
// Legacy-Modus:      level_pgm liegt nach aisel_pgm; Player schreibt Audio via
//   interaudiosink channel=${ch}_audio in den interaudio-Shared-Memory, den der Master
//   via interaudiosrc liest → aisel_pgm → level_pgm → pulsesink.
//   Dadurch misst level_pgm in beiden Modi das tatsächlich ausgespielte Signal.
//   Separate Unterdrückung / Player-Level-Handler sind nicht mehr nötig.
const _masterLevelThrottles = {};  // channel → lastSent ms
const _r128State = {};             // groupId → { gainDb }

function _r128Process(groupId, rmsArr) {
  const group = audioGroupConfig.getGroup(groupId);
  if (!group?.r128?.enabled) return;
  const target     = group.r128.target     ?? -23;
  const maxGain    = group.r128.maxGain    ?? 12;
  const smoothRate = group.r128.smoothRate ?? 0.5;
  const rms = rmsArr.reduce((a, b) => a + b, 0) / rmsArr.length;
  if (rms === 0 || !isFinite(rms)) return;
  const rawGainDb = Math.max(-maxGain, Math.min(maxGain, target - rms));
  const prev   = _r128State[groupId]?.gainDb ?? 0;
  const gainDb = Math.max(prev - smoothRate, Math.min(prev + smoothRate, rawGainDb));
  _r128State[groupId] = { gainDb };
  master.setR128Gain?.(groupId, Math.pow(10, gainDb / 20));
}

master.on('level', d => {
  const ch  = d.channel || 'pgm';
  const now = Date.now();

  // R128: channel-Name → groupId ('agrp_pgm_stereo' → 'pgm-stereo')
  const groupId = ch.startsWith('agrp_') ? ch.replace(/^agrp_/, '').replace(/_/g, '-') : null;
  if (groupId && d.rms?.length) _r128Process(groupId, d.rms);

  if (now - (_masterLevelThrottles[ch] || 0) < 80) return;
  _masterLevelThrottles[ch] = now;
  const r128GainDb = groupId ? (_r128State[groupId]?.gainDb ?? null) : null;
  broadcast('audio-level', { ...d, r128GainDb });
});

// Heartbeat: hält VU-Anzeige aktuell wenn Level-Element kurz keine Meldungen schickt
setInterval(() => {
  if (!masterOpts.audioGroupConfig) return;
  const now = Date.now();
  for (const group of masterOpts.audioGroupConfig.groups) {
    const ch = `agrp_${group.id.replace(/-/g, '_')}`;
    if (now - (_masterLevelThrottles[ch] || 0) < 800) continue;
    _masterLevelThrottles[ch] = now;
    broadcast('audio-level', {
      channel:    ch,
      rms:        Array(group.channels).fill(-60),
      peak:       Array(group.channels).fill(-60),
      r128GainDb: _r128State[group.id]?.gainDb ?? null,
    });
  }
}, 500);
master.on('switched', d => {
  broadcast('switched', d);
  // If master switched AWAY from padImagePl, any active still is no longer visible.
  // Clear active state so UI buttons reflect reality.
  if (d.pad !== master.padImagePl) {
    let changed = false;
    for (const s of _stillSlots) {
      if (s.active) { s.active = false; s.fromPad = -1; changed = true; }
    }
    if (changed) broadcast('still-state', _stillPublicState());
  }
});
master.on('error',    msg => log(msg, 'error', 'master'));

const players = Object.fromEntries([
  ..._slotIds.map(id => [id, new PlayerPipeline(id, masterOpts)]),
  ['playerIdle', new PlayerPipeline('playerIdle', masterOpts)],
]);

// Tracks players currently in a load() call — prevents seeder restart during pipeline creation
const _loadingPlayers = new Set();

for (const [id, p] of Object.entries(players)) {
  p.on('log',      ({ level, msg }) => log(msg, level, id));
  p.on('loading',  () => { _loadingPlayers.add(id); stopSeeder(id).catch(()=>{}); });
  p.on('cued',     d => { _loadingPlayers.delete(id); stopSeeder(id).catch(()=>{}); broadcast('player-cued', d); master?.onPlayerActive?.(id); pluginHost.dispatch('player:cued', { slotId: id, ...d }); });
  p.on('playing',  d => { broadcast('player-playing',  d); pluginHost.dispatch('player:playing', { slotId: id, ...d }); });
  p.on('stopped',  d => {
    broadcast('player-stopped', d);
    master?.onPlayerIdle?.(id);
    if (!_loadingPlayers.has(id)) startSeeder(id).catch(()=>{});
    pluginHost.dispatch('player:stopped', { slotId: id, ...d });
  });
  p.on('paused',   d => broadcast('player-paused',   d));
  // Throttle position broadcast to 4×/sec — client counters use performance.now() locally.
  let _posThrottleTs = 0;
  p.on('position', d => {
    const now = Date.now();
    if (now - _posThrottleTs >= 250) { _posThrottleTs = now; broadcast('player-position', { slotId: id, ...d }); }
  });
  p.on('eom',      d => { log(`EOM: ${id}`, 'info', id); broadcast('player-eom', { slotId: id, ...d }); });
  p.on('eos',      d => { log(`EOS: ${id}`, 'info', id); broadcast('player-eos', { slotId: id, ...d }); });
  p.on('error',    m => { _loadingPlayers.delete(id); startSeeder(id).catch(()=>{}); log(m, 'warn', id); });
  p.on('decklink-signal', d => {
    _dlSignalStatus[d.slot] = { ok: d.ok, ts: Date.now(), structure: d.structure };
    broadcast('decklink-signal', _dlSignalStatus);
    if (!d.ok) log(`DeckLink signal loss on slot ${d.slot}: ${d.structure}`, 'warn', 'system');
  });
}

const TransitionEngine = require('./lib/TransitionEngine');
const transitionEngine = new TransitionEngine(master, _settings.transitionSpeeds);
transitionEngine._log = (m, l) => log(`[trans] ${m}`, l, 'playlist');

// ── Plugin-Host ────────────────────────────────────────────────────────────────
const PluginHost = require('./lib/PluginHost');
const pluginHost = new PluginHost({
  pluginsDir:  path.join(__dirname, 'plugins'),
  configPath:  path.join(__dirname, 'plugins.json'),
  log:         (msg, lvl) => log(msg, lvl, 'plugins'),
  getState:    () => getState(),
  getPlaylist: () => playlist?.playlist || [],
  getLibrary:  () => library?.getAll() || {},
});
pluginHost.on('broadcast',    (event, data) => broadcast(event, data));
pluginHost.on('notify',       n => broadcast('plugin-notify', n));
pluginHost.on('plugin-status',s => broadcast('plugin-status', s));
// FTM (and other plugins) call resolveLocal when a file becomes available locally.
// Re-broadcast the playlist so the UI clears the "missing" indicator immediately.
pluginHost.on('path-resolved', () => {
  broadcast('playlist', _enrichPlaylist(playlist.playlist));
});
pluginHost.on('setEventProps',(eventId, props) => {
  const ev = playlist?.playlist?.find(e => e.id === eventId);
  if (ev) {
    Object.assign(ev, props);
    broadcast('playlist', _enrichPlaylist(playlist.playlist));
    _autoSavePlaylist();
  }
});

// Marina-Sync (und andere Plugins) können die Playlist komplett ersetzen
pluginHost.on('playlist-set', ({ events, startIndex, somOffset }) => {
  log(`Marina-Sync: ${events.length} Events geladen`, 'info', 'system');
  playlist.set(events);
  // Auto-Start: nur wenn Playlist aktuell nicht läuft UND Plugin explizit startIndex liefert
  if (!playlist._running && typeof startIndex === 'number' && startIndex >= 0 && startIndex < playlist.playlist.length) {
    // SOM-Offset für On-Air-Sync auf das Einsteige-Event anwenden
    if (typeof somOffset === 'number' && somOffset > 0) {
      const ev = playlist.playlist[startIndex];
      if (ev) ev.som = Math.max(0, (typeof ev.som === 'number' ? ev.som : 0) + somOffset);
    }
    playlist.start(startIndex);
    log(`Marina-Sync: Start ab Event ${startIndex + 1} (SOM-Offset ${somOffset?.toFixed(1) ?? 0}s)`, 'info', 'system');
    broadcast('state', getState());
  }
});

// ── RecordEngine ──────────────────────────────────────────────────────────────
const RecordEngine = require('./lib/RecordEngine');
const recordEngine = new RecordEngine({
  recordDir:   _settings.recordDir   || _writablePath('recordings'),
  audioGroups: _settings.recordAudioGroups || (_settings.recordAudioGroup ? [_settings.recordAudioGroup] : ['pgm-stereo']),
  slots:       _settings.recordSlots || ['rec1', 'rec2', 'rec3'],
  log:         (msg, lvl) => log(msg, lvl, 'record'),
});

let RECORD_IN_LIBRARY = !!_settings.recordIncludeInLibrary;
if (RECORD_IN_LIBRARY) library.addExtraDir(recordEngine._recordDir, 'rec');

recordEngine.on('started', d => { broadcast('record-started', d); _arOnRecord('start', d); library.lock(d.outputPath); });
recordEngine.on('stopped', d => { broadcast('record-stopped', d); _arOnRecord('stop', d); });
recordEngine.on('remuxed', d => { library.unlock(d.outputPath); if (RECORD_IN_LIBRARY && d.ok) library.scan(); });

const playlist = new PlaylistEngine(master, players, transitionEngine, {
  mediaDir:         MEDIA_DIR,
  gapSource:        _settings.gapSource || 'black',
  gapFile:          _settings.gapFile   || null,
  autoGap:          _settings.autoGap   ?? false,
  missingBehavior:  _settings.missingBehavior || 'skip',
  fps:              FPS,
  library,
  idleSource:       masterOpts.idleSource,
  idleSlot:         'playerIdle',
  grafixEngine,
  voiceoverEngine,
  recordEngine,
  liveSources:      _settings.liveSources     || [],
  liveCueMode:      _settings.liveCueMode     || 'timed',   // 'asap' | 'timed'
  liveCueLeadSec:   _settings.liveCueLeadSec  ?? 5,         // Sekunden Vorlauf für 'timed'
  grafikLatencyMs:  _settings.grafikLatencyMs ?? 0,         // Pipeline-Latenz-Kompensation
  slotIds:          _slotIds,
  backupSlot:       _settings.backupSlot     || null,
  backupMediaDirs:  _settings.backupMediaDirs || [],
  resolveFilePath: (file) => pluginHost.resolveFilePath(file),
  getSegment:  (file, segName) => {
    const segs = _segments[file] || [];
    return segs.find(s => s.name === segName) || null;
  },
});

const preview = new PreviewPipeline();
preview.on('log', ({ level, msg }) => log(msg, level, 'preview'));

// ── Freeze / Still Slots ───────────────────────────────────────────────────────
const _STILL_MAX = 9;
const _stillSlots = Array.from({ length: _STILL_MAX }, () => ({
  active:    false,
  fromPad:   -1,
  frameData: null,   // Buffer | null  — captured JPEG, kept in memory only
  tmpPath:   null,   // string | null  — path of the temp file for this slot
}));

async function _stillCapture(slot) {
  const s = _stillSlots[slot];
  if (!s) throw new Error('Invalid slot');
  // Use the latest preview JPEG as the still source
  const frame = preview._frame;
  if (!frame || frame.length < 200) throw new Error('No preview frame available');

  // Write to a temp file so gdkpixbufoverlay can read it
  const tmpPath = require('path').join(require('os').tmpdir(), `pc_still_${slot}.jpg`);
  require('fs').writeFileSync(tmpPath, frame);
  s.frameData = frame;
  s.tmpPath   = tmpPath;  // remember path so _stillActivate can reload it later
  await master.showPlaylistImage(tmpPath);
  broadcast('still-state', _stillPublicState());
  return { ok: true };
}

async function _stillActivate(slot) {
  const s = _stillSlots[slot];
  if (!s || !s.frameData) throw new Error('No still captured for slot ' + slot);
  // Deactivate any other active still first
  for (let i = 0; i < _STILL_MAX; i++) {
    if (i !== slot && _stillSlots[i].active) _stillDeactivate(i);
  }
  s.fromPad = master._activePad;
  // Load THIS slot's image into imgOverlay BEFORE switching to padImagePl.
  // Without this, a previously captured slot's image would remain on screen.
  if (s.tmpPath) await master.showPlaylistImage(s.tmpPath);
  master.switchVideoOnly(master.padImagePl);
  s.active = true;
  broadcast('still-state', _stillPublicState());
}

function _stillDeactivate(slot) {
  const s = _stillSlots[slot];
  if (!s || !s.active) return;
  const restorePad = (s.fromPad >= 0) ? s.fromPad : master.padSmpte;
  master.switchVideoOnly(restorePad);
  s.active = false;
  s.fromPad = -1;
  broadcast('still-state', _stillPublicState());
}

function _stillPublicState() {
  return _stillSlots.slice(0, _STILL_MAX).map((s, i) => ({
    slot: i, active: s.active, hasFrame: !!s.frameData,
  }));
}

playlist.on('log',          ({ level, msg }) => log(msg, level, 'playlist'));
let _suppressPlaylistUpdatedBroadcast = 0;
playlist.on('updated',      pl => {
  if (_suppressPlaylistUpdatedBroadcast > 0) { _suppressPlaylistUpdatedBroadcast--; return; }
  broadcast('playlist', _enrichPlaylist(pl)); _autoSavePlaylist(); pluginHost.dispatch('playlist:updated', { events: pl });
});
playlist.on('current',      d  => broadcast('playlist-current', { ...d, serverStartMs: Date.now() }));
// ASRUN-independent current-playing state for page-reload reconstruction
let _currentPlaying = null;
playlist.on('playing',      d  => {
  const _nowMs = Date.now();
  // Track start time for ALL events (needed for remaining-duration calc on interrupt)
  if (!((d.slotId === null || d.slotId === undefined) && d.fixEnd)) {
    _anyEventStartMs = _nowMs;  // real event start (not gap re-emit)
  }
  if (d.slotId) _clipStartMs = _nowMs;
  // Track playing state so reconnecting clients can reconstruct counters
  if (!((d.slotId === null || d.slotId === undefined) && d.fixEnd)) {
    // real event start (not gap re-emit)
    _currentPlaying = { clipDur: d.clipDur||0, postrollSec: d.postrollSec||0, fixEnd: d.fixEnd||null,
                        slotId: d.slotId||null, event: d.event||null, startMs: Date.now() };
  } else if (_currentPlaying) {
    _currentPlaying.fixEnd = d.fixEnd;
  }
  broadcast('playlist-playing', d); _arOnPlay(d); pluginHost.dispatch('playlist:playing', d); _onPlayingCheckAsset(d);
});
playlist.on('cut',          d  => broadcast('cut', d));
playlist.on('ready-to-cut', d  => broadcast('ready-to-cut', d));
playlist.on('ended',        () => { _currentPlaying = null; log('Playlist fertig', 'info', 'playlist'); broadcast('playlist-ended', {}); _arFlushPlay(Date.now(), 'Completed'); });
playlist.on('stopped',      () => { _currentPlaying = null; broadcast('playlist-ended', {}); broadcast('state', getState()); });
playlist.on('manual-hold',  d  => { broadcast('manual-hold', d); broadcast('state', getState()); });
playlist.on('live-precue',    d  => { broadcast('live-precue', d); pluginHost.dispatch('live:precue', d); });
playlist.on('backup-active',  d  => { broadcast('backup-active', d); log(`⚠ FAILOVER: ${d.fromSlot||'(file)'} → ${d.toSlot||'backup-path'} (${d.event?.file||'?'})`, 'warn', 'playlist'); });
playlist.on('backup-unavailable', d => { broadcast('backup-unavailable', d); log(`⚠ Backup nicht verfügbar: ${d.fromSlot}`, 'warn', 'playlist'); });
playlist.on('grafik',       d  => {
  broadcast('grafik', { action: d.action, id: d.id, template: d.template });
  _arOnGrafik(d.action, d.id, d.template, 'child');
});

// ── As-Run Log (ORF Marina Text fixed-width format) ────────────────────────────
const _AR_COLS = [4,22,22,32,20,32,11,32,11,12,11,12,11,32,32,32,32];
const _AR_HDRS = ['TYPE','START TIME','END TIME','MEDIA ID','EVENT','TITLE','SOM','SEGMENT','DURATION','START TYPE','STRT OFFSET','END TYPE','END OFFSET','DEVICE STREAM','RECONCILE KEY','HOUSE ID','STATUS'];
const _ar = { lastPlay: null, grafik: new Map(), vo: new Map(), _key: Date.now() };
// ASRUN-independent clip-start tracker (works even when ASRUN is disabled)
let _clipStartMs    = 0;  // wall-clock ms when current player clip went on-air
let _anyEventStartMs = 0; // wall-clock ms when ANY event (incl. smpte/black/live) went on-air

function _arRow(vals) {
  let row = ' ';
  for (let i = 0; i < _AR_COLS.length; i++) {
    const v = String(vals[i] ?? '').slice(0, _AR_COLS[i]).padEnd(_AR_COLS[i]);
    row += (i < _AR_COLS.length - 1) ? v + ' ' : v;
  }
  return row + '\n';
}

function _arFmtDate(ms) {
  const d = new Date(ms);
  const p2 = n => String(n).padStart(2,'0');
  const ff = p2(Math.min(FPS-1, Math.floor((d.getMilliseconds()/1000)*FPS)));
  return `${p2(d.getDate())}/${p2(d.getMonth()+1)}/${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}:${ff}`;
}

function _arFmtDur(ms) {
  const t = Math.max(0, ms);
  const s = Math.floor(t/1000);
  const p2 = n => String(n).padStart(2,'0');
  const ff = p2(Math.min(FPS-1, Math.floor(((t%1000)/1000)*FPS)));
  return `${p2(Math.floor(s/3600))}:${p2(Math.floor((s%3600)/60))}:${p2(s%60)}:${ff}`;
}

function _arFmtTC(secVal, fps) {
  // secVal is seconds (float); returns HH:MM:SS:FF
  const f   = fps || FPS;
  const tot = Math.round((secVal || 0) * f);
  const fr  = tot % f;
  const s   = Math.floor(tot / f);
  const p2  = n => String(n).padStart(2,'0');
  return `${p2(Math.floor(s/3600))}:${p2(Math.floor((s%3600)/60))}:${p2(s%60)}:${p2(fr)}`;
}

function _arFile() {
  if (!ASRUN_ENABLED) return null;
  try { fs.mkdirSync(ASRUN_DIR, { recursive: true }); } catch {}
  const d = new Date();
  const p2 = n => String(n).padStart(2,'0');
  const date = `${d.getFullYear()}${p2(d.getMonth()+1)}${p2(d.getDate())}`;
  return path.join(ASRUN_DIR, `AsRun_${date}.txt`);
}

function _arWriteHeader(file) {
  const now = new Date();
  const p2  = n => String(n).padStart(2,'0');
  const short = dt => `${p2(dt.getDate())}/${p2(dt.getMonth()+1)}/${String(dt.getFullYear()).slice(2)} ${p2(dt.getHours())}:${p2(dt.getMinutes())}:${p2(dt.getSeconds())}`;
  const from  = new Date(now); from.setHours(4,0,0,0);
  const to    = new Date(from.getTime() + 86400000);
  const ch    = (_settings.channelName || 'PIPELINE-CONTROLLER').toUpperCase().replace(/\s+/g,'_');
  const fname = `AsRun-${ch}-${now.getFullYear()}${p2(now.getMonth()+1)}${p2(now.getDate())}.txt`;
  const sep   = ' ' + _AR_COLS.map(w => '-'.repeat(w)).join(' ');
  const hdr   = _arRow(_AR_HDRS);
  const header = `Log Output - Marina Text AsRun v1.0\nFilename: '${fname}'\nChannel: '${ch}'\nFrom: ${short(from)} to ${short(to)}\nCreated : ${short(now)}\n\n${hdr}${sep}\n`;
  fs.writeFileSync(file, header, 'utf8');
}

function _arAppend(file, row) {
  try {
    if (!fs.existsSync(file)) _arWriteHeader(file);
    fs.appendFileSync(file, row, 'utf8');
  } catch { /* non-fatal */ }
}

function _arNextKey() { return String(++_ar._key); }

function _arOnPlay(d) {
  if (!ASRUN_ENABLED) return;
  const ev = d.event || d;
  // Skip gap/idle events (smpte, black, image) — only log media events
  if (ev.source === 'smpte' || ev.source === 'black' || ev.source === 'image') return;
  if (!ev.file && !ev.title) return;
  const now = Date.now();
  if (_ar.lastPlay) _arFlushPlay(now, 'User Next');
  _ar.lastPlay = { startMs: now, event: ev };
}

function _arFlushPlay(endMs, status) {
  if (!_ar.lastPlay) return;
  const { startMs, event: ev } = _ar.lastPlay;
  _ar.lastPlay = null;
  const file = _arFile(); if (!file) return;
  const fps     = FPS;
  const som     = ev.som != null ? _arFmtTC(typeof ev.som === 'number' ? ev.som : (ev.som||0), fps) : '';
  const mediaId = path.basename(ev.file||'', path.extname(ev.file||''));
  const evType  = ev._isAsset ? 'Asset Event' : 'Media Event';
  _arAppend(file, _arRow([
    'P',
    _arFmtDate(startMs),
    _arFmtDate(endMs),
    mediaId,
    evType,
    ev.title || ev.file || '',
    som,
    ev.segmentName || ev._assetLabel || '',
    _arFmtDur(endMs - startMs),
    'Sequential',
    '',
    'Duration',
    '',
    '',
    ev.reconcileKey || _arNextKey(),
    '',
    status || 'Completed',
  ]));
}

function _arOnAssetCut(assetId, assetLabel) {
  if (!ASRUN_ENABLED) return;
  const file = _arFile(); if (!file) return;
  const now = Date.now();
  _arAppend(file, _arRow([
    'A',
    _arFmtDate(now),
    _arFmtDate(now),
    assetId.slice(0, 32),
    'Asset Cut',
    assetLabel || '',
    '',
    '',
    '00:00:00:00',
    'Immediate',
    '',
    '',
    '',
    '',
    _arNextKey(),
    '',
    'Triggered',
  ]));
}

function _arOnVo(action, slotId, file) {
  if (!ASRUN_ENABLED) return;
  const now = Date.now();
  if (action === 'playing') {
    _ar.vo.set(slotId, { startMs: now, file });
  } else if (action === 'stopped') {
    const v = _ar.vo.get(slotId);
    if (!v) return;
    _ar.vo.delete(slotId);
    const arFile = _arFile(); if (!arFile) return;
    const mediaId = path.basename(v.file || '', path.extname(v.file || ''));
    _arAppend(arFile, _arRow([
      'S',
      _arFmtDate(v.startMs),
      _arFmtDate(now),
      mediaId.slice(0, 32),
      'Voiceover',
      v.file || '',
      '',
      '',
      _arFmtDur(now - v.startMs),
      '+ParentStart',
      '00:00:00:00',
      '+ParentEnd',
      '00:00:00:00',
      '',
      _arNextKey(),
      '',
      'Completed',
    ]));
  }
}

// As-Run Record-Logging (type 'R')
const _arRec = { sessions: new Map() };
function _arOnRecord(action, d) {
  if (!ASRUN_ENABLED) return;
  const now = Date.now();
  if (action === 'start') {
    _arRec.sessions.set(d.slot, { startMs: now, outputPath: d.outputPath, videoSource: d.videoSource });
  } else if (action === 'stop') {
    const s = _arRec.sessions.get(d.slot);
    if (!s) return;
    _arRec.sessions.delete(d.slot);
    const file = _arFile(); if (!file) return;
    const mediaId = path.basename(s.outputPath || '', path.extname(s.outputPath || ''));
    _arAppend(file, _arRow([
      'R',
      _arFmtDate(s.startMs),
      _arFmtDate(now),
      mediaId.slice(0, 32),
      `Record/${s.videoSource||'pgm'}`,
      s.outputPath || '',
      '',
      '',
      _arFmtDur(now - s.startMs),
      '+ParentStart',
      '00:00:00:00',
      '+ParentEnd',
      '00:00:00:00',
      '',
      _arNextKey(),
      '',
      'Completed',
    ]));
  }
}

function _arOnGrafik(action, id, template, source) {
  if (!ASRUN_ENABLED) return;
  const now = Date.now();
  if (action === 'show') {
    _ar.grafik.set(id, { startMs: now, template, source });
  } else if (action === 'hide') {
    const g = _ar.grafik.get(id);
    if (!g) return;
    _ar.grafik.delete(id);
    const file = _arFile(); if (!file) return;
    _arAppend(file, _arRow([
      'S',
      _arFmtDate(g.startMs),
      _arFmtDate(now),
      (g.template||'').slice(0,32),
      (g.source||'Grafik').slice(0,20),
      '',
      '',
      '',
      _arFmtDur(now - g.startMs),
      '+ParentStart',
      '00:00:00:00',
      '+ParentEnd',
      '00:00:00:00',
      '',
      _arNextKey(),
      '',
      'Completed',
    ]));
  }
}

// ── Master lifecycle ───────────────────────────────────────────────────────────
let masterStarted = false;
async function ensureMaster() {
  if (masterStarted && master.running) return true;
  masterStarted = false;

  // Seeder starten: füllt interaudio-Kanäle mit Stille bevor Master startet.
  // Verhindert GStreamer-CRITICAL-Assertions durch leere interaudiosrc-Kanäle.
  // Gilt für AudioRouter- UND Legacy-Modus (Legacy: player1_audio / player2_audio).
  await Promise.all(Object.keys(players).map(startSeeder));
  // Kurz warten damit Seeder-Daten in Shared Memory verfügbar sind
  await new Promise(r => setTimeout(r, 150));

  if (!grafixEngine._running) {
    await grafixEngine.start().catch(e => log(`GrafixEngine: ${e.message}`, 'warn', 'grafik'));
  }

  log(`Master starten (videoSink=${masterOpts.videoSink||'auto'}, idleSource=${masterOpts.idleSource})`, 'info', 'master');
  const ok = await master.start();
  if (ok) {
    masterStarted = true;
    grafixEngine.masterPipeline = master;
    log('Master-Pipeline gestartet ✓', 'info', 'master');
    broadcast('state', getState());
    if (!preview.running) {
      preview.start()
        .then(() => log(`Preview-Pipeline gestartet → /tmp/bcast_preview.jpg`, 'info', 'preview'))
        .catch(e => log(`Preview fehlgeschlagen: ${e.message}`, 'warn', 'preview'));
    }
    broadcast('state', getState());
  } else {
    log(`Master-Pipeline fehlgeschlagen — kein Video, Preview bleibt schwarz`, 'error', 'master');
    log(`  Hinweis: videoSink="${masterOpts.videoSink||'autovideosink'}" prüfen (ximagesink braucht X11-Display)`, 'warn', 'master');
  }
  return ok;
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', d => b += d);
    req.on('end',  () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function json(res, data, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function serveFile(res, filePath, contentType) {
  try {
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(filePath));
  } catch {
    res.writeHead(404); res.end('Not Found');
  }
}

// ── Request handler (shared by HTTP and optional HTTPS) ────────────────────────
async function _requestHandler(req, res) {
  const url  = new URL(req.url, 'http://localhost');
  const p    = url.pathname;
  const meth = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (meth === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Auth endpoints (always accessible) ──────────────────────────────────────
  if (meth === 'POST' && p === '/api/auth/login') {
    const b = await parseBody(req);
    if (!_settings.authEnabled || !_users) return json(res, { ok: true, token: null, username: 'anonymous', roles: ['admin'] });
    const user = _users.find(u => u.username === b.username && u.password === _hashPw(b.password || ''));
    if (!user) return json(res, { error: 'Invalid credentials' }, 401);
    const token = _genToken();
    const ip = req.socket?.remoteAddress || '-';
    _sessions.set(token, { userId: user.id, username: user.username, roles: user.roles, ip });
    _userLog({ username: user.username, ip }, 'auth.login', '');
    return json(res, { ok: true, token, username: user.username, roles: user.roles });
  }
  if (meth === 'POST' && p === '/api/auth/logout') {
    const sess = _getSession(req);
    if (sess) { _sessions.delete([..._sessions.entries()].find(([,v])=>v===sess)?.[0]); _userLog(sess,'auth.logout',''); }
    return json(res, { ok: true });
  }
  if (meth === 'GET' && p === '/api/auth/me') {
    if (!_settings.authEnabled || !_users) return json(res, { authEnabled: false, username: 'anonymous', roles: ['admin'] });
    const sess = _getSession(req);
    if (!sess) return json(res, { authEnabled: true, authenticated: false });
    return json(res, { authEnabled: true, authenticated: true, username: sess.username, roles: sess.roles });
  }

  // ── User management (admin only) ─────────────────────────────────────────────
  if (p === '/api/users') {
    const sess = _requireAuth(req, res, ['admin']); if (sess === false) return;
    if (meth === 'GET') {
      return json(res, (_users || []).map(u => ({ id: u.id, username: u.username, roles: u.roles })));
    }
    if (meth === 'POST') {
      const b = await parseBody(req);
      if (!b.username || !b.password) return json(res, { error: 'username+password required' }, 400);
      const arr = _users || [];
      if (arr.find(u => u.username === b.username)) return json(res, { error: 'Username already exists' }, 409);
      const nu = { id: _genToken().slice(0,12), username: b.username, password: _hashPw(b.password), roles: b.roles || ['viewer'] };
      arr.push(nu); _users = arr; _saveUsers(arr);
      _userLog(sess, 'user.create', b.username);
      return json(res, { ok: true, id: nu.id });
    }
  }
  if (p.startsWith('/api/users/')) {
    const uid = p.slice('/api/users/'.length);
    const sess = _requireAuth(req, res, ['admin']); if (sess === false) return;
    const arr = _users || [];
    const idx = arr.findIndex(u => u.id === uid);
    if (idx === -1) return json(res, { error: 'not found' }, 404);
    if (meth === 'PUT') {
      const b = await parseBody(req);
      if (b.password) arr[idx].password = _hashPw(b.password);
      if (b.roles)    arr[idx].roles    = b.roles;
      if (b.username) arr[idx].username = b.username;
      _saveUsers(arr); _userLog(sess, 'user.update', arr[idx].username);
      return json(res, { ok: true });
    }
    if (meth === 'DELETE') {
      const name = arr[idx].username;
      arr.splice(idx, 1); _saveUsers(arr); _userLog(sess, 'user.delete', name);
      return json(res, { ok: true });
    }
  }

  // ── User log viewer ──────────────────────────────────────────────────────────
  if (meth === 'GET' && p === '/api/userlog') {
    const sess = _requireAuth(req, res, ['admin','editor']); if (sess === false) return;
    const logPath = _settings.userLogPath;
    if (!logPath || !fs.existsSync(logPath)) return json(res, { lines: [] });
    const limit = parseInt(url.searchParams.get('limit') || '200');
    const raw = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    const lines = raw.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } });
    return json(res, { lines });
  }

  // SSE
  if (p === '/events') {
    if (_settings.authEnabled && _users) {
      const sess = _getSession(req);
      if (!sess) { res.writeHead(401); res.end('Unauthorized'); return; }
    }
    const maxC = parseInt(_settings.maxClients || '0');
    if (maxC > 0 && clients.size >= maxC) {
      // Emergency Override: Admin kann ältesten Client verdrängen
      const overrideToken = url.searchParams.get('override_token') || '';
      const isAdmin = overrideToken && _sessions.get(overrideToken)?.roles?.includes('admin');
      const authDisabled = !_settings.authEnabled || !_users;
      const allowOverride = isAdmin || (authDisabled && url.searchParams.get('override') === '1');

      if (allowOverride && clients.size > 0) {
        const [oldest] = clients;
        clients.delete(oldest);
        try { oldest.write('event: kicked\ndata: {"reason":"emergency_override"}\n\n'); oldest.end(); } catch {}
        log(`SSE Override: ältester Client verdrängt (${clients.size + 1}→${clients.size} + 1 neu)`, 'warn', 'system');
      } else {
        // Browser erhält eine HTML-Seite statt rohem JSON
        const accept = req.headers['accept'] || '';
        if (accept.includes('text/html')) {
          res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
          res.end(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="15">
<title>Pipeline Controller — Max Clients</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font:14px/1.6 'Courier New',monospace;background:#111;color:#ccc;
  display:flex;align-items:center;justify-content:center;height:100vh}
.box{text-align:center;max-width:460px;padding:32px}
.h{font-size:20px;color:#f0a830;margin-bottom:16px;letter-spacing:.04em}
.info{color:#888;font-size:12px;margin-top:24px;line-height:1.8}
a{color:#5aabff;text-decoration:none}a:hover{text-decoration:underline}
.badge{display:inline-block;background:#222;border:1px solid #444;border-radius:4px;
  padding:2px 10px;font-size:13px;color:#ff9944;margin:4px 0}
</style></head><body>
<div class="box">
  <div class="h">&#9888; Maximum Clients Reached</div>
  <div>Maximale Anzahl gleichzeitiger Verbindungen erreicht.</div>
  <div class="badge">${clients.size} / ${maxC} verbunden</div>
  <div class="info">
    Seite lädt automatisch alle 15 Sekunden neu.<br><br>
    Emergency-Zugriff (Admin):
    <a href="?override=1">Override (verdrängt ältesten Client)</a>
  </div>
</div></body></html>`);
        } else {
          res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: 'max_clients', maxClients: maxC, connected: clients.size }));
        }
        return;
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write(':\n\n');
    clients.add(res);
    res.write(`event: state\ndata: ${JSON.stringify(getState())}\n\n`);
    res.write(`event: library\ndata: ${JSON.stringify(_enrichLibrary(library.getAll()))}\n\n`);
    res.write(`event: playlist\ndata: ${JSON.stringify(_enrichPlaylist(playlist.playlist))}\n\n`);
    res.write(`event: audio-config\ndata: ${JSON.stringify(audioGroupConfig.toJSON())}\n\n`);
    res.write(`event: debug-status\ndata: ${JSON.stringify({ enabled: debugger_.enabled, verbose: debugger_.verboseBus })}\n\n`);
    res.write(`event: hotkeys\ndata: ${JSON.stringify(hotkeys)}\n\n`);
    if (Object.keys(_dlSignalStatus).length)
      res.write(`event: decklink-signal\ndata: ${JSON.stringify(_dlSignalStatus)}\n\n`);
    for (const entry of logs.slice(-50)) res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
    const ka = setInterval(() => { try { res.write(':\n\n'); } catch { clearInterval(ka); } }, 15000);
    req.on('close', () => { clients.delete(res); clearInterval(ka); });
    return;
  }

  // Static UI
  if (p === '/' || p === '/index.html') return serveFile(res, path.join(__dirname, 'ui.html'), 'text/html');

  // Preview
  if (p === '/preview') {
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    preview.addClient(res); req.on('close', () => preview.removeClient(res)); return;
  }
  if (p === '/preview/frame.jpg' || p.startsWith('/preview/frame.jpg?')) {
    const buf = preview.frame;
    if (!buf) { res.writeHead(204); res.end(); return; }  // 204 No Content: img keeps last frame, no error
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache, no-store', 'Access-Control-Allow-Origin': '*' });
    res.end(buf); return;
  }

  // ── DEBUG ──────────────────────────────────────────────────────────────────
  if (meth === 'GET' && p === '/debug') {
    const out = {
      timestamp:       new Date().toISOString(),
      masterRunning:   master.running,
      masterActivePad: master.activePad,
      masterElements: {
        isel:      !!master.isel,
        fg:        !!master.fg,
        aisel_pgm: !!master.aisel_pgm,
        aisel_sec: !!master.aisel_sec,
        branding:  !!master._brandingEl,
      },
      players: Object.fromEntries(
        Object.entries(players).map(([id, pl]) => [id, { running: pl.running, cued: pl.cued, playing: pl.playing, pos: (() => { try { return pl.vPipeline?.queryPosition?.() ?? null; } catch { return null; } })() }])
      ),
    };
    try {
      const tmp = new MasterPipeline({ ...masterOpts });
      tmp.build();
      out.pipelineLines = tmp.pipelineString
        .split(/(?= intervideosrc| interaudiosrc| audiotestsrc is-live| videotestsrc is-live| input-selector name| compositor name)/)
        .map(l => l.trim());
    } catch(e) { out.pipelineError = e.message; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(out, null, 2));
    return;
  }

  // ── API ────────────────────────────────────────────────────────────────────
  if (meth === 'GET' && p === '/api/state') return json(res, getState());
  if (meth === 'GET' && p === '/api/perf')  return json(res, getPerf());

  // Master
  if (meth === 'POST' && p === '/api/master/start') return json(res, { ok: await ensureMaster(), running: master.running });
  if (meth === 'POST' && p === '/api/master/stop')  {
    await master.stop(); masterStarted = false;
    grafixEngine.masterPipeline = null;
    broadcast('state', getState());
    return json(res, { ok: true });
  }

  // Switch
  if (meth === 'POST' && p === '/api/switch') {
    const b = await parseBody(req);
    master.switchTo(parseInt(b.pad ?? b.source ?? 2));
    return json(res, { ok: true });
  }

  // Players
  if (meth === 'POST' && p === '/api/player/cue') {
    const b = await parseBody(req);
    await ensureMaster();
    const slotId = b.slotId || playlist._idleSlot || 'player1';
    const ok = await playlist.cueManual(slotId, b.file, b.som ?? 0, b.eom ?? null, b.audioConfig ?? {});
    return json(res, { ok, slotId });
  }
  if (meth === 'POST' && p === '/api/player/cut') {
    const b = await parseBody(req);
    return json(res, { ok: await playlist.cutTo(b.slotId) });
  }
  if (meth === 'POST' && p === '/api/player/stop') {
    const b = await parseBody(req);
    const pl = players[b.slotId];
    if (pl) await pl.stop();
    return json(res, { ok: !!pl });
  }

  // ── Classifications ────────────────────────────────────────────────────────
  if (meth === 'GET' && p === '/api/classifications')
    return json(res, _getClassifications());
  if (meth === 'POST' && p === '/api/classifications') {
    const sess = _requireAuth(req, res, ['editor']); if (sess === false) return;
    const b = await parseBody(req);
    if (!Array.isArray(b.classifications)) return json(res, { ok: false, error: 'array required' }, 400);
    _settings.classifications = b.classifications;
    saveSettings(_settings);
    broadcast('classifications', _getClassifications());
    return json(res, { ok: true });
  }

  // ── Asset-Panel ────────────────────────────────────────────────────────────
  if (meth === 'GET' && p === '/api/assets')
    return json(res, _assets);
  if (meth === 'POST' && p === '/api/assets') {
    const sess = _requireAuth(req, res, ['editor']); if (sess === false) return;
    const b = await parseBody(req);
    const asset = { id: b.id || genId(), label: b.label || 'Asset', color: b.color || '#6366f1',
                    icon: b.icon || '▶', events: b.events || [], returnMode: b.returnMode || 'break',
                    liveSource: b.liveSource || null };
    const idx = _assets.findIndex(a => a.id === asset.id);
    if (idx >= 0) _assets[idx] = asset; else _assets.push(asset);
    _saveAssets(_assets);
    broadcast('assets', _assets);
    return json(res, { ok: true, asset });
  }
  if (meth === 'DELETE' && p.startsWith('/api/assets/')) {
    const sess = _requireAuth(req, res, ['editor']); if (sess === false) return;
    const id = decodeURIComponent(p.slice('/api/assets/'.length));
    _assets = _assets.filter(a => a.id !== id);
    _saveAssets(_assets);
    broadcast('assets', _assets);
    return json(res, { ok: true });
  }
  if (meth === 'POST' && p.startsWith('/api/assets/') && p.endsWith('/cut')) {
    const sess = _requireAuth(req, res, ['editor','operator']); if (sess === false) return;
    const id = decodeURIComponent(p.slice('/api/assets/'.length, -'/cut'.length));
    const b  = await parseBody(req);
    await ensureMaster();
    const result = _assetCut(id, b.returnMode);
    return json(res, result);
  }
  if (meth === 'GET' && p === '/api/assets/state')
    return json(res, _assetStatePublic());
  if (meth === 'POST' && p === '/api/assets/quickcut') {
    const sess = _requireAuth(req, res, ['editor','operator']); if (sess === false) return;
    const b = await parseBody(req);
    await ensureMaster();
    return json(res, _quickCut(b.source || 'black', b));
  }
  if (meth === 'POST' && p === '/api/assets/return') {
    const sess = _requireAuth(req, res, ['editor','operator']); if (sess === false) return;
    if (!_assetState.active) return json(res, { ok: false, error: 'Kein aktiver Asset' });
    const savedReturnMode  = _assetState.returnMode;
    const savedReturnId    = _assetState.returnEventId;
    const savedReturnSom   = _assetState.returnSom;
    _assetState.active = false;
    _assetCleanupInserted();
    if (savedReturnMode === 'interrupt' && savedReturnId) {
      const newPl  = playlist.playlist;
      const retIdx = newPl.findIndex(ev2 => ev2.id === savedReturnId);
      if (retIdx >= 0) {
        newPl[retIdx] = { ...newPl[retIdx], som: savedReturnSom };
        playlist.set(newPl);
        setTimeout(() => playlist.jump(retIdx).catch(() => {}), 50);
      }
    }
    broadcast('asset-state', _assetStatePublic());
    return json(res, { ok: true });
  }

  // ── Record API ─────────────────────────────────────────────────────────────
  if (meth === 'GET' && p === '/api/record/status')
    return json(res, recordEngine.getStatus());
  if (meth === 'POST' && p === '/api/record/start') {
    const sess = _requireAuth(req, res, ['editor','operator']); if (sess === false) return;
    const b = await parseBody(req);
    const slot = (!b.slot || b.slot === 'auto') ? recordEngine._pickFreeSlot() : b.slot;
    const outPath = recordEngine.start(slot, b);
    return json(res, { ok: true, slot, outputPath: outPath });
  }
  if (meth === 'POST' && p === '/api/record/stop') {
    const sess = _requireAuth(req, res, ['editor','operator']); if (sess === false) return;
    const b = await parseBody(req);
    recordEngine.stop(b.slot || 'rec1', !!b.force);
    return json(res, { ok: true });
  }
  if (meth === 'POST' && p === '/api/record/stop-all') {
    const sess = _requireAuth(req, res, ['editor','operator']); if (sess === false) return;
    recordEngine.stopAll();
    return json(res, { ok: true });
  }
  if (meth === 'POST' && p === '/api/record/settings') {
    const sess = _requireAuth(req, res, ['editor']); if (sess === false) return;
    const b = await parseBody(req);
    if (b.recordDir != null) {
      const oldDir = recordEngine._recordDir;
      _settings.recordDir = b.recordDir;
      recordEngine._recordDir = b.recordDir;
      if (RECORD_IN_LIBRARY) {
        library.removeExtraDir(oldDir);
        library.addExtraDir(b.recordDir, 'rec');
        library.scan();
      }
    }
    if (b.recordAudioGroups && Array.isArray(b.recordAudioGroups) && b.recordAudioGroups.length) {
      _settings.recordAudioGroups = b.recordAudioGroups;
      recordEngine._audioGroups   = b.recordAudioGroups;
    } else if (b.recordAudioGroup) {
      _settings.recordAudioGroups = [b.recordAudioGroup];
      recordEngine._audioGroups   = [b.recordAudioGroup];
    }
    if (b.recordSlots && Array.isArray(b.recordSlots) && b.recordSlots.length) { _settings.recordSlots = b.recordSlots; recordEngine._slotPool = b.recordSlots; }
    if (b.recordIncludeInLibrary != null) {
      RECORD_IN_LIBRARY = !!b.recordIncludeInLibrary;
      _settings.recordIncludeInLibrary = RECORD_IN_LIBRARY;
      if (RECORD_IN_LIBRARY) {
        library.addExtraDir(recordEngine._recordDir, 'rec');
        library.scan();
      } else {
        library.removeExtraDir(recordEngine._recordDir);
      }
      broadcast('library', _enrichLibrary(library.getAll()));
    }
    saveSettings(_settings);
    return json(res, { ok: true });
  }

  // ── Plugin-API ─────────────────────────────────────────────────────────────
  if (meth === 'GET'  && p === '/api/plugins')
    return json(res, pluginHost.getAll());

  if (meth === 'POST' && /^\/api\/plugins\/[^/]+\/config$/.test(p)) {
    const id = p.split('/')[3];
    const b  = await parseBody(req);
    try { await pluginHost.setConfig(id, b); return json(res, { ok: true }); }
    catch (e) { return json(res, { ok: false, error: e.message }, 400); }
  }

  if (meth === 'POST' && /^\/api\/plugins\/[^/]+\/enable$/.test(p)) {
    const id = p.split('/')[3];
    const b  = await parseBody(req);
    try { await pluginHost.setEnabled(id, !!b.enabled); return json(res, { ok: true }); }
    catch (e) { return json(res, { ok: false, error: e.message }, 400); }
  }

  // ── Filesystem helpers for plugin dir picker ──────────────────────────────
  if (meth === 'GET' && p === '/api/fs/validate-dir') {
    const dir = url.searchParams.get('path') || '';
    if (!dir) return json(res, { valid: false });
    try { return json(res, { valid: fs.statSync(dir).isDirectory() }); }
    catch { return json(res, { valid: false }); }
  }

  if (meth === 'GET' && p === '/api/fs/dirs') {
    const dir = url.searchParams.get('path') || '/';
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => { try { return e.isDirectory() || (e.isSymbolicLink() && fs.statSync(path.join(dir, e.name)).isDirectory()); } catch { return false; } })
        .map(e => e.name).sort();
      return json(res, { ok: true, path: dir, dirs: entries });
    } catch (e) {
      return json(res, { ok: false, error: e.message, dirs: [] });
    }
  }

  // Playlist control
  if (meth === 'POST' && p === '/api/playlist/playnext') {
    const sess = _requireAuth(req, res, ['editor','operator']); if (sess === false) return;
    _userLog(sess, 'playlist.next', '');
    await playlist.playNext(); return json(res, { ok: true });
  }
  if (meth === 'GET'  && p === '/api/playlist')           return json(res, playlist.playlist);
  if (meth === 'POST' && p === '/api/playlist/set') {
    const sess = _requireAuth(req, res, ['editor']); if (sess === false) return;
    const b = await parseBody(req);
    const evts = Array.isArray(b) ? b : (b.events || b.playlist || []);
    _userLog(sess, 'playlist.set', `${evts.length} events`);
    _suppressPlaylistUpdatedBroadcast += 2; // set() emits updated 1-2× before adaptation runs
    playlist.set(evts);
    _revalidateDurations();
    const validation = playlist.validate();
    broadcast('playlist', _enrichPlaylist(playlist.playlist)); // broadcast with adapted values
    _autoSavePlaylist();
    return json(res, { ok: true, validation, events: playlist.playlist });
  }
  if (meth === 'POST' && p === '/api/playlist/start') {
    const sess = _requireAuth(req, res, ['editor','operator']); if (sess === false) return;
    _userLog(sess, 'playlist.play', '');
    const b = await parseBody(req); await ensureMaster();
    await playlist.startCueFirst(parseInt(b.from ?? 0));
    return json(res, { ok: true });
  }
  if (meth === 'POST' && p === '/api/playlist/onair-preset') {
    const sess = _requireAuth(req, res, ['editor','operator']); if (sess === false) return;
    const b = await parseBody(req);
    const presetId = b.preset;
    if (!presetId) return json(res, { ok: false, error: 'preset required' }, 400);
    const slotId = playlist._onAirSlot;
    if (!slotId || !players[slotId]?.playing) return json(res, { ok: false, error: 'kein Player on-air' }, 400);
    const ok = await playlist.swapOnAirVariant({ audioPreset: presetId }).catch(e => { log(`onair-preset: ${e.message}`, 'warn', 'playlist'); return false; });
    if (ok) {
      log(`On-Air Audio-Preset → ${presetId} (${playlist._onAirSlot})`, 'info', 'playlist');
      broadcast('onair-preset', { preset: presetId, slotId: playlist._onAirSlot });
    }
    return json(res, { ok });
  }
  if (meth === 'POST' && p === '/api/playlist/onair-afd') {
    const sess = _requireAuth(req, res, ['editor','operator']); if (sess === false) return;
    const b = await parseBody(req);
    const afd = b.afd;
    if (!afd) return json(res, { ok: false, error: 'afd required' }, 400);
    const slotId = playlist._onAirSlot;
    if (!slotId || !players[slotId]?.playing) return json(res, { ok: false, error: 'kein Player on-air' }, 400);
    const ok = await playlist.swapOnAirVariant({ afd }).catch(e => { log(`onair-afd: ${e.message}`, 'warn', 'playlist'); return false; });
    if (ok) {
      log(`On-Air AFD → ${afd} (${playlist._onAirSlot})`, 'info', 'playlist');
      broadcast('onair-afd', { afd, slotId: playlist._onAirSlot });
    }
    return json(res, { ok });
  }

  if (meth === 'POST' && p === '/api/playlist/stop') {
    const sess = _requireAuth(req, res, ['editor','operator']); if (sess === false) return;
    _userLog(sess, 'playlist.stop', '');
    await playlist.stop(); return json(res, { ok: true });
  }
  if (meth === 'POST' && p === '/api/playlist/jump')      { const b = await parseBody(req); await playlist.jump(parseInt(b.index ?? 0)); return json(res, { ok: true }); }
  if (meth === 'POST' && p === '/api/playlist/forcejump') { const b = await parseBody(req); await playlist.forceJump(parseInt(b.index ?? 0)); return json(res, { ok: true }); }
  if (meth === 'POST' && p === '/api/playlist/validate') return json(res, playlist.validate());
  if (meth === 'POST' && p === '/api/playlist/insert') {
    const sess = _requireAuth(req, res, ['editor']); if (sess === false) return;
    const b = await parseBody(req);
    if (!Array.isArray(b.events)) return json(res, { ok: false, error: 'events required' });
    _userLog(sess, 'playlist.insert', `${b.events.length} events at index ${b.index ?? '?'}`);
    const arr = [...playlist.playlist];
    arr.splice(Math.max(0, Math.min(b.index ?? arr.length, arr.length)), 0,
      ...b.events.map(ev => ({ ...ev, id: ev.id || genId() })));
    playlist.set(arr);
    return json(res, { ok: true, events: playlist.playlist });
  }

  // Playlists CRUD
  if (meth === 'GET' && p === '/api/playlists') {
    return json(res, fs.readdirSync(PLAYLISTS_DIR).filter(f => f.endsWith('.json')).map(f => ({ name: f.replace('.json',''), file: f })));
  }
  if (meth === 'POST' && p === '/api/playlists/save') {
    const sess = _requireAuth(req, res, ['editor']); if (sess === false) return;
    const b = await parseBody(req);
    const name = (b.name||'playlist').replace(/[^a-zA-Z0-9_. -]/g, '_');
    fs.writeFileSync(path.join(PLAYLISTS_DIR, name+'.json'), JSON.stringify({ name, events: playlist.playlist }, null, 2));
    log(`Playlist gespeichert: ${name}`, 'info', 'system');
    _userLog(sess, 'playlist.save', name);
    return json(res, { ok: true, name });
  }
  if (meth === 'POST' && p === '/api/import/marina') {
    const sess = _requireAuth(req, res, ['editor']); if (sess === false) return;
    try {
      const { parseMarina } = require('./lib/MarinaParser');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const xmlString = Buffer.concat(chunks).toString('utf8');
      const events = parseMarina(xmlString);
      log(`📥 Marina-Import: ${events.length} Events`, 'info', 'system');
      return json(res, { ok: true, events });
    } catch (e) {
      log(`Marina-Import Fehler: ${e.message}`, 'warn', 'system');
      return json(res, { ok: false, error: e.message }, 400);
    }
  }
  if (meth === 'POST' && p === '/api/playlists/save-events') {
    const sess = _requireAuth(req, res, ['editor']); if (sess === false) return;
    const b = await parseBody(req);
    const name = (b.name||'playlist').replace(/[^a-zA-Z0-9_. -]/g, '_');
    if (!Array.isArray(b.events)) return json(res, { ok: false, error: 'events required' }, 400);
    fs.writeFileSync(path.join(PLAYLISTS_DIR, name+'.json'), JSON.stringify({ name, events: b.events }, null, 2));
    return json(res, { ok: true, name });
  }
  if (meth === 'POST' && p === '/api/playlists/load') {
    const sess = _requireAuth(req, res, ['editor']); if (sess === false) return;
    const b = await parseBody(req);
    const fp = path.join(PLAYLISTS_DIR, b.name+'.json');
    if (!fs.existsSync(fp)) return json(res, { ok: false, error: 'not found' }, 404);
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const events = data.events || data || [];
    if (b.apply) { playlist.set(events); log(`Playlist angewandt: ${b.name}`, 'info', 'system'); _userLog(sess,'playlist.load',b.name); }
    return json(res, { ok: true, events });
  }
  if (meth === 'POST' && p === '/api/playlists/append') {
    const sess = _requireAuth(req, res, ['editor']); if (sess === false) return;
    const b = await parseBody(req);
    const fp = path.join(PLAYLISTS_DIR, (b.name||'')+'.json');
    if (!fs.existsSync(fp)) return json(res, { ok: false, error: 'Not found' });
    const incoming = (JSON.parse(fs.readFileSync(fp, 'utf8')).events||[]).map(ev => ({ ...ev, id: genId() }));
    playlist.set([...playlist.playlist, ...incoming]);
    _userLog(sess, 'playlist.append', b.name);
    return json(res, { ok: true, events: playlist.playlist });
  }
  if (meth === 'DELETE' && p.startsWith('/api/playlists/')) {
    const sess = _requireAuth(req, res, ['editor']); if (sess === false) return;
    const name = decodeURIComponent(p.slice('/api/playlists/'.length));
    const fp = path.join(PLAYLISTS_DIR, name+'.json');
    if (fs.existsSync(fp)) { fs.unlinkSync(fp); log(`Playlist gelöscht: ${name}`, 'info', 'system'); _userLog(sess,'playlist.delete',name); }
    return json(res, { ok: true });
  }

  // Branding
  if (meth === 'GET' && p === '/api/branding') {
    const dir = path.join(__dirname, 'channelbranding');
    try { fs.mkdirSync(dir,{recursive:true}); return json(res, fs.readdirSync(dir).filter(f => /\.(png|jpg|svg)$/i.test(f))); }
    catch { return json(res, []); }
  }
  if (meth === 'POST' && p === '/api/branding/set') {
    const b = await parseBody(req); if (!b.file) return json(res, { ok: false, error: 'file required' });
    master.setBranding(b.file, true); return json(res, { ok: true, file: b.file });
  }
  if (meth === 'POST' && p === '/api/branding/off') { master.setBranding(null); return json(res, { ok: true }); }

  // ── Voiceover API ──────────────────────────────────────────────────────────
  if (meth === 'GET' && p === '/api/voiceover/config') {
    return json(res, { fadeInMs: _settings.voFadeInMs ?? 500, fadeOutMs: _settings.voFadeOutMs ?? 1000 });
  }
  if (meth === 'GET' && p === '/api/voiceover/presets') {
    return json(res, voiceoverEngine._presets);
  }
  if (meth === 'POST' && p === '/api/voiceover/presets') {
    const b = await parseBody(req);
    if (b.presets && typeof b.presets === 'object') {
      voiceoverEngine._presets = Object.assign({}, VoiceoverEngine.defaultPresets(), b.presets);
      _settings.voPresets = b.presets;
      saveSettings(_settings);
    }
    return json(res, { ok: true });
  }
  if (meth === 'POST' && p === '/api/voiceover/play') {
    const sess = _requireAuth(req, res, ['editor']); if (sess === false) return;
    const b = await parseBody(req);
    if (!b.file) return json(res, { ok: false, error: 'file required' }, 400);
    const absPath = path.join(MEDIA_DIR, b.file);
    if (!fs.existsSync(absPath)) return json(res, { ok: false, error: `File not found: ${b.file}` }, 404);
    const eng = voEngines[b.slotId || 'vo1'] || voiceoverEngine;
    await eng.play({ filePath: absPath, preset: b.preset, durationMs: b.durationMs });
    return json(res, { ok: true });
  }
  if (meth === 'POST' && p === '/api/voiceover/stop') {
    const sess = _requireAuth(req, res, ['editor']); if (sess === false) return;
    const b = await parseBody(req);
    const eng = voEngines[(b?.slotId) || 'vo1'] || voiceoverEngine;
    await eng.stop();
    return json(res, { ok: true });
  }
  if (meth === 'POST' && p === '/api/voiceover/config') {
    const sess = _requireAuth(req, res, ['admin']); if (sess === false) return;
    const b = await parseBody(req);
    if (b.fadeInMs  != null) { _settings.voFadeInMs  = parseInt(b.fadeInMs);  voiceoverEngine._fadeInMs  = _settings.voFadeInMs; }
    if (b.fadeOutMs != null) { _settings.voFadeOutMs = parseInt(b.fadeOutMs); voiceoverEngine._fadeOutMs = _settings.voFadeOutMs; }
    saveSettings(_settings);
    return json(res, { ok: true, fadeInMs: _settings.voFadeInMs, fadeOutMs: _settings.voFadeOutMs });
  }

  // Config
  if (meth === 'GET'  && p === '/api/config') {
    return json(res, {
      mediaDir:     MEDIA_DIR,
      playlistsDir: PLAYLISTS_DIR,
      grafixDir:    GRAFIK_DIR,
      asRunDir:     ASRUN_DIR,
      asRunEnabled: ASRUN_ENABLED,
      width:        masterOpts.width  || W,
      height:       masterOpts.height || H,
      fps:          masterOpts.fps    || FPS,
      videoSink:    masterOpts.videoSink || 'autovideosink',
      audioSink:    masterOpts.audioSink || 'pulsesink',
      idleSource:   masterOpts.idleSource || 'smpte',
      idleImagePath: masterOpts.idleImagePath || null,
      idleImageName: masterOpts.idleImagePath ? path.basename(masterOpts.idleImagePath) : null,
      numPlayers:        _numPlayers,
      numVoSlots:        _settings.numVoSlots || 2,
      slotIds:           _slotIds,
      backupSlot:        _settings.backupSlot       || null,
      backupMediaDirs:   _settings.backupMediaDirs  || [],
      transitionSpeeds:  _settings.transitionSpeeds || { fast: 500, medium: 1000, slow: 2000 },
      scaleMode:         masterOpts.scaleMode        || 'fit',
      scaleMethod:       masterOpts.scaleMethod      ?? 1,
      deinterlaceMode:   masterOpts.deinterlaceMode  || 'auto',
      stillSlots:        Math.max(0, Math.min(9, parseInt(_settings.stillSlots ?? 2))),
      maxClients:        parseInt(_settings.maxClients || '0') || 0,
      videoDelayMs:      _settings.videoDelayMs      ?? 0,
      audioDelayMs:      _settings.audioDelayMs      || {},
    });
  }
  if (meth === 'GET'  && p === '/api/config/sinks') {
    return json(res, { current: masterOpts.videoSink||'autovideosink', available: ['autovideosink','fakesink','ximagesink','xvimagesink','glimagesink'] });
  }
  if (meth === 'POST' && p === '/api/config/sink') {
    const b = await parseBody(req); if (!b.sink) return json(res, { ok: false, error: 'sink required' }, 400);
    masterOpts.videoSink = b.sink; _settings.videoSink = b.sink; saveSettings(_settings);
    await master.stop(); await ensureMaster(); return json(res, { ok: true, sink: b.sink });
  }
  if (meth === 'POST' && p === '/api/config/audiosink') {
    const b = await parseBody(req); if (!b.sink) return json(res, { ok: false, error: 'sink required' }, 400);
    masterOpts.audioSink = b.sink; _settings.audioSink = b.sink; saveSettings(_settings);
    await master.stop(); masterStarted = false; await ensureMaster();
    return json(res, { ok: true, sink: b.sink });
  }
  if (meth === 'POST' && p === '/api/config/format') {
    const b = await parseBody(req);
    if (b.format) { const f = MasterPipeline.parseFormat(b.format); Object.assign(masterOpts, { width: f.w, height: f.h, fps: f.fps }); }
    else { if (b.width) masterOpts.width=parseInt(b.width); if (b.height) masterOpts.height=parseInt(b.height); if (b.fps) masterOpts.fps=parseInt(b.fps); }
    Object.assign(_settings, { width: masterOpts.width, height: masterOpts.height, fps: masterOpts.fps });
    saveSettings(_settings);
    // GrafixEngine auf neue Auflösung bringen bevor Master neu startet
    grafixEngine.setFormat(masterOpts.width, masterOpts.height, masterOpts.fps).catch(() => {});
    await master.stop(); masterStarted = false;
    return json(res, { ok: await ensureMaster(), config: masterOpts });
  }
  if (meth === 'POST' && p === '/api/config/conversion') {
    const b = await parseBody(req);
    const SCALE_MODES   = ['fit','crop','stretch'];
    const DEINT_MODES   = ['auto','always','never'];
    const SCALE_METHODS = [0,1,2,3,4,5];
    if (b.scaleMode       !== undefined && SCALE_MODES.includes(b.scaleMode))   { masterOpts.scaleMode      = b.scaleMode;      _settings.scaleMode      = b.scaleMode; }
    if (b.scaleMethod     !== undefined && SCALE_METHODS.includes(+b.scaleMethod)) { masterOpts.scaleMethod  = +b.scaleMethod;   _settings.scaleMethod    = +b.scaleMethod; }
    if (b.deinterlaceMode !== undefined && DEINT_MODES.includes(b.deinterlaceMode)) { masterOpts.deinterlaceMode = b.deinterlaceMode; _settings.deinterlaceMode = b.deinterlaceMode; }
    saveSettings(_settings);
    await master.stop(); masterStarted = false;
    return json(res, { ok: await ensureMaster(), config: { scaleMode: masterOpts.scaleMode, scaleMethod: masterOpts.scaleMethod, deinterlaceMode: masterOpts.deinterlaceMode } });
  }
  if (meth === 'POST' && p === '/api/config/numplayers') {
    const b = await parseBody(req);
    const n = Math.max(1, Math.min(8, parseInt(b.numPlayers || '2')));
    _settings.numPlayers = n; saveSettings(_settings);
    return json(res, { ok: true, numPlayers: n, restart: true });
  }
  if (meth === 'POST' && p === '/api/config/numvoslots') {
    const b = await parseBody(req);
    const n = Math.max(1, Math.min(4, parseInt(b.numVoSlots || '2')));
    _settings.numVoSlots = n; saveSettings(_settings);
    return json(res, { ok: true, numVoSlots: n, restart: true });
  }
  if (meth === 'POST' && p === '/api/config/transitionspeeds') {
    const b = await parseBody(req);
    const speeds = {};
    if (b.fast   > 0) speeds.fast   = Math.max(100, Math.min(10000, parseInt(b.fast)));
    if (b.medium > 0) speeds.medium = Math.max(100, Math.min(20000, parseInt(b.medium)));
    if (b.slow   > 0) speeds.slow   = Math.max(100, Math.min(30000, parseInt(b.slow)));
    _settings.transitionSpeeds = Object.assign(_settings.transitionSpeeds || {}, speeds);
    saveSettings(_settings);
    transitionEngine.setSpeeds(_settings.transitionSpeeds);
    return json(res, { ok: true, transitionSpeeds: _settings.transitionSpeeds });
  }
  if (meth === 'POST' && p === '/api/config/backup') {
    const b = await parseBody(req);
    const slot = b.backupSlot || null;
    const dirs = Array.isArray(b.backupMediaDirs) ? b.backupMediaDirs.filter(d => typeof d === 'string' && d.trim()) : [];
    _settings.backupSlot      = slot;
    _settings.backupMediaDirs = dirs;
    playlist._backupSlot      = slot;
    playlist._backupMediaDirs = dirs;
    saveSettings(_settings);
    return json(res, { ok: true, backupSlot: slot, backupMediaDirs: dirs });
  }
  if (meth === 'POST' && p === '/api/config/idle') {
    const b = await parseBody(req);
    if (b.source) {
      masterOpts.idleSource = b.source;
      master.setIdleSource?.(b.source);
      playlist.opts.idleSource = b.source;
      _settings.idleSource = b.source;
    }
    if (b.imagePath) {
      const resolved = resolveIdleImage(b.imagePath);
      if (!resolved) {
        return json(res, { ok: false, error: `Bild nicht gefunden: ${b.imagePath} (gesucht in images/, channelbranding/)` }, 404);
      }
      masterOpts.idleImagePath = resolved;
      _settings.idleImagePath  = b.imagePath;  // Originalnamen speichern, nicht den absoluten Pfad
    }
    saveSettings(_settings);
    // Neustart damit Idle-Bild / -Quelle sofort wirksam wird
    if (!playlist.running) {
      await master.stop(); masterStarted = false; await ensureMaster();
    } else {
      // Playlist läuft: nur isel umschalten auf neuen Idle wenn gerade Idle aktiv
      const N = _slotIds.length;
      const idlePad = ({ smpte: N, black: N+1, image: N+2 })[masterOpts.idleSource] ?? N;
      if (master.activePad >= N && master.activePad <= N+2) master.switchTo(idlePad);
    }
    return json(res, { ok: true, idleSource: masterOpts.idleSource, idleImagePath: masterOpts.idleImagePath });
  }

  // ── Paths + As-Run config ──────────────────────────────────────────────────
  if (meth === 'GET' && p === '/api/config/paths') {
    return json(res, {
      mediaDir:        MEDIA_DIR,
      playlistsDir:    PLAYLISTS_DIR,
      grafixDir:       GRAFIK_DIR,
      asRunDir:        ASRUN_DIR,
      asRunEnabled:    ASRUN_ENABLED,
      channelName:     _settings.channelName || '',
      durationMismatch:      _settings.durationMismatch || 'warn',
      defaultStartTimecode:  _settings.defaultStartTimecode || '00:00:00:00',
      prepKeepReconcile:     !!_settings.prepKeepReconcile,
      userLogPath:           _settings.userLogPath || '',
      authEnabled:     !!_settings.authEnabled,
      missingBehavior: _settings.missingBehavior || 'skip',
      defaultEvent:    _settings.defaultEvent || null,
    });
  }
  if (meth === 'POST' && p === '/api/config/paths') {
    const sess = _requireAuth(req, res, ['admin']); if (sess === false) return;
    const b = await parseBody(req);
    let restartHint = false;
    if (b.mediaDir     !== undefined) { _settings.mediaDir     = b.mediaDir;     MEDIA_DIR     = b.mediaDir;     restartHint = true; }
    if (b.playlistsDir !== undefined) { _settings.playlistsDir = b.playlistsDir; PLAYLISTS_DIR = b.playlistsDir; restartHint = true; }
    if (b.grafixDir    !== undefined) { _settings.grafixDir    = b.grafixDir;    GRAFIK_DIR    = b.grafixDir;    restartHint = true; }
    if (b.asRunDir     !== undefined) { _settings.asRunDir     = b.asRunDir;     ASRUN_DIR     = b.asRunDir; }
    if (b.asRunEnabled !== undefined) { _settings.asRunEnabled = !!b.asRunEnabled; ASRUN_ENABLED = !!b.asRunEnabled; }
    if (b.channelName  !== undefined) { _settings.channelName  = b.channelName; }
    if (b.durationMismatch     !== undefined) { _settings.durationMismatch     = b.durationMismatch; }
    if (b.defaultStartTimecode !== undefined) { _settings.defaultStartTimecode = b.defaultStartTimecode; }
    if (b.prepKeepReconcile    !== undefined) { _settings.prepKeepReconcile    = !!b.prepKeepReconcile; }
    if (b.userLogPath  !== undefined) { _settings.userLogPath  = b.userLogPath; }
    if (b.authEnabled  !== undefined) { _settings.authEnabled  = !!b.authEnabled; }
    if (b.missingBehavior !== undefined && ['skip','idle'].includes(b.missingBehavior)) {
      _settings.missingBehavior = b.missingBehavior;
      playlist.opts.missingBehavior = b.missingBehavior;
    }
    if (b.defaultEvent !== undefined && b.defaultEvent && typeof b.defaultEvent === 'object') {
      _settings.defaultEvent = {
        somMode:         b.defaultEvent.somMode || 'user',
        endType:         b.defaultEvent.endType || 'sequential',
        transition:      b.defaultEvent.transition || 'cut',
        transitionSpeed: b.defaultEvent.transitionSpeed || 'fast',
        branding:        b.defaultEvent.branding || null,
      };
    }
    saveSettings(_settings);
    _userLog(sess, 'config.save', '');
    return json(res, { ok: true, restartRequired: restartHint });
  }

  // ── Library Segments API ───────────────────────────────────────────────────
  if (meth === 'GET' && p.startsWith('/api/library/') && p.endsWith('/segments')) {
    const file = decodeURIComponent(p.slice('/api/library/'.length, -'/segments'.length));
    return json(res, _segments[file] || []);
  }
  if (meth === 'POST' && p.startsWith('/api/library/') && p.endsWith('/segments')) {
    const file = decodeURIComponent(p.slice('/api/library/'.length, -'/segments'.length));
    const b = await parseBody(req);
    if (!Array.isArray(b.segments)) return json(res, { ok: false, error: 'segments array required' }, 400);
    _segments[file] = b.segments;
    saveSegments(_segments);
    return json(res, { ok: true });
  }

  // ── Audio API ──────────────────────────────────────────────────────────────
  if (meth === 'GET' && p === '/api/audio/config') {
    return json(res, audioGroupConfig.toJSON());
  }
  if (meth === 'POST' && p === '/api/audio/clock') {
    const b = await parseBody(req);
    if (!b.provider) return json(res, { ok: false, error: 'provider required' }, 400);
    audioGroupConfig.setClock(b);
    broadcast('audio-config', audioGroupConfig.toJSON());
    return json(res, { ok: true, clock: audioGroupConfig.clock });
  }
  // ── Still / Freeze Endpoints ────────────────────────────────────────────────
  if (meth === 'GET' && p === '/api/still/state') {
    return json(res, _stillPublicState());
  }
  if (p.startsWith('/api/still/') && p.endsWith('/frame') && meth === 'GET') {
    const slot = parseInt(p.split('/')[3]);
    const s = _stillSlots[slot];
    if (!s?.frameData) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' });
    res.end(s.frameData);
    return;
  }
  if (p.startsWith('/api/still/') && p.endsWith('/capture') && meth === 'POST') {
    const sess = _requireAuth(req, res, ['grafiker','editor','operator']); if (sess === false) return;
    const slot = parseInt(p.split('/')[3]);
    try { await _stillCapture(slot); return json(res, { ok: true, slot }); }
    catch(e) { return json(res, { ok: false, error: e.message }, 400); }
  }
  if (p.startsWith('/api/still/') && p.endsWith('/toggle') && meth === 'POST') {
    const sess = _requireAuth(req, res, ['grafiker','editor','operator']); if (sess === false) return;
    const slot = parseInt(p.split('/')[3]);
    const s = _stillSlots[slot];
    if (!s) return json(res, { ok: false, error: 'invalid slot' }, 400);
    try {
      if (s.active) _stillDeactivate(slot);
      else          await _stillActivate(slot);
      return json(res, { ok: true, slot, active: s.active });
    } catch(e) { return json(res, { ok: false, error: e.message }, 400); }
  }

  if (meth === 'POST' && p === '/api/preview/active') {
    const b = await parseBody(req);
    if (b.active) {
      if (!preview.running) preview.start().catch(e => log(`Preview: ${e.message}`, 'warn', 'preview'));
    } else {
      if (preview.running) preview.stop().catch(() => {});
    }
    return json(res, { ok: true, active: b.active });
  }
  if (meth === 'GET' && p === '/api/audio/dolbye') {
    let available = false;
    try { require('child_process').execSync('gst-inspect-1.0 dolbydec 2>/dev/null', {timeout:3000}); available = true; } catch {}
    if (!available) try { require('child_process').execSync('gst-inspect-1.0 dolbye 2>/dev/null', {timeout:3000}); available = 'dolbye'; } catch {}
    return json(res, { available: !!available, element: available === 'dolbye' ? 'dolbye' : available ? 'dolbydec' : null });
  }
  if (meth === 'POST' && p === '/api/audio/groups') {
    const b = await parseBody(req);
    if (!Array.isArray(b.groups)) return json(res, { ok: false, error: 'groups required' }, 400);
    audioGroupConfig.setGroups(b.groups);
    library.setAudioConfig(audioGroupConfig.groups, audioGroupConfig.presets);
    broadcast('audio-config', audioGroupConfig.toJSON());
    return json(res, { ok: true, groups: audioGroupConfig.groups });
  }
  if (meth === 'GET' && p === '/api/audio/presets') {
    return json(res, audioGroupConfig.presets);
  }
  if (meth === 'POST' && p === '/api/audio/presets') {
    const b = await parseBody(req);
    if (!b.id || !b.preset) return json(res, { ok: false, error: 'id + preset required' }, 400);
    audioGroupConfig.setPreset(b.id, b.preset);
    broadcast('audio-config', audioGroupConfig.toJSON());
    return json(res, { ok: true });
  }
  if (meth === 'DELETE' && p.startsWith('/api/audio/presets/')) {
    const id = decodeURIComponent(p.slice('/api/audio/presets/'.length));
    audioGroupConfig.deletePreset(id);
    broadcast('audio-config', audioGroupConfig.toJSON());
    return json(res, { ok: true });
  }

  if (meth === 'POST' && p.startsWith('/api/audio/r128/')) {
    const groupId = decodeURIComponent(p.slice('/api/audio/r128/'.length));
    const b = await parseBody(req);
    const ok = audioGroupConfig.setGroupR128(groupId, b);
    if (!ok) return json(res, { ok: false, error: 'group not found' }, 404);
    broadcast('audio-config', audioGroupConfig.toJSON());
    return json(res, { ok: true });
  }

  // Library
  if (meth === 'GET'  && p === '/api/library')      return json(res, _enrichLibrary(library.getAll()));
  if (meth === 'POST' && p === '/api/library/scan') return json(res, { ok: true, newFiles: await library.scan() });
  if (meth === 'POST' && p.startsWith('/api/library/') && p.endsWith('/rescan')) {
    const file = decodeURIComponent(p.slice('/api/library/'.length, -'/rescan'.length));
    library.reanalyzeFile(file).catch(()=>{});
    return json(res, { ok: true });
  }
  if (meth === 'POST' && p === '/api/library/cleanup') {
    const all = library.getAll();
    let removed = 0;
    for (const entry of all) {
      const fp = path.join(library.mediaDir, entry.fileName);
      if (!fs.existsSync(fp)) { delete library.library[entry.fileName]; removed++; }
    }
    if (removed) { library.save(); broadcast('library', _enrichLibrary(library.getAll())); }
    return json(res, { ok: true, removed });
  }

  // Images
  if (meth === 'GET' && p === '/api/images') {
    try { return json(res, fs.readdirSync(IMAGES_DIR).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f)).map(f => ({ name: f }))); }
    catch { return json(res, []); }
  }

  // Devices
  if (meth === 'GET' && p === '/api/devices') {
    const { execSync } = require('child_process'); const devices = [];
    try { execSync('ls /dev/video* 2>/dev/null',{timeout:2000}).toString().trim().split('\n').filter(Boolean)
      .forEach((dev,i) => devices.push({ id:`v4l2-${i}`, type:'v4l2', path:dev, name:dev, gstSrc:`v4l2src device=${dev}` })); } catch {}
    return json(res, devices);
  }

  // ── Grafik API ─────────────────────────────────────────────────────────────
  // Returns approximate seconds remaining in the current on-air clip.
  // Used as context for playlist-variable resolution (countdown / starttime).
  function _clipRemainingSec() {
    try {
      const curIdx = playlist.currentIndex ?? 0;
      const curEv  = playlist.playlist?.[curIdx];
      if (!curEv || !_ar.lastPlay) return 0;
      const elapsed = (Date.now() - _ar.lastPlay.startMs) / 1000;
      // Try live position from GStreamer first (most accurate)
      const onAirPlayer = playlist._onAirSlot ? playlist.players?.[playlist._onAirSlot] : null;
      const gstPos = onAirPlayer?.vPipeline?.queryPosition?.();
      const gstDur = onAirPlayer?.vPipeline?.queryDuration?.();
      if (gstPos != null && gstPos > 0 && gstDur != null && gstDur > 0 && gstDur < 7200) {
        return Math.max(0, gstDur - gstPos);
      }
      // Fallback: configured EOM/duration minus wall-clock elapsed
      const durSec = curEv.eom      != null ? (_fromTC(curEv.eom,      FPS) || 0)
                   : curEv.duration != null ? (_fromTC(curEv.duration,  FPS) || 0)
                   : (curEv._clipDur ?? 0);
      return Math.max(0, durSec - elapsed);
    } catch { return 0; }
  }

  if (meth === 'GET'  && p === '/api/grafik/status') {
    const tpls = grafixEngine.listTemplatesWithMeta ? grafixEngine.listTemplatesWithMeta() : [];
    log(`/api/grafik/status: ${tpls.length} Templates: ${tpls.map(t=>t.id+'['+t.type+']').join(', ')||'(keine)'}`, 'debug', 'server');
    return json(res, {
      running:   grafixEngine._running,
      puppeteer: grafixEngine._browser != null,
      active:    [...(grafixEngine._activeGrafiks?.keys() || [])],
      activeData: grafixEngine.activeGrafiks || [],
      templates: tpls,
    });
  }
  if (meth === 'POST' && p === '/api/grafik/show') {
    const sess = _requireAuth(req, res, ['grafiker','editor']); if (sess === false) return;
    const b = await parseBody(req);
    if (!b.template) return json(res, { ok: false, error: 'template required' }, 400);
    const _showCtx = {
      playlist:                playlist.playlist,
      currentIndex:            Math.max(0, playlist.currentIndex ?? 0),
      fps:                     FPS,
      classifs:                _getClassifications(),
      currentClipRemainingSec: _clipRemainingSec(),
    };
    const resolvedData = grafixEngine._resolveVars(b.data || {}, _showCtx);
    const id = await grafixEngine.show(b.template, resolvedData, b.layer || 'overlay', b.id || null);
    master.showGrafik?.();
    broadcast('grafik', { action: 'show', id, template: b.template });
    _arOnGrafik('show', id, b.template, 'manual');
    _userLog(sess, 'grafik.show', b.template);
    return json(res, { ok: true, id });
  }
  if (meth === 'POST' && p === '/api/grafik/hide') {
    const sess = _requireAuth(req, res, ['grafiker','editor']); if (sess === false) return;
    const b = await parseBody(req);
    // Collect template names for as-run before hiding
    const hiddenTemplates = [];
    if (b.id) {
      const g = grafixEngine._activeGrafiks?.get(b.id);
      if (g) hiddenTemplates.push(g.template);
      await grafixEngine.hide(b.id);
    } else {
      for (const [, g] of (grafixEngine._activeGrafiks || [])) hiddenTemplates.push(g.template);
      await grafixEngine.hideAll();
    }
    if (!grafixEngine._activeGrafiks?.size) master.hideGrafik?.();
    broadcast('grafik', { action: 'hide', id: b.id || 'all' });
    if (b.id) {
      _arOnGrafik('hide', b.id, hiddenTemplates[0] || '', 'manual');
    } else {
      const ids = [..._ar.grafik.keys()];
      for (const gid of ids) _arOnGrafik('hide', gid, _ar.grafik.get(gid)?.template || '', 'manual');
    }
    _userLog(sess, 'grafik.hide', b.id || 'all');
    return json(res, { ok: true });
  }
  if (meth === 'POST' && p === '/api/grafik/continue') {
    const sess = _requireAuth(req, res, ['grafiker','editor']); if (sess === false) return;
    const b = await parseBody(req);
    if (!b.id) return json(res, { ok: false, error: 'id required' }, 400);
    await grafixEngine.grafixContinue(b.id);
    broadcast('grafik', { action: 'continue', id: b.id });
    _userLog(sess, 'grafik.continue', b.id);
    return json(res, { ok: true });
  }
  if (meth === 'POST' && p === '/api/grafik/update') {
    const sess = _requireAuth(req, res, ['grafiker','editor']); if (sess === false) return;
    const b = await parseBody(req);
    if (!b.id) return json(res, { ok: false, error: 'id required' }, 400);
    const _updCtx = { playlist: playlist.playlist, currentIndex: Math.max(0, playlist.currentIndex ?? 0), fps: FPS, classifs: _getClassifications(), currentClipRemainingSec: _clipRemainingSec() };
    await grafixEngine.grafixUpdate(b.id, grafixEngine._resolveVars(b.data || {}, _updCtx));
    broadcast('grafik', { action: 'update', id: b.id, data: b.data || {} });
    _userLog(sess, 'grafik.update', b.id);
    return json(res, { ok: true });
  }
  if (meth === 'GET'  && p === '/api/grafik/templates') {
    try {
      const all = grafixEngine._listTemplates();
      console.log('[DEBUG][server] /api/grafik/templates →', all.map(t=>t.name+'['+t.type+']').join(', '));
      return json(res, all.map(t => t.name));
    } catch(e) {
      console.error('[DEBUG][server] /api/grafik/templates Fehler:', e.message);
      return json(res, []);
    }
  }

  // ── Grafik Hotkeys CRUD ────────────────────────────────────────────────────
  if (meth === 'GET'  && p === '/api/grafik/hotkeys') {
    return json(res, hotkeys);
  }
  if (meth === 'POST' && p === '/api/grafik/hotkeys') {
    const b = await parseBody(req);
    if (!b.label || !b.template) return json(res, { ok: false, error: 'label+template required' }, 400);
    const hk = { id: genId(), label: b.label, template: b.template, data: b.data || {}, layer: b.layer || 'overlay' };
    hotkeys.push(hk);
    saveHotkeys(hotkeys);
    broadcast('hotkeys', hotkeys);
    return json(res, { ok: true, hotkey: hk });
  }
  if (meth === 'PUT' && p.startsWith('/api/grafik/hotkeys/')) {
    const id = p.slice('/api/grafik/hotkeys/'.length);
    const b  = await parseBody(req);
    const i  = hotkeys.findIndex(h => h.id === id);
    if (i === -1) return json(res, { ok: false, error: 'not found' }, 404);
    hotkeys[i] = { ...hotkeys[i], ...b, id };
    saveHotkeys(hotkeys);
    broadcast('hotkeys', hotkeys);
    return json(res, { ok: true, hotkey: hotkeys[i] });
  }
  if (meth === 'DELETE' && p.startsWith('/api/grafik/hotkeys/')) {
    const id = p.slice('/api/grafik/hotkeys/'.length);
    hotkeys = hotkeys.filter(h => h.id !== id);
    saveHotkeys(hotkeys);
    broadcast('hotkeys', hotkeys);
    return json(res, { ok: true });
  }
  if (meth === 'POST' && p.startsWith('/api/grafik/hotkeys/') && p.endsWith('/fire')) {
    const id = p.slice('/api/grafik/hotkeys/'.length).replace('/fire','');
    const hk = hotkeys.find(h => h.id === id);
    if (!hk) return json(res, { ok: false, error: 'not found' }, 404);
    const _hkCtx = { playlist: playlist.playlist, currentIndex: Math.max(0, playlist.currentIndex ?? 0), fps: FPS, classifs: _getClassifications(), currentClipRemainingSec: _clipRemainingSec() };
    const gid = await grafixEngine.show(hk.template, grafixEngine._resolveVars(hk.data || {}, _hkCtx), hk.layer || 'overlay');
    master.showGrafik?.();
    broadcast('grafik', { action: 'show', id: gid, template: hk.template });
    _arOnGrafik('show', gid, hk.template, `hotkey:${hk.label}`);
    return json(res, { ok: true, id: gid });
  }

  // ── Playlist Gap/Source API ───────────────────────────────────────────────
  if (meth === 'POST' && p === '/api/playlist/gap-source') {
    const b = await parseBody(req);
    if (!['black','smpte','idle','clip'].includes(b.source)) return json(res, { ok: false, error: 'invalid source' }, 400);
    playlist.opts.gapSource = b.source;
    _settings.gapSource = b.source;
    if (b.gapFile !== undefined) { playlist.opts.gapFile = b.gapFile; _settings.gapFile = b.gapFile; }
    saveSettings(_settings);
    broadcast('state', getState());
    return json(res, { ok: true, gapSource: b.source, gapFile: playlist.opts.gapFile });
  }
  if (meth === 'POST' && p === '/api/settings') {
    const b = await parseBody(req);
    if (b.autoGap !== undefined) {
      playlist.opts.autoGap = !!b.autoGap;
      _settings.autoGap = !!b.autoGap;
    }
    if (b.stillSlots        !== undefined) _settings.stillSlots       = Math.max(0, Math.min(9, parseInt(b.stillSlots) || 0));
    if (b.maxClients        !== undefined) _settings.maxClients       = Math.max(0, parseInt(b.maxClients) || 0);
    if (b.grafikLatencyMs   !== undefined) {
      _settings.grafikLatencyMs = Math.max(0, parseInt(b.grafikLatencyMs) || 0);
      playlist.opts.grafikLatencyMs = _settings.grafikLatencyMs;
    }
    if (b.videoDelayMs !== undefined) {
      _settings.videoDelayMs = Math.max(-500, Math.min(2000, parseInt(b.videoDelayMs) || 0));
      if (master?.running) master.setVideoDelay(_settings.videoDelayMs);
    }
    if (b.audioDelayMs !== undefined && typeof b.audioDelayMs === 'object') {
      if (!_settings.audioDelayMs) _settings.audioDelayMs = {};
      for (const [gid, ms] of Object.entries(b.audioDelayMs)) {
        _settings.audioDelayMs[gid] = Math.max(-500, Math.min(2000, parseInt(ms) || 0));
        if (master?.running) master.setAudioDelay(gid, _settings.audioDelayMs[gid]);
      }
    }
    if (b.liveCueMode       !== undefined && ['asap','timed'].includes(b.liveCueMode)) {
      _settings.liveCueMode = b.liveCueMode;
      playlist.opts.liveCueMode = b.liveCueMode;
    }
    if (b.liveCueLeadSec    !== undefined) {
      _settings.liveCueLeadSec = Math.max(0, parseFloat(b.liveCueLeadSec) || 0);
      playlist.opts.liveCueLeadSec = _settings.liveCueLeadSec;
    }
    saveSettings(_settings);
    broadcast('state', getState());
    return json(res, { ok: true });
  }
  if (meth === 'GET' && p === '/api/live-sources') {
    return json(res, { liveSources: _settings.liveSources || [] });
  }
  if (meth === 'GET' && p === '/api/live/signal-status') {
    return json(res, _dlSignalStatus);
  }
  if (meth === 'POST' && p === '/api/live-sources') {
    if (!_requireAuth(req, res, ['admin'])) return;
    const b = await parseBody(req);
    if (!Array.isArray(b.liveSources)) return json(res, { error: 'liveSources muss ein Array sein' }, 400);
    // Validierung: jede Quelle braucht id + (gstSrc | uri)
    for (const ls of b.liveSources) {
      if (!ls.id) return json(res, { error: 'Jede Quelle braucht eine id' }, 400);
      if (!/^[a-zA-Z0-9_-]+$/.test(ls.id)) return json(res, { error: `Ungültige id: "${ls.id}" (nur a-z, 0-9, _, -)` }, 400);
      // uri-Shorthand: RTSP / HLS / UDP / HTTP → automatisch gstSrc generieren
      if (ls.uri && !ls.gstSrc) {
        ls.gstSrc = _buildUriLiveSrc(ls.uri, ls.uriLatencyMs ?? 200);
        if (!ls.gstAudioSrc) ls.gstAudioSrc = _buildUriLiveAudioSrc(ls.uri, ls.uriLatencyMs ?? 200);
        ls.hasAudio = ls.hasAudio !== false;
      }
      if (!ls.gstSrc) return json(res, { error: `Quelle "${ls.id}": gstSrc oder uri erforderlich` }, 400);
    }
    _settings.liveSources = b.liveSources;
    saveSettings(_settings);
    broadcast('state', getState());
    log(`Live-Quellen aktualisiert: ${b.liveSources.length} Einträge (Neustart erforderlich)`, 'info', 'system');
    return json(res, { ok: true, note: 'Neustart erforderlich damit GStreamer-Pipeline neu aufgebaut wird' });
  }

  // ── Pipeline-Latenz-Messung ─────────────────────────────────────────────────
  if (meth === 'GET' && p === '/api/pipeline/latency') {
    if (!_requireAuth(req, res, ['admin','operator'])) return;
    try {
      const info = _measurePipelineLatency();
      return json(res, info);
    } catch(e) {
      return json(res, { error: e.message }, 500);
    }
  }

  // ── A/V-Sync: automatische Messung ─────────────────────────────────────────
  // Injiziert SMPTE-Testsignal, misst Audio-Onset via Level-Meter, schätzt Video-Latenz.
  // Empfiehlt welchen Pfad und um wie viele ms zu verzögern.
  if (meth === 'POST' && p === '/api/pipeline/av-sync/measure') {
    if (!_requireAuth(req, res, ['admin','operator'])) return;
    if (!master?.running) return json(res, { error: 'Pipeline nicht aktiv' }, 409);
    const b = await parseBody(req);
    const timeoutMs = Math.min(5000, Math.max(500, parseInt(b.timeoutMs || '1500')));
    try {
      const result = await master.measureAvSync(timeoutMs);
      return json(res, result);
    } catch(e) {
      return json(res, { error: e.message }, 500);
    }
  }

  // ── A/V-Sync: Delay manuell setzen oder Messergebnis übernehmen ────────────
  // PATCH body: { videoDelayMs?: number, audioDelayMs?: {groupId: ms}, applyRecommendation?: true }
  if (meth === 'PATCH' && p === '/api/pipeline/av-sync') {
    if (!_requireAuth(req, res, ['admin','operator'])) return;
    const b = await parseBody(req);

    // applyRecommendation: Messung ausführen und automatisch anwenden
    if (b.applyRecommendation) {
      if (!master?.running) return json(res, { error: 'Pipeline nicht aktiv' }, 409);
      const mres = await master.measureAvSync(1500).catch(e => ({ error: e.message }));
      if (mres.error) return json(res, mres, 500);
      if (mres.recommendation) {
        const { delayPath, delayMs } = mres.recommendation;
        if (delayPath === 'video') {
          const newVms = Math.round((_settings.videoDelayMs || 0) + delayMs);
          _settings.videoDelayMs = newVms;
          master.setVideoDelay(newVms);
        } else {
          const newAms = { ...(_settings.audioDelayMs || {}) };
          for (const group of (audioGroupConfig?.groups || [])) {
            newAms[group.id] = Math.round((newAms[group.id] || 0) + delayMs);
            master.setAudioDelay(group.id, newAms[group.id]);
          }
          _settings.audioDelayMs = newAms;
        }
        saveSettings(_settings);
        broadcast('state', getState());
        return json(res, { ok: true, applied: mres.recommendation, current: master.getDelays() });
      }
      return json(res, { ok: false, note: 'Keine Empfehlung (Audio-Onset nicht erkannt)', measurement: mres });
    }

    // Manuell setzen
    if (b.videoDelayMs !== undefined) {
      const ms = Math.max(-500, Math.min(2000, parseInt(b.videoDelayMs) || 0));
      _settings.videoDelayMs = ms;
      if (master?.running) master.setVideoDelay(ms);
    }
    if (b.audioDelayMs !== undefined && typeof b.audioDelayMs === 'object') {
      if (!_settings.audioDelayMs) _settings.audioDelayMs = {};
      for (const [groupId, ms] of Object.entries(b.audioDelayMs)) {
        const msVal = Math.max(-500, Math.min(2000, parseInt(ms) || 0));
        _settings.audioDelayMs[groupId] = msVal;
        if (master?.running) master.setAudioDelay(groupId, msVal);
      }
    }
    // Reset: alle Delays auf 0
    if (b.reset) {
      _settings.videoDelayMs = 0;
      _settings.audioDelayMs = {};
      if (master?.running) {
        master.setVideoDelay(0);
        for (const group of (audioGroupConfig?.groups || [])) master.setAudioDelay(group.id, 0);
      }
    }

    saveSettings(_settings);
    broadcast('state', getState());
    return json(res, { ok: true, current: master?.running ? master.getDelays() : { videoMs: _settings.videoDelayMs || 0, audioMs: _settings.audioDelayMs || {} } });
  }

  // ── A/V-Sync: aktuellen Status abfragen ────────────────────────────────────
  if (meth === 'GET' && p === '/api/pipeline/av-sync') {
    if (!_requireAuth(req, res, ['admin','operator'])) return;
    return json(res, {
      current:    master?.running ? master.getDelays() : { videoMs: _settings.videoDelayMs||0, audioMs: _settings.audioDelayMs||{} },
      configured: { videoDelayMs: _settings.videoDelayMs||0, audioDelayMs: _settings.audioDelayMs||{} },
      groups:     (audioGroupConfig?.groups || []).map(g => g.id),
    });
  }
  if (meth === 'POST' && p === '/api/playlist/gap-fill') {
    // Lücken in der Playlist auffüllen: Gap-Clip zwischen Events einfügen
    const b = await parseBody(req);
    const result = playlist.fillGaps(b.gapFile || null, b.gapDuration || null);
    broadcast('playlist', _enrichPlaylist(playlist.playlist));
    return json(res, { ok: true, inserted: result });
  }
  if (meth === 'GET' && p === '/api/playlist/timeline') {
    return json(res, playlist.calcTimeline());
  }
  if (meth === 'GET' && p === '/api/playlist/availability') {
    const result = {};
    const backupDirs = _settings.backupMediaDirs || [];
    for (const ev of playlist.playlist) {
      const fn = ev.file;
      if (!fn || result[fn]) continue;
      const mainPath = path.isAbsolute(fn) ? fn : path.join(MEDIA_DIR, fn);
      const mainOk   = fs.existsSync(mainPath);
      const backupOk = backupDirs.some(d => fs.existsSync(path.join(d, path.basename(fn))));
      result[fn] = { main: mainOk, backup: backupOk };
    }
    return json(res, result);
  }
  if (p.startsWith('/grafik/')) {
    // Proxy zum GrafixEngine Template-Server (Port 3101)
    const proxyReq = require('http').request(
      { host: 'localhost', port: grafixEngine.port, path: p, method: meth,
        headers: { ...req.headers, host: `localhost:${grafixEngine.port}` } },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );
    proxyReq.on('error', () => { res.writeHead(502); res.end('Grafik-Server nicht erreichbar'); });
    req.pipe(proxyReq);
    return;
  }

  // ── GST_DEBUG Filter API ───────────────────────────────────────────────────
  if (meth === 'GET' && p === '/api/debug/gst') {
    const GST_DEBUG_PRESETS = [
      { label: '🔴 Nur Fehler',                         filter: '*:1',                                                                   description: 'GST_LEVEL_ERROR — nur fatale Fehler' },
      { label: '🟠 Fehler + Warnungen',                 filter: '*:2',                                                                   description: 'GST_LEVEL_WARNING — Fehler und Warnungen' },
      { label: 'Audio: interaudio + capsfilter',        filter: 'interaudiosink:5,interaudiosrc:5,capsfilter:4,audioconvert:3' },
      { label: 'Video: intervideo + compositor',        filter: 'intervideosink:5,intervideosrc:5,compositor:4,videorate:4' },
      { label: 'MXF: demuxer + uridecodebin',          filter: 'mxfdemux:5,uridecodebin:4,decodebin:4,typefind:3' },
      { label: 'Grafik: appsrc + compositor',          filter: 'appsrc:5,compositor:5,queue:4' },
      { label: 'Player: vollständig',                  filter: 'uridecodebin:4,decodebin:4,interaudiosink:5,intervideosink:5,audioconvert:3,videorate:4' },
      { label: 'Master: Audio-Routing',                filter: 'interaudiosrc:5,input-selector:5,audioconvert:4,audiomixmatrix:5' },
      { label: 'Clock / Sync',                         filter: 'basesink:5,clock:5,videorate:5' },
      { label: 'Alles (sehr viel Output!)',             filter: 'GST_ELEMENT_FACTORY:4,*:3' },
    ];
    const saved = _settings.gstDebugFilter || '';
    const active = process.env.GST_DEBUG || '';
    return json(res, { presets: GST_DEBUG_PRESETS, savedFilter: saved, filter: active });
  }
  if (meth === 'POST' && p === '/api/debug/gst') {
    const b = await parseBody(req);
    if (b.reset) {
      delete _settings.gstDebugFilter;
      saveSettings(_settings);
      return json(res, { ok: true, filter: '' });
    }
    const filter = (b.filter || '').trim();
    _settings.gstDebugFilter = filter;
    saveSettings(_settings);
    return json(res, { ok: true, filter });
  }

  // ── Debug API ──────────────────────────────────────────────────────────────
  if (meth === 'GET' && p === '/api/debug/stats') {
    return json(res, debugger_.getStats());
  }
  if (meth === 'POST' && p === '/api/debug/enable') {
    const b = await parseBody(req);
    const enable  = b.enabled !== false;
    const verbose = b.verbose ?? debugger_.verboseBus;
    enable ? debugger_.enable() : debugger_.disable();
    debugger_.setVerboseBus(verbose);
    _settings.debugEnabled = enable;
    _settings.debugVerbose = verbose;
    saveSettings(_settings);
    if (enable && master.running && master.pipeline) {
      debugger_.watch('master', master.pipeline, master.pipelineString);
      for (const [id, p] of Object.entries(players)) {
        if (p.vPipeline) debugger_.watch(id, p.vPipeline, p._lastPStr || null);
      }
    }
    if (!enable) debugger_.stopAll();
    log(`Debug: ${enable ? 'AN' : 'AUS'} verbose=${verbose}`, 'info', 'debugger');
    return json(res, { ok: true, enabled: enable, verbose });
  }
  if (meth === 'POST' && p === '/api/debug/reset') {
    debugger_.resetAll();
    return json(res, { ok: true });
  }
  if (meth === 'POST' && p === '/api/debug/dump') {
    if (master.running && master.pipelineString) {
      debugger_.dumpOnError('master', master.pipelineString, 'Manueller Dump');
    }
    return json(res, { ok: true });
  }

  res.writeHead(404); res.end('Not Found');
}

// ── HTTP server ────────────────────────────────────────────────────────────────
const server = http.createServer(_requestHandler);

// ── HTTPS server (optional) ───────────────────────────────────────────────────
// Configure via settings.json: { "httpsKey": "/path/to/key.pem", "httpsCert": "/path/to/cert.pem", "httpsPort": 3443 }
// Or env: HTTPS_KEY, HTTPS_CERT, HTTPS_PORT
// Generate self-signed: openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 3650 -nodes -subj "/CN=localhost"
const _httpsKey  = _settings.httpsKey  || process.env.HTTPS_KEY;
const _httpsCert = _settings.httpsCert || process.env.HTTPS_CERT;
if (_httpsKey && _httpsCert) {
  try {
    const https      = require('https');
    const HTTPS_PORT = parseInt(_settings.httpsPort || process.env.HTTPS_PORT || String(PORT + 443));
    const httpsServer = https.createServer(
      { key: fs.readFileSync(_httpsKey), cert: fs.readFileSync(_httpsCert) },
      _requestHandler
    );
    httpsServer.listen(HTTPS_PORT, () =>
      log(`🔒 HTTPS → https://localhost:${HTTPS_PORT}`, 'info', 'system'));
  } catch(e) {
    log(`HTTPS Fehler: ${e.message}`, 'error', 'system');
  }
}

// ── State / Perf ───────────────────────────────────────────────────────────────
function getState() {
  // Aktive Grafiken: Map id→{template,data,layer} → Array für UI
  const activeGrafiks = [];
  if (grafixEngine?._activeGrafiks) {
    for (const [id, g] of grafixEngine._activeGrafiks) {
      activeGrafiks.push({ id, template: g.template, data: g.data, layer: g.layer });
    }
  }
  return {
    master:   { running: master.running, activePad: master.activePad, pipelineString: master.pipelineString },
    players:  Object.fromEntries(Object.entries(players).map(([id, p]) => [id, { running: p.running, cued: p.cued, playing: p.playing, pos: (() => { try { return p.vPipeline?.queryPosition?.() ?? null; } catch { return null; } })() }])),
    slots:    { onAir: playlist._onAirSlot, idle: playlist._idleSlot },
    playlist: { running: playlist._running, paused: playlist._paused, currentIndex: playlist.currentIndex, length: playlist.playlist.length },
    playing:  _currentPlaying ? { ..._currentPlaying, elapsedMs: Date.now() - _currentPlaying.startMs } : null,
    config:   { mediaDir: MEDIA_DIR, width: masterOpts.width||W, height: masterOpts.height||H, fps: masterOpts.fps||FPS, videoSink: masterOpts.videoSink||'autovideosink', audioSink: masterOpts.audioSink||'pulsesink', idleSource: masterOpts.idleSource||'smpte', idleImagePath: masterOpts.idleImagePath||null, gapSource: playlist.opts.gapSource||'black', gapFile: playlist.opts.gapFile||null, autoGap: playlist.opts.autoGap||false, clockProvider: audioGroupConfig?.clock?.provider || 'audiotestsrc', liveSources: _settings.liveSources||[], liveCueMode: _settings.liveCueMode||'timed', liveCueLeadSec: _settings.liveCueLeadSec??5, grafikLatencyMs: _settings.grafikLatencyMs??0, slotIds: _slotIds, numPlayers: _numPlayers, voSlotIds: _voSlotIds, numVoSlots: _numVoSlots, backupSlot: _settings.backupSlot||null, backupMediaDirs: _settings.backupMediaDirs||[], scaleMode: masterOpts.scaleMode||'fit', scaleMethod: masterOpts.scaleMethod??1, deinterlaceMode: masterOpts.deinterlaceMode||'auto', transitionSpeeds: _settings.transitionSpeeds || { fast: 500, medium: 1000, slow: 2000 }, classifications: _getClassifications(), recordDir: _settings.recordDir || null, recordAudioGroup: (_settings.recordAudioGroups || [_settings.recordAudioGroup || 'pgm-stereo'])[0], recordAudioGroups: _settings.recordAudioGroups || (_settings.recordAudioGroup ? [_settings.recordAudioGroup] : ['pgm-stereo']), recordIncludeInLibrary: RECORD_IN_LIBRARY, recordSlots: _settings.recordSlots || ['rec1', 'rec2', 'rec3'], missingBehavior: _settings.missingBehavior || 'skip', defaultEvent: _settings.defaultEvent || null, stillSlots: Math.max(0, Math.min(9, parseInt(_settings.stillSlots ?? 2))), maxClients: parseInt(_settings.maxClients || '0') || 0, videoDelayMs: _settings.videoDelayMs??0, audioDelayMs: _settings.audioDelayMs||{} },
    avSync:   master?.running ? master.getDelays() : { videoMs: _settings.videoDelayMs??0, audioMs: _settings.audioDelayMs||{} },
    grafik:   { active: activeGrafiks },
  };
}

const os = require('os');
// CPU-Messung via process.cpuUsage() – misst diesen Prozess inkl. GStreamer-Native-Addon.
// Normiert durch Anzahl logischer CPUs damit der Wert dem Systemmonitor entspricht.
let _cpuPercent = 0;
{
  const _numCpus  = Math.max(1, os.cpus().length);
  let _lastUsage  = process.cpuUsage();
  let _lastTime   = Date.now();
  function _sampleCpu() {
    const now   = Date.now();
    const usage = process.cpuUsage();
    const elapsedUs = (now - _lastTime) * 1000;          // ms → µs
    if (elapsedUs > 0) {
      const usedUs = (usage.user - _lastUsage.user) + (usage.system - _lastUsage.system);
      _cpuPercent = Math.max(0, Math.min(100, Math.round(usedUs / elapsedUs / _numCpus * 100)));
    }
    _lastUsage = usage;
    _lastTime  = now;
  }
  setInterval(_sampleCpu, 1000);
}
function getCpuPercent() { return _cpuPercent; }
function getPerf() {
  const cpu=getCpuPercent(), mf=os.freemem();
  return { cpu, memPct:Math.round((1-mf/os.totalmem())*100), memFreeMB:Math.round(mf/1048576),
           cpus:os.cpus().length, fps:FPS, dropRisk:cpu>90?'HIGH':cpu>70?'MEDIUM':'LOW' };
}
setInterval(()=>broadcast('perf',getPerf()),1000);

// Master-Watchdog: alle 10s prüfen ob Pipeline noch läuft
// Master pipeline watchdog: auto-restart if pipeline stopped unexpectedly
setInterval(async () => {
  if (!masterStarted) return;
  if (master.running) return;
  log('⚠ Master-Pipeline nicht aktiv — Auto-Restart', 'warn', 'master');
  try { await ensureMaster(); }
  catch(e) { log(`Master-Restart fehlgeschlagen: ${e.message}`, 'error', 'master'); }
}, 10000);

// Playlist stall watchdog: detect if playlist is running but position doesn't advance
// (e.g. fallback timer never fired, EOM missed). Re-advances after 90s stall.
{
  let _plStallPos = null, _plStallSince = 0;
  setInterval(() => {
    if (!playlist._running || playlist._paused) { _plStallPos = null; return; }
    const slot = playlist._onAirSlot;
    if (!slot) { _plStallPos = null; return; }
    try {
      const pos = playlist.players[slot]?.vPipeline?.queryPosition?.();
      if (pos == null) return;
      if (_plStallPos !== null && Math.abs(pos - _plStallPos) < 0.1) {
        const stalledSec = (Date.now() - _plStallSince) / 1000;
        if (stalledSec > 90) {
          log(`⚠ Playlist-Stall erkannt (pos=${pos.toFixed(2)}s seit ${stalledSec.toFixed(0)}s) → advance erzwingen`, 'warn', 'playlist');
          _plStallPos = null;
          // Force-advance: signal EOM so the engine moves to the next event
          playlist.emit('eom', slot, {});
        }
      } else {
        _plStallPos = pos;
        _plStallSince = Date.now();
      }
    } catch {}
  }, 5000);
}

process.on('uncaughtException', err => {
  log(`[FATAL] Uncaught: ${err.message}\n${err.stack||''}`, 'error', 'system');
  console.error('[FATAL] Uncaught:', err);
});
process.on('unhandledRejection', reason => {
  const msg = reason?.message || String(reason);
  log(`[WARN] Unhandled rejection: ${msg}`, 'warn', 'system');
  console.error('[WARN] Unhandled rejection:', reason);
});

server.listen(PORT, () => {
  log(`🎬 Broadcast Controller → http://localhost:${PORT}`, 'info', 'system');
  log(`   __dirname   : ${__dirname}`, 'info', 'system');
  log(`   settings.json: ${SETTINGS_PATH} ${fs.existsSync(SETTINGS_PATH)?'✓':'✗ FEHLT'}`, 'info', 'system');
  log(`   Media-Ordner: ${MEDIA_DIR} ${fs.existsSync(MEDIA_DIR)?'✓':'✗ FEHLT'}`, 'info', 'system');
  log(`   Grafik-Dir  : ${GRAFIK_DIR} ${fs.existsSync(GRAFIK_DIR)?'✓':'✗ FEHLT'}`, 'info', 'system');
  log(`   Images-Dir  : ${IMAGES_DIR} ${fs.existsSync(IMAGES_DIR)?'✓':'✗ FEHLT'}`, 'info', 'system');
  log(`   Auflösung   : ${masterOpts.width}x${masterOpts.height} @ ${masterOpts.fps}fps`, 'info', 'system');
  log(`   videoSink   : ${masterOpts.videoSink || 'autovideosink (default)'}`, 'info', 'system');
  log(`   idleSource  : ${masterOpts.idleSource}`, 'info', 'system');

  if (masterOpts.idleSource === 'image') {
    if (masterOpts.idleImagePath) {
      log(`   Idle-Bild: ${masterOpts.idleImagePath}`, 'info', 'system');
    } else {
      const raw = _settings.idleImagePath;
      log(`   ⚠ Idle-Bild nicht gefunden${raw ? `: "${raw}" (existiert nicht)` : ' (kein Pfad konfiguriert)'} → Fallback SMPTE`, 'warn', 'system');
      masterOpts.idleSource = 'smpte';
    }
  }

  ensureMaster();
  _autoLoadPlaylist();
  pluginHost.loadAll().catch(e => log(`Plugin-Host Startup: ${e.message}`, 'warn', 'plugins'));
});

process.on('SIGTERM', async () => {
  pluginHost.dispatch('system:shutdown', {});
  await pluginHost.destroy().catch(()=>{});
  process.exit(0);
});
process.on('SIGINT', async () => {
  pluginHost.dispatch('system:shutdown', {});
  await pluginHost.destroy().catch(()=>{});
  process.exit(0);
});
