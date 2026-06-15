'use strict';
/**
 * PluginWorker — Child-Prozess-Einstiegspunkt für Plugins.
 * Läuft als isolierter child_process.fork()-Prozess (kein Worker-Thread),
 * da gst-kit's Native-Addon Worker-Thread-Bootstrap in Node.js 25 verhindert.
 * Alle Ausnahmen werden abgefangen und ans Host-Prozess gemeldet.
 */

// ── Globale Fehlerbehandlung — verhindert Prozess-Crash ───────────────────────
process.on('uncaughtException', e => {
  _send({ type: 'log', level: 'error', msg: `Uncaught: ${e.message}\n${e.stack?.slice(0, 300) || ''}` });
});
process.on('unhandledRejection', e => {
  _send({ type: 'log', level: 'warn', msg: `Unhandled rejection: ${e?.message || String(e)}` });
});

// ── Hilfsfunktionen ────────────────────────────────────────────────────────────
function _send(msg) {
  try { process.send(msg); } catch {}
}

function _safeClone(data) {
  try { return JSON.parse(JSON.stringify(data)); } catch { return null; }
}

// ── Auf Init-Nachricht warten ─────────────────────────────────────────────────
// Der Host sendet als erste Nachricht { type:'init', pluginPath, pluginId, config }.
process.once('message', async initMsg => {
  if (!initMsg || initMsg.type !== 'init') {
    _send({ type: 'log', level: 'error', msg: 'Ungültige Init-Nachricht' });
    process.exit(1);
    return;
  }

  const { pluginPath, pluginId, config } = initMsg;

  // ── Sandboxed API ────────────────────────────────────────────────────────────
  const api = {
    log(level, msg) {
      _send({ type: 'log', level: String(level), msg: String(msg).slice(0, 1024) });
    },

    notify(msg, notifyType = 'info') {
      _send({ type: 'notify', msg: String(msg).slice(0, 256), notifyType });
    },

    setStatus(state, data) {
      _send({ type: 'status', state: String(state), data: _safeClone(data) || {} });
    },

    updateStatus(data) {
      _send({ type: 'status', data: _safeClone(data) || {} });
    },

    resolveLocal(originalPath, localPath) {
      _send({ type: 'action', action: 'media:resolveLocal',
              originalPath: String(originalPath), localPath: String(localPath) });
    },

    clearLocal(originalPath) {
      _send({ type: 'action', action: 'media:clearLocal', originalPath: String(originalPath) });
    },

    broadcast(event, data) {
      _send({ type: 'action', action: 'broadcast',
              event: String(event), data: _safeClone(data) || {} });
    },

    setEventProps(eventId, props) {
      _send({ type: 'action', action: 'playlist:setEventProps',
              eventId: String(eventId), props: _safeClone(props) || {} });
    },

    setPlaylist(events, startIndex = null, somOffset = null) {
      _send({
        type:       'action',
        action:     'playlist:set',
        events:     _safeClone(events) || [],
        startIndex: (typeof startIndex === 'number') ? startIndex : null,
        somOffset:  (typeof somOffset  === 'number') ? somOffset  : null,
      });
    },

    // ── Async API-Calls zum Host ──────────────────────────────────────────────
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

    getState()    { return this._call('getState');    },
    getPlaylist() { return this._call('getPlaylist'); },
    getLibrary()  { return this._call('getLibrary');  },
    getConfig()   { return this._call('getConfig');   },
  };

  // ── Plugin laden ──────────────────────────────────────────────────────────────
  let plugin;
  try {
    plugin = require(pluginPath);
  } catch (e) {
    _send({ type: 'log', level: 'error', msg: `Laden fehlgeschlagen: ${e.message}` });
    process.exit(1);
    return;
  }

  // ── Nachrichten vom Host empfangen ────────────────────────────────────────────
  process.on('message', async msg => {
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
      api.log('warn', `Handler-Fehler: ${e.message}`);
    }
  });

  // ── Plugin initialisieren ─────────────────────────────────────────────────────
  try {
    if (typeof plugin.init === 'function') {
      await plugin.init(config || {}, api);
    }
    _send({ type: 'ready' });
    api.log('info', 'Plugin bereit');
  } catch (e) {
    api.log('error', `Init-Fehler: ${e.message}`);
    process.exit(1);
  }
});
