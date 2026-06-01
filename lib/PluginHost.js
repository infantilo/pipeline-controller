'use strict';
/**
 * PluginHost — lädt und verwaltet Plugins in isolierten Worker-Threads.
 * Ein Plugin-Absturz hat KEINE Auswirkung auf die Pipeline oder das Playout.
 */
const { Worker }       = require('worker_threads');
const EventEmitter     = require('events');
const fs               = require('fs');
const path             = require('path');

const WORKER_SCRIPT = path.join(__dirname, 'PluginWorker.js');

// ── Hilfsfunktionen ────────────────────────────────────────────────────────────
function safeClone(data) {
  try { return JSON.parse(JSON.stringify(data)); } catch { return null; }
}

// ── PluginHost ─────────────────────────────────────────────────────────────────
class PluginHost extends EventEmitter {
  /**
   * @param {object} opts
   *   pluginsDir  {string}   – Verzeichnis mit Plugin-Unterordnern
   *   configPath  {string}   – JSON-Datei für persistierte Plugin-Configs
   *   log         {Function} – (msg, level, source) Logging-Callback
   *   getState    {Function} – () → aktueller Playout-State
   *   getPlaylist {Function} – () → aktuelle Playlist-Events
   *   getLibrary  {Function} – () → Media-Library-Map
   */
  constructor({ pluginsDir, configPath, log, getState, getPlaylist, getLibrary }) {
    super();
    this._pluginsDir  = pluginsDir;
    this._configPath  = configPath;
    this._log         = (msg, lvl = 'info') => log?.(msg, lvl, 'plugins');
    this._getState    = getState    || (() => ({}));
    this._getPlaylist = getPlaylist || (() => []);
    this._getLibrary  = getLibrary  || (() => ({}));

    // id → PluginEntry
    this._plugins = new Map();
    // originalPath → localPath (für File Transfer Manager etc.)
    this._pathMap = new Map();
    // Persistierte Konfigurationen
    this._configs = this._loadConfigs();
  }

  // ── Config-Persistenz ────────────────────────────────────────────────────────
  _loadConfigs() {
    try {
      if (fs.existsSync(this._configPath))
        return JSON.parse(fs.readFileSync(this._configPath, 'utf8'));
    } catch {}
    return {};
  }
  _saveConfigs() {
    try { fs.writeFileSync(this._configPath, JSON.stringify(this._configs, null, 2)); }
    catch (e) { this._log(`Config speichern: ${e.message}`, 'warn'); }
  }

  // ── Plugins laden ────────────────────────────────────────────────────────────
  async loadAll() {
    if (!fs.existsSync(this._pluginsDir)) {
      fs.mkdirSync(this._pluginsDir, { recursive: true });
      return;
    }
    const entries = fs.readdirSync(this._pluginsDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const indexPath = path.join(this._pluginsDir, e.name, 'index.js');
      if (!fs.existsSync(indexPath)) continue;
      try {
        await this.loadPlugin(e.name, indexPath);
      } catch (err) {
        this._log(`Fehler beim Laden von ${e.name}: ${err.message}`, 'warn');
      }
    }
  }

  async loadPlugin(id, indexPath) {
    // Manifest ohne Plugin-Ausführung laden (nur exports.meta)
    let meta;
    const absPath = path.resolve(indexPath);
    try {
      const mod = require(absPath);
      meta = mod.meta || mod;
    } catch (e) {
      throw new Error(`Manifest-Fehler: ${e.message}`);
    }

    const cfg      = this._configs[id] || {};
    const enabled  = cfg.enabled ?? false;
    const config   = cfg.config  ?? {};

    /** @type {PluginEntry} */
    const entry = {
      id,
      indexPath: absPath,
      meta: {
        id,
        name:        meta.name        || id,
        version:     meta.version     || '1.0.0',
        description: meta.description || '',
        schema:      meta.schema      || [],
        subscribes:  meta.subscribes  || [],
        hasStatus:   meta.hasStatus   ?? false,
      },
      worker:  null,
      enabled,
      config,
      status: {
        state: enabled ? 'stopped' : 'disabled',
        error: null,
        data:  {},
      },
      _restartTimer: null,
    };
    this._plugins.set(id, entry);
    this._log(`Plugin geladen: ${id} v${entry.meta.version}`);

    if (enabled) await this._startWorker(entry);
    return entry;
  }

  // ── Worker-Lifecycle ─────────────────────────────────────────────────────────
  async _startWorker(entry) {
    // Alten Worker beenden
    await this._stopWorker(entry, false);

    const w = new Worker(WORKER_SCRIPT, {
      workerData: {
        pluginPath: entry.indexPath,
        pluginId:   entry.id,
        config:     safeClone(entry.config) || {},
      },
    });
    entry.worker = w;
    entry.status.state = 'starting';
    entry.status.error = null;
    this._broadcastStatus(entry);

    w.on('message', msg => {
      // Fehler im Message-Handler niemals nach oben durchreichen
      try { this._handleWorkerMsg(entry, msg); }
      catch (e) { this._log(`[${entry.id}] Handler-Fehler: ${e.message}`, 'warn'); }
    });

    w.on('error', err => {
      this._log(`[${entry.id}] Worker-Fehler: ${err.message}`, 'warn');
      entry.worker = null;
      entry.status = { state: 'error', error: err.message, data: entry.status.data };
      this._broadcastStatus(entry);
      this._scheduleRestart(entry);
    });

    w.on('exit', code => {
      if (entry.worker !== w) return; // wurde bereits ersetzt
      entry.worker = null;
      if (code !== 0 && entry.enabled) {
        entry.status = { state: 'error', error: `Exit-Code ${code}`, data: entry.status.data };
        this._broadcastStatus(entry);
        this._scheduleRestart(entry);
      } else if (entry.enabled) {
        entry.status.state = 'stopped';
        this._broadcastStatus(entry);
      }
    });
  }

  async _stopWorker(entry, markDisabled = true) {
    if (entry._restartTimer) { clearTimeout(entry._restartTimer); entry._restartTimer = null; }
    const w = entry.worker;
    if (!w) return;
    entry.worker = null;
    try {
      w.postMessage({ type: 'destroy' });
      await new Promise(r => setTimeout(r, 400));
      await w.terminate();
    } catch {}
    if (markDisabled) {
      entry.status.state = 'disabled';
      this._broadcastStatus(entry);
    }
  }

  _scheduleRestart(entry) {
    if (!entry.enabled || entry._restartTimer) return;
    this._log(`[${entry.id}] Neustart in 5s...`, 'info');
    entry._restartTimer = setTimeout(() => {
      entry._restartTimer = null;
      if (entry.enabled && !entry.worker) {
        this._startWorker(entry).catch(e =>
          this._log(`[${entry.id}] Neustart-Fehler: ${e.message}`, 'warn')
        );
      }
    }, 5000);
  }

  // ── Worker-Nachrichten verarbeiten ───────────────────────────────────────────
  _handleWorkerMsg(entry, msg) {
    switch (msg.type) {
      case 'ready':
        entry.status.state = 'running';
        this._broadcastStatus(entry);
        break;

      case 'log':
        this._log(`[${entry.id}] ${msg.msg}`, msg.level || 'info');
        break;

      case 'notify':
        this.emit('notify', {
          pluginId: entry.id,
          name:     entry.meta.name,
          msg:      String(msg.msg).slice(0, 256),
          type:     msg.notifyType || 'info',
        });
        break;

      case 'status':
        if (msg.state && entry.status.state !== 'error') entry.status.state = msg.state;
        if (msg.data) entry.status.data = msg.data;
        this._broadcastStatus(entry);
        break;

      case 'action':
        this._handleAction(entry, msg);
        break;

      case 'api':
        this._handleApiCall(entry, msg);
        break;
    }
  }

  _handleAction(entry, msg) {
    switch (msg.action) {
      // File-Pfad-Auflösung (z.B. FTM: Remote → Local)
      case 'media:resolveLocal':
        if (msg.originalPath && msg.localPath) {
          this._pathMap.set(msg.originalPath, msg.localPath);
          this.emit('path-resolved', msg.originalPath, msg.localPath);
        }
        break;
      case 'media:clearLocal':
        if (msg.originalPath) {
          this._pathMap.delete(msg.originalPath);
          this.emit('path-cleared', msg.originalPath);
        }
        break;

      // Broadcast-Event an UI-Clients
      case 'broadcast':
        if (msg.event && msg.data !== undefined) {
          this.emit('broadcast', `plugin:${msg.event}`, safeClone(msg.data) || {});
        }
        break;

      // Playlist komplett ersetzen (Marina-Sync und ähnliche Plugins)
      case 'playlist:set':
        if (Array.isArray(msg.events)) {
          this.emit('playlist-set', {
            events:     msg.events,
            startIndex: msg.startIndex ?? null,
            somOffset:  msg.somOffset  ?? null,
          });
        }
        break;

      // Playlist-Event-Properties ändern
      case 'playlist:setEventProps':
        if (msg.eventId && msg.props) {
          this.emit('setEventProps', msg.eventId, msg.props);
        }
        break;
    }
  }

  _handleApiCall(entry, msg) {
    let value;
    try {
      switch (msg.method) {
        case 'getState':    value = safeClone(this._getState())    || {}; break;
        case 'getPlaylist': value = safeClone(this._getPlaylist()) || []; break;
        case 'getLibrary':  value = safeClone(this._getLibrary())  || {}; break;
        case 'getConfig':   value = safeClone(entry.config)        || {}; break;
        default: value = null;
      }
    } catch { value = null; }
    try { entry.worker?.postMessage({ type: 'api-result', id: msg.id, value }); } catch {}
  }

  // ── Öffentliche API ──────────────────────────────────────────────────────────

  /** Pfad-Auflösung: gibt lokalen Pfad zurück wenn ein Plugin ihn registriert hat */
  resolveFilePath(originalPath) {
    return this._pathMap.get(originalPath) || null;
  }

  /** Event an alle abonnierten Plugins senden */
  dispatch(eventName, data) {
    const payload = safeClone(data);
    if (payload === null && data !== null && data !== undefined) return; // nicht serialisierbar

    for (const [, entry] of this._plugins) {
      if (!entry.worker) continue;
      const subs = entry.meta.subscribes;
      if (!subs.includes(eventName) && !subs.includes('*')) continue;
      try {
        entry.worker.postMessage({ type: 'event', name: eventName, data: payload });
      } catch (e) {
        this._log(`[${entry.id}] dispatch(${eventName}): ${e.message}`, 'warn');
      }
    }
  }

  /** Alle Plugins als serialisierbare Liste (für API/UI) */
  getAll() {
    return Array.from(this._plugins.values()).map(e => ({
      id:          e.id,
      name:        e.meta.name,
      version:     e.meta.version,
      description: e.meta.description,
      schema:      e.meta.schema,
      subscribes:  e.meta.subscribes,
      hasStatus:   e.meta.hasStatus,
      enabled:     e.enabled,
      status:      e.status,
      config:      e.config,
    }));
  }

  /** Konfiguration eines Plugins setzen und Worker neu starten */
  async setConfig(id, config) {
    const entry = this._plugins.get(id);
    if (!entry) throw new Error(`Plugin nicht gefunden: ${id}`);
    entry.config = config;
    this._configs[id] = { ...(this._configs[id] || {}), config };
    this._saveConfigs();
    if (entry.worker) await this._startWorker(entry);
  }

  /** Plugin aktivieren / deaktivieren */
  async setEnabled(id, enabled) {
    const entry = this._plugins.get(id);
    if (!entry) throw new Error(`Plugin nicht gefunden: ${id}`);
    entry.enabled = enabled;
    this._configs[id] = { ...(this._configs[id] || {}), enabled };
    this._saveConfigs();
    if (enabled && !entry.worker) {
      entry.status.state = 'stopped';
      await this._startWorker(entry);
    } else if (!enabled && entry.worker) {
      await this._stopWorker(entry, true);
    }
  }

  async destroy() {
    for (const [, entry] of this._plugins) {
      await this._stopWorker(entry, false).catch(() => {});
    }
  }

  // ── Intern ───────────────────────────────────────────────────────────────────
  _broadcastStatus(entry) {
    this.emit('plugin-status', {
      id:      entry.id,
      name:    entry.meta.name,
      enabled: entry.enabled,
      status:  entry.status,
    });
  }
}

module.exports = PluginHost;
