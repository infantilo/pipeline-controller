#!/usr/bin/env node
/**
 * pipeline_debug.js  v3
 * ─────────────────────────────────────────────────────────────────────────────
 * Korrekte gst-kit API: pipeline.busPop(ms) statt pipeline.bus.on()
 *
 * Usage:
 *   node pipeline_debug.js <Datei> [--player player1|player2] [--pstr pStr3|pStr2|videoOnly]
 *
 * Beispiele:
 *   node pipeline_debug.js OH20020B.mxf
 *   node pipeline_debug.js water_netflix_7500kbps_1080p_59.94fps_hevc.mp4 --player player2
 *   node pipeline_debug.js OH20020B.mxf --pstr videoOnly
 */
'use strict';

const path = require('path');
const fs   = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_DIR  = __dirname;
const SETTINGS  = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'settings.json'), 'utf8'));
const AUDIO_CFG = path.join(BASE_DIR, 'audio_config.json');
const MEDIA_DIR = SETTINGS.mediaDir || path.join(BASE_DIR, 'media');
const FPS       = SETTINGS.fps    || 25;
const WIDTH     = SETTINGS.width  || 640;
const HEIGHT    = SETTINGS.height || 360;

// ── Args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);

// Robuster Arg-Parser: --flag value Paare separat extrahieren
function getFlag(flag) {
  const i = argv.indexOf(flag);
  // indexOf returns -1 if not found → -1+1=0 → argv[0] = Dateiname → BUG.
  // Fix: nur wenn Flag tatsächlich gefunden.
  if (i < 0 || i + 1 >= argv.length) return null;
  return argv[i + 1];
}
// Positionale Args: alles was kein --flag und kein Wert eines --flags ist
const flagValues = new Set();
['--player','--pstr'].forEach(f => { const v = getFlag(f); if (v) flagValues.add(v); });
const positional = argv.filter(a => !a.startsWith('--') && !flagValues.has(a));

const fileArg   = positional[0] || null;
const playerArg = getFlag('--player') || 'player1';
const pstrArg   = getFlag('--pstr')   || null; // null = alle Strategien testen

if (!fileArg) {
  console.error('Usage: node pipeline_debug.js <Datei> [--player player1|player2] [--pstr pStr3|pStr2|videoOnly]');
  process.exit(1);
}

const absFile = [
  path.join(MEDIA_DIR, fileArg),
  fileArg,
  path.resolve(fileArg),
].find(p => fs.existsSync(p));

if (!absFile) {
  console.error(`Datei nicht gefunden: ${fileArg}\nGesucht in: ${MEDIA_DIR}`);
  process.exit(1);
}

const uri = 'file://' + absFile.split('/').map((seg, i) => i === 0 ? seg : encodeURIComponent(seg)).join('/');
const slotId = playerArg;

// ── Module ────────────────────────────────────────────────────────────────────
const { Pipeline } = require('gst-kit');

// AudioGroupConfig und AudioRouter: optional, relativ zum Script-Ordner
let AudioGroupConfig = null;
let AudioRouter = null;
try { AudioGroupConfig = require(path.join(__dirname, 'lib', 'AudioGroupConfig')); }
catch(e) { console.warn('[WARN] AudioGroupConfig nicht gefunden — Audio-Routing wird übersprungen'); }
try { ({ AudioRouter } = require(path.join(__dirname, 'lib', 'AudioRouter'))); }
catch(e) { console.warn('[WARN] AudioRouter nicht gefunden — Audio-Routing wird übersprungen'); }

// ── AudioGroupConfig ──────────────────────────────────────────────────────────
let cfg = null;
let preset = null;
let pgmGroupId = 'pgm-stereo';

if (AudioGroupConfig && fs.existsSync(AUDIO_CFG)) {
  cfg = new AudioGroupConfig(AUDIO_CFG);
  preset = cfg.getPreset('stereo');
  pgmGroupId = cfg.groups[0]?.id || 'pgm-stereo';
  const fmt = preset?.routes ? 'NEW(routes)' : preset?.mappings ? 'OLD(mappings)' : '?';
  console.log(`\n[Config] Gruppen: ${cfg.groups.map(g=>g.id).join(', ')}`);
  console.log(`[Config] stereo-Preset Format: ${fmt}`);
  if (preset?.routes) console.log(`[Config] routes: ${JSON.stringify(preset.routes)}`);
}

// ── Pipeline-Strings bauen ────────────────────────────────────────────────────
function videoPath() {
  return [
    `queue max-size-buffers=16 max-size-bytes=0 max-size-time=0 leaky=upstream`,
    `! videoconvert ! video/x-raw,format=I420`,
    `! deinterlace`,
    `! videoscale add-borders=true`,
    `! video/x-raw,width=${WIDTH},height=${HEIGHT},framerate=${FPS}/1`,
    `! intervideosink channel=${slotId} sync=false async=false`,
  ].join(' ');
}

const vp = videoPath();
const pgmCh   = cfg?.getGroup(pgmGroupId)?.channels || 2;
const pgmChan = `${slotId}_${pgmGroupId}`;

// pStr3: einfachste Strategie — kein tee, kein audiomixmatrix
const pStr3 = [
  `uridecodebin name=db uri="${uri}" expose-all-streams=false`,
  `db. ! ${vp}`,
  `audiotestsrc wave=silence is-live=true ! fakesink name=clockAnchor_${slotId} sync=true`,
  `db. ! audioconvert ! audio/x-raw,layout=interleaved ! audioresample`,
  `! audio/x-raw,format=F32LE,rate=48000,channels=2,layout=interleaved`,
  `! queue max-size-buffers=2 max-size-time=0 max-size-bytes=0 leaky=downstream`,
  `! interaudiosink channel=${pgmChan} sync=false async=false`,
].join(' ');

// pStr2: mit audiomixmatrix identity
const pStr2 = [
  `uridecodebin name=db uri="${uri}" expose-all-streams=false`,
  `db. ! ${vp}`,
  `audiotestsrc wave=silence is-live=true ! fakesink name=clockAnchor_${slotId} sync=true`,
  `db. ! audioconvert ! audio/x-raw,layout=interleaved ! audioresample`,
  `! audio/x-raw,rate=48000,channels=2`,
  `! audiomixmatrix in-channels=2 out-channels=${pgmCh} matrix="< < 1.000000, 0.000000 >, < 0.000000, 1.000000 > >"`,
  `! audio/x-raw,format=F32LE,rate=48000,channels=${pgmCh}`,
  `! queue max-size-buffers=2 max-size-time=0 max-size-bytes=0 leaky=downstream`,
  `! interaudiosink channel=${pgmChan} sync=false async=false`,
].join(' ');

// pStr1: mit tee + audiomixmatrix (aus AudioRouter, falls routes vorhanden)
let pStr1 = null;
if (cfg && preset) {
  const router = new AudioRouter(cfg, preset, 2, slotId);
  const frags  = router.buildPlayerFragments();
  const valid  = frags.filter(f => f !== null);
  if (valid.length > 0) {
    pStr1 = [
      `uridecodebin name=db uri="${uri}" expose-all-streams=false`,
      `db. ! ${vp}`,
      `audiotestsrc wave=silence is-live=true ! fakesink name=clockAnchor_${slotId} sync=true`,
      `db. ! queue max-size-buffers=16 ! audioconvert ! audioresample`,
      `! audio/x-raw,rate=48000,channels=2 ! tee name=atee_${slotId}`,
      ...valid.map(f => `atee_${slotId}. ! ${f}`),
    ].join(' ');
    console.log(`\n[AudioRouter] ${valid.length} Fragsment(e) für tee-Strategie:`);
    valid.forEach((f, i) => console.log(`  [${i}] ${f.substring(0,100)}...`));
  } else {
    console.log('\n[AudioRouter] Alle Fragmente null (kein routes-Mapping) → pStr1 übersprungen');
  }
}

// videoOnly: kein Audio-Branch
const videoOnly = [
  `uridecodebin name=db uri="${uri}" expose-all-streams=false`,
  `db. ! ${vp}`,
  `audiotestsrc wave=silence is-live=true ! fakesink name=clockAnchor_${slotId} sync=true`,
].join(' ');

// ── Strategie-Auswahl ─────────────────────────────────────────────────────────
const allStrategies = { pStr3, pStr2, ...(pStr1 ? { pStr1 } : {}), videoOnly };
const toTest = pstrArg
  ? (allStrategies[pstrArg] ? { [pstrArg]: allStrategies[pstrArg] } : (() => { console.error(`Unbekannte Strategie: ${pstrArg}`); process.exit(1); })())
  : allStrategies;

// ── Pipeline-Strings ausgeben ─────────────────────────────────────────────────
console.log('\n' + '═'.repeat(80));
console.log('PIPELINE-STRINGS');
console.log('═'.repeat(80));
for (const [name, str] of Object.entries(toTest)) {
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0,74-name.length))}`);
  // Zeilenumbruch nach jedem Element (visueller)
  console.log(str.replace(/ ! /g, '\n  ! ').replace(/  db\. ! /g, '\n  db. ! '));
}

// ── GStreamer-Test ────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(80));
console.log('GSTREAMER LIVE-TEST');
console.log('═'.repeat(80));

async function testPipeline(name, pStr, timeoutMs = 12000) {
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`TESTE: ${name}  (timeout=${timeoutMs}ms)`);
  console.log('─'.repeat(80));

  let p = null;

  // 1. Parsen
  try {
    p = new Pipeline(pStr);
    console.log('  [parse] OK');
  } catch(e) {
    console.log(`  [parse] ❌ FEHLER: ${e.message}`);
    return { ok: false, phase: 'parse', error: e.message };
  }

  // 2. play()
  let playResult;
  try {
    console.log('  [play]  Setze PLAYING...');
    playResult = await p.play();
    console.log(`  [play]  result=${playResult?.result} state=${playResult?.finalState}`);
  } catch(e) {
    console.log(`  [play]  ❌ EXCEPTION: ${e.message}`);
    try { await p.stop(); } catch {}
    return { ok: false, phase: 'play', error: e.message };
  }

  // 3. Bus-Loop
  let ok = false;
  let mxfErrorSeen = false;
  const deadline = Date.now() + timeoutMs;
  const msgLog = [];

  console.log('  [bus]   Warte auf PLAYING-Bestätigung...');

  while (Date.now() < deadline) {
    let m;
    try { m = await p.busPop(300); }
    catch(e) { console.log(`  [bus]   busPop exception: ${e.message}`); break; }

    if (!m) continue;

    const t   = m.type || '?';
    const src = m.srcElementName || m.srcName || m.src || '?';
    const err = m.errorMessage || m.message || '';
    const ts  = new Date().toISOString().slice(11,23);
    const dbg = m.debugMessage || m.debug || '';

    msgLog.push({ t, src, err });

    // ── Nachrichten-Ausgabe ──────────────────────────────────────────────────
    if (t === 'error') {
      console.log(`  [bus]   ❌ ERROR  src=${src}`);
      console.log(`              msg: ${err}`);
      if (dbg) console.log(`              dbg: ${dbg}`);

      // mxfdemux-Error ist bekannt und harmlos nach PLAYING
      if (/internal.data.stream/i.test(err) && /mxfdemux/i.test(src)) {
        console.log(`  [bus]   ℹ️  mxfdemux-Error erkannt → ignoriert (bekannter GStreamer-Bug)`);
        mxfErrorSeen = true;
        if (ok) {
          // Error-Recovery: zweites play()
          console.log('  [bus]   🔄 Error-Recovery: zweites play()...');
          try { await p.play(); } catch {}
          await new Promise(r => setTimeout(r, 200));
          break;
        }
        continue;
      }

      // Echter Fehler
      try { await p.stop(); } catch {}
      return { ok: false, phase: 'bus', error: err, src, mxfErrorSeen, msgLog };
    }

    if (t === 'eos') {
      console.log(`  [bus]   ⏹ EOS  src=${src}`);
      break;
    }

    if (t === 'state-changed') {
      // Nur relevante State-Changes ausgeben
      const old = m.oldState || '?';
      const nw  = m.newState || '?';
      if (/^(pipeline|db|intervideosink|interaudiosink|mxfdemux|uridecodebin|source|clockAnchor)/.test(src)) {
        console.log(`  [bus]   STATE  ${src}: ${old}→${nw}`);
      }
      // PLAYING erkannt?
      if (/^pipeline/.test(src) && nw === 'playing') {
        console.log(`  [bus]   ✅ pipeline in PLAYING`);
      }
      continue;
    }

    if (t === 'new-clock') {
      const clk = m.clock?.name || m.clockName || '?';
      console.log(`  [bus]   🕐 NEW-CLOCK: ${clk}`);
      ok = true;

      // Bus 300ms leeren (mxfdemux-Error konsumieren)
      const flush = Date.now() + 300;
      while (Date.now() < flush) {
        let m2;
        try { m2 = await p.busPop(50); } catch { break; }
        if (!m2) break;
        const src2 = m2.srcElementName || m2.srcName || '';
        const err2 = m2.errorMessage || '';
        if (m2.type === 'error') {
          console.log(`  [bus]   ⚠ Flush-Error src=${src2}: ${err2}`);
          if (/internal.data.stream/i.test(err2) && /mxfdemux/i.test(src2)) {
            console.log(`  [bus]   ℹ️  mxfdemux-Error in Flush → Error-Recovery`);
            mxfErrorSeen = true;
            try { await p.play(); } catch {}
            await new Promise(r => setTimeout(r, 200));
          }
        }
      }
      break;
    }

    if (t === 'async-done') {
      console.log(`  [bus]   ✓ ASYNC-DONE  src=${src}`);
      if (/^pipeline/.test(src)) {
        ok = true;
        // Flush mxfdemux error
        const flush = Date.now() + 300;
        while (Date.now() < flush) {
          let m2;
          try { m2 = await p.busPop(50); } catch { break; }
          if (!m2) break;
          const src2 = m2.srcElementName || m2.srcName || '';
          const err2 = m2.errorMessage || '';
          if (m2.type === 'error' && /mxfdemux/i.test(src2)) {
            mxfErrorSeen = true;
            console.log(`  [bus]   🔄 mxfdemux-Error nach async-done → zweites play()`);
            try { await p.play(); } catch {}
            await new Promise(r => setTimeout(r, 200));
          }
        }
        break;
      }
    }

    if (t === 'stream-start') {
      console.log(`  [bus]   ▶ STREAM-START  src=${src}`);
      ok = true;
      break;
    }

    if (t === 'warning') {
      console.log(`  [bus]   ⚠ WARNING  src=${src}: ${err}`);
      continue;
    }

    if (t === 'latency') continue; // Spam unterdrücken

    console.log(`  [bus]   MSG type=${t}  src=${src}${err?' err='+err:''}`);
  }

  // 4. Ergebnis
  if (!ok) {
    console.log(`  [result] ❌ TIMEOUT — Pipeline hat PLAYING nicht bestätigt in ${timeoutMs}ms`);
    console.log(`  [result]    Letzte Nachrichten: ${msgLog.slice(-5).map(m=>m.t+'/'+m.src).join(', ')}`);
    try { await p.stop(); } catch {}
    return { ok: false, phase: 'timeout', mxfErrorSeen, msgLog };
  }

  // 5. Kurze Beobachtungs-Phase: läuft die Pipeline stabil?
  console.log('\n  [watch] 3 Sekunden Beobachtung (Bus-Messages)...');
  const watchEnd = Date.now() + 3000;
  let extraErrors = 0;
  while (Date.now() < watchEnd) {
    let m;
    try { m = await p.busPop(200); } catch { break; }
    if (!m) continue;
    const t   = m.type || '?';
    const src = m.srcElementName || m.srcName || '?';
    const err = m.errorMessage || '';
    if (t === 'error') {
      if (/internal.data.stream/i.test(err) && /mxfdemux/i.test(src)) {
        console.log(`  [watch] ℹ️  mxfdemux-Error (wiederholt, normal)`);
        continue;
      }
      console.log(`  [watch] ❌ ERROR  src=${src}: ${err}`);
      extraErrors++;
    } else if (t === 'state-changed') {
      const nw = m.newState || '';
      if (nw === 'null' || nw === 'ready') {
        console.log(`  [watch] ⚠ Pipeline fällt zurück auf ${nw} — INSTABIL!`);
        extraErrors++;
      }
    } else if (t !== 'latency') {
      console.log(`  [watch] MSG ${t} src=${src}`);
    }
  }

  // 6. Position/Duration abfragen
  try {
    const pos = p.queryPosition();
    const dur = p.queryDuration();
    console.log(`\n  [query] Position: ${pos !== null ? pos.toFixed(3)+'s' : 'n/a'}`);
    console.log(`  [query] Duration: ${dur !== null ? dur.toFixed(3)+'s' : 'n/a'}`);
  } catch(e) {
    console.log(`  [query] Exception: ${e.message}`);
  }

  // 7. Stop
  try { await p.stop(); } catch {}
  console.log('  [stop]  OK');

  const stable = extraErrors === 0;
  console.log(`\n  [result] ${stable ? '✅ OK — Pipeline läuft stabil' : '⚠ INSTABIL — ' + extraErrors + ' Fehler in Beobachtungsphase'}`);
  return { ok: true, stable, mxfErrorSeen, extraErrors };
}

// ── Alle Strategien testen ────────────────────────────────────────────────────
async function main() {
  const results = {};

  for (const [name, str] of Object.entries(toTest)) {
    results[name] = await testPipeline(name, str);
    await new Promise(r => setTimeout(r, 800)); // Cooldown zwischen Tests
  }

  // ── Zusammenfassung ───────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(80));
  console.log('ZUSAMMENFASSUNG');
  console.log('═'.repeat(80));
  for (const [name, r] of Object.entries(results)) {
    const icon = r.ok && r.stable ? '✅' : r.ok ? '⚠' : '❌';
    const info = r.ok
      ? (r.stable ? 'OK, stabil' : `INSTABIL (${r.extraErrors} Fehler)`)
      : `FEHLER in Phase: ${r.phase}${r.error ? ' → ' + r.error.substring(0,80) : ''}`;
    console.log(`  ${icon}  ${name.padEnd(12)} ${info}`);
  }

  const anyOk = Object.values(results).some(r => r.ok);
  if (!anyOk) {
    console.log('\n⚠️  KEINE STRATEGIE ERFOLGREICH');
    console.log('\nNächste Schritte:');
    console.log(`  gst-launch-1.0 -v uridecodebin uri="${uri}" ! autovideosink`);
    console.log(`  gst-launch-1.0 -v uridecodebin uri="${uri}" ! fakesink`);
    console.log('  gst-inspect-1.0 mxfdemux');
    console.log('  gst-inspect-1.0 intervideosink');
  }

  process.exit(anyOk ? 0 : 1);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
