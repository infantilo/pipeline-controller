'use strict';
/**
 * GreenZoneDetect.js
 *
 * Editor-Hilfsfunktion: sucht in einem Referenzbild (PNG/JPG/...) nach einer
 * zusammenhängenden grünen Fläche (Chroma-Key-Grün) und liefert deren Bounding-Box
 * normalisiert (0..1) zurück — zur automatischen Positionierung einer DVE-Box,
 * ohne dass der Operator x/y/w/h manuell ausmessen muss.
 *
 * Läuft NUR im Editor (einmaliger Aufruf bei "Erkennen"-Klick, Ergebnis wird als
 * statische Box im Event gespeichert) — kein Laufzeit-/Performance-Einfluss auf
 * den Sendepfad.
 *
 * Dekodierung über eine kurzlebige gst-kit-Pipeline (kein zusätzliches npm-Image-
 * Paket nötig — GStreamer kann ohnehin jedes unterstützte Bildformat decodebin'en).
 */

const { Pipeline } = require('gst-kit');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.join(os.tmpdir(), 'pc_chromakey');

// Chroma-Key-Heuristik: G dominiert klar über R und B (typisches Studio-Grün).
function _isGreen(r, g, b) {
  return g > 100 && g > r * 1.4 && g > b * 1.4;
}

async function _decode(absPath, format, timeoutMs = 5000) {
  const quoted = absPath.replace(/"/g, '\\"');
  const pipeStr = `filesrc location="${quoted}" ! decodebin ! videoconvert ! video/x-raw,format=${format} ! appsink name=sink max-buffers=1 sync=false`;
  const p = new Pipeline(pipeStr);
  try {
    const r = await p.play(timeoutMs);
    if (!['success', 'async', 'no-preroll'].includes(r?.result)) {
      throw new Error(`Pipeline-Status: ${r?.result || 'unbekannt'}`);
    }
    const sink = p.getElementByName('sink');
    if (!sink) throw new Error('appsink nicht gefunden');
    const sample = await sink.getSample(timeoutMs);
    if (!sample?.buffer) throw new Error('Bild konnte nicht dekodiert werden');
    const width  = sample.caps?.width;
    const height = sample.caps?.height;
    if (!width || !height) throw new Error('Bildmaße nicht ermittelbar');
    return { buffer: Buffer.from(sample.buffer), width, height };
  } finally {
    try { await p.stop(2000); } catch {}
  }
}

// Encodiert einen RGBA-Buffer als PNG und liefert die fertigen Bytes zurück
// (appsrc → pngenc → appsink — bewusst KEIN filesink: dessen EOS-Bus-Event kommt
// nicht zuverlässig erst NACH dem tatsächlichen fsync/close der Datei, was unter
// Last im Hauptprozess zu ENOENT beim anschließenden renameSync führte. Mit
// appsink+fs.writeFileSync ist der Bytetransfer durch Node selbst garantiert
// abgeschlossen, sobald die Funktion zurückkehrt.)
async function _encodePngBuffer(buffer, width, height, timeoutMs = 5000) {
  const pipeStr = `appsrc name=src is-live=false format=time ` +
    `caps="video/x-raw,format=RGBA,width=${width},height=${height},framerate=1/1" ` +
    `! pngenc ! appsink name=sink max-buffers=1 sync=false`;
  const p = new Pipeline(pipeStr);
  try {
    const r = await p.play(timeoutMs);
    if (!['success', 'async', 'no-preroll'].includes(r?.result)) {
      throw new Error(`PNG-Encode-Pipeline: play()-Status "${r?.result || 'unbekannt'}"`);
    }
    const src  = p.getElementByName('src');
    const sink = p.getElementByName('sink');
    if (!src)  throw new Error('appsrc nicht gefunden');
    if (!sink) throw new Error('appsink nicht gefunden');
    src.push(buffer, 0);
    src.endOfStream();
    const sample = await sink.getSample(timeoutMs);
    if (!sample?.buffer) throw new Error('PNG-Encode: kein Sample vom appsink erhalten');
    return Buffer.from(sample.buffer);
  } finally {
    try { await p.stop(2000); } catch {}
  }
}

/**
 * Macht grüne Pixel in einem Bild transparent (Chroma-Key) und liefert den Pfad
 * zu einer gecachten PNG-Variante mit Alphakanal zurück.
 * Für den "Bild als Vollbild-Rahmen, Video gesqueezt im grünen Loch"-Anwendungsfall
 * (DVE target='video') — das Original bleibt unverändert, das Ergebnis wird per
 * Hash(Pfad+mtime+size) gecacht, damit wiederholtes Abspielen nicht jedes Mal neu
 * dekodiert/encodiert werden muss.
 * @param {string} absPath — absoluter Pfad zum Quellbild
 * @returns {Promise<string>} absoluter Pfad zur gecachten transparenten PNG
 */
async function chromaKeyToTransparentPng(absPath) {
  const stat = fs.statSync(absPath);
  const key  = crypto.createHash('md5').update(`${absPath}:${stat.mtimeMs}:${stat.size}`).digest('hex');
  const outPath = path.join(CACHE_DIR, `${key}.png`);
  if (fs.existsSync(outPath)) return outPath;

  const { buffer, width, height } = await _decode(absPath, 'RGBA');
  for (let p = 0, n = width * height; p < n; p++) {
    const i = p * 4;
    if (_isGreen(buffer[i], buffer[i+1], buffer[i+2])) buffer[i+3] = 0;
  }
  const pngBytes = await _encodePngBuffer(buffer, width, height);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  // writeFileSync auf denselben Pfad + atomare rename — verhindert, dass ein
  // paralleler Aufruf für dasselbe Bild eine halbgeschriebene Datei liest.
  const tmpOut = `${outPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpOut, pngBytes);
  fs.renameSync(tmpOut, outPath);
  return outPath;
}

// Connected-Components (4-Nachbarschaft, iterativer Flood-Fill — keine Rekursion
// nötig, vermeidet Stack-Overflow bei großen zusammenhängenden Flächen).
function _findRegions(mask, width, height) {
  const labels = new Int32Array(width * height).fill(-1);
  const regions = [];
  const stack = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!mask[idx] || labels[idx] !== -1) continue;
      let minX = x, maxX = x, minY = y, maxY = y, area = 0;
      stack.length = 0;
      stack.push(idx);
      labels[idx] = regions.length;
      while (stack.length) {
        const cur = stack.pop();
        const cy = Math.floor(cur / width), cx = cur % width;
        area++;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        if (cx > 0)        { const n = cur - 1;     if (mask[n] && labels[n] === -1) { labels[n] = regions.length; stack.push(n); } }
        if (cx < width-1)  { const n = cur + 1;     if (mask[n] && labels[n] === -1) { labels[n] = regions.length; stack.push(n); } }
        if (cy > 0)        { const n = cur - width; if (mask[n] && labels[n] === -1) { labels[n] = regions.length; stack.push(n); } }
        if (cy < height-1) { const n = cur + width; if (mask[n] && labels[n] === -1) { labels[n] = regions.length; stack.push(n); } }
      }
      regions.push({ minX, minY, maxX, maxY, area });
    }
  }
  return regions;
}

/**
 * @param {string} absPath — absoluter Pfad zum Referenzbild
 * @returns {Promise<{ok:boolean, box?:{x,y,w,h}, regionsFound:number, warning:string|null, error?:string}>}
 *   box ist normalisiert (0..1, relativ zur Bildauflösung).
 */
async function detectGreenZone(absPath) {
  let width, height, buffer;
  try {
    ({ buffer, width, height } = await _decode(absPath, 'RGB'));
  } catch(e) {
    return { ok: false, regionsFound: 0, warning: null, error: e.message };
  }

  const mask = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < mask.length; i++, p += 3) {
    if (_isGreen(buffer[p], buffer[p+1], buffer[p+2])) mask[i] = 1;
  }

  const minArea = Math.max(16, Math.round(0.0008 * width * height));
  const regions = _findRegions(mask, width, height).filter(r => r.area >= minArea);

  if (!regions.length) {
    return { ok: false, regionsFound: 0, warning: null, error: 'Keine grüne Fläche im Bild gefunden' };
  }

  regions.sort((a, b) => b.area - a.area);
  const best = regions[0];
  const box = {
    x: best.minX / width,
    y: best.minY / height,
    w: (best.maxX - best.minX + 1) / width,
    h: (best.maxY - best.minY + 1) / height,
  };

  const warning = regions.length > 1
    ? `${regions.length} grüne Flächen gefunden — größte (${Math.round(box.w*width)}×${Math.round(box.h*height)}px) verwendet`
    : null;

  return { ok: true, box, regionsFound: regions.length, warning: warning || null };
}

module.exports = { detectGreenZone, chromaKeyToTransparentPng };
