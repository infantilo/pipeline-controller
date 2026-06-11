'use strict';

const fs   = require('fs');
const path = require('path');
const { Client: FtpClient } = require('basic-ftp');

const _RECORDINGS_DIR = path.join(__dirname, '../../recordings');

// ── Plugin-Manifest ────────────────────────────────────────────────────────────
const meta = exports.meta = {
  id:          'file-transfer-manager',
  name:        'File Transfer Manager',
  version:     '1.3.0',
  description: 'Kopiert fehlende Mediendateien von FTP/Netzlaufwerk in den Medien-Ordner, bevor sie in der Playlist abgespielt werden.',
  hasStatus:   true,

  schema: [
    {
      key: 'protocol', label: 'Protokoll', type: 'select',
      options: [
        { value: 'ftp',   label: 'FTP' },
        { value: 'ftps',  label: 'FTPS (explizit)' },
        { value: 'local', label: 'Lokaler/Netzwerk-Pfad (mount)' },
      ],
      default: 'local',
    },
    { key: 'host',     label: 'FTP Host',      type: 'string',   default: '', condition: 'protocol!=local' },
    { key: 'port',     label: 'FTP Port',      type: 'number',   default: 21, condition: 'protocol!=local' },
    { key: 'username', label: 'Benutzername',  type: 'string',   default: '', condition: 'protocol!=local' },
    { key: 'password', label: 'Passwort',      type: 'password', default: '', condition: 'protocol!=local' },
    {
      key: 'remotePath', label: 'Remote-Basispfad', type: 'string', default: '/',
      condition: 'protocol!=local',
    },
    {
      key: 'sourcePaths', label: 'Quell-Verzeichnisse', type: 'dirlist',
      default: _RECORDINGS_DIR,
      condition: 'protocol=local',
      help: 'Einen Pfad pro Zeile. Dateien werden VON hier in den Medien-Ordner kopiert.',
    },
    {
      key: 'destDir', label: 'Ziel-Verzeichnis (Medien-Ordner)', type: 'dirpicker',
      default: '',
      help: 'Leer lassen = automatisch aus Systemkonfiguration (MEDIA_DIR).',
    },
    {
      key: 'preFetchMinutes', label: 'Voraus-Transfer (Min.)', type: 'number', default: 60,
      help: 'Transfer starten wenn Event innerhalb dieser Zeit in der Playlist erscheint.',
    },
    {
      key: 'deleteAfterMinutes', label: 'Löschen nach (Min.)', type: 'number', default: 120,
      help: 'Lokale Datei löschen, wenn sie X Minuten nach der letzten Nutzung nicht mehr in der Playlist ist.',
    },
    { key: 'maxCacheGB',          label: 'Max. Speicher (GB)',  type: 'number', default: 50 },
    { key: 'concurrentTransfers', label: 'Parallele Transfers', type: 'number', default: 2, min: 1, max: 8 },
    {
      key: 'fileExtensions', label: 'Dateierweiterungen (kommasepariert)',
      type: 'string', default: 'mxf,mov,mp4,ts,mpeg,mpg,mkv',
      help: 'Nur Dateien mit diesen Erweiterungen werden verwaltet.',
    },
    {
      key: 'enabled', label: 'Transfer aktiviert', type: 'boolean', default: true,
      help: 'Deaktivieren zum Pausieren aller Transfers.',
    },
  ],

  subscribes: [
    'playlist:updated',
    'playlist:playing',
    'player:cued',
    'system:shutdown',
  ],
};

// ── State ─────────────────────────────────────────────────────────────────────
let _api;
let _config = {};

const _transfers = new Map();  // filename → TransferEntry
const _lastUsed  = new Map();  // localPath → { ts }
const _activeFtp = new Set();
const _fileOrder = new Map();  // file → playlist distance from on-air

let _scanTimer     = null;
let _houseTimer    = null;
let _activeWorkers = 0;
let _libCache      = {};
let _libCacheTs    = 0;

// System dirs fetched from server state (mediaDir, recordDir, backupMediaDirs)
let _sysDirs   = [];
let _sysDirsTs = 0;

// ── Lifecycle ─────────────────────────────────────────────────────────────────
exports.init = async function (config, api) {
  _api    = api;
  _config = { ..._defaults(), ...config };
  await _refreshSysDirs();  // must run before _destDir() is used
  _ensureDestDir();
  _startTimers();
  _publishStatus();
};

exports.onEvent = async function (name, data) {
  switch (name) {
    case 'playlist:updated':
      await _scanPlaylist(data?.events || data || []);
      break;
    case 'playlist:playing': {
      try {
        const pl = await _api.getPlaylist();
        await _scanPlaylist(pl || []);
      } catch {
        await _scanPlaylist(data?.events || data || []);
      }
      break;
    }
    case 'player:cued':
      if (data?.filePath) _markUsed(data.filePath);
      break;
    case 'system:shutdown':
      await _destroy();
      break;
  }
};

exports.destroy = async function () { await _destroy(); };

// ── Config ────────────────────────────────────────────────────────────────────
function _defaults() {
  return {
    protocol:            'local',
    host:                '',
    port:                21,
    username:            '',
    password:            '',
    remotePath:          '/',
    sourcePaths:         _RECORDINGS_DIR,
    destDir:             '',
    preFetchMinutes:     60,
    deleteAfterMinutes:  120,
    maxCacheGB:          50,
    concurrentTransfers: 2,
    fileExtensions:      'mxf,mov,mp4,ts,mpeg,mpg,mkv',
    enabled:             true,
  };
}

function _extensions() {
  return (_config.fileExtensions || 'mxf,mov,mp4,ts')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
}

function _isManaged(filename) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return _extensions().includes(ext);
}

// Effective destination directory: explicit config or MEDIA_DIR from system state
function _destDir() {
  const explicit = (_config.destDir || '').trim();
  return explicit || _sysDirs[0] || '/tmp/ftm-cache-fallback';
}

// Source directories configured in plugin (for files to be COPIED FROM)
function _sourceDirs() {
  const raw = _config.sourcePaths || '';
  return raw.split('\n').map(s => s.trim()).filter(Boolean);
}

// Find basename in configured source dirs; returns full path or null
function _findInSourceDirs(basename) {
  for (const dir of _sourceDirs()) {
    try {
      const p = path.join(dir, basename);
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

// Find basename in system dirs (MEDIA_DIR, recordDir, backupDirs) — already-local files
function _findInSysDirs(basename) {
  for (const dir of _sysDirs) {
    try {
      const p = path.join(dir, basename);
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

// ── System dirs from server state ────────────────────────────────────────────
async function _refreshSysDirs() {
  if (Date.now() - _sysDirsTs < 60_000) return;
  try {
    const state = await _api.getState();
    const cfg   = state?.config || {};
    const dirs  = [
      cfg.mediaDir,
      cfg.recordDir,
      ...(Array.isArray(cfg.backupMediaDirs) ? cfg.backupMediaDirs : []),
    ].filter(d => d && typeof d === 'string');
    if (dirs.length) {
      _sysDirs   = dirs;
      _sysDirsTs = Date.now();
      _api.log('info', `FTM: System-Verzeichnisse: ${dirs.join(', ')}`);
    } else {
      _sysDirsTs = Date.now(); // don't retry immediately even if empty
    }
  } catch {}
}

// ── Destination dir ───────────────────────────────────────────────────────────
function _ensureDestDir() {
  const dir = _destDir();
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { _api.log('warn', `Ziel-Verzeichnis anlegen (${dir}): ${e.message}`); }
}

// ── Timers ────────────────────────────────────────────────────────────────────
function _startTimers() {
  _scanTimer = setInterval(async () => {
    try { const pl = await _api.getPlaylist(); await _scanPlaylist(pl || []); } catch {}
  }, 30_000);
  _houseTimer = setInterval(() => _housekeeping(), 5 * 60_000);
}

function _stopTimers() {
  if (_scanTimer)  { clearInterval(_scanTimer);  _scanTimer  = null; }
  if (_houseTimer) { clearInterval(_houseTimer); _houseTimer = null; }
}

// ── Library cache ─────────────────────────────────────────────────────────────
async function _getLibrary() {
  if (Date.now() - _libCacheTs < 30_000) return _libCache;
  try {
    const lib = await _api.getLibrary();
    if (lib && typeof lib === 'object') { _libCache = lib; _libCacheTs = Date.now(); }
  } catch {}
  return _libCache;
}

// ── Playlist scan ─────────────────────────────────────────────────────────────
async function _scanPlaylist(events) {
  if (!_config.enabled) return;
  if (!Array.isArray(events)) return;

  await _refreshSysDirs();

  // Determine current on-air index
  let currentIdx = 0;
  for (let i = 0; i < events.length; i++) {
    const st = events[i]._state;
    if (st === 'playing') { currentIdx = i; break; }
    if (st === 'done' || st === 'skipped') currentIdx = i + 1;
  }

  // Build priority map (playlist position from on-air)
  _fileOrder.clear();
  let pos = 0;
  for (let i = currentIdx; i < events.length; i++) {
    const ev = events[i];
    if (ev._state === 'done' || ev._state === 'skipped') continue;
    const file = ev.file;
    if (file && _isManaged(file) && !_fileOrder.has(file)) _fileOrder.set(file, pos++);
  }

  const library = await _getLibrary();
  const dest    = _destDir();

  for (let i = currentIdx; i < events.length; i++) {
    const ev   = events[i];
    const file = ev.file;
    if (!file || !_isManaged(file)) continue;
    if (ev._state === 'done' || ev._state === 'skipped') continue;

    const baseName  = path.basename(file);
    const localPath = path.join(dest, baseName);

    // 1) File exists at its absolute playlist path
    if (path.isAbsolute(file) && fs.existsSync(file)) {
      _markReady(file, file); continue;
    }

    // 2) File indexed in media library with valid path
    const libEntry = library[file] || library[baseName];
    if (libEntry && !libEntry.error) {
      const libPath = typeof libEntry.filePath === 'string' ? libEntry.filePath
                    : (path.isAbsolute(libEntry.fileName || '') ? libEntry.fileName : null);
      if (libPath && fs.existsSync(libPath)) {
        _markReady(file, libPath); continue;
      }
    }

    // 3) File found in system dirs (MEDIA_DIR, recordDir, backupDirs) — already local
    const sysPath = _findInSysDirs(baseName);
    if (sysPath) { _markReady(file, sysPath); continue; }

    // 4) File already in destination dir
    if (fs.existsSync(localPath)) {
      _markReady(file, localPath); continue;
    }

    // 5) Transfer already active or successfully completed
    const existing = _transfers.get(file);
    if (existing && (existing.state === 'queued' || existing.state === 'transferring' || existing.state === 'ready')) continue;

    // 6) File missing — queue transfer FROM source dirs TO destination (MEDIA_DIR)
    _queueTransfer(file, localPath);
  }

  _drainQueue();
  _publishStatus();
}

function _markReady(file, resolvedPath) {
  const ex = _transfers.get(file);
  if (!ex || ex.state !== 'ready' || ex.localPath !== resolvedPath) {
    _setTransfer(file, { state: 'ready', progress: 100, localPath: resolvedPath, error: null, bytes: 0, totalBytes: 0 });
    _api.resolveLocal(file, resolvedPath);
  }
}

// ── Transfer queue ─────────────────────────────────────────────────────────────
function _queueTransfer(file, localPath) {
  _setTransfer(file, { state: 'queued', progress: 0, localPath, remoteFull: null, error: null, bytes: 0, totalBytes: 0 });
  _api.log('info', `In Transfer-Queue: ${file} → ${localPath}`);
}

function _drainQueue() {
  const maxWorkers = Math.max(1, Math.min(8, _config.concurrentTransfers || 2));
  if (_activeWorkers >= maxWorkers) return;

  const queued = Array.from(_transfers.values())
    .filter(e => e.state === 'queued')
    .sort((a, b) => {
      const pa = _fileOrder.get(a.file) ?? Infinity;
      const pb = _fileOrder.get(b.file) ?? Infinity;
      return pa - pb;
    });

  for (const entry of queued) {
    if (_activeWorkers >= maxWorkers) break;
    _activeWorkers++;
    _doTransfer(entry.file, entry).finally(() => {
      _activeWorkers--;
      _drainQueue();
    });
  }
}

// ── Execute transfer ──────────────────────────────────────────────────────────
async function _doTransfer(file, entry) {
  const { localPath } = entry;
  const baseName = path.basename(file);
  let srcPath;

  if (_config.protocol === 'local') {
    // Search all configured source directories
    srcPath = _findInSourceDirs(baseName);
    if (!srcPath) {
      const searched = _sourceDirs().join(', ') || '(keine Quell-Verzeichnisse konfiguriert)';
      _setTransfer(file, { ...entry, state: 'error', error: `Nicht gefunden in: ${searched}` });
      _publishStatus(); return;
    }
    // File is already at destination (shouldn't happen if _scanPlaylist is correct, but be safe)
    if (path.resolve(srcPath) === path.resolve(localPath)) {
      _markReady(file, localPath);
      _publishStatus(); return;
    }
  } else {
    if (!_config.host) {
      _setTransfer(file, { ...entry, state: 'error', error: 'Kein FTP-Host konfiguriert' });
      _publishStatus(); return;
    }
    const base = (_config.remotePath || '/').trim().replace(/\/+$/, '');
    srcPath = `${base}/${baseName}`;
  }

  // Ensure destination directory exists
  try { fs.mkdirSync(path.dirname(localPath), { recursive: true }); } catch {}

  _setTransfer(file, { ...entry, state: 'transferring', progress: 0, remoteFull: srcPath });
  _publishStatus();

  const tmpPath = localPath + '.ftm-tmp';

  try {
    if (_config.protocol === 'local') {
      await _copyLocal(srcPath, tmpPath, file);
    } else {
      await _copyFtp(srcPath, tmpPath, file);
    }

    fs.renameSync(tmpPath, localPath);
    _setTransfer(file, { ..._transfers.get(file), state: 'ready', progress: 100, error: null });
    _api.resolveLocal(file, localPath);
    _api.log('info', `Transfer fertig: ${baseName} → ${localPath}`);
    _api.notify(`Transfer fertig: ${baseName}`, 'success');
  } catch (e) {
    _api.log('warn', `Transfer-Fehler ${file}: ${e.message}`);
    _setTransfer(file, { ..._transfers.get(file), state: 'error', error: e.message });
    try { fs.unlinkSync(tmpPath); } catch {}
  }

  _publishStatus();
}

// ── FTP transfer ──────────────────────────────────────────────────────────────
async function _copyFtp(remotePath, localTmp, fileKey) {
  const client = new FtpClient();
  client.ftp.verbose = false;
  _activeFtp.add(client);

  try {
    await client.access({
      host:     _config.host,
      port:     _config.port || 21,
      user:     _config.username || 'anonymous',
      password: _config.password || '',
      secure:   _config.protocol === 'ftps',
      secureOptions: { rejectUnauthorized: false },
    });

    let total = 0;
    try { total = await client.size(remotePath); } catch {}
    if (total > 0) _setTransfer(fileKey, { ..._transfers.get(fileKey), totalBytes: total });

    client.trackProgress(info => {
      if (total > 0) {
        const pct = Math.round((info.bytes / total) * 100);
        _setTransfer(fileKey, { ..._transfers.get(fileKey), bytes: info.bytes, progress: pct });
        if (pct % 5 === 0) _publishStatus();
      }
    });

    fs.mkdirSync(path.dirname(localTmp), { recursive: true });
    await client.downloadTo(localTmp, remotePath);
  } finally {
    client.trackProgress();
    _activeFtp.delete(client);
    client.close();
  }
}

// ── Local copy ────────────────────────────────────────────────────────────────
async function _copyLocal(srcPath, localTmp, fileKey) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(localTmp), { recursive: true });

    try {
      fs.accessSync(srcPath, fs.constants.R_OK);
    } catch (e) {
      return reject(new Error(
        e.code === 'ENOENT' ? `Quelldatei nicht gefunden: ${srcPath}`
                            : `Kein Lesezugriff (${e.code}): ${srcPath}`
      ));
    }

    let total = 0;
    try { total = fs.statSync(srcPath).size; } catch {}
    if (total > 0) _setTransfer(fileKey, { ..._transfers.get(fileKey), totalBytes: total });

    const rd = fs.createReadStream(srcPath);
    const wr = fs.createWriteStream(localTmp);
    let bytes = 0;

    rd.on('data', chunk => {
      bytes += chunk.length;
      if (total > 0) {
        const pct = Math.round((bytes / total) * 100);
        _setTransfer(fileKey, { ..._transfers.get(fileKey), bytes, progress: pct });
        if (pct % 5 === 0) _publishStatus();
      }
    });
    rd.on('error', err => { wr.destroy(); reject(err); });
    wr.on('error', reject);
    wr.on('finish', resolve);
    rd.pipe(wr);
  });
}

// ── Housekeeping ──────────────────────────────────────────────────────────────
async function _housekeeping() {
  const deleteAfterMs = (_config.deleteAfterMinutes || 120) * 60_000;
  const dest = _destDir();
  if (!dest || !fs.existsSync(dest)) return;

  let currentFiles = new Set();
  try {
    const pl = await _api.getPlaylist();
    for (const ev of (pl || [])) {
      if (ev.file) currentFiles.add(path.basename(ev.file));
    }
  } catch {}

  let deletedCount = 0;
  const now = Date.now();

  for (const [file, entry] of _transfers) {
    if (entry.state !== 'ready') continue;

    // Never delete files that live in system dirs or at their original path
    const absLocal = path.resolve(entry.localPath);
    const inSys = _sysDirs.some(d => absLocal.startsWith(path.resolve(d) + path.sep) || absLocal === path.resolve(d));
    if (inSys || absLocal === path.resolve(entry.file)) continue;

    if (currentFiles.has(path.basename(entry.localPath))) continue;

    const lastUse = _lastUsed.get(entry.localPath)?.ts || 0;
    if (now - lastUse < deleteAfterMs) continue;

    try {
      fs.unlinkSync(entry.localPath);
      _api.clearLocal(file);
      _transfers.delete(file);
      _lastUsed.delete(entry.localPath);
      deletedCount++;
      _api.log('info', `Housekeeping: ${path.basename(file)} gelöscht`);
    } catch (e) {
      _api.log('warn', `Housekeeping-Fehler ${file}: ${e.message}`);
    }
  }

  if (deletedCount > 0) {
    _api.notify(`Housekeeping: ${deletedCount} Datei(en) gelöscht`, 'info');
    _publishStatus();
  }

  _checkDestSize(dest);
}

function _checkDestSize(dest) {
  const maxBytes = (_config.maxCacheGB || 50) * 1024 * 1024 * 1024;
  let total = 0;
  try {
    for (const f of fs.readdirSync(dest)) {
      try { total += fs.statSync(path.join(dest, f)).size; } catch {}
    }
  } catch { return; }
  if (total > maxBytes) {
    _api.log('warn', `Ziel-Ordner ${(total / 1e9).toFixed(1)} GB > Limit ${_config.maxCacheGB} GB`);
    _api.notify(`Speicher-Warnung: ${(total / 1e9).toFixed(1)} GB / ${_config.maxCacheGB} GB`, 'warn');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _markUsed(localPath) {
  _lastUsed.set(localPath, { ts: Date.now() });
}

function _setTransfer(file, entry) {
  _transfers.set(file, { file, ...entry });
}

// ── Status publish ─────────────────────────────────────────────────────────────
function _publishStatus() {
  const dest = _destDir();
  const list = Array.from(_transfers.values())
    .sort((a, b) => {
      const stateOrder = { transferring: 0, queued: 1, ready: 2, error: 3, skipped: 4 };
      const so = (stateOrder[a.state] ?? 9) - (stateOrder[b.state] ?? 9);
      if (so !== 0) return so;
      const pa = _fileOrder.get(a.file) ?? Infinity;
      const pb = _fileOrder.get(b.file) ?? Infinity;
      return pa - pb;
    })
    .map(t => ({
      file:       path.basename(t.file),
      state:      t.state,
      progress:   t.progress,
      error:      t.error,
      bytes:      t.bytes,
      totalBytes: t.totalBytes,
      priority:   _fileOrder.get(t.file) ?? null,
    }));

  const queued       = list.filter(t => t.state === 'queued').length;
  const transferring = list.filter(t => t.state === 'transferring').length;
  const errors       = list.filter(t => t.state === 'error').length;

  const state = (transferring > 0 || queued > 0) ? 'running'
              : errors > 0 ? 'warning' : 'idle';

  _api.setStatus(state, {
    transfers: list,
    summary: { queued, transferring, ready: list.filter(t=>t.state==='ready').length, errors, destDir: dest },
  });
}

// ── Shutdown ───────────────────────────────────────────────────────────────────
async function _destroy() {
  _stopTimers();
  for (const client of _activeFtp) { try { client.close(); } catch {} }
  _activeFtp.clear();
}
