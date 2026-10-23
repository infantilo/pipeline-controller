'use strict';
/**
 * GstKitGuard — Absicherung gegen native Abstürze im gst-kit-Addon.
 *
 * Hintergrund (Crash-Report 2026-10-23): Segfault ~2s nach Start in g_mutex_lock,
 * unmittelbar davor "gst_object_ref: object != NULL" / "gst_element_get_clock:
 * GST_IS_ELEMENT" — d.h. ein Pipeline-/Element-Objekt wurde benutzt, während es
 * (parallel) abgebaut wurde. Im Backtrace hing ein StateChangeWorker. gst-kit 0.2.5
 * startet play()/pause()/stop() jeweils als eigenen Worker-Thread OHNE sie zu
 * serialisieren; überlappende Zustandswechsel (z.B. stop() während play() noch
 * async wartet, Retry/Rebuild) sind damit möglich.
 *
 * Dieses Modul ersetzt gst-kit's Pipeline durch eine Fabrik, die pro Instanz
 *   1. play()/pause()/stop() strikt hintereinander ausführt (kein Überlappen),
 *   2. jeden Zustandswechsel als Breadcrumb ins Server-Log schreibt (steht dann im
 *      Crash-Report vor dem Absturz).
 * Muss VOR dem ersten Laden der lib/*-Module require()d werden.
 * Abschalten: PC_GST_GUARD=0.
 */
const gst = require('gst-kit');

if (process.env.PC_GST_GUARD === '0' || gst.__guarded) return;

const Native = gst.Pipeline;
let _seq = 0;
const tag = () => process.uptime().toFixed(3);

function GuardedPipeline(str) {
  const p = new Native(str);
  const id = ++_seq;
  const label = String(str).slice(0, 40).replace(/\s+/g, ' ');
  let chain = Promise.resolve();
  let pending = 0;
  const wrapped = {};

  const serialize = (m, orig) => (...args) => {
    if (pending > 0) console.log(`[gst-guard ${tag()}] #${id} ${m}() wartet auf ${pending} laufenden Zustandswechsel`);
    pending++;
    const run = chain.then(async () => {
      console.log(`[gst-guard ${tag()}] #${id} ${m}() start (${label})`);
      try { return await orig(...args); }
      finally { console.log(`[gst-guard ${tag()}] #${id} ${m}() ende`); }
    });
    // Kette darf durch Fehler nie reißen
    chain = run.then(() => {}, () => {});
    return run.finally(() => { pending--; });
  };

  // Die nativen Methoden sind nicht beschreibbare Instanz-Properties → per Proxy ersetzen.
  // (Dummy-Target nötig: die nativen Properties sind non-configurable, ein Proxy
  // direkt darüber dürfte andere Werte nicht liefern.)
  return new Proxy({}, {
    has: (_t, prop) => prop in p,
    set: (_t, prop, val) => { p[prop] = val; return true; },
    get(_t, prop) {
      const v = p[prop];
      if (prop === 'play' || prop === 'pause' || prop === 'stop') {
        return wrapped[prop] || (wrapped[prop] = serialize(prop, v));
      }
      return v;
    },
  });
}
GuardedPipeline.prototype = Native.prototype;

gst.Pipeline = GuardedPipeline;
gst.__guarded = true;
