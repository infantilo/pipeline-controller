'use strict';
/**
 * PluginWorker — Worker-Thread-Einstiegspunkt.
 * Lädt ein Plugin und stellt ihm die sandboxed API bereit.
 * Alle Ausnahmen werden abgefangen und ans Host-Thread gemeldet,
 * niemals weitergegeben.
 */
const { workerData, parentPort } = require('worker_threads');

// ── Sandboxed API ──────────────────────────────────────────────────────────────
const api = {
  /** Nachricht ins System-Log schreiben */
  log(level, msg) {
    _send({ type: 'log', level: String(level), msg: String(msg).slice(0, 1024) });
  },

  /** UI-Benachrichtigung senden */
  notify(msg, notifyType = 'info') {
    _send({ type: 'notify', msg: String(msg).slice(0, 256), notifyType });
  },

  /** Plugin-Status setzen (wird in der UI angezeigt) */
  setStatus(state, data) {
    _send({ type: 'status', state: String(state), data: _safeClone(data) || {} });
  },

  /** Plugin-Status-Daten aktualisieren (state unverändert) */
  updateStatus(data) {
    _send({ type: 'status', data: _safeClone(data) || {} });
  },

  /**
   * Lokalen Pfad für eine Original-Datei registrieren.
   * Danach wird statt originalPath der localPath geladen.
   */
  resolveLocal(originalPath, localPath) {
    _send({ type: 'action', action: 'media:resolveLocal',
            originalPath: String(originalPath), localPath: String(localPath) });
  },

  /** Lokale Pfad-Auflösung wieder entfernen */
  clearLocal(originalPath) {
    _send({ type: 'action', action: 'media:clearLocal', originalPath: String(originalPath) });
  },

  /** Event an UI-Clients senden (wird als "plugin:<event>" gebroadcastet) */
  broadcast(event, data) {
    _send({ type: 'action', action: 'broadcast',
            event: String(event), data: _safeClone(data) || {} });
  },

  /** Playlist-Event-Properties ändern (z.B. Logo, Audio-Shuffle setzen) */
  setEventProps(eventId, props) {
    _send({ type: 'action', action: 'playlist:setEventProps',
            eventId: String(eventId), props: _safeClone(props) || {} });
  },

  /**
   * Komplette Playlist laden. PluginHost leitet an server.js → playlist.set() weiter.
   * @param {object[]} events     - Playlist-Events (internes Format)
   * @param {number|null} startIndex - Index ab dem gestartet wird (null = nicht starten)
   * @param {number|null} somOffset  - SOM-Offset in Sekunden für das erste Event (On-Air Sync)
   */
  setPlaylist(events, startIndex = null, somOffset = null) {
    _send({
      type:       'action',
      action:     'playlist:set',
      events:     _safeClone(events) || [],
      startIndex: (typeof startIndex === 'number') ? startIndex : null,
      somOffset:  (typeof somOffset  === 'number') ? somOffset  : null,
    });
  },

  // ── Async API-Calls zum Host ────────────────────────────────────────────────
  _callId: 0,
  _pending: new Map(),

  _call(method) {
    const id = ++this._callId;
    return new Promise(resolve => {
      this._pending.set(id, resolve);
      _send({ type: 'api', id, method });
      setTimeout(() => {
        if (this._pending.delete(id)) resolve(null);
      }, 5000);
    });
  },

  /** Aktuellen Playout-State abrufen */
  getState()    { return this._call('getState');    },
  /** Aktuelle Playlist-Events abrufen */
  getPlaylist() { return this._call('getPlaylist'); },
  /** Media-Library abrufen */
  getLibrary()  { return this._call('getLibrary');  },
  /** Eigene Plugin-Konfiguration abrufen */
  getConfig()   { return this._call('getConfig');   },
};

// ── Hilfsfunktionen ────────────────────────────────────────────────────────────
function _send(msg) {
  try { parentPort.postMessage(msg); } catch {}
}

function _safeClone(data) {
  try { return JSON.parse(JSON.stringify(data)); } catch { return null; }
}

// ── Plugin laden ───────────────────────────────────────────────────────────────
let plugin;
try {
  plugin = require(workerData.pluginPath);
} catch (e) {
  _send({ type: 'log', level: 'error', msg: `Laden fehlgeschlagen: ${e.message}` });
  process.exit(1);
}

// ── Nachrichten vom Host empfangen ────────────────────────────────────────────
parentPort.on('message', async msg => {
  try {
    switch (msg.type) {

      case 'api-result':
        api._pending.get(msg.id)?.(msg.value);
        api._pending.delete(msg.id);
        break;

      case 'event':
        if (typeof plugin.onEvent === 'function') {
          try {
            await plugin.onEvent(msg.name, msg.data);
          } catch (e) {
            api.log('warn', `onEvent(${msg.name}) Fehler: ${e.message}`);
          }
        }
        break;

      case 'destroy':
        if (typeof plugin.destroy === 'function') {
          try { await plugin.destroy(); } catch {}
        }
        process.exit(0);
        break;
    }
  } catch (e) {
    api.log('warn', `Worker-Handler-Fehler: ${e.message}`);
  }
});

// ── Globale Fehlerbehandlung — verhindert Worker-Crash ────────────────────────
process.on('uncaughtException', e => {
  api.log('error', `Uncaught: ${e.message}\n${e.stack?.slice(0, 300) || ''}`);
});
process.on('unhandledRejection', e => {
  api.log('warn', `Unhandled rejection: ${e?.message || String(e)}`);
});

// ── Plugin initialisieren ─────────────────────────────────────────────────────
(async () => {
  try {
    if (typeof plugin.init === 'function') {
      await plugin.init(workerData.config || {}, api);
    }
    _send({ type: 'ready' });
    api.log('info', 'Plugin bereit');
  } catch (e) {
    api.log('error', `Init-Fehler: ${e.message}`);
    process.exit(1);
  }
})();
