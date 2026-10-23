'use strict';
/**
 * DeckLink-Preflight / -Diagnose ohne Blackmagic-SDK-Header.
 *
 * Hintergrund: Ein fehlgeschlagener Master-Start mit decklinkvideosink liefert nur
 * "state change failed and some element failed to post a proper error message".
 * Der echte Grund steht nicht in der GStreamer-Meldung, sondern ist meist:
 *   - ein anderer Prozess (auch ein per Ctrl+Z angehaltener!) hält das Device,
 *   - der Desktop-Video-Helper/-Treiber läuft nicht,
 *   - der Kanal ist im Desktop-Video-Setup nicht konfiguriert (IP 100G).
 *
 * passive()  — nebenwirkungsfrei, sicher vor jedem Start: findet andere Prozesse, die
 *              libDeckLinkAPI geladen haben (über /proc/<pid>/maps), prüft Helper/Modul.
 * activeOpen() — NUR nach einem Fehlschlag: öffnet das Device kurz in einem
 *              Subprozess (gst-launch) mit GST_DEBUG=decklink:5 und liefert den echten
 *              HRESULT-/Fehlertext. Läuft isoliert, kann den Handle dieses Prozesses
 *              also nicht verschlimmern.
 */
const fs   = require('fs');
const { execFile, execFileSync } = require('child_process');

function _cmdline(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim().slice(0, 200); } catch { return '?'; }
}
function _state(pid) {
  try { return (/^State:\s+(\S)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8')) || [])[1] || '?'; } catch { return '?'; }
}

/** Andere Prozesse mit geladener libDeckLinkAPI (außer diesem). */
function findHolders() {
  const holders = [];
  let unreadable = 0;
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = +name;
    if (pid === process.pid) continue;
    try {
      if (!fs.readFileSync(`/proc/${pid}/maps`, 'utf8').includes('libDeckLinkAPI')) continue;
      holders.push({ pid, state: _state(pid), cmd: _cmdline(pid) });
    } catch (e) {
      if (e.code === 'EACCES') unreadable++;
    }
  }
  return { holders, unreadable };
}

function _helperRunning() {
  for (const unit of ['DesktopVideoHelper', 'desktopvideod']) {
    try { execFileSync('pgrep', ['-x', unit], { stdio: 'ignore' }); return unit; } catch {}
  }
  try {
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const c = _cmdline(name);
      if (/DesktopVideo|desktopvideod/i.test(c) && !/pgrep|grep/.test(c)) return c.split(' ')[0];
    }
  } catch {}
  return null;
}

function _moduleLoaded() {
  try { return /^blackmagic/m.test(fs.readFileSync('/proc/modules', 'utf8')); } catch { return null; }
}

/** @returns {{ok:boolean, findings:{level:'error'|'warn'|'info', msg:string}[]}} */
function passive() {
  const findings = [];
  const add = (level, msg) => findings.push({ level, msg });
  const { holders, unreadable } = findHolders();
  for (const h of holders) {
    add(h.state === 'T' ? 'error' : 'warn',
      `Prozess ${h.pid} (${h.state === 'T' ? 'ANGEHALTEN/Ctrl+Z' : 'Status ' + h.state}) hat die DeckLink-API geladen und kann die Karte belegen: ${h.cmd}  → beenden mit: kill -9 ${h.pid}`);
  }
  if (unreadable) add('info', `${unreadable} weitere Prozesse (anderer Benutzer) nicht prüfbar — ggf. als root: sudo grep -l libDeckLinkAPI /proc/*/maps`);
  const helper = _helperRunning();
  if (!helper) add('warn', 'Desktop-Video-Helper (DesktopVideoHelper/desktopvideod) läuft nicht — Karte/IP-100G-Kanäle werden nicht bereitgestellt');
  else add('info', `Desktop-Video-Helper läuft (${helper})`);
  const mod = _moduleLoaded();
  if (mod === false) add('info', 'Kein blackmagic-Kernelmodul geladen (bei IP 100G/reinem Netzwerkbetrieb normal; bei PCIe-Karten nicht)');
  return { ok: !findings.some(f => f.level === 'error'), findings };
}

/**
 * Kurzer Öffnungstest in einem Subprozess.
 * @param {{deviceNumber?:number, timeoutMs?:number}} o
 * @returns {Promise<{ok:boolean, lines:string[]}>}
 */
function activeOpen({ deviceNumber = 0, timeoutMs = 12000 } = {}) {
  return new Promise(resolve => {
    // Mode bewusst nicht gesetzt (auto): es geht nur ums Öffnen des Devices, nicht ums Format.
    const args = ['-q', 'videotestsrc', 'num-buffers=3', '!', 'videoconvert', '!',
      'video/x-raw,format=UYVY,width=1920,height=1080,framerate=25/1,interlace-mode=progressive',
      '!', 'decklinkvideosink', `device-number=${deviceNumber}`];
    const env = { ...process.env, GST_DEBUG: 'decklink:5,*:1', GST_DEBUG_NO_COLOR: '1' };
    execFile('gst-launch-1.0', args, { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const all = `${stdout || ''}\n${stderr || ''}`.split('\n');
      const lines = all.filter(l => /ERROR|error|fail|HRESULT|0x8\w{7}|in use|access|denied|Cannot|ERRORED|decklink.*(open|acquire|start)/i.test(l))
        .map(l => l.replace(/^\S+\s+\d+\s+\S+\s+/, '').slice(0, 300)).slice(-25);
      resolve({ ok: !err, lines: lines.length ? lines : (err ? [`gst-launch: ${err.message.slice(0, 200)}`] : []) });
    });
  });
}

module.exports = { passive, activeOpen, findHolders };
