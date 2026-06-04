/**
 * GrafixEngine.js
 * ════════════════════════════════════════════════════════════════════
 * oGraf HTML5-Grafik-Layer via Puppeteer → JPEG-Frames → intervideosink
 *
 * ARCHITEKTUR:
 *   1. Template-Server (Express): serviert HTML-Templates auf localhost:PORT
 *   2. Puppeteer (Headless Chrome): rendert Templates → JPEG-Screenshots
 *   3. GStreamer-Pipeline: appsrc → jpegdec → videoconvert → intervideosink:grafik
 *   4. MasterPipeline: intervideosrc:grafik als Grafik-Input-Pad (Overlay oder Replace)
 *
 * GRAFIK-LAYER-TYPEN:
 *   overlay  — RGBA-Overlay über Video (gdkpixbufoverlay oder compositor)
 *   full     — Ersetzt Video-Signal vollständig (isel-Pad)
 *
 * CHILD EVENTS:
 *   Pro Primär-Event können mehrere Grafik-Events als `children` attached werden:
 *   {
 *     source: 'player',
 *     file: 'clip.mxf',
 *     children: [
 *       { source: 'grafik', grafik: { template: 'lowerThird', data: {...}, delay: 2.5, duration: 8 }},
 *       { source: 'grafik', grafik: { template: 'clock', data: {}, delay: 0, duration: null }},
 *     ]
 *   }
 *   delay:    Sekunden nach Event-Start (0 = sofort mit Event)
 *   duration: Sekunden sichtbar (null = bis Event-Ende)
 *
 * TEMPLATES:
 *   Liegen in templates/grafik/*.html.
 *   Daten werden via URL-Query-Parameter übergeben.
 *   Template bekommt window.__GRAFIX_DATA__ als Objekt injiziert.
 *
 * PUPPETEER vs SVG/PNG:
 *   Option A (Puppeteer, Standard): vollständiges HTML5/CSS/Animationen
 *   Option B (SVG-Render, Fallback): schnell, kein Browser nötig, nur für einfache Grafiken
 *
 *   Puppeteer wird bevorzugt. Falls nicht installiert: automatischer Fallback auf SVG-Render.
 *
 * INSTALLATION:
 *   npm install puppeteer
 *   (oder: npm install puppeteer-core + chromium-browser)
 */

'use strict';

const { EventEmitter } = require('events');
const http  = require('http');
const path  = require('path');
const fs    = require('fs');
const zlib  = require('zlib');
const { execSync } = require('child_process');

const DEFAULT_PORT    = 3101;
const DEFAULT_WIDTH    = 1920;
const DEFAULT_HEIGHT   = 1080;
const RENDER_FPS       = 25;
const RENDER_INTERVAL  = Math.round(1000 / RENDER_FPS);   // 40ms @ 25fps — full rate when grafik active
const RENDER_INTERVAL_IDLE   = 1000;   // 1fps — grafik active but static (no pixel change)
const RENDER_INTERVAL_NOGFX  = 5000;  // 0.2fps — no grafik at all (transparent frames)

// Pre-cue lead time: inject iframe hidden this many ms before the show-timer.
// Allows the template (oGraf or HTML) to fully load and reach its first frame
// before becoming visible, eliminating 100-200ms iframe-load jitter.
const GRAFIK_PRECUE_LEAD_MS = 200;

// ── Puppeteer-Verfügbarkeit ────────────────────────────────────────────────

let _puppeteer = null;
let _puppeteerAvailable = null;

function getPuppeteer() {
  if (_puppeteerAvailable !== null) return _puppeteer;
  try {
    _puppeteer = require('puppeteer');
    _puppeteerAvailable = true;
  } catch {
    try {
      _puppeteer = require('puppeteer-core');
      _puppeteerAvailable = true;
    } catch {
      _puppeteerAvailable = false;
      _puppeteer = null;
    }
  }
  return _puppeteer;
}

// ── GrafixEngine ────────────────────────────────────────────────────────────

class GrafixEngine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string}  opts.templatesDir   — Pfad zu HTML-Templates
   * @param {number}  [opts.port=3101]    — HTTP-Port für Template-Server
   * @param {number}  [opts.width=1920]
   * @param {number}  [opts.height=1080]
   * @param {number}  [opts.fps=25]
   * @param {boolean} [opts.enablePuppeteer=true]
   */
  constructor(opts = {}) {
    super();
    this.templatesDir  = opts.templatesDir || path.join(process.cwd(), 'templates', 'grafik');
    this.port          = opts.port         || DEFAULT_PORT;
    this.width         = opts.width        || DEFAULT_WIDTH;
    this.height        = opts.height       || DEFAULT_HEIGHT;
    this.fps           = opts.fps          || RENDER_FPS;
    this.enablePuppeteer = opts.enablePuppeteer !== false;

    this._server       = null;
    this._browser      = null;
    this._page         = null;
    this._renderTimer  = null;
    this._running      = false;
    this._currentTemplate = null;
    this._currentData     = {};
    this._currentLayer    = 'overlay';
    this._frame           = null;
    this._clients         = new Set();
    this._activeGrafiks   = new Map();
    this._gstProc         = null;   // nicht mehr verwendet, bleibt für stop()-Kompatibilität
    this._gstReady        = false;
    this._frameQueue      = [];
    this._pageRecreating  = false;
    this._browserWatchdog = null;
    this._lastFrameHash   = null;
    this._lastRgba        = null;
    this._renderInterval  = RENDER_INTERVAL;
    this._transparentRgba = null;
    this._masterPipeline  = null;   // wird von außen gesetzt: grafixEngine.masterPipeline = master
  }

  _log(m, l = 'info') { this.emit('log', { level: l, msg: `[grafik] ${m}` }); }

  set masterPipeline(v) { this._masterPipeline = v; }
  get masterPipeline()  { return this._masterPipeline; }

  /**
   * Aktualisiert das Video-Format (Auflösung/FPS) ohne Neustart.
   * Schreibt Templates neu und setzt Puppeteer-Viewport neu.
   */
  async setFormat(width, height, fps) {
    this.width  = width  || this.width;
    this.height = height || this.height;
    this.fps    = fps    || this.fps;
    this._ensureDefaultTemplates();  // Templates mit neuen Dimensionen überschreiben
    if (this._page) {
      try {
        await this._page.setViewport({ width: this.width, height: this.height, deviceScaleFactor: 1 });
        // Compositor-Seite neu laden damit html/body-Dimensionen passen
        await this._page.goto(`http://localhost:${this.port}/grafik/__compositor_live`, { waitUntil: 'load', timeout: 3000 });
        this._log(`Format aktualisiert: ${this.width}×${this.height} @ ${this.fps}fps`);
      } catch(e) { this._log(`setFormat Puppeteer-Fehler: ${e.message}`, 'warn'); }
    }
    this._transparentFrame = null;  // Dimensionen-Cache ungültig machen
  }

  // ── Start / Stop ──────────────────────────────────────────────────────────

  async start() {
    if (this._running) return true;

    fs.mkdirSync(this.templatesDir, { recursive: true });
    this._ensureDefaultTemplates();

    this._startHttpServer();

    if (this.enablePuppeteer && getPuppeteer()) {
      await this._startPuppeteer();
    } else {
      this._log(this.enablePuppeteer
        ? 'Puppeteer nicht verfügbar → SVG-Fallback'
        : 'Puppeteer deaktiviert', 'warn');
    }

    // Periodic browser health check — detects silent crashes not caught by _renderFrame
    this._browserWatchdog = setInterval(async () => {
      if (!this._running || !this.enablePuppeteer || this._pageRecreating) return;
      if (this._page && this._browser) return;  // healthy
      const pptr = getPuppeteer();
      if (!pptr) return;
      this._log('Browser-Watchdog: kein Browser/Page → Neustart', 'warn');
      this._pageRecreating = true;
      try {
        try { await this._browser?.close(); } catch {}
        this._browser = null; this._page = null;
        await this._startPuppeteer();
        this._log('Browser-Watchdog: Neustart ✓');
      } catch(e) { this._log(`Browser-Watchdog Neustart fehlgeschlagen: ${e.message}`, 'warn'); }
      finally { this._pageRecreating = false; }
    }, 60000);

    // Pre-allocate transparent frame buffer once (avoids GC churn at 25fps)
    if (!this._transparentRgba) {
      this._transparentRgba = Buffer.alloc(this.width * this.height * 4, 0);
    }
    // grafikSrc appsrc MUST receive frames at all times — the compositor blocks if sink_2 starves.
    if (!this._renderTimer) {
      this._startTransparentFallback();
    }

    this._running = true;
    this._log(`GrafixEngine läuft (Port ${this.port})`);
    // Template-Liste beim Start loggen — so ist der Status immer sichtbar ohne API-Aufruf
    try {
      const tpls = this._listTemplates();
      this._log(`Templates (${tpls.length}): ${tpls.map(t=>t.name+'['+t.type+']').join(', ') || '(keine)'}`, 'info');
    } catch(e) { this._log(`Template-Scan Fehler: ${e.message}`, 'warn'); }
    this.emit('started');
    return true;
  }

  async stop() {
    this._running = false;
    this._clearAll();
    if (this._browserWatchdog) { clearInterval(this._browserWatchdog); this._browserWatchdog = null; }
    if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null; }
    if (this._page)    { try { await this._page.close();    } catch {} this._page    = null; }
    if (this._browser) { try { await this._browser.close(); } catch {} this._browser = null; }
    if (this._server)  { this._server.close(); this._server = null; }
    if (this._gstProc) { try { this._gstProc.stdin.end(); this._gstProc.kill(); } catch {} this._gstProc = null; }
    this._gstReady = false;
    this._log('Gestoppt');
    this.emit('stopped');
  }

  // ── Puppeteer ─────────────────────────────────────────────────────────────

  async _startPuppeteer() {
    const pptr = getPuppeteer();
    try {
      // pptr.launch() has no built-in timeout — on misconfigured systems it hangs
      // indefinitely, blocking ensureMaster() and preventing the preview from ever starting.
      const launchTimeout = new Promise((_, rej) =>
        setTimeout(() => rej(new Error('Puppeteer launch timeout (10s)')), 10000));
      this._browser = await Promise.race([
        pptr.launch({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            `--window-size=${this.width},${this.height}`,
            '--disable-web-security',
            '--allow-file-access-from-files',
          ],
        }),
        launchTimeout,
      ]);
      this._page = await this._browser.newPage();
      await this._page.setViewport({ width: this.width, height: this.height, deviceScaleFactor: 1 });

      // Leere Startseite (transparent)
      // Compositor-Page einmalig laden — bleibt für gesamte Session geladen.
      // show()/hide() nutzen page.evaluate() um Layers dynamisch zu verwalten.
      await this._page.goto(`http://localhost:${this.port}/grafik/__compositor_live`, { waitUntil: 'load', timeout: 3000 });

      this._log(`Puppeteer bereit (${this.width}×${this.height} @ ${this.fps}fps)`);
      // Adaptive render loop — started by _scheduleRender() after Puppeteer is ready
      this._scheduleRender();
    } catch(e) {
      this._log(`Puppeteer-Start fehlgeschlagen: ${e.message}`, 'warn');
      this._browser = null;
      this._page    = null;
    }
  }

  _startTransparentFallback() {
    const W = this.width, H = this.height;
    this._transparentRgba = Buffer.alloc(W * H * 4, 0);
    this._log(`Grafix-Fallback aktiv: transparente Frames ${W}×${H}`, 'info');
    this._scheduleRender();
  }

  _scheduleRender() {
    if (this._renderTimer) return;  // already scheduled
    const hasGfx  = this._activeGrafiks?.size > 0;
    const hasPage = !!(this._page && this._browser && !this._pageRecreating);

    let interval;
    if (!hasGfx) {
      interval = RENDER_INTERVAL_NOGFX;         // no grafik: ~0.2fps, transparent only
    } else if (!hasPage) {
      interval = RENDER_INTERVAL_IDLE;           // grafik active but page unavailable
    } else if (this._renderInterval === RENDER_INTERVAL_IDLE) {
      interval = RENDER_INTERVAL_IDLE;           // static frame detected last tick
    } else {
      interval = RENDER_INTERVAL;               // animated grafik: full 25fps
    }

    this._renderTimer = setTimeout(async () => {
      this._renderTimer = null;
      if (!this._running) return;
      await this._renderFrame();
      this._scheduleRender();
    }, interval);
  }

  async _renderFrame() {
    // No grafik active: push cached transparent frame, skip expensive screenshot
    if (!this._activeGrafiks?.size) {
      const tr = this._transparentRgba;
      if (tr) this._pushFrameToGst(tr);
      return;
    }

    if (!this._page || !this._browser || this._pageNavigating) {
      // Page not available: push transparent
      const tr = this._transparentRgba;
      if (tr) this._pushFrameToGst(tr);
      return;
    }
    try {
      const pngBuf = Buffer.from(await this._page.screenshot({
        type: 'png', omitBackground: true, captureBeyondViewport: false,
      }));
      this._frame = pngBuf;

      // Preview-Clients ~5fps
      const now = Date.now();
      if (now - (this._lastPreviewPush || 0) >= 200) {
        this._lastPreviewPush = now;
        this._pushToClients(pngBuf);
      }

      // Detect static frame: compare a quick hash of the first 4KB of PNG data.
      // If unchanged, still push the same RGBA (GStreamer needs frames) but at reduced rate.
      const quickHash = pngBuf.slice(0, 4096).toString('base64', 0, 64);
      const changed = quickHash !== this._lastFrameHash;
      this._lastFrameHash = quickHash;
      if (!changed) {
        // Static frame — push cached RGBA at low rate (interval already slowed by _scheduleRender)
        if (this._lastRgba) this._pushFrameToGst(this._lastRgba);
        // Slow down next tick to IDLE rate when static
        if (this._renderInterval !== RENDER_INTERVAL_IDLE) {
          this._renderInterval = RENDER_INTERVAL_IDLE;
        }
        return;
      }
      this._renderInterval = RENDER_INTERVAL;  // animated: full rate

      const rgba = this._pngToRgbaSync(pngBuf);
      if (rgba) {
        this._rgbaWarnLogged = false;
        this._lastRgba = rgba;
        this._pushFrameToGst(rgba);
      } else if (!this._rgbaWarnLogged) {
        this._rgbaWarnLogged = true;
        this._log(`WARN: PNG→RGBA Dekodierung fehlgeschlagen (buf=${pngBuf?.length ?? 0} bytes)`, 'warn');
      }
      this.emit('frame', pngBuf);
    } catch(e) {
      const msg = e.message || '';
      const isPageCrash = msg.includes('Not attached') || msg.includes('Target closed') || msg.includes('Session closed');
      const isBrowserCrash = msg.includes('Protocol error') || msg.includes('pipe') || msg.includes('ECONNRESET') || msg.includes('Connection closed');

      if ((isPageCrash || isBrowserCrash) && !this._pageRecreating) {
        this._pageRecreating = true;
        this._page = null;
        this._log(`Puppeteer ${isBrowserCrash ? 'Browser' : 'Page'} neu starten...`, 'warn');
        try {
          if (isBrowserCrash || !this._browser) {
            // Full browser restart
            try { await this._browser?.close(); } catch {}
            this._browser = null;
            await this._startPuppeteer();
          } else {
            // Page-only restart
            try { await this._page?.close(); } catch {}
            this._page = await this._browser.newPage();
            await this._page.setViewport({ width: this.width, height: this.height, deviceScaleFactor: 1 });
            await this._page.goto(`http://localhost:${this.port}/grafik/__compositor_live`, { waitUntil: 'load', timeout: 3000 });
          }
          this._log('Puppeteer neu bereit ✓');
        } catch(e2) {
          this._log(`Puppeteer-Neustart fehlgeschlagen: ${e2.message}`, 'warn');
          this._page = null; this._browser = null;
        } finally {
          this._pageRecreating = false;
        }
      } else if (!this._pageRecreating) {
        this._log(`Render-Fehler: ${msg}`, 'debug');
      }
    }
  }

  // ── PNG → rohe RGBA-Pixel (Node.js built-in zlib, keine externe Deps) ──────

  _pngToRgbaSync(buf) {
    try {
      // PNG Signature
      if (buf[0] !== 0x89 || buf[1] !== 0x50) return null;
      let pos = 8;
      let width = 0, height = 0, colorType = 0, bitDepth = 0;
      const idatChunks = [];

      while (pos + 8 <= buf.length) {
        const len  = buf.readUInt32BE(pos); pos += 4;
        const type = buf.slice(pos, pos + 4).toString('ascii'); pos += 4;
        const data = buf.slice(pos, pos + len); pos += len + 4; // +4 CRC

        if (type === 'IHDR') {
          width     = data.readUInt32BE(0);
          height    = data.readUInt32BE(4);
          bitDepth  = data[8];
          colorType = data[9];
        } else if (type === 'IDAT') {
          idatChunks.push(data);
        } else if (type === 'IEND') break;
      }

      if (!width || !height) return null;
      // Only support 8-bit RGB(2) and RGBA(6)
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) return null;

      const bpp    = colorType === 6 ? 4 : 3;
      const stride = width * bpp;
      const raw    = zlib.inflateSync(Buffer.concat(idatChunks));
      const out    = Buffer.alloc(width * height * 4, 0);

      let inPos = 0;
      const prevRow = Buffer.alloc(stride, 0);

      for (let y = 0; y < height; y++) {
        const filter = raw[inPos++];
        const row    = Buffer.from(raw.slice(inPos, inPos + stride)); inPos += stride;

        // PNG filter reconstruction
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? row[i - bpp] : 0;
          const b = prevRow[i];
          const c = i >= bpp ? prevRow[i - bpp] : 0;
          switch (filter) {
            case 0: break; // None
            case 1: row[i] = (row[i] + a) & 0xff; break; // Sub
            case 2: row[i] = (row[i] + b) & 0xff; break; // Up
            case 3: row[i] = (row[i] + ((a + b) >> 1)) & 0xff; break; // Average
            case 4: { // Paeth
              const p = a + b - c;
              const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
              row[i] = (row[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
              break;
            }
          }
        }
        row.copy(prevRow);

        const outBase = y * width * 4;
        for (let x = 0; x < width; x++) {
          if (colorType === 6) {
            out[outBase + x * 4]     = row[x * 4];
            out[outBase + x * 4 + 1] = row[x * 4 + 1];
            out[outBase + x * 4 + 2] = row[x * 4 + 2];
            out[outBase + x * 4 + 3] = row[x * 4 + 3];
          } else {
            out[outBase + x * 4]     = row[x * 3];
            out[outBase + x * 4 + 1] = row[x * 3 + 1];
            out[outBase + x * 4 + 2] = row[x * 3 + 2];
            out[outBase + x * 4 + 3] = 255;
          }
        }
      }
      return out;
    } catch(e) {
      return null;
    }
  }

  _pushFrameToGst(pngBuf) {
    if (!pngBuf) return;
    if (!this._masterPipeline) {
      // Nur beim ersten Mal warnen
      if (!this._masterNullWarned) {
        this._masterNullWarned = true;
        this._log('GrafixEngine: masterPipeline noch nicht gesetzt — Frames werden verworfen', 'warn');
      }
      return;
    }
    this._masterNullWarned = false;  // Reset falls masterPipeline wieder gesetzt wird
    try { this._masterPipeline.pushGrafikFrame(pngBuf); } catch(e) {
      this._log(`pushGrafikFrame error: ${e.message}`, 'warn');
    }
  }

  // ── Grafik-Anzeige ────────────────────────────────────────────────────────

  /**
   * Zeigt ein Grafik-Template an.
   * @param {string} template    — Template-Name (ohne .html)
   * @param {object} data        — Template-Daten (window.__GRAFIX_DATA__)
   * @param {string} layer       — 'overlay' | 'full'
   * @param {string} [grafixId]  — Eindeutige ID (für multi-layer)
   * @returns {string}           — grafixId
   */
  async show(template, data = {}, layer = 'overlay', grafixId = null) {
    const id = grafixId || `grafik-${Date.now()}`;
    this._log(`Show: ${template} [${layer}] id=${id} (${this.width}×${this.height})`);
    this._activeGrafiks.set(id, { template, data, layer });
    this._currentLayer = layer;
    this._alphaChecked = false;
    this._lastFrameHash = null;  // force re-render at full rate when new grafik appears
    // Kick render loop into full-rate mode immediately
    if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null; }
    this._scheduleRender();
    this.emit('show', { id, template, data, layer });
    if (this._page) {
      // w/h als explizite URL-Parameter → Server verwendet immer die aktuellen Dimensionen,
      // auch wenn this.width/height zwischen Anfragen geändert wurde.
      const params = new URLSearchParams({ data: JSON.stringify(data), layer, w: this.width, h: this.height, fps: this.fps });
      const url = `http://localhost:${this.port}/grafik/${encodeURIComponent(template)}?${params}`;
      const W = this.width, H = this.height;
      try {
        // Iframe injizieren und auf load-Event warten (max 3s).
        // Der load-Event feuert NACH dem ES-Modul-Import → play() wurde aufgerufen.
        // Zusätzliche 80ms damit die erste Animations-Frame-Gruppe gerendert wird,
        // bevor showGrafik() den Compositor auf echte Frames umschaltet.
        // Explizite px-Dimensionen statt width:100%/height:100% — verhindert Chromium-
        // Viewport-Berechnungsfehler bei Prozentangaben auf fixem Pixel-Container.
        await this._page.evaluate((iframeId, iframeSrc, iW, iH) => {
          return new Promise((resolve) => {
            // Bestehenden Layer mit gleicher ID entfernen (falls Reload)
            const old = document.getElementById(iframeId);
            if (old) old.remove();
            const fr = document.createElement('iframe');
            fr.id   = iframeId;
            fr.name = iframeId;   // Puppeteer kann Frame per name() finden
            fr.src  = iframeSrc;
            fr.style.cssText = `position:absolute;top:0;left:0;width:${iW}px;height:${iH}px;border:none;background:transparent;`;
            fr.allowTransparency = true;
            // Fallback-Timeout falls load nie feuert (404, Netzwerk-Fehler etc.)
            const fallback = setTimeout(resolve, 3000);
            fr.addEventListener('load', () => { clearTimeout(fallback); setTimeout(resolve, 80); }, { once: true });
            document.body.appendChild(fr);
          });
        }, id, url, W, H);
      } catch(e) { this._log(`Template-Load: ${e.message}`, 'warn'); }
    }
    return id;
  }

  /**
   * Versteckt/entfernt eine aktive Grafik.
   * @param {string} grafixId
   */
  async hide(grafixId) {
    const g = this._activeGrafiks.get(grafixId);
    if (!g) return;
    this._log(`Hide: ${grafixId} (${g.template})`);
    this._activeGrafiks.delete(grafixId);
    this.emit('hide', { id: grafixId });
    // If no more grafiks: let render loop naturally slow to NOGFX rate on next tick
    if (this._page) {
      try {
        await this._page.evaluate(iframeId => {
          const el = document.getElementById(iframeId);
          if (el) el.remove();
        }, grafixId);
      } catch(e) { this._log(`hide eval: ${e.message}`, 'warn'); }
    }
  }

  /**
   * Sendet "continue" an eine aktive oGraf-Grafik.
   * Ruft el.continueAction() im Puppeteer-Context auf.
   * @param {string} grafixId
   */
  async grafixContinue(grafixId) {
    if (!this._page) return;
    const g = this._activeGrafiks.get(grafixId);
    if (!g) return;
    this._log(`Continue: ${grafixId} (${g.template})`);
    // Puppeteer-Frame per name() suchen (iframe hat fr.name = grafixId).
    // frame.evaluate() läuft direkt im iframe-Kontext → kein cross-frame-Zugriffsproblem.
    const frame = this._page.frames().find(f => f.name() === grafixId);
    if (!frame) {
      this._log(`grafixContinue: Frame "${grafixId}" nicht gefunden`, 'warn');
      return;
    }
    try {
      await frame.evaluate(() => {
        if (window.__OGRAF_HOST__?.continue) return window.__OGRAF_HOST__.continue();
      });
    } catch(e) { this._log(`grafixContinue eval: ${e.message}`, 'warn'); }
  }

  async grafixUpdate(grafixId, data) {
    if (!this._page) return;
    const g = this._activeGrafiks.get(grafixId);
    if (!g) return;
    // Update the stored data so subsequent continues see the new data
    g.data = { ...g.data, ...data };
    this._log(`Update: ${grafixId} (${g.template})`);
    const frame = this._page.frames().find(f => f.name() === grafixId);
    if (!frame) {
      this._log(`grafixUpdate: Frame "${grafixId}" nicht gefunden`, 'warn');
      return;
    }
    try {
      await frame.evaluate((d) => {
        if (window.__OGRAF_HOST__?.update) return window.__OGRAF_HOST__.update(d);
      }, data);
    } catch(e) { this._log(`grafixUpdate eval: ${e.message}`, 'warn'); }
  }

  async _renderActiveLayers() {
    // Nicht mehr nötig: show()/hide() verwalten Compositor-iframes direkt per evaluate().
    // Methode bleibt als Stub für mögliche Aufrufe aus altem Code.
  }

  /** Alle aktiven Grafiken entfernen */
  async hideAll() {
    for (const id of [...this._activeGrafiks.keys()]) {
      await this.hide(id);
    }
    this._clearAll();
  }

  _clearAll() {
    for (const [id, g] of this._activeGrafiks) {
      if (g._durationTimer) clearTimeout(g._durationTimer);
      if (g._delayTimer)    clearTimeout(g._delayTimer);
    }
    this._activeGrafiks.clear();
  }

  async _showBlank() {
    this._currentTemplate = null;
    if (this._page) {
      try {
        await this._page.evaluate(() => {
          // Alle iframe-Layer entfernen → transparentes Bild
          document.body.innerHTML = '';
        });
      } catch {}
    }
  }

  // ── Pre-Cue: Template vorladen (unsichtbar) ───────────────────────────────

  /**
   * Injiziert den Template-iframe hidden ins Compositor-DOM.
   * Das Template lädt, initialisiert und rendert seinen ersten Frame —
   * ohne dass GStreamer es sieht (kein _activeGrafiks-Eintrag).
   * @returns {boolean} true wenn erfolgreich
   */
  async _precueFrame(id, url, W, H) {
    if (!this._page || this._pageRecreating) return false;
    try {
      await this._page.evaluate((iframeId, iframeSrc, iW, iH) => {
        return new Promise(resolve => {
          const old = document.getElementById(iframeId);
          if (old) old.remove();
          const fr  = document.createElement('iframe');
          fr.id     = iframeId;
          fr.name   = iframeId;
          fr.src    = iframeSrc;
          // visibility:hidden — el ist im Layout aber unsichtbar für Screenshots
          fr.style.cssText = `position:absolute;top:0;left:0;width:${iW}px;height:${iH}px;border:none;background:transparent;visibility:hidden;`;
          fr.allowTransparency = true;
          const fallback = setTimeout(resolve, 3000);
          fr.addEventListener('load', () => { clearTimeout(fallback); setTimeout(resolve, 80); }, { once: true });
          document.body.appendChild(fr);
        });
      }, id, url, W, H);
      return true;
    } catch(e) {
      this._log(`_precueFrame ${id}: ${e.message}`, 'debug');
      return false;
    }
  }

  /**
   * Macht einen per _precueFrame vorgeladenen iframe sichtbar.
   * Setzt _activeGrafiks und kickt den Render-Loop.
   * @returns {boolean} true wenn iframe gefunden und sichtbar gemacht
   */
  async _showPrecued(id, template, data, layer) {
    if (!this._page) return false;
    try {
      const found = await this._page.evaluate(iframeId => {
        const el = document.getElementById(iframeId);
        if (!el) return false;
        el.style.visibility = '';
        return true;
      }, id);
      if (!found) return false;
      this._activeGrafiks.set(id, { template, data, layer });
      this._lastFrameHash = null;
      if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null; }
      this._scheduleRender();
      this.emit('show', { id, template, data, layer });
      return true;
    } catch(e) {
      this._log(`_showPrecued ${id}: ${e.message}`, 'debug');
      return false;
    }
  }

  // ── Child Events / Scheduled Grafik ───────────────────────────────────────

  /**
   * Resolves playlist variable references in a grafik data object.
   * Syntax: {{SCOPE:FIELD}} or {{SCOPE[FILTER]:FIELD}}
   *   SCOPE:  current | next | next2 | prev
   *   FILTER: class(id) | title(substr) | source(id)
   *   FIELD:  title | file | source | classification | classifcolor | classificon |
   *           starttime | duration | endtime
   * Example: {{next[class=movie]:title}}, {{current:classification}}
   *
   * @param {object} data     — grafik data object (values may contain {{...}})
   * @param {object} context  — { playlist, currentIndex, fps, classifs }
   * @returns {object}        — resolved copy of data
   */
  _resolveVars(data, context) {
    if (!data || !context) return data;
    const { playlist = [], currentIndex = 0, fps: cfps = 25, classifs = [],
            currentClipRemainingSec = 0,
            _scheduleElapsedSec = 0 } = context;
    // For child-event grafiks: remaining = clip duration - time already elapsed at show-time
    const _effectiveRemainingSec = Math.max(0, currentClipRemainingSec - _scheduleElapsedSec);

    // Optional |FORMAT suffix: {{next:starttime|unix}}, {{next:starttime|HH:MM}}, etc.
    const VAR_RE = /\{\{(current|next\d*|prev\d*)(?:\[([^\]]+)\])?:([\w]+)(?:\|([\w:.]+))?\}\}/gi;
    // Detect whether the whole value is exactly one variable (for numeric type coercion)
    const SINGLE_VAR_RE = /^\{\{[^}]+\}\}$/;

    const findEvent = (scope, filter) => {
      if (scope === 'current') return { ev: playlist[currentIndex], idx: currentIndex };

      let direction = 1, skip = 1;
      if (scope.startsWith('prev')) {
        direction = -1;
        skip = parseInt(scope.slice(4) || '1', 10) || 1;
      } else {
        skip = parseInt(scope.slice(4) || '1', 10) || 1;  // next, next2, …
      }

      let filterFn = () => true;
      if (filter) {
        const fm = filter.match(/^(class|source|title)\(([^)]+)\)$/i) ||
                   filter.match(/^(class|source|title)=(.+)$/i);
        if (fm) {
          const [, ftype, fval] = fm;
          const lval = fval.toLowerCase().replace(/^["']|["']$/g, '');
          if (ftype === 'class')  filterFn = ev => (ev.classification || '').toLowerCase() === lval;
          else if (ftype === 'source') filterFn = ev => (ev.source || '').toLowerCase() === lval;
          else if (ftype === 'title')  filterFn = ev => (ev.title || ev.file || '').toLowerCase().includes(lval);
        }
      }

      let found = 0;
      const start = direction > 0 ? currentIndex + 1 : currentIndex - 1;
      const end   = direction > 0 ? playlist.length  : -1;
      for (let i = start; direction > 0 ? i < end : i > end; i += direction) {
        const ev = playlist[i];
        if (!ev || ev._state === 'done' || ev._state === 'skipped') continue;
        if (ev.source === 'comment' || ev.source === 'block_start' || ev.source === 'block_end') continue;
        if (!filterFn(ev)) continue;
        if (++found >= skip) return { ev, idx: i };
      }
      return { ev: null, idx: -1 };
    };

    // Parse TC string "HH:MM:SS:FF" or plain seconds number → seconds float.
    const _parseTcSec = (v) => {
      if (v == null) return 0;
      if (typeof v === 'number') return v;
      const s = String(v).trim();
      if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
      const p = s.split(':').map(Number);
      if (p.some(isNaN) || !p.length) return 0;
      if (p.length === 4) return p[0]*3600 + p[1]*60 + p[2] + p[3]/(cfps||25);
      if (p.length === 3) return p[0]*3600 + p[1]*60 + p[2];
      if (p.length === 2) return p[0]*60 + p[1];
      return 0;
    };

    // Helper: duration of a playlist event in seconds (best effort)
    const _evDurSec = (ev) => {
      if (!ev) return 0;
      if (ev.eom      != null) return _parseTcSec(ev.eom);
      if (ev.duration != null) return _parseTcSec(ev.duration);
      return ev._clipDur ?? 0;
    };

    const estimateStartTime = (idx) => {
      // Start from the time remaining in the CURRENT clip, then add up durations
      // of all events between currentIndex+1 and idx-1.
      let msFromNow = _effectiveRemainingSec * 1000;

      for (let i = currentIndex + 1; i < idx && i < playlist.length; i++) {
        const ev = playlist[i];
        if (!ev) break;
        // fixtime: snap to wall-clock time if it's in the future
        if (ev.startType === 'fixtime' && ev.startTime) {
          const p  = ev.startTime.split(':').map(Number);
          const ft = new Date();
          ft.setHours(p[0]||0, p[1]||0, p[2]||0, Math.round((p[3]||0) / (cfps||25) * 1000));
          if (ft.getTime() > Date.now()) {
            // This fixtime is in the future — use it as anchor for all subsequent events
            let postFixMs = 0;
            for (let j = i + 1; j < idx && j < playlist.length; j++) {
              postFixMs += _evDurSec(playlist[j]) * 1000;
            }
            return new Date(ft.getTime() + postFixMs);
          }
        }
        msFromNow += _evDurSec(ev) * 1000;
      }
      return new Date(Date.now() + msFromNow);
    };

    const resolveStartTime = (ev, idx, fmt) => {
      let d;
      if (ev.startType === 'fixtime' && ev.startTime) {
        const p = ev.startTime.split(':').map(Number);
        d = new Date();
        d.setHours(p[0]||0, p[1]||0, p[2]||0, Math.round((p[3]||0) / (cfps||25) * 1000));
        if (d.getTime() < Date.now() - 1000) d.setDate(d.getDate() + 1);
      } else {
        d = idx > currentIndex ? estimateStartTime(idx) : new Date();
      }
      const f = (fmt || '').toLowerCase();
      if (f === 'unix')    return String(Math.round(d.getTime() / 1000));
      if (f === 'unixms')  return String(d.getTime());
      // Countdown: Sekunden/ms/formatiert bis zum Event-Start
      if (f.startsWith('countdown')) {
        const remMs  = Math.max(0, d.getTime() - Date.now());
        const remSec = Math.round(remMs / 1000);
        if (f === 'countdownms')      return String(remMs);
        if (f === 'countdown')        return String(remSec);
        const cdH = Math.floor(remSec / 3600);
        const cdM = Math.floor((remSec % 3600) / 60);
        const cdS = remSec % 60;
        const p2  = n => String(n).padStart(2,'0');
        if (f === 'countdown:hh:mm')    return `${p2(cdH)}:${p2(cdM)}`;
        if (f === 'countdown:hh:mm:ss') return `${p2(cdH)}:${p2(cdM)}:${p2(cdS)}`;
        return String(remSec);  // Fallback: Sekunden
      }
      const hh = String(d.getHours()).padStart(2,'0');
      const mm = String(d.getMinutes()).padStart(2,'0');
      const ss = String(d.getSeconds()).padStart(2,'0');
      if (f === 'hh:mm')    return `${hh}:${mm}`;
      if (f === 'hh:mm:ss') return `${hh}:${mm}:${ss}`;
      return `${hh}:${mm}:${ss}:00`;   // default HH:MM:SS:FF
    };

    const resolveField = (ev, idx, field, fmt) => {
      if (!ev) return '';
      const lf = field.toLowerCase();
      if (lf === 'title')          return ev.title || ev.file?.split('/').pop()?.replace(/\.[^.]+$/, '') || '';
      if (lf === 'file')           return ev.file || '';
      if (lf === 'source')         return ev.source || '';
      if (lf === 'classification') return ev.classification || '';
      if (lf === 'classifcolor')   { const c = classifs.find(cl => cl.id === ev.classification); return c?.color || ''; }
      if (lf === 'classificon')    { const c = classifs.find(cl => cl.id === ev.classification); return c?.icon  || ''; }
      if (lf === 'duration')       return String(ev.eom ?? ev.duration ?? ev._clipDur ?? '');
      if (lf === 'starttime')      return resolveStartTime(ev, idx, fmt);
      return '';
    };

    const resolved = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v !== 'string' || !v.includes('{{')) { resolved[k] = v; continue; }
      const str = v.replace(VAR_RE, (_, scope, filter, field, fmt) => {
        const { ev, idx } = findEvent(scope.toLowerCase(), filter);
        return resolveField(ev, idx, field, fmt);
      });
      // Numeric coercion: if the whole value was one variable and resolved to a pure number,
      // return a JS number (e.g. for Unix-timestamp fields expecting number type).
      if (SINGLE_VAR_RE.test(v) && /^-?\d+(\.\d+)?$/.test(str)) {
        resolved[k] = parseFloat(str);
      } else {
        resolved[k] = str;
      }
    }
    return resolved;
  }

  /**
   * Plant Grafik-Child-Events für ein Primär-Event.
   *
   * TIMING-MODELL (frame-genau):
   *   g.delayFrames    — Start N Frames nach Clip-Beginn (0 = sofort)
   *   g.delay          — Start in Sekunden nach Clip-Beginn; negativ = vor Clip-Beginn
   *   g.durationFrames — Dauer in Frames
   *   g.duration       — Dauer in Sekunden
   *   g.endOffset      — Relativer End-Anker: negativ = N Sekunden VOR Clip-Ende
   *   g.endOffsetFrames — Wie endOffset aber in Frames
   *   g.persist        — true → Grafik überlebt Clip-Ende (kein Auto-Cleanup beim Event-Wechsel)
   *
   * @param {object}   event
   * @param {number}   [clipDurationSec]
   * @param {number}   [fps=25]
   * @param {Function} [onGrafik]
   * @param {object}   [playlistCtx]
   * @param {object}   [opts]
   *   opts.latencyMs     — Pipeline-Latenz in ms (wird von allen Delays subtrahiert; default 0)
   *   opts.preStartMs    — ms vor Clip-Beginn, zu dem diese Methode aufgerufen wird (default 0).
   *                        Erlaubt negative delays: effDelay = delay*1000 + preStartMs.
   *   opts.negativeOnly  — nur Kinder mit delay < 0 schedulen (für Pre-Cue-Phase)
   * @returns {Function}  cleanup()
   */
  scheduleChildEvents(event, clipDurationSec = null, fps = 25, onGrafik = null, playlistCtx = null, opts = {}) {
    if (!event.children || event.children.length === 0) return () => {};

    const timers    = [];
    const activeIds = [];
    const persistIds = new Set();
    const frameDur  = 1000 / fps;

    const latencyMs  = opts.latencyMs  || 0;
    const preStartMs = opts.preStartMs || 0;
    const negativeOnly = !!opts.negativeOnly;

    const grafixEvents = event.children.filter(c => c.source === 'grafik' && c.grafik);
    if (!grafixEvents.length) return () => {};

    this._log(`Schedule ${grafixEvents.length} Grafik-Child-Event(s) für "${event.file || event.source}" (clip=${clipDurationSec?.toFixed(2) ?? '?'}s, ${fps}fps, latency=${latencyMs}ms, preStart=${preStartMs}ms)`);

    for (const child of grafixEvents) {
      const g  = child.grafik;

      // ── Native delay (vor Latenz-Kompensation und preStart) ─────────────
      let nativeDelayMs;
      if (g.delayFrames != null) {
        nativeDelayMs = Math.round(g.delayFrames * frameDur);
      } else {
        nativeDelayMs = Math.round((g.delay ?? 0) * 1000);
      }

      // negativeOnly: nur negative-delay Kinder schedulen (Pre-Cue-Phase)
      if (negativeOnly && nativeDelayMs >= 0) continue;
      // Normalphase: keine negativen delays (die wurden bereits in der Pre-Cue-Phase geschedult)
      if (!negativeOnly && preStartMs === 0 && nativeDelayMs < 0) continue;

      // Effektiver Delay: nativeDelay + preStartMs (kann negativ sein) - latencyMs
      // preStartMs verschiebt den Nullpunkt zurück: bei preStartMs=5000 und nativeDelay=-2000
      // → effDelay = -2000 + 5000 - latency = 3000ms von jetzt = 2s vor Clip-Start.
      const effDelayMs = Math.max(0, nativeDelayMs + preStartMs - latencyMs);

      const id = `child-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      activeIds.push(id);
      if (g.persist) persistIds.add(id);

      // ── Dauer / End-Zeitpunkt ────────────────────────────────────────────
      let durMs = null;
      if (g.endOffsetFrames != null && clipDurationSec != null) {
        const clipMs = clipDurationSec * 1000;
        const endMs  = clipMs + (g.endOffsetFrames * frameDur);
        durMs = Math.max(0, endMs - (nativeDelayMs + preStartMs));
      } else if (g.endOffset != null && clipDurationSec != null) {
        const clipMs = clipDurationSec * 1000;
        const endMs  = clipMs + (g.endOffset * 1000);
        durMs = Math.max(0, endMs - (nativeDelayMs + preStartMs));
      } else if (g.durationFrames != null) {
        durMs = Math.round(g.durationFrames * frameDur);
      } else if (g.duration != null) {
        durMs = Math.round(g.duration * 1000);
      }
      // persist + no duration → kein Auto-Hide, läuft bis explizites hide() oder hideAll()
      // null = bis Event-Ende (kein Auto-Hide bei sequentiellem Ablauf)

      this._log(
        `  → ${g.template} nativeDelay=${(nativeDelayMs/1000).toFixed(3)}s effDelay=${(effDelayMs/1000).toFixed(3)}s` +
        (durMs != null ? ` dur=${(durMs/1000).toFixed(3)}s` : ' dur=∞') +
        (g.persist ? ' [persist]' : '') +
        (g.endOffset != null ? ` endOffset=${g.endOffset}s` : '') +
        (g.endOffsetFrames != null ? ` endOffsetFrames=${g.endOffsetFrames}` : ''),
        'debug'
      );

      // ── Pre-Cue: Template vorladen (hidden) ─────────────────────────────
      // Starte pre-cue GRAFIK_PRECUE_LEAD_MS vor dem effektiven Show-Zeitpunkt.
      // Der iframe wird geladen und spielt seinen ersten Frame, ohne sichtbar zu sein.
      const W = this.width, H = this.height;
      const params = new URLSearchParams({
        data: JSON.stringify(g.data || {}),
        layer: g.layer || 'overlay',
        w: W, h: H, fps: this.fps,
      });
      const templateUrl = `http://localhost:${this.port}/grafik/${encodeURIComponent(g.template)}?${params}`;

      let _precued = false;

      const precueLeadMs = GRAFIK_PRECUE_LEAD_MS;
      const precueFireMs = effDelayMs > precueLeadMs ? effDelayMs - precueLeadMs : 0;

      if (precueFireMs > 0) {
        const precueTimer = setTimeout(async () => {
          if (!this._running) return;
          _precued = await this._precueFrame(id, templateUrl, W, H);
        }, precueFireMs);
        timers.push(precueTimer);
      } else if (this._page && !this._pageRecreating) {
        // Sofort pre-cuen (zu wenig Vorlaufzeit → async, fire-and-forget)
        this._precueFrame(id, templateUrl, W, H).then(ok => { _precued = ok; });
      }

      // ── Show-Timer ──────────────────────────────────────────────────────
      const showTimer = setTimeout(async () => {
        if (!this._running) return;
        const rawData = g.data || {};
        const resolvedData = playlistCtx
          ? this._resolveVars(rawData, {
              ...playlistCtx,
              _scheduleElapsedSec: (nativeDelayMs + preStartMs) / 1000,
            })
          : rawData;
        const layer = g.layer || 'overlay';

        let shownId;
        if (_precued) {
          // iframe bereits geladen → nur sichtbar machen (frame-genau, ohne Load-Latenz)
          const ok = await this._showPrecued(id, g.template, resolvedData, layer);
          shownId = ok ? id : await this.show(g.template, resolvedData, layer, id);
        } else {
          shownId = await this.show(g.template, resolvedData, layer, id);
        }
        if (onGrafik) onGrafik({ action: 'show', id: shownId, template: g.template });

        if (durMs !== null && durMs > 0) {
          const hideTimer = setTimeout(async () => {
            await this.hide(id);
            if (onGrafik) onGrafik({ action: 'hide', id, template: g.template });
          }, durMs);
          timers.push(hideTimer);
          const entry = this._activeGrafiks.get(id);
          if (entry) entry._durationTimer = hideTimer;
        }
      }, effDelayMs);

      timers.push(showTimer);
    }

    // Cleanup: alle Timer canceln + aktive (nicht-persistente) Grafiken ausblenden
    return () => {
      for (const t of timers) clearTimeout(t);
      let hidAny = false;
      for (const id of activeIds) {
        if (persistIds.has(id)) continue;  // persist → überleben Event-Wechsel
        const entry = this._activeGrafiks.get(id);
        if (entry) {
          this._activeGrafiks.delete(id);
          hidAny = true;
          if (onGrafik) onGrafik({ action: 'hide', id, template: entry.template });
        }
        // Auch pre-gecuete (noch nicht angezeigte) iframes entfernen
        if (this._page && !this._pageRecreating) {
          this._page.evaluate(iframeId => {
            const el = document.getElementById(iframeId);
            if (el) el.remove();
          }, id).catch(() => {});
        }
      }
      if (hidAny && this._activeGrafiks.size === 0) this._showBlank().catch(() => {});
    };
  }

  // ── HTTP Template-Server ──────────────────────────────────────────────────

  _startHttpServer() {
    this._server = http.createServer((req, res) => {
      const url  = new URL(req.url, `http://localhost`);
      const pth  = url.pathname;

      // MJPEG-Preview-Stream
      if (pth === '/grafik/stream') {
        res.writeHead(200, {
          'Content-Type':  'multipart/x-mixed-replace; boundary=frame',
          'Cache-Control': 'no-cache',
          'Connection':    'keep-alive',
        });
        this._clients.add(res);
        if (this._frame) {
          res.write(`--frame\r\nContent-Type: image/png\r\nContent-Length: ${this._frame.length}\r\n\r\n`);
          res.write(this._frame);
          res.write('\r\n');
        }
        req.on('close', () => this._clients.delete(res));
        return;
      }

      // Blank-Template
      // Compositor-Live-Page — bleibt dauerhaft geladen in Puppeteer.
      // Layers werden per page.evaluate() als iframes dynamisch hinzugefügt/entfernt.
      if (pth === '/grafik/__compositor_live') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><style>
          *{margin:0;padding:0;box-sizing:border-box}
          html,body{width:${this.width}px;height:${this.height}px;overflow:hidden;
            background:transparent;position:relative}
        </style></head><body></body></html>`);
        return;
      }

      if (pth === '/grafik/__blank') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><style>
          *{margin:0;padding:0;box-sizing:border-box}
          html,body{width:${this.width}px;height:${this.height}px;overflow:hidden;
            background:rgba(0,0,0,0);display:block}
        </style></head><body></body></html>`);
        return;
      }

      // Compositor — stapelt mehrere Grafik-Layer als iframes übereinander
      if (pth === '/grafik/__compositor') {
        let layers = [];
        try { layers = JSON.parse(decodeURIComponent(url.searchParams.get('layers') || '[]')); } catch {}
        const iframes = layers.map(l =>
          `<iframe src="${l.url}" style="position:absolute;top:0;left:0;width:100%;height:100%;border:none;background:transparent;" allowtransparency="true"></iframe>`
        ).join('\n');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><style>
          *{margin:0;padding:0;box-sizing:border-box}
          html,body{width:${this.width}px;height:${this.height}px;overflow:hidden;
            background:transparent;position:relative}
        </style></head><body>${iframes}</body></html>`);
        return;
      }

      // Index / Liste aller Templates — auch / und /grafik ohne Slash
      if (pth === '/' || pth === '/grafik/' || pth === '/grafik' || pth === '') {
        const allTemplates = this._listTemplates();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>GrafixEngine</title>
          <style>body{font-family:monospace;background:#111;color:#ccc;padding:20px}
          a{color:#f0a830;display:block;margin:4px 0}h2{color:#5aabff}
          .type{color:#888;font-size:0.85em;margin-left:6px}</style></head><body>
          <h2>GrafixEngine ${this.width}\u00d7${this.height} @ ${this.fps}fps</h2>
          <p>Templates (${allTemplates.length}):</p>
          ${allTemplates.map(t=>`<a href="/grafik/${t.name}?data={}">${t.name}<span class="type">[${t.type}]</span></a>`).join('')}
          <p style="margin-top:12px"><a href="/grafik/stream">MJPEG Stream (live preview)</a></p>
          </body></html>`);
        return;
      }

      // Template-Dateien und Unterordner-Assets
      if (pth.startsWith('/grafik/')) {
        const subPath = decodeURIComponent(pth.slice('/grafik/'.length));
        // Sicherheits-Check: kein path traversal
        const safeSub = subPath.replace(/\.\./g, '').replace(/^[\/]+/, '');
        const parts   = safeSub.split('/');
        const tName   = parts[0];  // Template-Name (erstes Segment)

        // Asset-Request: /grafik/myTemplate/style.css etc.
        if (parts.length >= 2) {
          const assetRel  = parts.slice(1).join('/');
          const assetPath = path.join(this.templatesDir, tName, assetRel);
          if (fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
            const ext = path.extname(assetPath).toLowerCase();
            const mime = { '.css':'text/css', '.js':'application/javascript',
                           '.json':'application/json', '.png':'image/png',
                           '.jpg':'image/jpeg', '.svg':'image/svg+xml',
                           '.woff2':'font/woff2', '.woff':'font/woff' }[ext] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': mime });
            res.end(fs.readFileSync(assetPath));
          } else {
            res.writeHead(404); res.end();
          }
          return;
        }

        // Template-Request: /grafik/myTemplate
        const dataParam = url.searchParams.get('data') || '{}';
        let   data      = {};
        try { data = JSON.parse(dataParam); } catch {}

        const resolved = this._resolveTemplate(tName);
        if (!resolved) {
          res.writeHead(404);
          res.end(`Template nicht gefunden: ${tName}`);
          return;
        }

        if (resolved.type === 'ograf') {
          // oGraf: Host-Seite mit eingebettetem Custom-Element.
          // w/h/fps aus URL-Parametern übernehmen (gesetzt von show()), damit die
          // Host-Seite immer mit dem aktuellen Pipeline-Format gerendert wird.
          const pW   = parseInt(url.searchParams.get('w'))   || this.width;
          const pH   = parseInt(url.searchParams.get('h'))   || this.height;
          const pFps = parseInt(url.searchParams.get('fps')) || this.fps;
          const inject = `<script>window.__GRAFIX_DATA__ = ${JSON.stringify(data)};</script>`;
          let html = this._buildOgrafHostPage(resolved.manifest, tName, data, pW, pH, pFps);
          html = html.replace('</head>', `${inject}</head>`);
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
        } else {
          // Klassisches HTML-Template
          const pW = parseInt(url.searchParams.get('w')) || this.width;
          const pH = parseInt(url.searchParams.get('h')) || this.height;
          let html = fs.readFileSync(resolved.path, 'utf8');
          const inject = `<script>window.__GRAFIX_DATA__ = ${JSON.stringify(data)};</script>`;
          html = html.replace('</head>', `${inject}</head>`);
          // Bei Unterordner-Template: Basis-URL setzen
          const isFolder = path.dirname(resolved.path) !== this.templatesDir;
          if (isFolder) {
            const base = `<base href="/grafik/${encodeURIComponent(tName)}/">`;
            html = html.replace('<head>', `<head>${base}`);
          }
          // Scale template body to pipeline dimensions if it has hardcoded px body size.
          // Extract body { width:Xpx; height:Ypx } from the first body CSS rule found.
          const bodyBlock = html.match(/body\s*\{([^}]+)\}/s)?.[1] ?? '';
          const tW = parseInt(bodyBlock.match(/\bwidth\s*:\s*(\d+)px/)?.[1] ?? '0');
          const tH = parseInt(bodyBlock.match(/\bheight\s*:\s*(\d+)px/)?.[1] ?? '0');
          if (tW > 0 && tH > 0 && (tW !== pW || tH !== pH)) {
            const sx = (pW / tW).toFixed(6);
            const sy = (pH / tH).toFixed(6);
            // Transform the body content to fill the pipeline viewport.
            // html clips the overflow so Puppeteer captures exactly pW×pH.
            const scaleStyle = `<style id="_gfx_scale">` +
              `html{overflow:hidden;width:${pW}px;height:${pH}px;}` +
              `body{transform:scale(${sx},${sy});transform-origin:top left;}</style>`;
            html = html.replace('</head>', `${scaleStyle}</head>`);
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
        }
        return;
      }

      // Assets (CSS, Fonts, etc.) aus templatesDir
      if (pth.startsWith('/assets/')) {
        const assetPath = path.join(this.templatesDir, '..', pth);
        if (fs.existsSync(assetPath)) {
          res.writeHead(200);
          res.end(fs.readFileSync(assetPath));
        } else {
          res.writeHead(404); res.end();
        }
        return;
      }

      res.writeHead(404); res.end();
    });

    this._server.listen(this.port, '127.0.0.1', () => {
      this._log(`Template-Server: http://localhost:${this.port}/grafik/`);
    });

    this._server.on('error', e => this._log(`Server-Fehler: ${e.message}`, 'error'));
  }

  _pushToClients(jpegBuf) {
    const header = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpegBuf.length}\r\n\r\n`;
    for (const res of this._clients) {
      try { res.write(header); res.write(jpegBuf); res.write('\r\n'); }
      catch { this._clients.delete(res); }
    }
  }

  // ── Default-Templates ─────────────────────────────────────────────────────

  _ensureDefaultTemplates() {
    const templates = {
      'lowerThird': this._tmplLowerThird(),
      'clock':      this._tmplClock(),
      'fullscreen': this._tmplFullscreen(),
      'ticker':     this._tmplTicker(),
    };
    for (const [name, html] of Object.entries(templates)) {
      const p = path.join(this.templatesDir, `${name}.html`);
      try {
        fs.writeFileSync(p, html, 'utf8');
      } catch (e) {
        if (e.code === 'EROFS' || e.code === 'EACCES') {
          // Read-only filesystem (z.B. AppImage squashfs) — Fallback auf WORK_DIR
          const workDir = process.env.APPDIR
            ? path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME || '~', '.local', 'share'), 'pipeline-controller', 'templates', 'grafik')
            : null;
          if (workDir && workDir !== this.templatesDir) {
            this._log(`templatesDir read-only — weiche aus auf ${workDir}`, 'warn');
            this.templatesDir = workDir;
            try {
              fs.mkdirSync(workDir, { recursive: true });
              fs.writeFileSync(path.join(workDir, `${name}.html`), html, 'utf8');
            } catch (e2) {
              this._log(`Fallback-Write fehlgeschlagen: ${e2.message}`, 'warn');
            }
          } else {
            this._log(`Template-Write ${name} übersprungen (${e.code}): ${e.message}`, 'warn');
          }
        } else {
          throw e;
        }
      }
    }
  }

  _tmplLowerThird() {
    const W = this.width, H = this.height;
    const s = W / 1920;
    return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html { background: transparent !important; }
  body {
    width:${W}px; height:${H}px; overflow:hidden;
    background: transparent;
    font-family: 'Arial', sans-serif;
  }
  .lower-third {
    position: absolute;
    bottom: ${Math.round(120*s)}px; left: ${Math.round(80*s)}px;
    /* animation: slideIn 0.4s cubic-bezier(0.25,0.46,0.45,0.94) both; */
  }
  /* slideIn disabled for screenshot stability */
  @keyframes slideIn {
    from { transform: translateX(${Math.round(-60*s)}px); opacity: 0; }
    to   { transform: translateX(0);     opacity: 1; }
  }
  .bar {
    background: linear-gradient(135deg, #c00 0%, #800 100%);
    padding: 0 0 0 ${Math.round(8*s)}px;
    display: inline-flex;
    flex-direction: column;
    min-width: ${Math.round(480*s)}px;
  }
  .name  { color: #fff; font-size: ${Math.round(36*s)}px; font-weight: 700; padding: ${Math.round(14*s)}px ${Math.round(24*s)}px ${Math.round(4*s)}px; letter-spacing:0.04em; }
  .title { color: #ffd; font-size: ${Math.round(22*s)}px; font-weight: 400; padding: ${Math.round(4*s)}px ${Math.round(24*s)}px ${Math.round(14*s)}px; letter-spacing:0.02em; }
  .accent { width: 100%; height: ${Math.round(4*s)}px; background: #ff0; }
</style>
</head>
<body>
<script>
  const d = window.__GRAFIX_DATA__ || {};
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('.name').textContent  = d.name  || '';
    document.querySelector('.title').textContent = d.title || '';
    if (!d.title) document.querySelector('.title').style.display='none';
  });
</script>
<div class="lower-third">
  <div class="accent"></div>
  <div class="bar">
    <div class="name">Name</div>
    <div class="title">Titel</div>
  </div>
</div>
</body></html>`;
  }

  _tmplClock() {
    const W = this.width, H = this.height;
    const s = W / 1920;
    return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<style>
  * { margin:0; padding:0; }
  html { background: transparent !important; }
  body { width:${W}px; height:${H}px; overflow:hidden; background:transparent; font-family:monospace; }
  .clock {
    position:absolute;
    top:${Math.round(40*s)}px; right:${Math.round(60*s)}px;
    background: rgba(0,0,0,0.65);
    color:#fff; font-size:${Math.round(38*s)}px; font-weight:700;
    padding: ${Math.round(8*s)}px ${Math.round(20*s)}px; border-radius:${Math.round(6*s)}px;
    letter-spacing:0.08em;
  }
</style>
</head><body>
<div class="clock" id="c">00:00:00</div>
<script>
  function tick() {
    const n = new Date();
    document.getElementById('c').textContent =
      String(n.getHours()).padStart(2,'0') + ':' +
      String(n.getMinutes()).padStart(2,'0') + ':' +
      String(n.getSeconds()).padStart(2,'0');
  }
  tick();
  setInterval(tick, 1000);
</script>
</body></html>`;
  }

  _tmplFullscreen() {
    const W = this.width, H = this.height;
    const s = W / 1920;
    return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<style>
  * { margin:0; padding:0; }
  html { background: transparent !important; }
  body { width:${W}px; height:${H}px; overflow:hidden; background:#000; }
  .fs { width:100%; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; }
  .title { color:#fff; font-size:${Math.round(72*s)}px; font-weight:700; font-family:Arial; text-align:center; }
  .sub   { color:#ccc; font-size:${Math.round(36*s)}px; font-weight:300; font-family:Arial; text-align:center; margin-top:${Math.round(20*s)}px; }
</style>
</head><body>
<div class="fs">
  <div class="title" id="t"></div>
  <div class="sub"   id="s"></div>
</div>
<script>
  const d = window.__GRAFIX_DATA__ || {};
  document.getElementById('t').textContent = d.title || '';
  document.getElementById('s').textContent = d.subtitle || '';
</script>
</body></html>`;
  }

  _tmplTicker() {
    const W = this.width, H = this.height;
    const s = W / 1920;
    return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<style>
  * { margin:0; padding:0; }
  html { background: transparent !important; }
  body { width:${W}px; height:${H}px; overflow:hidden; background:transparent; }
  .ticker-bar {
    position:absolute; bottom:0; left:0; right:0;
    height:${Math.round(60*s)}px; background:#c00;
    display:flex; align-items:center; overflow:hidden;
  }
  .ticker-label {
    background:#fff; color:#c00; font-weight:700; font-size:${Math.round(26*s)}px;
    padding:0 ${Math.round(18*s)}px; height:100%; display:flex; align-items:center;
    font-family:Arial; white-space:nowrap; min-width:${Math.round(160*s)}px;
  }
  .ticker-text {
    color:#fff; font-size:${Math.round(26*s)}px; font-family:Arial;
    white-space:nowrap;
    animation: ticker 20s linear infinite;
    padding-left:${Math.round(40*s)}px;
  }
  @keyframes ticker {
    0%   { transform: translateX(${W}px); }
    100% { transform: translateX(-100%); }
  }
</style>
</head><body>
<div class="ticker-bar">
  <div class="ticker-label" id="lb">NEWS</div>
  <div style="overflow:hidden;flex:1">
    <div class="ticker-text" id="tx"></div>
  </div>
</div>
<script>
  const d = window.__GRAFIX_DATA__ || {};
  document.getElementById('lb').textContent = d.label || 'NEWS';
  document.getElementById('tx').textContent = d.text  || '';
  const dur = d.speed || 20;
  document.querySelector('.ticker-text').style.animationDuration = dur + 's';
</script>
</body></html>`;
  }

  // ── Öffentliche Getter ────────────────────────────────────────────────────

  get running()          { return this._running; }
  get frame()            { return this._frame; }
  get activeGrafiks()    { return [...this._activeGrafiks.entries()].map(([id,g]) => ({ id, ...g })); }
  get templateServerUrl(){ return `http://localhost:${this.port}`; }
  get hasPuppeteer()     { return !!this._browser; }

  // ── Template-Discovery ───────────────────────────────────────────────────

  /**
   * Listet alle Templates: HTML-Dateien UND oGraf-Unterordner.
   * Gibt Array von { name, type: 'html'|'ograf' } zurück.
   */
  _listTemplates() {
    if (!fs.existsSync(this.templatesDir)) {
      this._log(`_listTemplates: templatesDir existiert nicht: ${this.templatesDir}`, 'warn');
      return [];
    }
    const entries = fs.readdirSync(this.templatesDir);
    this._log(`_listTemplates: ${entries.length} Einträge in ${this.templatesDir}: ${entries.join(', ')}`, 'debug');
    const result = [];
    for (const entry of entries) {
      try {
        const full = path.join(this.templatesDir, entry);
        const stat = fs.statSync(full);
        if (!stat.isDirectory() && entry.endsWith('.html')) {
          result.push({ name: entry.replace('.html', ''), type: 'html' });
          this._log(`_listTemplates: html → ${entry}`, 'debug');
        } else if (stat.isDirectory()) {
          const dirFiles = fs.readdirSync(full);
          this._log(`_listTemplates: Unterordner ${entry}: ${dirFiles.join(', ')}`, 'debug');
          const manifest = this._findManifest(full);
          if (manifest) {
            result.push({ name: entry, type: 'ograf' });
            this._log(`_listTemplates: ograf → ${entry} (main=${manifest.main})`, 'debug');
          } else if (fs.existsSync(path.join(full, 'index.html'))) {
            result.push({ name: entry, type: 'html' });
            this._log(`_listTemplates: html-folder → ${entry}`, 'debug');
          } else {
            this._log(`_listTemplates: Unterordner ${entry} übersprungen (kein Manifest, kein index.html)`, 'debug');
          }
        }
      } catch(e) {
        this._log(`_listTemplates: Fehler bei ${entry}: ${e.message}`, 'warn');
      }
    }
    this._log(`_listTemplates: Ergebnis: ${result.map(t=>t.name+'['+t.type+']').join(', ')}`, 'debug');
    return result;
  }

  /** Öffentlich: nur Namen, abwärtskompatibel */
  listTemplates() {
    return this._listTemplates().map(t => t.name);
  }

  /**
   * Listet Templates mit Metadaten: id, label, type ('html'|'ograf'), fields[]
   * fields[] = Array von {id, label, type} für den UI-Editor.
   */
  listTemplatesWithMeta() {
    return this._listTemplates().map(t => {
      const meta = { id: t.name, label: t.name, type: t.type, fields: [] };
      if (t.type === 'ograf') {
        const manifest = this._findManifest(path.join(this.templatesDir, t.name));
        if (manifest) {
          meta.label      = manifest.name || t.name;
          meta.stepCount  = manifest.stepCount ?? 1;  // 1 = single-step (no continue needed)
          const props = manifest.schema?.properties || {};
          meta.fields = Object.entries(props).map(([key, def]) => {
            const field = {
              id:      key,
              label:   def.title   || key,
              type:    def.type    || 'string',
              gddType: def.gddType || null,
              default: def.default !== undefined ? def.default : null,
            };
            if (def.enum)              field.enum    = def.enum;
            if (def.gddOptions?.labels) field.labels = def.gddOptions.labels;
            return field;
          });
        }
      }
      return meta;
    });
  }

  /**
   * Löst einen Template-Namen zu einem absoluten HTML-Pfad auf.
   * Reihenfolge: 1) Unterordner/index.html  2) name.html
   * Gibt null zurück wenn nichts gefunden.
   */
  _resolveTemplate(name) {
    // oGraf-Unterordner: suche index.html oder main aus Manifest
    const dirPath = path.join(this.templatesDir, name);
    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      const manifest = this._findManifest(dirPath);
      if (manifest) {
        // oGraf → kein statisches HTML, wird dynamisch per Host-Page gerendert
        return { type: 'ograf', dir: dirPath, manifest };
      }
      // Normaler Unterordner mit index.html
      const idx = path.join(dirPath, 'index.html');
      if (fs.existsSync(idx)) return { type: 'html', path: idx };
      const main = path.join(dirPath, 'main.html');
      if (fs.existsSync(main)) return { type: 'html', path: main };
    }
    // Klassische .html-Datei
    const htmlPath = path.join(this.templatesDir, `${name}.html`);
    if (fs.existsSync(htmlPath)) return { type: 'html', path: htmlPath };
    return null;
  }

  /** Sucht *.ograf.json oder *_ograf.json in einem Verzeichnis, gibt geparsten Inhalt oder null zurück */
  _findManifest(dirPath) {
    if (!fs.existsSync(dirPath)) return null;
    const files = fs.readdirSync(dirPath);
    // Akzeptiert beide Schreibweisen: name.ograf.json UND name_ograf.json
    const mf = files.find(f => f.endsWith('.ograf.json') || f.endsWith('_ograf.json'));
    if (!mf) {
      this._log(`_findManifest: kein Manifest in ${dirPath}, Dateien: [${files.join(', ')}]`, 'debug');
      return null;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dirPath, mf), 'utf8'));
      this._log(`_findManifest: gefunden ${mf}, main=${parsed.main}`, 'debug');
      return { file: mf, ...parsed };
    } catch(e) {
      this._log(`_findManifest: Parse-Fehler ${mf}: ${e.message}`, 'warn');
      return null;
    }
  }

  /**
   * Baut die oGraf-Host-HTML-Seite.
   * Diese Seite:
   *   - importiert das JS-Modul (ES Module, default-export = Custom Element Klasse)
   *   - registriert das Custom Element
   *   - ruft load() → playAction() auf
   *   - leitet updateAction() / stopAction() via window.__OGRAF_HOST__ weiter
   */
  _buildOgrafHostPage(manifest, templateName, data, W, H, fps) {
    // Explizite Dimensionen verwenden — Fallback auf this.width/height falls nicht übergeben.
    W   = W   || this.width;
    H   = H   || this.height;
    fps = fps || this.fps;
    const mainJs  = manifest.main || 'index.js';
    const tagName = 'ograf-' + templateName.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const baseHref = `/grafik/${encodeURIComponent(templateName)}/`;

    // Design resolution: from manifest or broadcast standard 1920×1080.
    // The web component's shadow DOM CSS uses px values for this design size.
    // CSS zoom scales the element and its shadow DOM so it fills the pipeline viewport.
    const dW   = manifest.designWidth  || 1920;
    const dH   = manifest.designHeight || 1080;
    const zoom = (W / dW).toFixed(6);   // e.g. 640/1920 = 0.333333

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=${W}, height=${H}, initial-scale=1.0">
<base href="${baseHref}">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html {
    width:${W}px; height:${H}px; overflow:hidden;
    background: transparent !important;
  }
  body {
    width:${W}px; height:${H}px; overflow:hidden;
    position:relative;
    background: transparent !important;
  }
  ${tagName} {
    display:block; position:absolute; top:0; left:0;
    width:${dW}px; height:${dH}px;
    zoom:${zoom};
  }
</style>
</head>
<body>
<${tagName}></${tagName}>
<script type="module">
import ComponentClass from '${baseHref}${mainJs}';

const TAG = '${tagName}';
if (!customElements.get(TAG)) customElements.define(TAG, ComponentClass);

const el = document.querySelector(TAG);

window.__OGRAF_HOST__ = {
  _step: -1,  // interner Schritt-Zähler: -1 = vor erstem play()

  async load(d) {
    this._step = -1;
    return el.load
      ? el.load({ renderType:'realtime', data: d, renderEnvironment: { width: ${W}, height: ${H}, frameRate: ${fps} } })
      : {statusCode:200};
  },

  async play(params) {
    const r = el.playAction ? await el.playAction(params||{}) : {statusCode:200};
    // Schritt-Zähler aus Rückgabewert oder params.goto aktualisieren
    if (typeof r?.currentStep === 'number') this._step = r.currentStep;
    else if (typeof params?.goto === 'number')  this._step = params.goto;
    return r;
  },

  async stop(params) {
    this._step = -1;
    return el.stopAction ? el.stopAction(params||{}) : {statusCode:200};
  },

  async update(d) {
    return el.updateAction ? el.updateAction({ data: d }) : {statusCode:200};
  },

  // "Continue" = nächsten Schritt abspielen.
  // Vorrang: continueAction() des Custom Elements (falls implementiert).
  // Fallback: playAction({ goto: currentStep + 1 }) — Standard für multi-step-Templates.
  async continue() {
    if (el.continueAction) return el.continueAction();
    return this.play({ goto: this._step + 1 });
  },
};

(async () => {
  const initData = window.__GRAFIX_DATA__ || {};
  await window.__OGRAF_HOST__.load(initData);
  await window.__OGRAF_HOST__.play({ goto: 0 });
})().catch(err => console.error('[ograf] init fehler:', err));
</script>
</body>
</html>`;
  }
}

module.exports = GrafixEngine;
