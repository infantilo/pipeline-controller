'use strict';
/**
 * SCTE-35 Cue Generator — Pipeline Controller Plugin
 *
 * Erzeugt SCTE-35 splice_info_section Nachrichten aus Playlist-Events
 * und sendet sie als MPEG-TS (188 B) via UDP.
 *
 * Manuell: POST /api/scte35/cue  { cueType:'out'|'in'|'null', durationSec:N }
 */
const dgram = require('dgram');

// ── SCTE-35 Binary Encoder ─────────────────────────────────────────────────────

function _crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= (buf[i] << 24) >>> 0;
    for (let j = 0; j < 8; j++)
      crc = ((crc & 0x80000000) ? ((crc << 1) ^ 0x04C11DB7) : (crc << 1)) >>> 0;
  }
  return (~crc) >>> 0;
}

let _eidCounter = (Date.now() & 0xFFFF);

function buildSection(type, outOfNetwork, durationSec, eventId) {
  const eid = (eventId >>> 0) || ((_eidCounter++) & 0xFFFFFFFF);

  let cmdType, cmdBuf;

  if (type === 'splice_null') {
    cmdType = 0x00;
    cmdBuf  = Buffer.alloc(0);
  } else {
    cmdType = 0x05;
    const hasDur = durationSec != null && durationSec > 0;
    const parts  = [];

    const id4 = Buffer.alloc(4); id4.writeUInt32BE(eid, 0); parts.push(id4);
    parts.push(Buffer.from([0x7F]));
    parts.push(Buffer.from([
      ((outOfNetwork ? 1 : 0) << 7) | (1 << 6) | ((hasDur ? 1 : 0) << 5) | (1 << 4),
    ]));
    if (hasDur) {
      const pts = BigInt(Math.round(durationSec * 90000));
      const d5  = Buffer.alloc(5);
      d5[0] = 0x80 | Number((pts >> 32n) & 1n);
      d5.writeUInt32BE(Number(pts & 0xFFFFFFFFn), 1);
      parts.push(d5);
    }
    const upid = Buffer.alloc(2); upid.writeUInt16BE(eid & 0xFFFF, 0); parts.push(upid);
    parts.push(Buffer.from([0x00, 0x00]));
    cmdBuf = Buffer.concat(parts);
  }

  const bodyLen = 1 + 1 + 4 + 1 + 3 + 1 + cmdBuf.length + 2 + 4;
  const sec     = Buffer.alloc(3 + bodyLen, 0xFF);
  let   p       = 0;

  sec[p++] = 0xFC;
  sec[p++] = 0x30 | ((bodyLen >> 8) & 0x0F);
  sec[p++] = bodyLen & 0xFF;

  sec[p++] = 0x00;
  sec[p++] = 0x00;
  sec.writeUInt32BE(0, p); p += 4;
  sec[p++] = 0xFF;

  sec[p++] = 0xFF;
  sec[p++] = 0xF0 | ((cmdBuf.length >> 8) & 0x0F);
  sec[p++] = cmdBuf.length & 0xFF;

  sec[p++] = cmdType;
  cmdBuf.copy(sec, p); p += cmdBuf.length;

  sec.writeUInt16BE(0, p); p += 2;
  sec.writeUInt32BE(_crc32(sec.slice(0, p)), p); p += 4;

  return sec;
}

let _tsContinuity = 0;
function wrapMpegTs(section, pid) {
  const pkt = Buffer.alloc(188, 0xFF);
  pkt[0] = 0x47;
  pkt[1] = 0x40 | ((pid >> 8) & 0x1F);
  pkt[2] = pid & 0xFF;
  pkt[3] = 0x10 | ((_tsContinuity++) & 0x0F);
  pkt[4] = 0x00;
  section.copy(pkt, 5);
  return pkt;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const NON_CLIP = new Set(['live', 'smpte', 'black', 'image', 'block_start', 'block_end', 'comment']);

function _parseClassList(str) {
  if (!str) return [];
  return String(str).split(/[,;\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
}

function _isLiveEv(ev) {
  return ev?.source === 'live';
}

function _isClipEv(ev) {
  return ev && !NON_CLIP.has(ev.source);
}

function _evClassification(ev) {
  return (ev?.classification || '').toLowerCase().trim();
}

// ── Plugin ─────────────────────────────────────────────────────────────────────

exports.meta = {
  id: 'scte35',
  name: 'SCTE-35 Cue Generator',
  version: '1.1.0',
  description: 'Sendet SCTE-35 Splice-Cues als MPEG-TS/UDP basierend auf Playlist-Events und Classifications.',
  hasStatus: true,
  subscribes: [
    'playlist:playing',
    'playlist:block-start',
    'playlist:block-end',
    'playlist:updated',
    'playlist:started',
    'playlist:ended',
    'scte35:manual-cue',
    'system:shutdown',
  ],
  schema: [
    { key: 'outputHost',           label: 'Ziel-Host (UDP)',                    type: 'string',  default: '127.0.0.1' },
    { key: 'outputPort',           label: 'UDP-Port',                           type: 'number',  default: 5500 },
    { key: 'pid',                  label: 'SCTE-35 PID',                        type: 'number',  default: 500 },
    { key: 'cueOutOnLive',         label: 'Cue-Out bei Live-Events',            type: 'boolean', default: true },
    { key: 'cueInOnClip',          label: 'Cue-In bei Clip-Events',             type: 'boolean', default: true },
    { key: 'cueOutClassifications',label: 'Cue-Out bei Classification (komma-getrennt, z.B. commercial,promo)', type: 'string', default: 'commercial' },
    { key: 'cueInClassifications', label: 'Cue-In bei Classification (leer = alle anderen)', type: 'string', default: '' },
    { key: 'cueOutOnBlock',        label: 'Cue-Out/In bei block_start/block_end', type: 'boolean', default: true },
    { key: 'prerollMs',            label: 'Pre-Roll (ms vor Event-Start)',       type: 'number',  default: 0 },
    { key: 'durationSec',          label: 'Cue-Out Dauer (s, 0=offen)',         type: 'number',  default: 0 },
    { key: 'keepaliveHz',          label: 'Keepalive splice_null (Hz, 0=aus)',   type: 'number',  default: 1 },
  ],
};

let _api, _cfg;
let _sock         = null;
let _keepTimer    = null;
let _scanTimer    = null;
let _scheduled    = [];
let _inBreak      = false;
let _stats        = { sent: 0, errors: 0 };
let _lastCue      = null;

function _sendSection(type, outOfNetwork, durationSec) {
  if (!_sock) return;
  const host = _cfg.outputHost || '127.0.0.1';
  const port = parseInt(_cfg.outputPort) || 5500;
  const pid  = parseInt(_cfg.pid)        || 500;
  try {
    const sec = buildSection(type, outOfNetwork, durationSec ?? null);
    const pkt = wrapMpegTs(sec, pid);
    _sock.send(pkt, 0, 188, port, host, err => {
      if (err) { _stats.errors++; _api?.log('warn', `UDP: ${err.message}`); return; }
      _stats.sent++;
    });
    _lastCue = {
      type,
      dir:  type === 'splice_null' ? 'NULL' : (outOfNetwork ? 'CUE-OUT' : 'CUE-IN'),
      dur:  durationSec ?? null,
      ts:   Date.now(),
    };
    _pushStatus();
    _api?.log('info', `SCTE-35 ${_lastCue.dir}${durationSec ? ` dur=${durationSec}s` : ''} → ${host}:${port} PID=${pid}`);
  } catch (e) {
    _stats.errors++;
    _api?.log('error', `build: ${e.message}`);
    _pushStatus('error');
  }
}

function _sendNull() {
  if (!_sock) return;
  const host = _cfg.outputHost || '127.0.0.1';
  const port = parseInt(_cfg.outputPort) || 5500;
  const pid  = parseInt(_cfg.pid) || 500;
  try {
    _sock.send(wrapMpegTs(buildSection('splice_null', false, null), pid), 0, 188, port, host);
  } catch {}
}

function _pushStatus(state = 'ok') {
  _api?.setStatus(state, {
    target:  `${_cfg.outputHost||'127.0.0.1'}:${_cfg.outputPort||5500}`,
    pid:      _cfg.pid || 500,
    inBreak:  _inBreak,
    lastCue:  _lastCue,
    stats:    { ..._stats },
  });
}

function _startKeepalive() {
  if (_keepTimer) { clearInterval(_keepTimer); _keepTimer = null; }
  const hz = parseFloat(_cfg.keepaliveHz) || 0;
  if (hz > 0) _keepTimer = setInterval(_sendNull, Math.max(100, Math.round(1000 / hz)));
}

function _clearScheduled() {
  for (const t of _scheduled) clearTimeout(t);
  _scheduled = [];
}

// ── Classification-based trigger logic ─────────────────────────────────────────

function _shouldCueOut(ev) {
  if (!ev) return false;
  if (_isLiveEv(ev) && _cfg.cueOutOnLive) return true;
  const cls = _evClassification(ev);
  if (!cls) return false;
  const outList = _parseClassList(_cfg.cueOutClassifications);
  return outList.length > 0 && outList.includes(cls);
}

function _shouldCueIn(ev) {
  if (!ev) return false;
  if (_isClipEv(ev) && _cfg.cueInOnClip) {
    const cls = _evClassification(ev);
    const outList = _parseClassList(_cfg.cueOutClassifications);
    // A clip that is NOT itself a cue-out classification → cue-in
    if (outList.length === 0 || !outList.includes(cls)) return true;
  }
  const inList = _parseClassList(_cfg.cueInClassifications);
  if (inList.length === 0) return false;
  return inList.includes(_evClassification(ev));
}

// ── Polling scan for pre-roll scheduling ──────────────────────────────────────

/**
 * Estimates the absolute start time (ms epoch) of a playlist event at index `idx`.
 * Uses the PlaylistEngine's current state (playing event + elapsed position).
 */
async function _estimateStartMs(playlist, idx, state) {
  if (!Array.isArray(playlist) || idx < 0 || idx >= playlist.length) return null;

  // Find last 'playing' or 'done' event with a known wall-clock anchor
  const playingIdx = state?.playlistIndex ?? -1;
  const posMs      = (state?.position ?? 0) * 1000;    // seconds → ms
  const anchorMs   = Date.now() - posMs;                // approx. start of current event

  if (playingIdx < 0) return null;

  // Walk from playingIdx to idx, accumulating durations
  let accMs = anchorMs;
  for (let i = playingIdx; i < idx; i++) {
    const ev = playlist[i];
    if (!ev) return null;
    const dur = (ev.duration ?? ev.dur ?? 0) * 1000;
    accMs += dur;
  }
  return accMs;
}

async function _scan() {
  if (!_api) return;
  try {
    const state    = await _api.getState();
    const playlist = await _api.getPlaylist();
    if (!Array.isArray(playlist) || !state?.playing) return;

    _clearScheduled();
    const now     = Date.now();
    const preroll = parseInt(_cfg.prerollMs) || 0;
    const dur     = parseFloat(_cfg.durationSec) || 0;
    const outList = _parseClassList(_cfg.cueOutClassifications);

    for (let i = 0; i < playlist.length; i++) {
      const ev = playlist[i];
      if (!ev || ev.state === 'done') continue;

      const absMs = await _estimateStartMs(playlist, i, state);
      if (absMs == null || absMs < now - 2000) continue;

      const delay = (absMs - preroll) - now;
      if (delay < 0 || delay > 3600_000) continue;   // ignore past or >1h future

      const cls = _evClassification(ev);

      if (outList.length > 0 && outList.includes(cls)) {
        _scheduled.push(setTimeout(() => {
          if (!_inBreak) {
            _inBreak = true;
            _sendSection('splice_insert', true, dur > 0 ? dur : null);
          }
        }, delay));
      } else if (_isLiveEv(ev) && _cfg.cueOutOnLive) {
        _scheduled.push(setTimeout(() => {
          if (!_inBreak) {
            _inBreak = true;
            _sendSection('splice_insert', true, dur > 0 ? dur : null);
          }
        }, delay));
      } else if (_inBreak && _shouldCueIn(ev)) {
        _scheduled.push(setTimeout(() => {
          _inBreak = false;
          _sendSection('splice_insert', false, null);
        }, delay));
      }
    }
  } catch (e) {
    _api?.log('warn', `scan: ${e.message}`);
  }
}

function _startScan() {
  if (_scanTimer) { clearInterval(_scanTimer); _scanTimer = null; }
  const preroll = parseInt(_cfg.prerollMs) || 0;
  // Only run periodic scan when pre-roll is configured
  if (preroll > 0) _scanTimer = setInterval(_scan, 10_000);
}

// ── Plugin lifecycle ───────────────────────────────────────────────────────────

exports.init = async function(config, api) {
  _api = api;
  _cfg = config || {};
  _sock = dgram.createSocket('udp4');
  _sock.on('error', e => api.log('warn', `socket: ${e.message}`));
  _startKeepalive();
  _startScan();
  _pushStatus();
};

exports.onEvent = async function(type, data) {
  try {
    const dur = parseFloat(_cfg.durationSec) || 0;

    switch (type) {

      case 'playlist:playing': {
        const ev = data?.event;
        if (_shouldCueOut(ev)) {
          _inBreak = true;
          _sendSection('splice_insert', true, dur > 0 ? dur : null);
        } else if (_inBreak && _shouldCueIn(ev)) {
          _inBreak = false;
          _sendSection('splice_insert', false, null);
        }
        break;
      }

      case 'playlist:block-start': {
        if (!_cfg.cueOutOnBlock) break;
        const ev = data?.event;
        // Check if the block itself (or any of its known children) is commercial
        const cls = _evClassification(ev);
        const outList = _parseClassList(_cfg.cueOutClassifications);
        const isCommercialBlock = (outList.length > 0 && outList.includes(cls)) ||
          (Array.isArray(ev?.children) && ev.children.some(c => outList.includes(_evClassification(c))));
        if (isCommercialBlock) {
          _inBreak = true;
          const blockDurSec = data?.blockDur ?? 0;
          _sendSection('splice_insert', true, blockDurSec > 0 ? blockDurSec : (dur > 0 ? dur : null));
        }
        break;
      }

      case 'playlist:block-end': {
        if (!_cfg.cueOutOnBlock) break;
        if (_inBreak) {
          _inBreak = false;
          _sendSection('splice_insert', false, null);
        }
        break;
      }

      case 'playlist:updated':
        if (parseInt(_cfg.prerollMs) > 0) _scan().catch(() => {});
        break;

      case 'playlist:started':
        _inBreak = false;
        _clearScheduled();
        if (parseInt(_cfg.prerollMs) > 0) _scan().catch(() => {});
        break;

      case 'playlist:ended':
        _inBreak = false;
        _clearScheduled();
        _pushStatus();
        break;

      case 'scte35:manual-cue': {
        const cueType = data?.cueType;
        const durSec  = parseFloat(data?.durationSec) || 0;
        if (cueType === 'out') {
          _inBreak = true;
          _sendSection('splice_insert', true,  durSec > 0 ? durSec : null);
        } else if (cueType === 'in') {
          _inBreak = false;
          _sendSection('splice_insert', false, null);
        } else {
          _sendNull();
        }
        break;
      }

      case 'system:shutdown':
        _clearScheduled();
        if (_keepTimer) { clearInterval(_keepTimer); _keepTimer = null; }
        if (_scanTimer) { clearInterval(_scanTimer); _scanTimer = null; }
        try { _sock?.close(); } catch {}
        _sock = null;
        break;
    }
  } catch (e) {
    _api?.log('error', `onEvent(${type}): ${e.message}`);
  }
};

exports.onConfigUpdate = function(newCfg) {
  _cfg = newCfg;
  _startKeepalive();
  _startScan();
  _pushStatus();
};

exports.destroy = function() {
  _clearScheduled();
  if (_keepTimer) { clearInterval(_keepTimer); _keepTimer = null; }
  if (_scanTimer) { clearInterval(_scanTimer); _scanTimer = null; }
  try { _sock?.close(); } catch {}
  _sock = null;
};
