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
const fsp  = fs.promises;
const path = require('path');

const RESTART_MS    = 3000;  // fixes Intervall, kein Backoff — Channel-Anzahl pro Host ist klein/stabil
const METRICS_MS    = 3000;  // CPU/RAM-Sampling-Intervall — liest nur /proc, keine Last auf den Channel-Prozessen selbst
const CLK_TCK       = 100;   // USER_HZ — Standardwert auf praktisch allen Linux-Distributionen
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

// Merkt sich, welche Channels der User zuletzt explizit gestartet/gestoppt hat — getrennt von
// channels.json, damit ein Supervisor-Neustart (z.B. Crash, Deploy, "systemctl restart") nur die
// Channels wieder hochfährt, die vorher liefen, statt pauschal alles zu starten.
function _statePath(configPath) {
  return path.join(path.dirname(configPath), '.supervisor-state.json');
}
function loadState(configPath) {
  try { return JSON.parse(fs.readFileSync(_statePath(configPath), 'utf8')); }
  catch { return {}; }
}
function saveState(configPath, desired) {
  try { fs.writeFileSync(_statePath(configPath), JSON.stringify(desired, null, 2)); }
  catch (e) { console.error('[supervisor] state save failed:', e.message); }
}

// ── Leichtgewichtiges CPU/RAM-Sampling über /proc — läuft komplett im Supervisor-Prozess,
// erzeugt keine zusätzliche Last auf den Channel-Prozessen selbst. ─────────────────────────
async function _readProcCpuTicks(pid) {
  const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  // rest[0] = Feld 3 (state) → utime = Feld 14 = rest[11], stime = Feld 15 = rest[12]
  return (parseInt(rest[11], 10) || 0) + (parseInt(rest[12], 10) || 0);
}
async function _readProcRssMb(pid) {
  const status = await fsp.readFile(`/proc/${pid}/status`, 'utf8');
  const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
  return m ? Math.round(parseInt(m[1], 10) / 1024 * 10) / 10 : null;
}

// Holt /api/state vom Channel selbst (eigener Port, localhost) — liefert den Playlist-Status
// (running/paused). Kurzer Timeout, damit ein hängender Channel das Dashboard nicht blockiert.
function _fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, r => {
      let data = '';
      r.on('data', c => { data += c; });
      r.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}
async function _samplePlaylistStatus(cp) {
  if (cp.status !== 'running') { cp.playlistStatus = null; return; }
  try {
    const state = await _fetchJson(`http://127.0.0.1:${cp.spec.port}/api/state`, 1500);
    const pl = state.playlist || {};
    cp.playlistStatus = pl.running ? (pl.paused ? 'paused' : 'playing') : 'stopped';
  } catch {
    cp.playlistStatus = 'unknown';
  }
}

async function sampleMetrics(registry) {
  const now = Date.now();
  await Promise.all([...registry.values()].map(async cp => {
    const pid = cp.proc?.pid;
    if (!pid) { cp.metrics = null; cp._cpuSample = null; cp.playlistStatus = null; return; }
    try {
      const ticks = await _readProcCpuTicks(pid);
      const rssMb = await _readProcRssMb(pid);
      const prev = cp._cpuSample;
      let cpuPercent = null;
      if (prev && prev.pid === pid) {
        const dSec = (now - prev.at) / 1000;
        if (dSec > 0) cpuPercent = Math.max(0, Math.round(((ticks - prev.ticks) / CLK_TCK) / dSec * 1000) / 10);
      }
      cp._cpuSample = { pid, ticks, at: now };
      cp.metrics = { cpuPercent, rssMb };
    } catch {
      cp.metrics = null; cp._cpuSample = null; // Prozess inzwischen weg o.ä. — nicht fatal
    }
    await _samplePlaylistStatus(cp);
  }));
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
    this.metrics = null;      // { cpuPercent, rssMb } — siehe sampleMetrics()
    this._cpuSample = null;
    this.playlistStatus = null; // 'playing' | 'paused' | 'stopped' | 'unknown' | null — siehe _samplePlaylistStatus()
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
    this.metrics = null; this._cpuSample = null; this.playlistStatus = null;
  }

  toJSON() {
    return {
      id: this.spec.id, dataDir: this.spec.dataDir, port: this.spec.port, grafikPort: this.spec.grafikPort,
      status: this.status, pid: this.proc?.pid || null, startedAt: this.startedAt,
      restarts: this.restarts, lastExit: this.lastExit, metrics: this.metrics,
      playlistStatus: this.playlistStatus,
    };
  }
}

// ── Dashboard (ein HTTP-Interface für alle Channels) ────────────────────────
function renderDashboard() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Channel-Supervisor</title>
<style>
body{font-family:system-ui,sans-serif;background:#15171c;color:#e6e6e6;margin:0;padding:24px}
h1{font-size:18px;font-weight:600;margin:0 0 16px}
table{width:100%;border-collapse:collapse;margin-bottom:24px;table-layout:fixed}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #2a2d35;font-size:14px;overflow:hidden}
th{color:#9aa0ab;font-weight:500}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.status,.plstatus{display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:600}
.running{background:#1d3b25;color:#5fd97c}
.starting,.restarting{background:#3b3414;color:#e0c050}
.stopped{background:#33363d;color:#9aa0ab}
.crashed{background:#3b1d1d;color:#e05050}
.pl-playing{background:#1d3b25;color:#5fd97c}
.pl-paused{background:#3b3414;color:#e0c050}
.pl-stopped{background:#33363d;color:#9aa0ab}
.pl-unknown{background:#33363d;color:#6c727c}
a.btn,button{background:#2a2d35;color:#e6e6e6;border:1px solid #3a3d45;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;margin-right:4px;text-decoration:none;display:inline-block}
a.btn:hover,button:hover{background:#3a3d45}
button:disabled{opacity:.35;cursor:not-allowed;background:#2a2d35}
button:disabled:hover{background:#2a2d35}
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
#langSwitch{position:fixed;top:20px;right:24px;display:flex;gap:0}
#langSwitch button{margin:0;border-radius:0}
#langSwitch button:first-child{border-radius:6px 0 0 6px}
#langSwitch button:last-child{border-radius:0 6px 6px 0}
#langSwitch button.active{background:#2c4a66;color:#bfe0ff;border-color:#5fa8e0}
#modalOverlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;z-index:200;align-items:center;justify-content:center}
#modalOverlay.show{display:flex}
#modalBox{background:#1a1c21;border:1px solid #3a3d45;border-radius:8px;width:380px;max-width:90vw;padding:20px}
#modalMsg{font-size:14px;line-height:1.5;margin-bottom:18px;white-space:pre-wrap}
#modalBtns{display:flex;justify-content:flex-end;gap:8px}
button.danger{background:#4a2024;color:#ff9b9b;border-color:#6b2a2e}
button.danger:hover{background:#5c2629}
</style></head><body>
<div id="langSwitch">
  <button id="langDe" onclick="setLang('de')">DE</button>
  <button id="langEn" onclick="setLang('en')">EN</button>
</div>
<h1 data-t="title">Channel-Supervisor</h1>
<table id="tbl">
<colgroup>
  <col style="width:80px"><col style="width:90px"><col style="width:60px"><col style="width:60px">
  <col style="width:60px"><col style="width:75px"><col style="width:75px"><col style="width:95px">
  <col style="width:70px"><col>
</colgroup>
<thead><tr>
  <th data-t="colId">ID</th><th data-t="colStatus">Status</th><th data-t="colPort">Port</th><th data-t="colPid">PID</th>
  <th data-t="colCpu">CPU</th><th data-t="colRam">RAM</th><th data-t="colUptime">Uptime</th><th data-t="colPlaylist">Playlist</th>
  <th data-t="colRestarts">Restarts</th><th data-t="colActions">Aktionen</th>
</tr></thead><tbody></tbody></table>
<h1 data-t="addHeading">Channel hinzufügen</h1>
<form id="addForm">
  <div><label data-t="lblId">ID</label><input name="id" required pattern="[A-Za-z0-9_-]+" placeholder="ORF2E"></div>
  <div><label data-t="lblDataDir">Data-Dir</label><input name="dataDir" required placeholder="channels/orf2e"></div>
  <div><label data-t="lblPort">Port</label><input name="port" type="number" required placeholder="3010"></div>
  <div><label data-t="lblGrafikPort">Grafik-Port</label><input name="grafikPort" type="number" placeholder="3111"></div>
  <button type="submit" data-t="btnCreate">Anlegen + Starten</button>
</form>

<div id="cfgOverlay">
  <div id="cfgDialog">
    <div id="cfgTabs"><button id="cfgClose" onclick="closeConfig()" data-t="btnClose">✕ Schließen</button></div>
    <div id="cfgEmpty" data-t="cfgEmpty">Channel wird nicht ausgeführt — keine UI verfügbar.</div>
    <iframe id="cfgFrame" style="display:none"></iframe>
  </div>
</div>

<div id="modalOverlay">
  <div id="modalBox">
    <div id="modalMsg"></div>
    <div id="modalBtns">
      <button id="modalCancel" onclick="_modalClickCancel()"></button>
      <button id="modalOk" onclick="_modalClickOk()"></button>
    </div>
  </div>
</div>

<script>
const I18N = {
  de: {
    title: 'Channel-Supervisor', colId: 'ID', colStatus: 'Status', colPort: 'Port', colPid: 'PID',
    colCpu: 'CPU', colRam: 'RAM', colUptime: 'Laufzeit', colPlaylist: 'Playlist',
    colRestarts: 'Restarts', colActions: 'Aktionen', addHeading: 'Channel hinzufügen',
    lblId: 'ID', lblDataDir: 'Data-Dir', lblPort: 'Port', lblGrafikPort: 'Grafik-Port',
    btnCreate: 'Anlegen + Starten', btnClose: '✕ Schließen', btnOk: 'OK', btnCancel: 'Abbrechen',
    cfgEmpty: 'Channel wird nicht ausgeführt — keine UI verfügbar.',
    btnConfigure: '⚙ Konfigurieren', btnOpenUi: 'UI öffnen', btnStart: 'Start', btnStop: 'Stop',
    btnRestart: 'Restart', btnRemove: 'Entfernen',
    plPlaying: 'läuft', plPaused: 'pausiert', plStopped: 'gestoppt', plUnknown: '?',
    confirmStop: id => \`Channel "\${id}" wirklich stoppen? Die Ausspielung wird unterbrochen.\`,
    confirmRestart: id => \`Channel "\${id}" wirklich neu starten? Die Ausspielung wird kurz unterbrochen.\`,
    confirmRemove: id => \`Channel "\${id}" wirklich entfernen? Der Prozess wird gestoppt und die Konfiguration gelöscht.\`,
    error: 'Fehler',
  },
  en: {
    title: 'Channel Supervisor', colId: 'ID', colStatus: 'Status', colPort: 'Port', colPid: 'PID',
    colCpu: 'CPU', colRam: 'RAM', colUptime: 'Uptime', colPlaylist: 'Playlist',
    colRestarts: 'Restarts', colActions: 'Actions', addHeading: 'Add Channel',
    lblId: 'ID', lblDataDir: 'Data Dir', lblPort: 'Port', lblGrafikPort: 'Graphics Port',
    btnCreate: 'Create + Start', btnClose: '✕ Close', btnOk: 'OK', btnCancel: 'Cancel',
    cfgEmpty: 'Channel is not running — no UI available.',
    btnConfigure: '⚙ Configure', btnOpenUi: 'Open UI', btnStart: 'Start', btnStop: 'Stop',
    btnRestart: 'Restart', btnRemove: 'Remove',
    plPlaying: 'playing', plPaused: 'paused', plStopped: 'stopped', plUnknown: '?',
    confirmStop: id => \`Really stop channel "\${id}"? Playout will be interrupted.\`,
    confirmRestart: id => \`Really restart channel "\${id}"? Playout will be briefly interrupted.\`,
    confirmRemove: id => \`Really remove channel "\${id}"? The process will be stopped and its configuration deleted.\`,
    error: 'Error',
  },
};
let LANG = localStorage.getItem('pc_lang') || 'de';
function t(key){ return I18N[LANG][key]; }
function setLang(l){ LANG = l; localStorage.setItem('pc_lang', l); applyStaticI18n(); refresh(); }
function applyStaticI18n(){
  document.querySelectorAll('[data-t]').forEach(el => { el.textContent = t(el.getAttribute('data-t')); });
  document.getElementById('langDe').classList.toggle('active', LANG === 'de');
  document.getElementById('langEn').classList.toggle('active', LANG === 'en');
  document.title = t('title');
}
// ── Modal-Dialoge (ersetzen native confirm()/alert() — Sicherheitsabfrage für Stop/Restart/Entfernen) ──
let _modalResolve = null;
function _openModal(msg, withCancel){
  document.getElementById('modalMsg').textContent = msg;
  document.getElementById('modalCancel').style.display = withCancel ? '' : 'none';
  document.getElementById('modalCancel').textContent = t('btnCancel');
  document.getElementById('modalOk').textContent = t('btnOk');
  document.getElementById('modalOk').className = withCancel ? 'danger' : '';
  document.getElementById('modalOverlay').classList.add('show');
}
function _closeModal(){ document.getElementById('modalOverlay').classList.remove('show'); }
function showConfirm(msg){
  return new Promise(resolve => {
    _openModal(msg, true);
    _modalResolve = v => { _closeModal(); _modalResolve = null; resolve(v); };
  });
}
function showAlert(msg){
  return new Promise(resolve => {
    _openModal(msg, false);
    _modalResolve = () => { _closeModal(); _modalResolve = null; resolve(); };
  });
}
function _modalClickOk(){ if (_modalResolve) _modalResolve(true); }
function _modalClickCancel(){ if (_modalResolve) _modalResolve(false); }
document.getElementById('modalOverlay').addEventListener('click', e => { if (e.target.id === 'modalOverlay') _modalClickCancel(); });

let _channels = [];
let _activeId = null;
// Feste Nachkommastellen statt variabler Länge ("5%" vs "12.3%") — verhindert, dass die
// Spaltenbreite bei jedem Refresh hüpft und damit die Aktions-Buttons mitwandern.
function fmtUptime(ms){ if(!ms) return '–'; const s=Math.floor((Date.now()-ms)/1000); const h=Math.floor(s/3600),m=Math.floor((s%3600)/60); return String(h).padStart(2,'0')+'h '+String(m).padStart(2,'0')+'m'; }
function fmtMetric(c){
  const cpu = c.metrics?.cpuPercent != null ? c.metrics.cpuPercent.toFixed(1) + '%' : '–';
  const ram = c.metrics?.rssMb != null ? c.metrics.rssMb.toFixed(1) + ' MB' : '–';
  return [cpu, ram];
}
function plStatusLabel(s){
  if (s === 'playing') return t('plPlaying');
  if (s === 'paused')  return t('plPaused');
  if (s === 'stopped') return t('plStopped');
  if (s === 'unknown') return t('plUnknown');
  return '–';
}
async function refresh(){
  const res = await fetch('/api/channels');
  _channels = await res.json();
  const tb = document.querySelector('#tbl tbody');
  tb.innerHTML = _channels.map(c => { const [cpu, ram] = fmtMetric(c); const plCls = c.playlistStatus ? 'pl-'+c.playlistStatus : 'pl-unknown';
    // Aktiv (Prozess existiert/wird gerade verwaltet) vs. ruhend ('stopped'/'crashed') — Start nur bei
    // ruhend, Stop/Restart nur bei aktiv erlaubt, damit man nicht z.B. einen bereits laufenden Channel
    // erneut startet oder einen gestoppten "stoppt".
    const isActive = c.status === 'running' || c.status === 'starting' || c.status === 'restarting';
    return \`<tr>
    <td>\${c.id}</td>
    <td><span class="status \${c.status}">\${c.status}</span></td>
    <td>\${c.port}</td>
    <td>\${c.pid || '–'}</td>
    <td class="num">\${cpu}</td>
    <td class="num">\${ram}</td>
    <td class="num">\${c.status==='running' ? fmtUptime(c.startedAt) : '–'}</td>
    <td>\${c.status==='running' ? \`<span class="plstatus \${plCls}">\${plStatusLabel(c.playlistStatus)}</span>\` : '–'}</td>
    <td class="num">\${c.restarts}</td>
    <td>
      <button class="open" onclick="openConfig('\${c.id}')">\${t('btnConfigure')}</button>
      <a class="btn open" target="_blank" href="//\${location.hostname}:\${c.port}/">\${t('btnOpenUi')}</a>
      <button \${isActive?'disabled':''} onclick="act('\${c.id}','start')">\${t('btnStart')}</button>
      <button \${!isActive?'disabled':''} onclick="actConfirm('\${c.id}','stop','confirmStop')">\${t('btnStop')}</button>
      <button \${!isActive?'disabled':''} onclick="actConfirm('\${c.id}','restart','confirmRestart')">\${t('btnRestart')}</button>
      <button onclick="del('\${c.id}')">\${t('btnRemove')}</button>
    </td>
  </tr>\`; }).join('');
  // Dialog offen + Channel inzwischen entfernt → schließen; sonst Tabs/Frame synchron halten.
  if (document.getElementById('cfgOverlay').classList.contains('show')) {
    if (_activeId && !_channels.some(c => c.id === _activeId)) closeConfig();
    else renderCfgTabs();
  }
}
async function act(id, action){ await fetch('/api/channels/'+encodeURIComponent(id)+'/'+action, {method:'POST'}); refresh(); }
async function actConfirm(id, action, confirmKey){ if(!(await showConfirm(t(confirmKey)(id)))) return; await act(id, action); }
async function del(id){ if(!(await showConfirm(t('confirmRemove')(id)))) return; await fetch('/api/channels/'+encodeURIComponent(id), {method:'DELETE'}); refresh(); }
document.querySelector('#addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = { id: f.get('id'), dataDir: f.get('dataDir'), port: parseInt(f.get('port')), grafikPort: f.get('grafikPort') ? parseInt(f.get('grafikPort')) : undefined };
  const res = await fetch('/api/channels', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if (!res.ok) { const e2 = await res.json().catch(()=>({})); await showAlert(e2.error || t('error')); return; }
  e.target.reset();
  refresh();
});

// ── Config-Dialog: Tableiste über allen Channels, darunter die jeweilige UI per iframe ──
function renderCfgTabs(){
  const tabs = document.getElementById('cfgTabs');
  tabs.innerHTML = _channels.map(c =>
    \`<button class="\${c.id===_activeId?'active':''}" onclick="openConfig('\${c.id}')">\${c.id===_activeId&&c.status!=='running'?'⚠ ':''}\${c.id}</button>\`
  ).join('') + \`<button id="cfgClose" onclick="closeConfig()">\${t('btnClose')}</button>\`;
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
applyStaticI18n();
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

function startDashboard(port, registry, configPath, desired) {
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
        desired[b.id] = 'running'; saveState(configPath, desired);
        saveChannels(configPath, registry);
        return json(res, { ok: true, channel: cp.toJSON() });
      }
      const m = p.match(/^\/api\/channels\/([^/]+)\/(start|stop|restart)$/);
      if (req.method === 'POST' && m) {
        const id = decodeURIComponent(m[1]);
        const cp = registry.get(id);
        if (!cp) return json(res, { ok: false, error: 'unbekannte Channel-ID' }, 404);
        if (m[2] === 'start')   { cp.start(); desired[id] = 'running'; }
        if (m[2] === 'stop')    { cp.stop();  desired[id] = 'stopped'; }
        if (m[2] === 'restart') { cp.stop(); setTimeout(() => cp.start(), 500); desired[id] = 'running'; }
        saveState(configPath, desired);
        return json(res, { ok: true, channel: cp.toJSON() });
      }
      const dm = p.match(/^\/api\/channels\/([^/]+)$/);
      if (req.method === 'DELETE' && dm) {
        const id = decodeURIComponent(dm[1]);
        const cp = registry.get(id);
        if (!cp) return json(res, { ok: false, error: 'unbekannte Channel-ID' }, 404);
        cp.stop();
        registry.delete(id);
        delete desired[id]; saveState(configPath, desired);
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
  const desired = loadState(configPath); // { [id]: 'running'|'stopped' } — vom letzten Lauf

  const registry = new Map();
  for (const spec of specs) registry.set(spec.id, new ChannelProcess(spec));
  // Nur Channels starten, die beim letzten Lauf liefen (oder neue, für die es noch keinen
  // State-Eintrag gibt) — ein manuell gestoppter Channel bleibt auch nach einem
  // Supervisor-Neustart gestoppt.
  for (const cp of registry.values()) {
    if (desired[cp.spec.id] === 'stopped') continue;
    cp.start();
    desired[cp.spec.id] = 'running';
  }
  saveState(configPath, desired);

  const dashPort = parseInt(process.env.SUPERVISOR_PORT || '3099');
  const dashboard = startDashboard(dashPort, registry, configPath, desired);
  const metricsTimer = setInterval(() => sampleMetrics(registry).catch(() => {}), METRICS_MS);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[supervisor] Shutdown — stoppe alle Channels...');
    clearInterval(metricsTimer);
    for (const cp of registry.values()) cp.stop();
    dashboard.close();
    const t = setTimeout(() => process.exit(0), 6000);
    t.unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
