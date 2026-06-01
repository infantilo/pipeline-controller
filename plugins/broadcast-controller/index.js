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
 * Meldezeitpunkte:
 *   live:precue      — Live-Event vor On-Air: routet Upstream-Signal auf idle Decklink-Eingang
 *   player:cued      — Clip pre-cued (5s vor On-Air)
 *   playlist:playing — tatsächliches On-Air-Event
 */

const net   = require('net');
const http  = require('http');
const https = require('https');

// ── Plugin-Manifest ────────────────────────────────────────────────────────────
const meta = exports.meta = {
  id:          'broadcast-controller',
  name:        'Broadcast Controller',
  version:     '2.0.0',
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
      label: 'SW-P-08 PGM-Destination (On-Air)',
      type: 'string', default: '',
      condition: 'protocol=sw-p-08',
      help: 'Für On-Air-Meldung: Ziel-Port-Name oder -Nummer (z.B. "PGM" oder 0). Leer = keine On-Air-Route.',
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

    // ── Meldezeitpunkte ────────────────────────────────────────────────────────
    {
      key: 'reportOnCue', label: 'Bei Pre-Cue melden (player:cued)', type: 'boolean', default: true,
      help: 'Sendet Meldung wenn Clip-Player geladen wird (~5s vor On-Air).',
    },
    {
      key: 'reportOnPlay', label: 'Bei On-Air melden (playlist:playing)', type: 'boolean', default: true,
    },
    {
      key: 'liveSourcesOnly', label: 'Nur Live-Quellen melden', type: 'boolean', default: false,
      help: 'Filtert clip-basierte Events heraus — nur Live-Routing-Befehle werden gesendet.',
    },
  ],

  subscribes: [
    'playlist:playing',
    'player:cued',
    'live:precue',
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

// ── TCP-Verbindung (alle TCP-basierten Protokolle) ────────────────────────────
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
  sock.on('data', _onTcpData); // empfange Antworten (SW-P-08 sendet ggf. Status zurück)
}

// Empfangene TCP-Daten (SW-P-08 Quittierungen, Cerebrum-Antworten) — nur loggen
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

// ── SW-P-08 Protokoll ─────────────────────────────────────────────────────────
//
// Frame-Format:  DLE STX [CMD] [DATA mit DLE-Stuffing] DLE ETX
//   DLE = 0x10, STX = 0x02, ETX = 0x03
//
// Crosspoint Connect (CMD = 0x04):
//   DATA = dst_hi dst_lo src_hi src_lo level
//   Alle Bytes 0x10 in DATA werden als 0x10 0x10 gesendet (DLE-Stuffing).
//
// Adressierung: 16-bit Big-Endian (0–65535)
//   Level: 0=Video, 1=Audio, 255=alle Ebenen
//
const _SWP_DLE = 0x10;
const _SWP_STX = 0x02;
const _SWP_ETX = 0x03;
const _SWP_CONNECT = 0x04;

function _swp08BuildConnect(dstAddr, srcAddr, level) {
  // DLE-Stuffing der Datenbytes
  const raw = [
    (dstAddr >> 8) & 0xFF, dstAddr & 0xFF,
    (srcAddr >> 8) & 0xFF, srcAddr & 0xFF,
    level & 0xFF,
  ];
  const stuffed = [];
  for (const b of raw) { stuffed.push(b); if (b === _SWP_DLE) stuffed.push(_SWP_DLE); }
  return Buffer.from([_SWP_DLE, _SWP_STX, _SWP_CONNECT, ...stuffed, _SWP_DLE, _SWP_ETX]);
}

// Löst einen Namen oder direkte Nummer aus einer Lookup-Tabelle auf.
// Direkte Ganzzahl-Strings (z.B. "5") werden ohne Tabelle akzeptiert.
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

// ── EVS Cerebrum CERECONTROL ───────────────────────────────────────────────────
// Format: TAKE <router> <destination> <source>\r\n
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

// ── Live Pre-Cue Routing ───────────────────────────────────────────────────────
// data = { liveSlot, inputId, upstreamSource, upstreamLabel, index }
//   inputId        = physischer Decklink-Eingang (z.B. "DL_IN_2" oder "2")
//   upstreamSource = Upstream-Signal-ID (z.B. "FeedWien" oder "5")
function _dispatchLivePrecue(data) {
  const { inputId, upstreamSource, upstreamLabel, liveSlot } = data;
  if (!upstreamSource) return;

  const tc = new Date().toTimeString().slice(0, 8);

  switch (_cfg.protocol) {
    case 'sw-p-08':
      // Route: upstreamSource → inputId (Decklink-Eingang)
      _swp08Connect(upstreamSource, inputId);
      break;
    case 'cerebrum':
      // TAKE VPR <inputId> <upstreamSource>
      _cerebrumTake(upstreamSource, inputId);
      break;
    case 'tcp':
      _tcpTemplate({
        eventType: 'live-precue', source: upstreamSource,
        liveSlot: liveSlot || '', inputId: inputId || '',
        upstreamSource, upstreamLabel: upstreamLabel || upstreamSource,
        file: '', title: upstreamLabel || upstreamSource, timecode: tc, slotId: liveSlot || '',
      });
      break;
    default: // http / https
      _httpPost({ eventType: 'live-precue', liveSlot, inputId, upstreamSource,
        upstreamLabel: upstreamLabel || upstreamSource, ts: Date.now() });
  }
}

// ── On-Air / Pre-Cue Dispatch (Clips + generisch) ─────────────────────────────
let _cachedLiveSources = [];
async function _refreshLiveSources() {
  try { _cachedLiveSources = (await _api?.getState?.())?.config?.liveSources || []; } catch {}
}

function _dispatch(eventType, data) {
  const source  = data.event?.source || data.slotId || '';
  const file    = data.event?.file   || '';
  const title   = data.event?.title  || '';
  const slotId  = data.slotId        || '';
  const tc      = new Date().toTimeString().slice(0, 8);
  const isLive  = _cachedLiveSources.some(ls => ls.id === source) || source === 'live';
  const liveLabel = _cachedLiveSources.find(ls => ls.id === source)?.label || source;

  if (_cfg.liveSourcesOnly && !isLive) return;

  switch (_cfg.protocol) {
    case 'sw-p-08': {
      const pgmDst = (_cfg.swp08PgmDest || '').trim();
      if (!pgmDst) return; // kein PGM-Ziel konfiguriert → kein On-Air-Route
      _swp08Connect(source, pgmDst);
      break;
    }
    case 'cerebrum':
      if (!isLive) return;
      _cerebrumTake(source, _cfg.cerebrumDestination || 'PGM1');
      break;
    case 'tcp':
      _tcpTemplate({ source, file, title, timecode: tc, slotId, eventType,
        liveLabel: isLive ? liveLabel : '', upstreamSource: source, inputId: '', liveSlot: '' });
      break;
    default:
      _httpPost({ eventType, source, file, title, slotId, timecode: tc,
        isLive, liveLabel: isLive ? liveLabel : null, ts: Date.now() });
  }
}

// ── Plugin-API ─────────────────────────────────────────────────────────────────
exports.init = async function(config, api) {
  _api = api;
  _cfg = config || {};
  await _refreshLiveSources();
  _updateStatus('idle');

  // SW-P-08 / Cerebrum: Verbindung proaktiv aufbauen
  if (_cfg.protocol === 'sw-p-08' || _cfg.protocol === 'cerebrum') {
    _ensureTcp(() => {}); // connect im Hintergrund
  }
};

exports.onEvent = async function(type, data) {
  try {
    switch (type) {
      case 'playlist:playing':
        await _refreshLiveSources();
        if (_cfg.reportOnPlay !== false) _dispatch('on-air', data);
        break;
      case 'player:cued':
        if (_cfg.reportOnCue !== false) _dispatch('pre-cue', data);
        break;
      case 'live:precue':
        _dispatchLivePrecue(data);
        break;
      case 'system:shutdown':
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
  if (_cfg.protocol === 'sw-p-08' || _cfg.protocol === 'cerebrum') {
    _ensureTcp(() => {});
  }
  _updateStatus('idle');
};

exports.destroy = function() {
  try { _tcpSocket?.destroy(); } catch {}
  _tcpSocket = null;
};
