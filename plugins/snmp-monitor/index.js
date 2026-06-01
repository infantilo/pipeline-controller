'use strict';
/**
 * SNMP Monitor Plugin — Broadcast-Metriken via SNMP v2c
 *
 * Exponiert Channel-State, Playlist-Status, laufendes Event und System-Metriken
 * über einen SNMP-Agenten (net-snmp).
 *
 * OID-Basis: .1.3.6.1.4.1.59999 (private enterprise)
 *   .1.0  — channelState (Integer: 1=idle, 2=running, 3=paused, 4=hold)
 *   .2.0  — currentEventTitle (OctetString)
 *   .3.0  — currentEventFile  (OctetString)
 *   .4.0  — currentEventRemainingSec (Integer)
 *   .5.0  — playlistLength   (Integer)
 *   .6.0  — playlistPosition (Integer)
 *   .7.0  — uptimeSec        (Integer)
 *   .8.0  — cpuPercent       (Integer)
 *   .9.0  — memFreeMB        (Integer)
 *   .10.0 — channelName      (OctetString)
 *   .11.0 — recordActive     (Integer: 0=nein, 1=ja)
 */

const net = require('net');

// ── Plugin-Manifest ────────────────────────────────────────────────────────────
const meta = exports.meta = {
  id:          'snmp-monitor',
  name:        'SNMP Monitor',
  version:     '1.0.0',
  description: 'Exponiert Channel-Metriken via SNMP v2c für Monitoring-Systeme (Nagios, Zabbix, Grafana).',
  hasStatus:   true,

  schema: [
    { key: 'community',  label: 'SNMP Community',    type: 'string',  default: 'public' },
    { key: 'port',       label: 'SNMP UDP-Port',     type: 'number',  default: 161,
      help: 'Standard SNMP-Port ist 161. Unter 1024 benötigt root-Rechte → empfohlen: 1161.' },
    { key: 'bindAddr',   label: 'Bind-Adresse',      type: 'string',  default: '0.0.0.0',
      help: 'IP-Adresse auf der der Agent horcht. 0.0.0.0 = alle Interfaces.' },
    { key: 'channelName',label: 'Kanal-Name',         type: 'string',  default: '',
      help: 'Wird in .10.0 gemeldet. Leer = aus Pipeline-Controller-Einstellungen.' },
    { key: 'trapHost',   label: 'Trap-Ziel (optional)', type: 'string', default: '',
      help: 'Host/IP für SNMP-Traps bei State-Änderungen. Leer = keine Traps.' },
    { key: 'trapPort',   label: 'Trap-Port',          type: 'number',  default: 162 },
    { key: 'trapCommunity', label: 'Trap-Community',  type: 'string',  default: 'public' },
  ],
};

// ── Plugin-Logik ───────────────────────────────────────────────────────────────

let _snmp       = null;
let _agent      = null;
let _session    = null;  // Trap-Session
let _startTime  = Date.now();
let _lastState  = null;
let _statusData = {};
let _cfg        = {};
let _ctx        = {};

const OID_BASE = '1.3.6.1.4.1.59999';

function _oid(suffix) { return `${OID_BASE}.${suffix}`; }

function _intVal(v)  { return _snmp?.ObjectType ? { oid: null, type: _snmp.ObjectType.Integer,   value: parseInt(v)||0 } : null; }
function _strVal(v)  { return _snmp?.ObjectType ? { oid: null, type: _snmp.ObjectType.OctetString, value: String(v||'') } : null; }

function _buildMIB() {
  const state = _ctx.getState?.() || {};
  const pl    = state.playlist || {};
  const cfg   = state.config   || {};
  const perf  = state.perf     || {};

  let channelState = 1; // idle
  if (pl.running && pl.paused) channelState = 3;
  else if (pl.running)         channelState = 2;

  const curIdx = pl.currentIndex ?? -1;
  const events = _ctx.getPlaylist?.() || [];
  const curEv  = curIdx >= 0 ? events[curIdx] : null;

  const remainSec = (() => {
    try {
      if (!pl.running || !_ctx._playingStart) return 0;
      const elapsed = (Date.now() - _ctx._playingStart) / 1000;
      return Math.max(0, Math.round((_ctx._playingClipDur || 0) - elapsed));
    } catch { return 0; }
  })();

  const recActive = Object.keys(_ctx.recordStatus?.() || {}).length > 0 ? 1 : 0;

  return {
    [_oid('1.0')]:  channelState,
    [_oid('2.0')]:  curEv?.title || curEv?.file?.split('/').pop() || '',
    [_oid('3.0')]:  curEv?.file  || '',
    [_oid('4.0')]:  remainSec,
    [_oid('5.0')]:  pl.length    || 0,
    [_oid('6.0')]:  curIdx + 1,
    [_oid('7.0')]:  Math.floor((Date.now() - _startTime) / 1000),
    [_oid('8.0')]:  perf.cpu     || 0,
    [_oid('9.0')]:  perf.memFreeMB || 0,
    [_oid('10.0')]: _cfg.channelName || cfg.channelName || 'PIPELINE-CONTROLLER',
    [_oid('11.0')]: recActive,
  };
}

function _sendTrap(channelState) {
  if (!_session || !_cfg.trapHost) return;
  try {
    const varbinds = [
      { oid: _oid('1.0'), type: _snmp.ObjectType.Integer, value: channelState },
    ];
    _session.trap(_snmp.TrapType.EnterpriseSpecific, varbinds, _oid('1'), 1, err => {
      if (err) _statusData.lastTrapError = err.message;
    });
  } catch(e) { _statusData.lastTrapError = e.message; }
}

function _startAgent(config) {
  _cfg = config;
  try {
    _snmp = require('net-snmp');
  } catch {
    _statusData = { error: 'net-snmp nicht installiert (npm install net-snmp)' };
    return false;
  }

  const community = config.community || 'public';
  const port      = parseInt(config.port) || 1161;
  const bindAddr  = config.bindAddr || '0.0.0.0';

  try {
    _agent = _snmp.createAgent(`${bindAddr}:${port}`, (error, session) => {
      if (error) { _statusData.error = error.message; return; }
      // GET-Handler
      session.addGetHandler(varbinds => {
        const mib = _buildMIB();
        for (const vb of varbinds) {
          const val = mib[vb.oid];
          if (val === undefined) { vb.type = _snmp.ObjectType.NoSuchObject; continue; }
          if (typeof val === 'number') { vb.type = _snmp.ObjectType.Integer; vb.value = val; }
          else { vb.type = _snmp.ObjectType.OctetString; vb.value = Buffer.from(String(val)); }
        }
        return varbinds;
      });
    });

    // Trap-Session aufbauen wenn trapHost konfiguriert
    if (config.trapHost) {
      _session = _snmp.createSession(config.trapHost, config.trapCommunity || 'public',
        { port: parseInt(config.trapPort) || 162 });
    }

    _statusData = { listening: `${bindAddr}:${port}`, community, trapHost: config.trapHost || null };
    return true;
  } catch(e) {
    _statusData = { error: e.message };
    return false;
  }
}

function _stopAgent() {
  try { _agent?.close?.(); } catch {}
  try { _session?.close?.(); } catch {}
  _agent = null; _session = null;
}

// ── Plugin-Lifecycle ───────────────────────────────────────────────────────────

exports.activate = function activate(context) {
  _ctx     = context;
  _startTime = Date.now();

  const config = context.config || {};
  if (!_startAgent(config)) return;

  // State-Change-Trap senden
  context.on('state', state => {
    const pl    = state.playlist || {};
    let cs = 1;
    if (pl.running && pl.paused) cs = 3;
    else if (pl.running)         cs = 2;
    if (cs !== _lastState) { _lastState = cs; _sendTrap(cs); }
  });

  // Perf-Daten cachen für MIB
  context.on('perf', perf => { _ctx.perf = perf; });
};

exports.deactivate = function deactivate() {
  _stopAgent();
  _statusData = {};
};

exports.getStatus = function getStatus() {
  if (!_agent) return { active: false, ..._statusData };
  const mib = _buildMIB();
  return {
    active:       true,
    ..._statusData,
    channelState: mib[_oid('1.0')],
    currentEvent: mib[_oid('2.0')],
    remainSec:    mib[_oid('4.0')],
    cpu:          mib[_oid('8.0')],
    memFreeMB:    mib[_oid('9.0')],
  };
};
