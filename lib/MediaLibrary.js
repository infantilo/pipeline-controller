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

const SUPPORTED        = /\.(mxf|mp4|mov|ts|mts|mkv|wav|mp3|aac|flac|ogg|m4a)$/i;
const AUDIO_ONLY       = /\.(wav|mp3|aac|flac|ogg|m4a)$/i;
const SCAN_INTERVAL_MS = 5000;
const MAX_CONCURRENT   = 3;   // max parallel ffprobe processes during scan

// Simple async semaphore for concurrency-limiting analysis
class _Semaphore {
  constructor(n) { this._n = n; this._q = []; }
  acquire() {
    if (this._n > 0) { this._n--; return Promise.resolve(); }
    return new Promise(r => this._q.push(r));
  }
  release() {
    if (this._q.length) { this._q.shift()(); } else { this._n++; }
  }
}

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
    this._sem         = new _Semaphore(MAX_CONCURRENT);
    // dead.dir: corrupt/unanalyzable files are moved here (default: <mediaDir>/../dead)
    this._deadDir     = null;  // set via setDeadDir(); null = don't move (log only)
  }

  setDeadDir(dir) { this._deadDir = dir; }

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

  // ── Dead-Dir: move unanalyzable file ─────────────────────────────────────────

  _moveToDead(filePath, fileName) {
    const deadDir = this._deadDir || path.join(this.mediaDir, '..', 'dead');
    try {
      fs.mkdirSync(deadDir, { recursive: true });
      const ext  = path.extname(fileName);
      const base = path.basename(fileName, ext);
      const dest = path.join(deadDir, `${base}.${Date.now()}${ext}`);
      fs.renameSync(filePath, dest);
      return dest;
    } catch { return null; }
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

    // Concurrency-limited analyze helper
    const analyze = async (filePath, extraOpts = {}) => {
      await this._sem.acquire();
      try { return await analyzeFile(filePath, this._audioConfig); }
      finally { this._sem.release(); }
    };

    // Collect pending analysis tasks (file changed or new) and run concurrently
    const tasks = [];

    // ── main dir (relative keys) ──
    for (const fileName of mainFiles) {
      const filePath = path.join(this.mediaDir, fileName);
      expectedKeys.add(fileName);
      if (this._locked.has(filePath)) continue;
      let stat;
      try { stat = fs.statSync(filePath); } catch { continue; }
      const existing = this.library[fileName];
      // Use both size and mtime for change detection to avoid redundant re-analysis
      if (!existing || existing.fileSize !== stat.size || existing.mtime !== stat.mtimeMs) {
        tasks.push(async () => {
          try {
            const info = await analyze(filePath);
            info.fileSize = stat.size;
            info.mtime    = stat.mtimeMs;
            this.library[fileName] = info;
            changed = true;
            this._emit('analyzed', { fileName, info });
          } catch(e) {
            // Try to move corrupt file to dead dir (only if truly unreachable/corrupt)
            const deadPath = this._deadDir !== false ? this._moveToDead(filePath, fileName) : null;
            if (deadPath) {
              delete this.library[fileName];
              changed = true;
              this._emit('dead', { fileName, error: e.message, deadPath });
            } else {
              this.library[fileName] = { fileName, filePath, error: e.message, analyzedAt: Date.now(), fileSize: stat.size, mtime: stat.mtimeMs };
              this._emit('error', { fileName, error: e.message });
            }
          }
        });
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
        if (!existing || existing.fileSize !== stat.size || existing.mtime !== stat.mtimeMs) {
          const _fp = filePath, _bn = baseName, _tag = tag;
          tasks.push(async () => {
            try {
              const info = await analyze(_fp);
              info.fileSize     = stat.size;
              info.mtime        = stat.mtimeMs;
              info._tag         = _tag || undefined;
              info._displayName = _bn;
              this.library[_fp] = info;
              changed = true;
              this._emit('analyzed', { fileName: _fp, info });
            } catch(e) {
              const deadPath = this._deadDir !== false ? this._moveToDead(_fp, _bn) : null;
              if (deadPath) {
                delete this.library[_fp];
                changed = true;
                this._emit('dead', { fileName: _fp, error: e.message, deadPath });
              } else {
                this.library[_fp] = { fileName: _fp, filePath: _fp, error: e.message, analyzedAt: Date.now(), fileSize: stat.size, mtime: stat.mtimeMs, _tag: _tag || undefined, _displayName: _bn };
                this._emit('error', { fileName: _fp, error: e.message });
              }
            }
          });
        }
      }
    }

    // Run all pending analysis tasks with semaphore-limited concurrency
    await Promise.all(tasks.map(t => t()));

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
      info.mtime    = stat.mtimeMs;
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
