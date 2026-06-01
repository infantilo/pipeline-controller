'use strict';
/**
 * Subtitle FAB/ESUB Plugin
 *
 * Implementiert FAB Subtitle Automation Protocol und ESUB-XF über TCP/IP.
 * Steuert externe Subtitle-Encoder/Decoder (z.B. EEG, FAB Subtitler, ESUB).
 *
 * FAB Subtitle Automation Protocol:
 *   Textbasiertes TCP-Protokoll. Befehle: LOAD, PLAY, STOP, PAUSE, STATUS, CLEAR
 *   Format: COMMAND\r\n oder COMMAND ARGUMENT\r\n
 *
 * ESUB-XF Protocol:
 *   Binäres/Text-Hybridprotokoll. Konfigurierbare Befehle als Templates.
 *
 * Playlist-Integration:
 *   Wenn Plugin aktiviert: eigene Subtitle-Spalte in der Playlist.
 *   Jedes Event kann ein subtitle-Feld haben: { file, preset, delay, endOffset }
 *
 * Events die das Plugin von PlaylistEngine bekommt:
 *   playlist:playing  → LOAD + PLAY Subtitle-File
 *   playlist:current  → Pre-Cue (LOAD)
 */

const net = require('net');

// ── Plugin-Manifest ────────────────────────────────────────────────────────────
const meta = exports.meta = {
  id:          'subtitle-fab',
  name:        'Subtitle FAB/ESUB',
  version:     '1.1.0',
  description: 'Steuert Subtitle-Encoder über FAB Subtitle Automation Protocol oder ESUB-XF via TCP/IP.',
  hasStatus:   true,
  playlistColumn: {
    id:    'subtitle',
    label: 'SUB',
    width: '52px',
    eventField: 'subtitle',  // welches Feld am Event wird gezeigt
  },

  schema: [
    {
      key: 'protocol', label: 'Protokoll', type: 'select',
      options: [
        { value: 'fab',     label: 'FAB Subtitle Automation Protocol' },
        { value: 'esub-xf', label: 'ESUB-XF (Template-TCP)' },
        { value: 'tcp',     label: 'Generisch TCP (Template)' },
      ],
      default: 'fab',
    },
    { key: 'host', label: 'Host / IP',     type: 'string', default: '192.168.1.200' },
    { key: 'port', label: 'TCP-Port',      type: 'number', default: 9001,
      help: 'FAB: 9001 (Standard). ESUB-XF: 9000.' },
    { key: 'reconnectMs', label: 'Reconnect-Intervall (ms)', type: 'number', default: 5000 },

    // FAB-spezifisch
    { key: 'fabLoadCmd',  label: 'LOAD-Befehl',  type: 'string', default: 'LOAD {{file}}',
      condition: 'protocol=fab',
      help: '{{file}} = Subtitle-Dateiname, {{preset}} = Preset-ID' },
    { key: 'fabPlayCmd',  label: 'PLAY-Befehl',  type: 'string', default: 'PLAY',
      condition: 'protocol=fab' },
    { key: 'fabStopCmd',  label: 'STOP-Befehl',  type: 'string', default: 'STOP',
      condition: 'protocol=fab' },
    { key: 'fabClearCmd', label: 'CLEAR-Befehl', type: 'string', default: 'CLEAR',
      condition: 'protocol=fab' },
    { key: 'fabPreCueCmd',label: 'PRE-CUE-Befehl', type: 'string', default: 'LOAD {{file}}',
      condition: 'protocol=fab',
      help: 'Wird beim Pre-Cue gesendet (5s vor On-Air). {{file}} = Subtitle-File.' },

    // ESUB-XF / TCP Generisch
    { key: 'tcpOnPlay',   label: 'Befehl bei PLAY',  type: 'string', default: 'SUBTITLE PLAY {{file}}\r\n',
      condition: 'protocol=esub-xf,protocol=tcp' },
    { key: 'tcpOnStop',   label: 'Befehl bei STOP',  type: 'string', default: 'SUBTITLE STOP\r\n',
      condition: 'protocol=esub-xf,protocol=tcp' },
    { key: 'tcpOnPreCue', label: 'Befehl bei PRE-CUE', type: 'string', default: 'SUBTITLE LOAD {{file}}\r\n',
      condition: 'protocol=esub-xf,protocol=tcp' },

    // Verzeichnis
    { key: 'subtitleDir', label: 'Subtitle-Verzeichnis', type: 'string', default: '/subtitles',
      help: 'Basis-Pfad für Subtitle-Dateien auf dem Subtitle-Encoder.' },

    // Status-Polling
    { key: 'pollStatus',  label: 'Status-Polling', type: 'boolean', default: false,
      help: 'FAB STATUS-Befehl alle 2s senden um Verbindung zu prüfen.' },
  ],
};

// ── TCP-Verbindung ─────────────────────────────────────────────────────────────

class SubtitleTCP {
  constructor(host, port, reconnectMs, log) {
    this._host         = host;
    this._port         = port;
    this._reconnectMs  = reconnectMs || 5000;
    this._log          = log;
    this._socket       = null;
    this._connected    = false;
    this._reconnTimer  = null;
    this._destroyed    = false;
    this._rxBuf        = '';
    this.onResponse    = null;
  }

  connect() {
    if (this._destroyed) return;
    this._socket = net.createConnection({ host: this._host, port: this._port }, () => {
      this._connected = true;
      this._log(`Verbunden: ${this._host}:${this._port}`, 'info');
    });
    this._socket.setEncoding('utf8');
    this._socket.on('data', d => {
      this._rxBuf += d;
      const lines = this._rxBuf.split(/\r?\n/);
      this._rxBuf  = lines.pop();
      for (const l of lines) { if (l) this.onResponse?.(l.trim()); }
    });
    this._socket.on('close', () => {
      this._connected = false;
      if (!this._destroyed) {
        this._log(`Verbindung getrennt — Reconnect in ${this._reconnectMs}ms`, 'warn');
        this._reconnTimer = setTimeout(() => this.connect(), this._reconnectMs);
      }
    });
    this._socket.on('error', e => this._log(`TCP-Fehler: ${e.message}`, 'warn'));
  }

  send(cmd) {
    if (!this._connected || !this._socket) return false;
    try {
      const line = cmd.endsWith('\n') ? cmd : cmd + '\r\n';
      this._socket.write(line);
      return true;
    } catch(e) { this._log(`send Fehler: ${e.message}`, 'warn'); return false; }
  }

  destroy() {
    this._destroyed = true;
    clearTimeout(this._reconnTimer);
    try { this._socket?.destroy(); } catch {}
    this._socket    = null;
    this._connected = false;
  }

  get connected() { return this._connected; }
}

// ── Template-Auflösung ─────────────────────────────────────────────────────────

function _tpl(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

// ── Plugin-Logik ───────────────────────────────────────────────────────────────

let _tcp         = null;
let _cfg         = {};
let _statusData  = {};
let _pollTimer   = null;
let _currentSub  = null;  // aktive Subtitle-Datei

function _subtitleVars(ev) {
  const sub = ev?.subtitle || {};
  const file = sub.file || ev?.subtitleFile || '';
  return {
    file:    file,
    preset:  sub.preset || '',
    title:   ev?.title  || '',
    evFile:  ev?.file?.split('/').pop() || '',
  };
}

function _sendFAB(cmd, vars) {
  if (!cmd) return;
  _tcp?.send(_tpl(cmd, vars));
}

function _onPlay(d) {
  const ev = d.event || d;
  if (!ev) return;
  const vars = _subtitleVars(ev);
  const hasSub = !!(vars.file);

  if (!hasSub) {
    // kein Subtitle → STOP/CLEAR
    if (_currentSub) {
      _currentSub = null;
      if (_cfg.protocol === 'fab') {
        _sendFAB(_cfg.fabStopCmd || 'STOP', {});
        setTimeout(() => _sendFAB(_cfg.fabClearCmd || 'CLEAR', {}), 100);
      } else {
        _tcp?.send(_tpl(_cfg.tcpOnStop || 'SUBTITLE STOP\r\n', {}));
      }
    }
    return;
  }

  _currentSub = vars.file;

  if (_cfg.protocol === 'fab') {
    _sendFAB(_cfg.fabLoadCmd || 'LOAD {{file}}', vars);
    setTimeout(() => _sendFAB(_cfg.fabPlayCmd || 'PLAY', vars), 100);
  } else {
    _tcp?.send(_tpl(_cfg.tcpOnPlay || 'SUBTITLE PLAY {{file}}\r\n', vars));
  }

  _statusData.lastFile = vars.file;
  _statusData.lastAction = 'PLAY';
}

function _onPreCue(d) {
  const ev = d.event || d;
  if (!ev) return;
  const vars = _subtitleVars(ev);
  if (!vars.file) return;

  if (_cfg.protocol === 'fab') {
    _sendFAB(_cfg.fabPreCueCmd || 'LOAD {{file}}', vars);
  } else {
    _tcp?.send(_tpl(_cfg.tcpOnPreCue || 'SUBTITLE LOAD {{file}}\r\n', vars));
  }
  _statusData.lastPreCue = vars.file;
}

function _onStop() {
  if (!_currentSub) return;
  _currentSub = null;
  if (_cfg.protocol === 'fab') {
    _sendFAB(_cfg.fabStopCmd || 'STOP', {});
    setTimeout(() => _sendFAB(_cfg.fabClearCmd || 'CLEAR', {}), 100);
  } else {
    _tcp?.send(_tpl(_cfg.tcpOnStop || 'SUBTITLE STOP\r\n', {}));
  }
  _statusData.lastAction = 'STOP';
}

// ── Plugin-Lifecycle ───────────────────────────────────────────────────────────

exports.activate = function activate(context) {
  _cfg = context.config || {};
  _statusData = {};

  if (!_cfg.host) {
    _statusData.error = 'Host nicht konfiguriert';
    return;
  }

  _tcp = new SubtitleTCP(
    _cfg.host,
    parseInt(_cfg.port) || 9001,
    parseInt(_cfg.reconnectMs) || 5000,
    (msg, lvl) => context.log?.(msg, lvl),
  );
  _tcp.onResponse = line => {
    _statusData.lastResponse = line;
    context.log?.(`RX: ${line}`, 'debug');
  };
  _tcp.connect();

  context.on('playlist:playing', _onPlay);
  context.on('live:precue',      _onPreCue);
  context.on('playlist:updated', () => {
    // Playlist geändert — eventuell läuft kein Clip mehr
  });

  // Playlist gestoppt → Subtitle stoppen
  context.on('state', st => {
    if (!st.playlist?.running && _currentSub) _onStop();
  });

  if (_cfg.pollStatus && _cfg.protocol === 'fab') {
    _pollTimer = setInterval(() => {
      if (_tcp?.connected) _tcp.send('STATUS');
    }, 2000);
  }

  _statusData.configured = `${_cfg.host}:${parseInt(_cfg.port)||9001}`;
};

exports.deactivate = function deactivate() {
  clearInterval(_pollTimer);
  _pollTimer = null;
  _tcp?.destroy();
  _tcp = null;
  _currentSub  = null;
  _statusData  = {};
};

exports.getStatus = function getStatus() {
  return {
    connected:    _tcp?.connected ?? false,
    currentFile:  _currentSub || null,
    protocol:     _cfg.protocol || 'fab',
    ..._statusData,
  };
};
