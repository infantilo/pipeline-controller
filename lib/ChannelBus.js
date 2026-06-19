'use strict';
/**
 * ChannelBus — Cross-Channel/Cross-Host Trigger- und Sync-Bus.
 *
 * Verbindet mehrere Channel-Prozesse (gleicher Host oder mehrere Hosts, z.B.
 * Master/Slave-Redundanz) über einfache TCP-Verbindungen mit newline-
 * delimited JSON ("\n" als Frame-Trenner — keine neue Dependency wie `ws`).
 *
 * TOPOLOGIE: explizit konfiguriert, kein Discovery/Routing. Jeder Channel
 * kennt seine Peers (host:port) aus der eigenen Config und verbindet sich zu
 * ihnen; gleichzeitig lauscht er selbst auf `listenPort` für eingehende
 * Peer-Verbindungen. Nachrichten werden NICHT weitergeleitet (kein Multi-Hop)
 * — wer einen Trigger empfangen soll, braucht eine direkte Verbindung
 * (entweder als Listener oder als Connector), üblicherweise über `groups`.
 *
 * ADRESSIERUNG: `send(target, type, payload)`
 *   target === '*'            → an alle verbundenen Peers
 *   target === peer.id          → an genau diesen Channel
 *   target === eine peer.group → an alle Peers mit dieser Gruppen-Mitgliedschaft
 *
 * HANDSHAKE: nach Connect schickt jede Seite sofort {t:'hello', id, groups}.
 * Erst danach ist der Peer adressierbar (peer.id/peer.groups bekannt).
 *
 * RECONNECT: ausgehende Peer-Verbindungen werden bei Abbruch automatisch neu
 * versucht (fixes Intervall, kein Backoff — Anzahl Peers ist klein/stabil).
 */
const net          = require('net');
const EventEmitter = require('events');

const RECONNECT_MS = 5000;

class ChannelBus extends EventEmitter {
  /**
   * @param {object} opts
   *   id         {string}   – eigene Channel-ID (z.B. 'ORF2')
   *   groups     {string[]} – Gruppen-Mitgliedschaften (z.B. ['orf2-followers'])
   *   listenPort {number}   – TCP-Port für eingehende Peer-Verbindungen
   *   peers      {Array}    – [{ host, port }] – auszugehende Verbindungen
   *   log        {Function} – (msg, level) => void
   */
  constructor({ id, groups = [], listenPort, peers = [], log } = {}) {
    super();
    if (!id) throw new Error('ChannelBus: id erforderlich');
    this.id         = id;
    this.groups     = groups;
    this._listenPort = listenPort || null;
    this._peerSpecs  = peers;
    this._log        = log || (() => {});

    this._server     = null;
    // socket → { id, groups, buf }  (buf = unverarbeiteter Rest eines Frames)
    this._sockets     = new Map();
    this._reconnectTimers = new Map(); // peerKey → Timeout
    this._stopped = false;
  }

  start() {
    this._stopped = false;
    if (this._listenPort) this._startServer();
    for (const spec of this._peerSpecs) this._connectPeer(spec);
  }

  stop() {
    this._stopped = true;
    for (const t of this._reconnectTimers.values()) clearTimeout(t);
    this._reconnectTimers.clear();
    for (const sock of this._sockets.keys()) sock.destroy();
    this._sockets.clear();
    if (this._server) { this._server.close(); this._server = null; }
  }

  /** Sendet eine Nachricht an alle Peers, die `target` matchen ('*', Channel-ID oder Gruppe). */
  send(target, type, payload = {}) {
    const msg = JSON.stringify({ t: 'msg', from: this.id, target, type, payload }) + '\n';
    let sent = 0;
    for (const [sock, meta] of this._sockets) {
      if (!meta.id) continue; // Handshake noch nicht abgeschlossen
      if (!this._matches(target, meta)) continue;
      try { sock.write(msg); sent++; } catch {}
    }
    return sent;
  }

  _matches(target, meta) {
    return target === '*' || target === meta.id || (meta.groups || []).includes(target);
  }

  // ── Server-Seite (eingehende Verbindungen) ──────────────────────────────────
  _startServer() {
    this._server = net.createServer(sock => this._setupSocket(sock));
    this._server.on('error', e => this._log(`ChannelBus listen-Fehler: ${e.message}`, 'warn'));
    this._server.listen(this._listenPort, () => {
      this._log(`ChannelBus lauscht auf Port ${this._listenPort}`, 'debug');
    });
  }

  // ── Client-Seite (ausgehende Verbindungen, mit Reconnect) ───────────────────
  _connectPeer(spec) {
    if (this._stopped) return;
    const key = `${spec.host}:${spec.port}`;
    const sock = net.connect({ host: spec.host, port: spec.port });
    sock.on('connect', () => {
      this._log(`ChannelBus verbunden mit ${key}`, 'debug');
      this._setupSocket(sock);
    });
    sock.on('error', () => {}); // 'close' folgt, Reconnect dort
    sock.on('close', () => {
      this._sockets.delete(sock);
      if (this._stopped) return;
      const t = setTimeout(() => this._connectPeer(spec), RECONNECT_MS);
      this._reconnectTimers.set(key, t);
    });
  }

  // ── Gemeinsame Socket-Logik (Server + Client) ───────────────────────────────
  _setupSocket(sock) {
    const meta = { id: null, groups: [], buf: '' };
    this._sockets.set(sock, meta);
    sock.setEncoding('utf8');
    sock.write(JSON.stringify({ t: 'hello', id: this.id, groups: this.groups }) + '\n');

    sock.on('data', chunk => {
      meta.buf += chunk;
      let idx;
      while ((idx = meta.buf.indexOf('\n')) !== -1) {
        const line = meta.buf.slice(0, idx);
        meta.buf = meta.buf.slice(idx + 1);
        if (line) this._handleLine(sock, meta, line);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => { this._sockets.delete(sock); });
  }

  _handleLine(sock, meta, line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.t === 'hello') {
      meta.id = msg.id;
      meta.groups = msg.groups || [];
      this.emit('peer-connected', { id: meta.id, groups: meta.groups });
      return;
    }
    if (msg.t === 'msg') {
      this.emit('message', { from: msg.from, target: msg.target, type: msg.type, payload: msg.payload });
      this.emit(`trigger:${msg.type}`, { from: msg.from, payload: msg.payload });
    }
  }
}

module.exports = ChannelBus;
