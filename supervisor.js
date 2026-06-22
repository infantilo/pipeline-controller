#!/usr/bin/env node
'use strict';
/**
 * Multi-Channel-Supervisor — startet/überwacht mehrere server.js-Instanzen auf
 * einem Host (z.B. ORF2 + ORF2E über mehrere I/Os derselben DeckLink IP-100-
 * Karte). Jeder Channel läuft als eigener Node-Prozess via fork() — nicht
 * worker_threads, weil gst-kit's natives Addon den worker-thread-Bootstrap
 * nicht überlebt (siehe PluginHost.js). Ein abgestürzter Channel hat keine
 * Auswirkung auf die anderen und wird automatisch neu gestartet.
 *
 * Jeder Channel bekommt sein eigenes PC_DATA_DIR (siehe server.js _writablePath)
 * sowie eigene PORT/GRAFIK_PORT — settings.json/library.json/playlists/ etc.
 * kollidieren dadurch nicht zwischen Channels.
 *
 * Dashboard: EIN Web-Interface für alle Channels (Standard-Port 3099, siehe
 * SUPERVISOR_PORT) — Übersicht/Status/Start/Stop/Restart sowie Links zur UI
 * jedes einzelnen Channels (dessen eigener Port). Channels können dort auch
 * zur Laufzeit hinzugefügt/entfernt werden; Änderungen werden in channels.json
 * persistiert.
 *
 * Config: channels.json (Pfad als erstes Argument, sonst Repo-Root), Format:
 *   [
 *     { "id": "ORF2",  "dataDir": "channels/orf2",  "port": 3000, "grafikPort": 3101 },
 *     { "id": "ORF2E", "dataDir": "channels/orf2e", "port": 3010, "grafikPort": 3111 }
 *   ]
 *   dataDir relativ zum Repo-Root (oder absolut) — wird beim ersten Start
 *   angelegt; server.js bootstrapped dort mit Defaults wie im Single-Channel-
 *   Betrieb. Optionales Feld "env": { ... } für zusätzliche/überschreibende
 *   Umgebungsvariablen pro Channel (z.B. HW-spezifische Overrides). Eine leere
 *   oder fehlende channels.json ist erlaubt — Channels lassen sich dann
 *   ausschließlich über das Dashboard anlegen.
 *
 * Verwendung: node supervisor.js [pfad/zu/channels.json]
 */
const http = require('http');
const { fork } = require('child_process');
const fs   = require('fs');
const path = require('path');

const RESTART_MS    = 3000;  // fixes Intervall, kein Backoff — Channel-Anzahl pro Host ist klein/stabil
const SERVER_SCRIPT = path.join(__dirname, 'server.js');
const ID_RE         = /^[A-Za-z0-9_-]+$/;

function loadChannels(configPath) {
  if (!fs.existsSync(configPath)) return [];
  const list = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!Array.isArray(list)) throw new Error('channels.json muss ein Array sein');
  const ids = new Set();
  for (const c of list) {
    if (!c.id || !c.dataDir || !c.port) throw new Error(`Channel-Eintrag unvollständig (id/dataDir/port erforderlich): ${JSON.stringify(c)}`);
    if (ids.has(c.id)) throw new Error(`Channel-ID doppelt vergeben: ${c.id}`);
    ids.add(c.id);
  }
  return list;
}

function saveChannels(configPath, registry) {
  const list = [...registry.values()].map(cp => cp.spec);
  fs.writeFileSync(configPath, JSON.stringify(list, null, 2));
}

function _prefixLines(buf, prefix) {
  const text = buf.toString();
  if (!text) return '';
  return text.split('\n').filter(Boolean).map(l => `${prefix} ${l}`).join('\n') + '\n';
}

class ChannelProcess {
  constructor(spec) {
    this.spec = spec;
    this.proc = null;
    this.status = 'stopped';      // stopped | starting | running | restarting | crashed
    this.startedAt = null;
    this.restarts = 0;
    this.lastExit = null;         // { code, signal, at }
    this._stopped = true;
    this._restartTimer = null;
  }

  start() {
    this._stopped = false;
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    const dataDir = path.isAbsolute(this.spec.dataDir) ? this.spec.dataDir : path.join(__dirname, this.spec.dataDir);
    fs.mkdirSync(dataDir, { recursive: true });

    const env = {
      ...process.env,
      PC_DATA_DIR: dataDir,
      PORT:        String(this.spec.port),
      GRAFIK_PORT: String(this.spec.grafikPort || this.spec.port + 100),
      ...(this.spec.env || {}),
    };

    const prefix = `[${this.spec.id}]`;
    this.status = 'starting';
    this.proc = fork(SERVER_SCRIPT, [], { cwd: __dirname, env, stdio: ['inherit', 'pipe', 'pipe', 'ipc'] });
    this.startedAt = Date.now();
    this.proc.stdout.on('data', d => process.stdout.write(_prefixLines(d, prefix)));
    this.proc.stderr.on('data', d => process.stderr.write(_prefixLines(d, prefix)));
    this.proc.on('spawn', () => { this.status = 'running'; });
    this.proc.on('exit', (code, sig) => {
      console.log(`${prefix} beendet (code=${code} sig=${sig || ''})`);
      this.proc = null;
      this.lastExit = { code, signal: sig, at: Date.now() };
      if (this._stopped) {
        this.status = 'stopped';
      } else {
        this.status = 'restarting';
        this.restarts++;
        this._restartTimer = setTimeout(() => this.start(), RESTART_MS);
      }
    });
    console.log(`${prefix} gestartet (pid=${this.proc.pid}, port=${this.spec.port}, dataDir=${dataDir})`);
  }

  stop() {
    this._stopped = true;
    this.status = 'stopped';
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    if (this.proc) this.proc.kill('SIGTERM');
  }

  toJSON() {
    return {
      id: this.spec.id, dataDir: this.spec.dataDir, port: this.spec.port, grafikPort: this.spec.grafikPort,
      status: this.status, pid: this.proc?.pid || null, startedAt: this.startedAt,
      restarts: this.restarts, lastExit: this.lastExit,
    };
  }
}

// ── Dashboard (ein HTTP-Interface für alle Channels) ────────────────────────
function renderDashboard() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Channel-Supervisor</title>
<style>
body{font-family:system-ui,sans-serif;background:#15171c;color:#e6e6e6;margin:0;padding:24px}
h1{font-size:18px;font-weight:600;margin:0 0 16px}
table{width:100%;border-collapse:collapse;margin-bottom:24px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #2a2d35;font-size:14px}
th{color:#9aa0ab;font-weight:500}
.status{display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:600}
.running{background:#1d3b25;color:#5fd97c}
.starting,.restarting{background:#3b3414;color:#e0c050}
.stopped{background:#33363d;color:#9aa0ab}
.crashed{background:#3b1d1d;color:#e05050}
a.btn,button{background:#2a2d35;color:#e6e6e6;border:1px solid #3a3d45;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;margin-right:4px;text-decoration:none;display:inline-block}
a.btn:hover,button:hover{background:#3a3d45}
a.open{color:#5fa8e0;border-color:#2c4a66}
form{display:flex;gap:8px;flex-wrap:wrap;align-items:end}
input{background:#1e2025;border:1px solid #3a3d45;color:#e6e6e6;border-radius:6px;padding:6px 8px;font-size:13px}
label{font-size:12px;color:#9aa0ab;display:block;margin-bottom:3px}
#cfgOverlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;z-index:100;align-items:center;justify-content:center}
#cfgOverlay.show{display:flex}
#cfgDialog{background:#1a1c21;border:1px solid #3a3d45;border-radius:8px;width:96vw;height:92vh;display:flex;flex-direction:column;overflow:hidden}
#cfgTabs{display:flex;align-items:center;gap:2px;background:#15171c;border-bottom:1px solid #2a2d35;padding:6px 8px;flex-shrink:0;overflow-x:auto}
#cfgTabs button{margin:0;border-radius:6px 6px 0 0;border-bottom:none;white-space:nowrap}
#cfgTabs button.active{background:#2c4a66;color:#bfe0ff;border-color:#5fa8e0}
#cfgClose{margin-left:auto;flex-shrink:0}
#cfgFrame{flex:1;border:none;background:#0c0d10}
#cfgEmpty{flex:1;display:flex;align-items:center;justify-content:center;color:#9aa0ab;font-size:13px}
</style></head><body>
<h1>Channel-Supervisor</h1>
<table id="tbl"><thead><tr><th>ID</th><th>Status</th><th>Port</th><th>PID</th><th>Restarts</th><th>Aktionen</th></tr></thead><tbody></tbody></table>
<h1>Channel hinzufügen</h1>
<form id="addForm">
  <div><label>ID</label><input name="id" required pattern="[A-Za-z0-9_-]+" placeholder="ORF2E"></div>
  <div><label>Data-Dir</label><input name="dataDir" required placeholder="channels/orf2e"></div>
  <div><label>Port</label><input name="port" type="number" required placeholder="3010"></div>
  <div><label>Grafik-Port</label><input name="grafikPort" type="number" placeholder="3111"></div>
  <button type="submit">Anlegen + Starten</button>
</form>

<div id="cfgOverlay">
  <div id="cfgDialog">
    <div id="cfgTabs"><button id="cfgClose" onclick="closeConfig()">✕ Schließen</button></div>
    <div id="cfgEmpty">Channel wird nicht ausgeführt — keine UI verfügbar.</div>
    <iframe id="cfgFrame" style="display:none"></iframe>
  </div>
</div>

<script>
let _channels = [];
let _activeId = null;
function fmtUptime(ms){ if(!ms) return ''; const s=Math.floor((Date.now()-ms)/1000); const h=Math.floor(s/3600),m=Math.floor((s%3600)/60); return h+'h '+m+'m'; }
async function refresh(){
  const res = await fetch('/api/channels');
  _channels = await res.json();
  const tb = document.querySelector('#tbl tbody');
  tb.innerHTML = _channels.map(c => \`<tr>
    <td>\${c.id}</td>
    <td><span class="status \${c.status}">\${c.status}</span></td>
    <td>\${c.port}</td>
    <td>\${c.pid || '–'}</td>
    <td>\${c.restarts}</td>
    <td>
      <button class="open" onclick="openConfig('\${c.id}')">⚙ Konfigurieren</button>
      <a class="btn open" target="_blank" href="//\${location.hostname}:\${c.port}/">UI öffnen</a>
      <button onclick="act('\${c.id}','start')">Start</button>
      <button onclick="act('\${c.id}','stop')">Stop</button>
      <button onclick="act('\${c.id}','restart')">Restart</button>
      <button onclick="del('\${c.id}')">Entfernen</button>
    </td>
  </tr>\`).join('');
  // Dialog offen + Channel inzwischen entfernt → schließen; sonst Tabs/Frame synchron halten.
  if (document.getElementById('cfgOverlay').classList.contains('show')) {
    if (_activeId && !_channels.some(c => c.id === _activeId)) closeConfig();
    else renderCfgTabs();
  }
}
async function act(id, action){ await fetch('/api/channels/'+encodeURIComponent(id)+'/'+action, {method:'POST'}); refresh(); }
async function del(id){ if(!confirm('Channel '+id+' entfernen (stoppt den Prozess)?')) return; await fetch('/api/channels/'+encodeURIComponent(id), {method:'DELETE'}); refresh(); }
document.querySelector('#addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = { id: f.get('id'), dataDir: f.get('dataDir'), port: parseInt(f.get('port')), grafikPort: f.get('grafikPort') ? parseInt(f.get('grafikPort')) : undefined };
  const res = await fetch('/api/channels', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if (!res.ok) { const e2 = await res.json().catch(()=>({})); alert(e2.error || 'Fehler'); return; }
  e.target.reset();
  refresh();
});

// ── Config-Dialog: Tableiste über allen Channels, darunter die jeweilige UI per iframe ──
function renderCfgTabs(){
  const tabs = document.getElementById('cfgTabs');
  tabs.innerHTML = _channels.map(c =>
    \`<button class="\${c.id===_activeId?'active':''}" onclick="openConfig('\${c.id}')">\${c.id===_activeId&&c.status!=='running'?'⚠ ':''}\${c.id}</button>\`
  ).join('') + '<button id="cfgClose" onclick="closeConfig()">✕ Schließen</button>';
}
function openConfig(id){
  _activeId = id;
  document.getElementById('cfgOverlay').classList.add('show');
  renderCfgTabs();
  const c = _channels.find(c => c.id === id);
  const frame = document.getElementById('cfgFrame');
  const empty = document.getElementById('cfgEmpty');
  if (!c || c.status !== 'running') {
    frame.style.display = 'none'; frame.src = 'about:blank';
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';
  frame.style.display = '';
  frame.src = \`//\${location.hostname}:\${c.port}/\`;
}
function closeConfig(){
  _activeId = null;
  document.getElementById('cfgOverlay').classList.remove('show');
  document.getElementById('cfgFrame').src = 'about:blank';
}
document.getElementById('cfgOverlay').addEventListener('click', e => { if (e.target.id === 'cfgOverlay') closeConfig(); });
refresh();
setInterval(refresh, 2000);
</script>
</body></html>`;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function startDashboard(port, registry, configPath) {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    try {
      if (req.method === 'GET' && p === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(renderDashboard());
      }
      if (req.method === 'GET' && p === '/api/channels') {
        return json(res, [...registry.values()].map(cp => cp.toJSON()));
      }
      if (req.method === 'POST' && p === '/api/channels') {
        const b = await parseBody(req);
        if (!b.id || !ID_RE.test(b.id)) return json(res, { ok: false, error: 'id erforderlich (a-z, A-Z, 0-9, _, -)' }, 400);
        if (registry.has(b.id)) return json(res, { ok: false, error: `Channel "${b.id}" existiert bereits` }, 409);
        if (!b.dataDir) return json(res, { ok: false, error: 'dataDir erforderlich' }, 400);
        const port_ = parseInt(b.port);
        if (!port_) return json(res, { ok: false, error: 'port erforderlich' }, 400);
        for (const cp of registry.values()) {
          if (cp.spec.port === port_) return json(res, { ok: false, error: `Port ${port_} bereits von Channel "${cp.spec.id}" belegt` }, 409);
        }
        const cp = new ChannelProcess({ id: b.id, dataDir: b.dataDir, port: port_, grafikPort: b.grafikPort ? parseInt(b.grafikPort) : undefined, env: b.env });
        registry.set(b.id, cp);
        cp.start();
        saveChannels(configPath, registry);
        return json(res, { ok: true, channel: cp.toJSON() });
      }
      const m = p.match(/^\/api\/channels\/([^/]+)\/(start|stop|restart)$/);
      if (req.method === 'POST' && m) {
        const cp = registry.get(decodeURIComponent(m[1]));
        if (!cp) return json(res, { ok: false, error: 'unbekannte Channel-ID' }, 404);
        if (m[2] === 'start')   cp.start();
        if (m[2] === 'stop')    cp.stop();
        if (m[2] === 'restart') { cp.stop(); setTimeout(() => cp.start(), 500); }
        return json(res, { ok: true, channel: cp.toJSON() });
      }
      const dm = p.match(/^\/api\/channels\/([^/]+)$/);
      if (req.method === 'DELETE' && dm) {
        const id = decodeURIComponent(dm[1]);
        const cp = registry.get(id);
        if (!cp) return json(res, { ok: false, error: 'unbekannte Channel-ID' }, 404);
        cp.stop();
        registry.delete(id);
        saveChannels(configPath, registry);
        return json(res, { ok: true });
      }
      json(res, { ok: false, error: 'not found' }, 404);
    } catch (e) {
      json(res, { ok: false, error: e.message }, 500);
    }
  });
  server.listen(port, () => console.log(`[supervisor] Dashboard → http://localhost:${port}`));
  return server;
}

function main() {
  const configPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, 'channels.json');
  const specs = loadChannels(configPath);

  const registry = new Map();
  for (const spec of specs) registry.set(spec.id, new ChannelProcess(spec));
  for (const cp of registry.values()) cp.start();

  const dashPort = parseInt(process.env.SUPERVISOR_PORT || '3099');
  const dashboard = startDashboard(dashPort, registry, configPath);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[supervisor] Shutdown — stoppe alle Channels...');
    for (const cp of registry.values()) cp.stop();
    dashboard.close();
    const t = setTimeout(() => process.exit(0), 6000);
    t.unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
