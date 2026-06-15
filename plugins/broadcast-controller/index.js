'use strict';
/**
 * Broadcast Controller Plugin
 *
 * Protokolle:
 *   sw-p-08   — Binäres Router-Kontrollprotokoll (Leitch/GVG, Nevion IPATH, EVS Cerebrum)
 *               Standard-Port 8079, binäres DLE-Framing, Crosspoint Connect 0x04
 *   cerebrum  — EVS Cerebrum CERECONTROL-Text-TCP (TAKE <router> <dst> <src>)
 *   http/s    — JSON-Webhook (POST)
 *   tcp       — Generischer Text-TCP mit {{variable}}-Template
 *
 * Schaltzeitpunkte für Live-Quellen:
 *   asap   — Sofort beim Erkennen eines bevorstehenden Live-Events vorlegen
 *   timed  — Einstellbarer Vorlauf (routeLeadSec) vor der kalkulierten Startzeit
 *
 * Sonderfälle:
 *   - Das nächste zu spielende Event ist immer sofort — unabhängig vom Modus
 *   - live:precue dient als Sicherheitsnetz (manuelle Starts, Latenzkorrekturen)
 */

const net   = require('net');
const http  = require('http');
const https = require('https');

// ── Plugin-Manifest ────────────────────────────────────────────────────────────
const meta = exports.meta = {
  id:          'broadcast-controller',
  name:        'Broadcast Controller',
  version:     '3.0.0',
  description: 'Router-Steuerung via SW-P-08 (Nevion IPATH, EVS Cerebrum), CERECONTROL-TCP oder HTTP-Webhook.',
  hasStatus:   true,

  schema: [
    {
      key: 'protocol', label: 'Protokoll', type: 'select',
      options: [
        { value: 'sw-p-08',   label: 'SW-P-08 (Nevion IPATH / EVS Cerebrum / Leitch)' },
        { value: 'cerebrum',  label: 'EVS Cerebrum CERECONTROL (Text-TCP)' },
        { value: 'http',      label: 'HTTP Webhook (JSON POST)' },
        { value: 'https',     label: 'HTTPS Webhook (JSON POST)' },
        { value: 'tcp',       label: 'TCP Generisch (Text-Template)' },
      ],
      default: 'sw-p-08',
    },
    { key: 'host', label: 'Host / IP', type: 'string', default: '192.168.1.100' },
    {
      key: 'port', label: 'Port', type: 'number', default: 8079,
      help: 'SW-P-08: 8079 (Standard). Cerebrum: 9735 (Standard). HTTP: 80/443.',
    },

    // ── SW-P-08 ────────────────────────────────────────────────────────────────
    {
      key: 'swp08Matrix', label: 'SW-P-08 Matrix/Level', type: 'number', default: 0,
      condition: 'protocol=sw-p-08',
      help: '0 = Video, 1 = Audio, 255 = alle Level gleichzeitig',
    },
    {
      key: 'swp08SourceMap',
      label: 'Quellen-Tabelle',
      type: 'kvtable', default: '{"FeedWien": 1, "CAM_Studio": 2}',
      kvKeyLabel: 'Signal-Name', kvValLabel: 'Port-Nr.',
      condition: 'protocol=sw-p-08',
      help: 'Signal-Name → Router-Source-Port-Nummer.',
    },
    {
      key: 'swp08DestMap',
      label: 'Ziel-Tabelle',
      type: 'kvtable', default: '{"DL_IN_1": 1, "DL_IN_2": 2}',
      kvKeyLabel: 'Input-ID', kvValLabel: 'Port-Nr.',
      condition: 'protocol=sw-p-08',
      help: 'inputId (aus Live-Quellen-Konfiguration) → Router-Destination-Port-Nummer.',
    },
    {
      key: 'swp08PgmDest',
      label: 'SW-P-08 PGM-Destination (Pre-Cue)',
      type: 'string', default: '',
      condition: 'protocol=sw-p-08',
      help: 'Für Clip-Pre-Cue-Meldung: Ziel-Port-Name oder -Nummer (z.B. "PGM" oder 0). Leer = keine Clip-Route.',
    },

    // ── Cerebrum ───────────────────────────────────────────────────────────────
    {
      key: 'cerebrumRouterName', label: 'Router-Name', type: 'string', default: 'VPR',
      condition: 'protocol=cerebrum',
      help: 'Router-Name in Cerebrum (z.B. VPR, MAIN)',
    },
    {
      key: 'cerebrumDestination', label: 'PGM-Destination', type: 'string', default: 'PGM1',
      condition: 'protocol=cerebrum',
    },
    {
      key: 'cerebrumSourceMap',
      label: 'Quellen-Tabelle',
      type: 'kvtable', default: '{"RP7": "RP7", "FeedWien": "FeedWien"}',
      kvKeyLabel: 'Signal-Name', kvValLabel: 'Cerebrum-Source-ID',
      condition: 'protocol=cerebrum',
      help: 'Signal-Name → Cerebrum-Source-ID. Signalnamen erscheinen als Dropdown im Playlist-Event-Editor.',
    },

    // ── HTTP ───────────────────────────────────────────────────────────────────
    { key: 'path',   label: 'HTTP Pfad',        type: 'string',   default: '/api/playlist-event', condition: 'protocol=http||protocol=https' },
    { key: 'apiKey', label: 'API-Key (Bearer)',  type: 'password', default: '',                   condition: 'protocol=http||protocol=https' },

    // ── Generisches TCP ────────────────────────────────────────────────────────
    {
      key: 'tcpTemplate', label: 'TCP Vorlage', type: 'string',
      default: 'EVENT {{source}} {{file}} {{timecode}}\r\n',
      condition: 'protocol=tcp',
      help: 'Variablen: {{source}}, {{file}}, {{title}}, {{timecode}}, {{slotId}}, {{eventType}}, {{upstreamSource}}, {{inputId}}, {{liveSlot}}',
    },

    // ── Live-Routing Zeitpunkt ─────────────────────────────────────────────────
    {
      key: 'routeMode',
      label: 'Schaltzeitpunkt Live-Routing',
      type: 'select',
      options: [
        { value: 'asap',  label: 'a) Sofort — beim ersten Erkennen vorlegen (auch Stunden vor Sendung)' },
        { value: 'timed', label: 'b) Normal — einstellbarer Vorlauf vor kalkulierter Startzeit' },
      ],
      default: 'timed',
      help: 'Bestimmt wann die Schaltung für bevorstehende Live-Events ausgelöst wird. Das nächste Event wird immer sofort vorgelegt.',
    },
    {
      key: 'routeLeadSec',
      label: 'Vorlauf (Sekunden)',
      type: 'number', default: 15,
      condition: 'routeMode=timed',
      help: 'Sekunden vor der kalkulierten Event-Startzeit. Ausreichend für langsames Schaltverhalten wählen.',
    },

    // ── Pre-Cue Clip-Meldung ───────────────────────────────────────────────────
    {
      key: 'reportOnCue',
      label: 'Clip Pre-Cue melden (player:cued)',
      type: 'boolean', default: false,
      help: 'Sendet Meldung wenn ein Clip-Player geladen wird (~5 s vor On-Air). Gilt nicht für Live-Events.',
    },
  ],

  subscribes: [
    'player:cued',
    'live:precue',
    'playlist:started',
    'playlist:ended',
    'playlist:jumped',
    'system:shutdown',
  ],
};

// ── Plugin-Zustand ─────────────────────────────────────────────────────────────
let _api;
let _cfg = {};
let _tcpSocket       = null;
let _tcpConnecting   = false;
let _cachedLiveSrcs  = [];

let _lastStatus = { state: 'idle', lastEvent: null, errors: 0 };
function _updateStatus(state, extra = {}) {
  _lastStatus = { lastEvent: _lastStatus.lastEvent, errors: _lastStatus.errors || 0, ...extra };
  _api?.setStatus?.(state, _lastStatus);
}
function _log(msg, level = 'info') { _api?.log?.(level, msg); }

// ── TCP-Verbindung ─────────────────────────────────────────────────────────────
function _ensureTcp(onReady) {
  if (_tcpSocket?.writable) { onReady(_tcpSocket); return; }
  if (_tcpConnecting) { setTimeout(() => _ensureTcp(onReady), 200); return; }

  _tcpConnecting = true;
  const sock = new net.Socket();
  const host  = _cfg.host || '127.0.0.1';
  const port  = parseInt(_cfg.port) || (_cfg.protocol === 'sw-p-08' ? 8079 : 9735);

  sock.connect(port, host, () => {
    _tcpConnecting = false;
    _tcpSocket = sock;
    _updateStatus('connected', { lastEvent: `Verbunden mit ${host}:${port}` });
    _log(`Verbunden mit ${host}:${port}`);
    onReady(sock);
  });
  sock.on('error', err => {
    _tcpConnecting = false;
    _tcpSocket = null;
    _log(`TCP-Fehler: ${err.message}`, 'warn');
    _updateStatus('error', { error: err.message, errors: (_lastStatus.errors || 0) + 1 });
  });
  sock.on('close', () => {
    if (_tcpSocket === sock) { _tcpSocket = null; _updateStatus('disconnected'); }
  });
  sock.on('data', _onTcpData);
}

let _rxBuf = Buffer.alloc(0);
function _onTcpData(chunk) {
  _rxBuf = Buffer.concat([_rxBuf, chunk]);
  if (_rxBuf.length > 512) _rxBuf = _rxBuf.slice(_rxBuf.length - 512);
}

function _tcpSend(data) {
  _ensureTcp(sock => {
    try { sock.write(data); }
    catch (e) { _tcpSocket = null; _updateStatus('error', { error: e.message }); }
  });
}

// ── SW-P-08 ────────────────────────────────────────────────────────────────────
const _SWP_DLE = 0x10, _SWP_STX = 0x02, _SWP_ETX = 0x03, _SWP_CONNECT = 0x04;

function _swp08BuildConnect(dstAddr, srcAddr, level) {
  const raw = [
    (dstAddr >> 8) & 0xFF, dstAddr & 0xFF,
    (srcAddr >> 8) & 0xFF, srcAddr & 0xFF,
    level & 0xFF,
  ];
  const stuffed = [];
  for (const b of raw) { stuffed.push(b); if (b === _SWP_DLE) stuffed.push(_SWP_DLE); }
  return Buffer.from([_SWP_DLE, _SWP_STX, _SWP_CONNECT, ...stuffed, _SWP_DLE, _SWP_ETX]);
}

function _swp08Resolve(mapObj, key) {
  if (key === null || key === undefined || key === '') return null;
  const direct = parseInt(key, 10);
  if (!isNaN(direct) && String(direct) === String(key).trim()) return direct;
  const looked = mapObj?.[key];
  if (looked !== undefined) return parseInt(looked, 10);
  return null;
}

function _parseMap(val) {
  if (val && typeof val === 'object') return val;
  try { return JSON.parse(val || '{}'); } catch { return {}; }
}

function _swp08Connect(srcName, dstName) {
  const srcMap = _parseMap(_cfg.swp08SourceMap);
  const dstMap = _parseMap(_cfg.swp08DestMap);
  const srcAddr = _swp08Resolve(srcMap, srcName);
  const dstAddr = _swp08Resolve(dstMap, dstName);
  const level   = parseInt(_cfg.swp08Matrix) || 0;
  if (srcAddr === null) {
    _log(`SW-P-08: Kein Mapping für Quelle "${srcName}" — swp08SourceMap prüfen`, 'warn');
    _updateStatus('error', { error: `Kein Source-Mapping: "${srcName}"` }); return;
  }
  if (dstAddr === null) {
    _log(`SW-P-08: Kein Mapping für Ziel "${dstName}" — swp08DestMap prüfen`, 'warn');
    _updateStatus('error', { error: `Kein Dest-Mapping: "${dstName}"` }); return;
  }
  const frame = _swp08BuildConnect(dstAddr, srcAddr, level);
  _log(`SW-P-08 CONNECT src=${srcName}(${srcAddr}) → dst=${dstName}(${dstAddr}) Level=${level}`);
  _tcpSend(frame);
  _updateStatus('ok', { lastEvent: `SW-P-08: ${srcName}(${srcAddr}) → ${dstName}(${dstAddr}) L${level}` });
}

// ── Cerebrum ───────────────────────────────────────────────────────────────────
function _cerebrumTake(srcName, dstName) {
  const router = _cfg.cerebrumRouterName || 'VPR';
  const dst    = dstName || _cfg.cerebrumDestination || 'PGM1';
  const msg    = `TAKE ${router} ${dst} ${srcName}\r\n`;
  _log(`Cerebrum: ${msg.trim()}`);
  _tcpSend(msg);
  _updateStatus('ok', { lastEvent: `CEREBRUM TAKE ${router} ${dst} → ${srcName}` });
}

// ── HTTP Webhook ───────────────────────────────────────────────────────────────
function _httpPost(payload) {
  const body  = JSON.stringify(payload);
  const proto = _cfg.protocol === 'https' ? https : http;
  const opts  = {
    hostname: _cfg.host || '127.0.0.1',
    port:     parseInt(_cfg.port) || 80,
    path:     _cfg.path || '/api/playlist-event',
    method:   'POST',
    headers:  {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...(_cfg.apiKey ? { Authorization: `Bearer ${_cfg.apiKey}` } : {}),
    },
    timeout: 5000,
  };
  const req = proto.request(opts, res => {
    _updateStatus('ok', { lastEvent: `HTTP ${res.statusCode} → ${opts.hostname}${opts.path}` });
  });
  req.on('error',   e => _updateStatus('error', { error: e.message, errors: (_lastStatus.errors||0)+1 }));
  req.on('timeout', () => { req.destroy(); _updateStatus('error', { error: 'HTTP timeout' }); });
  req.write(body); req.end();
}

// ── Generisches TCP-Template ───────────────────────────────────────────────────
function _tcpTemplate(vars) {
  const tmpl = _cfg.tcpTemplate || 'EVENT {{source}} {{file}} {{timecode}}\r\n';
  const msg  = tmpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
  _tcpSend(msg);
  _updateStatus('ok', { lastEvent: `TCP → ${msg.trim()}` });
}

// ── Live-Input Routing ─────────────────────────────────────────────────────────
// data = { liveSlot, inputId, upstreamSource, upstreamLabel }
function _dispatchLiveRoute(data) {
  const { inputId, upstreamSource, upstreamLabel, liveSlot } = data;
  if (!upstreamSource) return;
  const tc = new Date().toTimeString().slice(0, 8);
  switch (_cfg.protocol) {
    case 'sw-p-08':
      _swp08Connect(upstreamSource, inputId);
      break;
    case 'cerebrum':
      _cerebrumTake(upstreamSource, inputId);
      break;
    case 'tcp':
      _tcpTemplate({
        eventType: 'live-route', source: upstreamSource,
        liveSlot: liveSlot || '', inputId: inputId || '',
        upstreamSource, upstreamLabel: upstreamLabel || upstreamSource,
        file: '', title: upstreamLabel || upstreamSource, timecode: tc, slotId: liveSlot || '',
      });
      break;
    default:
      _httpPost({ eventType: 'live-route', liveSlot, inputId, upstreamSource,
        upstreamLabel: upstreamLabel || upstreamSource, ts: Date.now() });
  }
}

// ── Clip Pre-Cue Dispatch ──────────────────────────────────────────────────────
async function _refreshLiveSources() {
  try { _cachedLiveSrcs = (await _api?.getState?.())?.config?.liveSources || []; } catch {}
}

function _isLiveEvent(ev) {
  if (!ev?.source) return false;
  return _cachedLiveSrcs.some(ls => ls.id === ev.source) || ev.source === 'live';
}

function _dispatchClipCue(data) {
  const source = data.event?.source || data.slotId || '';
  const file   = data.event?.file   || '';
  const title  = data.event?.title  || '';
  const slotId = data.slotId        || '';
  const tc     = new Date().toTimeString().slice(0, 8);
  switch (_cfg.protocol) {
    case 'sw-p-08': {
      const pgmDst = (_cfg.swp08PgmDest || '').trim();
      if (!pgmDst) return;
      _swp08Connect(source, pgmDst);
      break;
    }
    case 'cerebrum':
      _cerebrumTake(source, _cfg.cerebrumDestination || 'PGM1');
      break;
    case 'tcp':
      _tcpTemplate({ source, file, title, timecode: tc, slotId, eventType: 'pre-cue',
        liveLabel: '', upstreamSource: source, inputId: '', liveSlot: '' });
      break;
    default:
      _httpPost({ eventType: 'pre-cue', source, file, title, slotId, timecode: tc, ts: Date.now() });
  }
}

// ── Live-Routing Scheduler ─────────────────────────────────────────────────────
// Tracks which events have been routed and schedules future routes.
// Key: event.id (stable across playlist mutations)
const _routed  = new Set();   // IDs already dispatched this playlist run
const _timers  = new Map();   // eventId → setTimeout handle
let   _pollTimer = null;

function _clearScheduled() {
  for (const t of _timers.values()) clearTimeout(t);
  _timers.clear();
}

function _routeNow(ev, lsConf) {
  if (_routed.has(ev.id)) return;
  _routed.add(ev.id);
  _timers.delete(ev.id);
  const inputId        = lsConf.inputId        || ev.source;
  const upstreamSource = ev.upstreamSource      || lsConf.upstreamSource || ev.source;
  const upstreamLabel  = ev.upstreamLabel       || lsConf.label          || ev.source;
  _log(`Live-Route: ${upstreamSource} → ${inputId} (Event: ${ev.title || ev.source})`);
  _dispatchLiveRoute({ liveSlot: ev.source, inputId, upstreamSource, upstreamLabel });
}

// Estimate cumulative start time (ms from now) for events starting at pl[fromIdx].
// Uses playing.durMs/elapsedMs for the current event, then sums subsequent durations.
function _estimateStartMs(pl, fromIdx, playing) {
  let base = Date.now();
  if (playing) {
    base += Math.max(0, (playing.durMs || 0) - (playing.elapsedMs || 0));
  }
  for (let i = 0; i < fromIdx; i++) {
    base += ((pl[i]?.duration || 0) * 1000);
  }
  return base;
}

async function _scan() {
  try {
    const state = await _api?.getState?.();
    if (!state?.playlist?.running) {
      _clearScheduled();
      _routed.clear();
      return;
    }

    const curIdx = state.playlist.currentIndex ?? -1;
    const pl     = (await _api?.getPlaylist?.()) || [];
    if (!pl.length) return;

    // Remove routed/timer entries for already-played or removed events
    const upcomingIds = new Set(pl.slice(curIdx + 1).map(e => e.id));
    for (const [id, t] of _timers) {
      if (!upcomingIds.has(id)) { clearTimeout(t); _timers.delete(id); }
    }
    for (const id of _routed) {
      if (!upcomingIds.has(id)) _routed.delete(id);
    }

    const mode    = _cfg.routeMode || 'timed';
    const leadMs  = Math.max(0, (parseInt(_cfg.routeLeadSec) || 15)) * 1000;

    for (let i = curIdx + 1; i < pl.length; i++) {
      const ev     = pl[i];
      const lsConf = _cachedLiveSrcs.find(ls => ls.id === ev.source);
      if (!lsConf) continue;
      if (_routed.has(ev.id) || _timers.has(ev.id)) continue;

      const isNext        = i === curIdx + 1;
      const startMs       = _estimateStartMs(pl.slice(curIdx + 1, i), i - curIdx - 1, state.playing);
      const msUntilRoute  = startMs - Date.now() - leadMs;

      if (mode === 'asap' || isNext || msUntilRoute <= 0) {
        // Route immediately
        _routeNow(ev, lsConf);
      } else {
        // Schedule for (startMs - leadMs)
        const timer = setTimeout(() => {
          _timers.delete(ev.id);
          _routeNow(ev, lsConf);
        }, msUntilRoute);
        _timers.set(ev.id, timer);
        _log(`Live-Route geplant: ${ev.title || ev.source} in ${Math.round(msUntilRoute/1000)}s`, 'debug');
      }
    }
  } catch(e) {
    _log(`scan: ${e.message}`, 'debug');
  }
}

function _schedulePoll() {
  clearTimeout(_pollTimer);
  _pollTimer = setTimeout(async () => {
    await _scan();
    _schedulePoll(); // re-arm
  }, 5000);
}

// ── Plugin-API ─────────────────────────────────────────────────────────────────
exports.init = async function(config, api) {
  _api = api;
  _cfg = config || {};
  await _refreshLiveSources();
  _updateStatus('idle');

  if (_cfg.protocol === 'sw-p-08' || _cfg.protocol === 'cerebrum') {
    _ensureTcp(() => {});
  }

  await _scan();
  _schedulePoll();
};

exports.onEvent = async function(type, data) {
  try {
    switch (type) {
      case 'player:cued':
        // Clip pre-cue notification (non-live events, if configured)
        if (_cfg.reportOnCue) {
          await _refreshLiveSources();
          if (!_isLiveEvent(data.event)) _dispatchClipCue(data);
        }
        // Trigger a scan: next event may now have changed
        await _scan();
        break;

      case 'live:precue':
        // Safety-net: fires immediately before on-air for live events.
        // Routes if not already done (handles manual jumps / forceJump starts).
        {
          const { liveSlot, inputId, upstreamSource, upstreamLabel } = data;
          if (upstreamSource && inputId) {
            // Use event index to build a stable key if no id available
            const key = `__precue_${data.index ?? liveSlot}`;
            if (!_routed.has(key)) {
              _routed.add(key);
              _log(`Live-Route (safety-net / live:precue): ${upstreamSource} → ${inputId}`);
              _dispatchLiveRoute({ liveSlot, inputId, upstreamSource, upstreamLabel });
            }
          }
          await _scan();
        }
        break;

      case 'playlist:started':
      case 'playlist:jumped':
        // Playlist started or manually jumped — re-evaluate scheduling immediately
        _clearScheduled();
        _routed.clear();
        await _refreshLiveSources();
        await _scan();
        break;

      case 'playlist:ended':
        _clearScheduled();
        _routed.clear();
        break;

      case 'system:shutdown':
        clearTimeout(_pollTimer);
        _clearScheduled();
        try { _tcpSocket?.destroy(); } catch {}
        _tcpSocket = null;
        break;
    }
  } catch(e) {
    _log(`onEvent-Fehler: ${e.message}`, 'warn');
    _updateStatus('error', { error: e.message, errors: (_lastStatus.errors||0)+1 });
  }
};

exports.onConfigUpdate = function(newCfg) {
  _cfg = newCfg;
  try { _tcpSocket?.destroy(); } catch {}
  _tcpSocket = null;
  _clearScheduled();
  _routed.clear();
  if (_cfg.protocol === 'sw-p-08' || _cfg.protocol === 'cerebrum') {
    _ensureTcp(() => {});
  }
  _scan();
  _updateStatus('idle');
};

exports.destroy = function() {
  clearTimeout(_pollTimer);
  _clearScheduled();
  try { _tcpSocket?.destroy(); } catch {}
  _tcpSocket = null;
};
