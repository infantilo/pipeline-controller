'use strict';

const fs               = require('fs');
const path             = require('path');
const { execFile }     = require('child_process');
const { analyzeFile }  = require('./MediaAnalyzer');

// Remux via ffmpeg -c copy to write proper duration header.
function _remuxInPlace(filePath) {
  const ext = path.extname(filePath);
  const tmp = (ext ? filePath.slice(0, -ext.length) : filePath) + '.__r' + (ext || '.mkv');
  return new Promise(resolve => {
    execFile('ffmpeg', ['-i', filePath, '-c', 'copy', '-y', tmp], { timeout: 300000 }, (err) => {
      if (err) { try { fs.unlinkSync(tmp); } catch {} return resolve(false); }
      try { fs.renameSync(tmp, filePath); resolve(true); }
      catch { try { fs.unlinkSync(tmp); } catch {} resolve(false); }
    });
  });
}

const SUPPORTED  = /\.(mxf|mp4|mov|ts|mts|mkv|wav|mp3|aac|flac|ogg|m4a)$/i;
const AUDIO_ONLY = /\.(wav|mp3|aac|flac|ogg|m4a)$/i;
const SCAN_INTERVAL_MS = 5000;

class MediaLibrary {
  constructor(mediaDir, dbPath) {
    this.mediaDir  = mediaDir;
    this.dbPath    = dbPath;
    this.library   = {};   // key → mediaInfo  (relative for mediaDir, absolute for extraDirs)
    this._timer    = null;
    this._listeners = [];
    this._extraDirs  = [];  // [{dir, tag}]
    this._locked     = new Set(); // absolute paths currently being written — skip analysis
    this._audioConfig = { groups: [], presets: {} };
  }

  lock(filePath)   { this._locked.add(filePath); }
  unlock(filePath) { this._locked.delete(filePath); }

  setAudioConfig(groups, presets) {
    this._audioConfig = { groups: groups || [], presets: presets || {} };
  }

  // ── Extra dirs ─────────────────────────────────────────────────────────────

  addExtraDir(dir, tag = '') {
    if (this._extraDirs.some(e => e.dir === dir)) return;
    this._extraDirs.push({ dir, tag });
  }

  removeExtraDir(dir) {
    this._extraDirs = this._extraDirs.filter(e => e.dir !== dir);
    // purge entries that came from this dir
    for (const key of Object.keys(this.library)) {
      if (path.isAbsolute(key) && key.startsWith(dir + path.sep)) {
        delete this.library[key];
        this._emit('removed', { fileName: key });
      }
    }
    this.save();
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  load() {
    try {
      if (fs.existsSync(this.dbPath)) {
        this.library = JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
      }
    } catch { this.library = {}; }
    return this;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
      fs.writeFileSync(this.dbPath, JSON.stringify(this.library, null, 2));
    } catch(e) { console.error('MediaLibrary save error:', e.message); }
  }

  // ── Scanning ───────────────────────────────────────────────────────────────

  async scan() {
    if (!fs.existsSync(this.mediaDir)) {
      fs.mkdirSync(this.mediaDir, { recursive: true });
    }

    const mainFiles = fs.existsSync(this.mediaDir)
      ? fs.readdirSync(this.mediaDir).filter(f => SUPPORTED.test(f))
      : [];

    // keys expected in library after this scan
    const expectedKeys = new Set();
    let changed = false;

    // ── main dir (relative keys) ──
    for (const fileName of mainFiles) {
      const filePath = path.join(this.mediaDir, fileName);
      expectedKeys.add(fileName);
      if (this._locked.has(filePath)) continue;
      const stat     = fs.statSync(filePath);
      const existing = this.library[fileName];
      if (!existing || existing.fileSize !== stat.size) {
        try {
          const info = await analyzeFile(filePath, this._audioConfig);
          info.fileSize = stat.size;
          this.library[fileName] = info;
          changed = true;
          this._emit('analyzed', { fileName, info });
        } catch(e) {
          this.library[fileName] = { fileName, filePath, error: e.message, analyzedAt: Date.now(), fileSize: stat.size };
          this._emit('error', { fileName, error: e.message });
        }
      }
    }

    // ── extra dirs (absolute keys) ──
    for (const { dir, tag } of this._extraDirs) {
      if (!fs.existsSync(dir)) continue;
      let dirFiles;
      try { dirFiles = fs.readdirSync(dir).filter(f => SUPPORTED.test(f)); } catch { continue; }
      for (const baseName of dirFiles) {
        const filePath = path.join(dir, baseName);
        expectedKeys.add(filePath);
        if (this._locked.has(filePath)) continue;
        let stat;
        try { stat = fs.statSync(filePath); } catch { continue; }
        const existing = this.library[filePath];
        if (!existing || existing.fileSize !== stat.size) {
          try {
            const info = await analyzeFile(filePath, this._audioConfig);
            info.fileSize = stat.size;
            info._tag     = tag || undefined;
            info._displayName = baseName;
            this.library[filePath] = info;
            changed = true;
            this._emit('analyzed', { fileName: filePath, info });
          } catch(e) {
            this.library[filePath] = { fileName: filePath, filePath, error: e.message, analyzedAt: Date.now(), fileSize: stat.size, _tag: tag || undefined, _displayName: baseName };
            this._emit('error', { fileName: filePath, error: e.message });
          }
        }
      }
    }

    // Remove deleted files
    for (const key of Object.keys(this.library)) {
      if (!expectedKeys.has(key)) {
        // Only remove keys that belong to tracked dirs
        const isMain  = !path.isAbsolute(key);
        const isExtra = path.isAbsolute(key) && this._extraDirs.some(e => key.startsWith(e.dir + path.sep));
        if (isMain || isExtra) {
          delete this.library[key];
          changed = true;
          this._emit('removed', { fileName: key });
        }
      }
    }

    if (changed) this.save();
    return [];
  }

  async reanalyzeFile(fileName) {
    const filePath = path.isAbsolute(fileName) ? fileName : path.join(this.mediaDir, fileName);
    if (!fs.existsSync(filePath)) return;
    try {
      let info = await analyzeFile(filePath, this._audioConfig);
      // Video file with no duration and not actively being recorded → remux to fix container header
      if (!info.duration && info.video && !this._locked.has(filePath)) {
        await _remuxInPlace(filePath);
        info = await analyzeFile(filePath, this._audioConfig);
      }
      const stat = fs.statSync(filePath); // re-stat after potential remux
      info.fileSize = stat.size;
      if (path.isAbsolute(fileName)) {
        const existingTag = this.library[fileName]?._tag;
        if (existingTag) info._tag = existingTag;
        info._displayName = path.basename(fileName);
      }
      this.library[fileName] = info;
      this.save();
      this._emit('analyzed', { fileName, info });
    } catch(e) {
      this.library[fileName] = { fileName, filePath, error: e.message, analyzedAt: Date.now() };
      this._emit('error', { fileName, error: e.message });
    }
  }

  startWatching() {
    this.scan();
    this._timer = setInterval(() => this.scan(), SCAN_INTERVAL_MS);
    return this;
  }

  stopWatching() {
    if (this._timer) clearInterval(this._timer);
  }

  // ── Query ──────────────────────────────────────────────────────────────────

  getAll() { return Object.values(this.library); }

  get(fileName) { return this.library[fileName] || null; }

  exists(fileName) {
    if (!this.library[fileName] || this.library[fileName].error) return false;
    const filePath = path.isAbsolute(fileName) ? fileName : path.join(this.mediaDir, fileName);
    return fs.existsSync(filePath);
  }

  /** Validate a playlist entry — returns { ok, error } */
  validateEntry(entry) {
    if (entry.source === 'smpte' || entry.source === 'black') return { ok: true };
    if (!entry.file && (entry.source === 'player' || entry.source === 'player1' || entry.source === 'player2')) return { ok: false, error: 'Kein Dateiname' };
    if (!entry.file) return { ok: false, error: 'Kein Dateiname' };
    if (!SUPPORTED.test(entry.file)) return { ok: false, error: 'Nicht unterstütztes Format' };
    if (!this.exists(entry.file)) return { ok: false, error: `Datei nicht gefunden: ${entry.file}` };
    const info = this.get(entry.file);
    if (entry.som != null && entry.som < 0) return { ok: false, error: 'SOM < 0' };
    if (entry.eom != null && info.eom != null && entry.eom > info.eom + 0.1)
      return { ok: false, error: `EOM (${entry.eom.toFixed(2)}s) > Mediadauer (${info.eom?.toFixed(2)}s)` };
    return { ok: true };
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  on(event, fn) { this._listeners.push({ event, fn }); return this; }
  _emit(event, data) { this._listeners.filter(l => l.event === event).forEach(l => l.fn(data)); }
}

module.exports = MediaLibrary;
