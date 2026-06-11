'use strict';
const { EventEmitter } = require('events');
const { Pipeline }     = require('gst-kit');
const { execFile }     = require('child_process');
const path             = require('path');
const fs               = require('fs');

function _resolveBin(name) {
  if (process.env.APPDIR) {
    const p = path.join(process.env.APPDIR, 'usr', 'bin', name);
    if (fs.existsSync(p)) return p;
  }
  for (const dir of (process.env.PATH || '').split(':')) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return name;
}
const FFMPEG_BIN = _resolveBin('ffmpeg');

// Post-process: remux via ffmpeg to write proper duration header.
// Fires callback(ok) when done; never throws.
function _remuxForDuration(filePath, log, cb) {
  const ext = path.extname(filePath);
  const tmp = (ext ? filePath.slice(0, -ext.length) : filePath) + '.__r' + (ext || '.mkv');
  execFile(FFMPEG_BIN, ['-i', filePath, '-c', 'copy', '-y', tmp],
    { timeout: 300000 },
    (err, _stdout, stderr) => {
      if (err) {
        const tail = (stderr || '').trim().split('\n').slice(-6).join(' | ');
        log(`remux failed (${path.basename(filePath)}): ${tail || err.message}`, 'warn');
        try { fs.unlinkSync(tmp); } catch {}
        return cb(false);
      }
      try { fs.renameSync(tmp, filePath); cb(true); }
      catch(e) { log(`remux rename: ${e.message}`, 'warn'); try { fs.unlinkSync(tmp); } catch {} cb(false); }
    });
}

function _resolveFilename(template, ctx) {
  const d  = new Date();
  const p2 = n => String(n).padStart(2, '0');
  return template
    .replace(/\{date\}/g,   `${d.getFullYear()}${p2(d.getMonth()+1)}${p2(d.getDate())}`)
    .replace(/\{time\}/g,   `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`)
    .replace(/\{slot\}/g,   ctx.slot  || 'rec1')
    .replace(/\{title\}/g,  (ctx.title || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40))
    .replace(/\{source\}/g, ctx.videoSource || 'pgm');
}

function _buildPipelineStr(videoChannel, audioChannels, outputPath, opts = {}) {
  const bitrate  = opts.videoBitrate || 8000;
  const preset   = opts.speedPreset  || 'ultrafast';
  const format   = opts.format       || 'mkv';

  // Quote path to handle embedded spaces in gst_parse_launch
  const quotedPath = `"${outputPath.replace(/"/g, '\\"')}"`;

  const videoSrc = (
    `intervideosrc channel=${videoChannel}` +
    ` ! queue max-size-buffers=10 max-size-time=200000000 max-size-bytes=0 leaky=downstream` +
    ` ! videoconvert` +
    ` ! x264enc tune=zerolatency speed-preset=${preset} bitrate=${bitrate} key-int-max=50` +
    ` ! h264parse` +
    ` ! queue max-size-buffers=10` +
    ` ! mux.`
  );

  // One AAC branch per audio group — matroskamux/qtmux accept multiple audio pads
  const audioSrcs = audioChannels.map(ch => (
    `interaudiosrc channel=${ch} do-timestamp=true` +
    ` ! queue max-size-buffers=20 max-size-time=200000000 max-size-bytes=0 leaky=downstream` +
    ` ! audioconvert ! audioresample` +
    ` ! avenc_aac bitrate=320000` +
    ` ! aacparse` +
    ` ! queue max-size-buffers=20` +
    ` ! mux.`
  )).join(' ');

  let mux, sink;
  if (format === 'mp4') {
    mux  = `qtmux name=mux`;
    sink = `filesink location=${quotedPath} sync=false`;
  } else if (format === 'ts') {
    mux  = `mpegtsmux name=mux`;
    sink = `filesink location=${quotedPath} sync=false`;
  } else {
    // streamable=true: clusters valid even on hard stop; ffmpeg remux fixes duration post-stop
    mux  = `matroskamux name=mux streamable=true`;
    sink = `filesink location=${quotedPath} sync=false`;
  }

  return `${videoSrc} ${audioSrcs} ${mux} ! ${sink}`;
}

class RecordEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._recordDir   = opts.recordDir  || '/tmp';
    this._audioGroups = opts.audioGroups || (opts.audioGroup ? [opts.audioGroup] : ['pgm-stereo']);
    this._log         = opts.log || ((msg, lvl) => console.log(`[record/${lvl||'info'}] ${msg}`));
    this._slots       = new Map();  // slotId → { pipeline, outputPath, startMs, videoSource, audioGroups }
    this._slotPool    = opts.slots || ['rec1', 'rec2', 'rec3'];
  }

  // Returns first pool slot not currently active and not in the local exclude set.
  // Falls back to rec4, rec5... if all pool slots are busy.
  _pickFreeSlot(exclude = new Set()) {
    for (const s of this._slotPool) {
      if (!this._slots.has(s) && !exclude.has(s)) return s;
    }
    let n = this._slotPool.length + 1;
    while (this._slots.has(`rec${n}`) || exclude.has(`rec${n}`)) n++;
    return `rec${n}`;
  }

  start(slot, opts = {}) {
    if (this._slots.has(slot)) {
      this._log(`Slot ${slot} läuft bereits — stoppe zuerst`, 'warn');
      this.stop(slot);
    }

    const videoSource   = opts.videoSource || 'pgm';
    const videoChannel  = videoSource === 'clean' ? 'rec_clean_v' : 'rec_pgm_v';
    // Resolve audio groups: per-start override → engine default
    const audioGroupIds = (opts.audioGroups && opts.audioGroups.length) ? opts.audioGroups
                        : opts.audioGroup ? [opts.audioGroup]
                        : this._audioGroups;
    // Channel names must match AudioRouter.buildMasterOutputs selName: agrp_<id_with_underscores>
    const audioChannels = audioGroupIds.map(g => `rec_pgm_a_agrp_${g.replace(/-/g, '_')}`);
    const format        = opts.format || 'mkv';
    const ext          = format === 'mp4' ? '.mp4' : format === 'ts' ? '.ts' : '.mkv';
    const tpl  = opts.fileTemplate || opts.filename || `{date}_{time}_{slot}${ext}`;
    const fname = _resolveFilename(tpl.endsWith(ext) ? tpl : tpl + ext, { slot, title: opts.title, videoSource });
    let outPath = path.isAbsolute(fname) ? fname : path.join(this._recordDir, fname);

    try { fs.mkdirSync(path.dirname(outPath), { recursive: true }); } catch {}

    if (fs.existsSync(outPath)) {
      if (opts.overwrite) {
        try { fs.unlinkSync(outPath); } catch(e) { this._log(`unlink: ${e.message}`, 'warn'); }
      } else {
        const fext = path.extname(outPath);
        const base = outPath.slice(0, -fext.length);
        let n = 1;
        while (fs.existsSync(`${base}_${String(n).padStart(3, '0')}${fext}`)) n++;
        outPath = `${base}_${String(n).padStart(3, '0')}${fext}`;
        this._log(`Datei existiert bereits → ${path.basename(outPath)}`, 'warn');
      }
    }

    const pipeStr = _buildPipelineStr(videoChannel, audioChannels, outPath, opts);
    this._log(`Starte Aufzeichnung: slot=${slot} audio=[${audioChannels.join(',')}] out=${outPath}`, 'info');

    let pipeline;
    try {
      pipeline = new Pipeline(pipeStr);
    } catch(e) {
      this._log(`Pipeline-Fehler: ${e.message}`, 'error');
      return null;
    }

    this._slots.set(slot, { pipeline, outputPath: outPath, startMs: Date.now(), videoSource, audioGroups: audioGroupIds });
    this.emit('started', { slot, outputPath: outPath, videoSource });

    pipeline.play(-1).then(() => {
      this._busLoop(slot, pipeline);
    }).catch(e => {
      this._log(`play error ${slot}: ${e.message}`, 'error');
      const entry = this._slots.get(slot);
      if (entry?.pipeline === pipeline) {
        this._slots.delete(slot);
        this.emit('stopped', { slot, outputPath: outPath, durationMs: 0, code: 1, sig: null });
      }
    });

    return outPath;
  }

  async _busLoop(slot, p) {
    while (true) {
      if (this._slots.get(slot)?.pipeline !== p) break;
      let msg;
      try { msg = await p.busPop(500); } catch { break; }
      if (!msg) continue;
      if (msg.type === 'error') {
        this._log(`[${slot}] GStreamer-Fehler: ${msg.message || JSON.stringify(msg)}`, 'error');
        const entry = this._slots.get(slot);
        if (entry?.pipeline === p) {
          this._slots.delete(slot);
          p.stop(3000).catch(() => {});
          this.emit('stopped', { slot, outputPath: entry.outputPath, durationMs: Date.now() - entry.startMs, code: 1, sig: null });
        }
        break;
      }
      if (msg.type === 'eos') {
        const entry = this._slots.get(slot);
        if (entry?.pipeline === p) {
          this._slots.delete(slot);
          p.stop(3000).catch(() => {});
          this.emit('stopped', { slot, outputPath: entry.outputPath, durationMs: Date.now() - entry.startMs, code: 0, sig: null });
          _remuxForDuration(entry.outputPath, this._log, ok => { this.emit('remuxed', { slot, outputPath: entry.outputPath, ok }); });
        }
        break;
      }
    }
  }

  stop(slot, force = false) {
    const entry = this._slots.get(slot);
    if (!entry) return;
    this._log(`Stoppe Aufzeichnung: slot=${slot}`, 'info');
    this._slots.delete(slot);  // stops _busLoop
    const { pipeline, outputPath, startMs } = entry;
    pipeline.stop(3000)
      .then(() => {
        this.emit('stopped', { slot, outputPath, durationMs: Date.now() - startMs, code: 0, sig: null });
        _remuxForDuration(outputPath, this._log, ok => { this.emit('remuxed', { slot, outputPath, ok }); });
      })
      .catch(e => {
        this._log(`stop error ${slot}: ${e.message}`, 'warn');
        this.emit('stopped', { slot, outputPath, durationMs: Date.now() - startMs, code: 1, sig: null });
      });
  }

  stopAll(force = false) {
    for (const slot of [...this._slots.keys()]) this.stop(slot, force);
  }

  getStatus() {
    const result = {};
    for (const [slot, e] of this._slots) {
      result[slot] = {
        active:      true,
        outputPath:  e.outputPath,
        videoSource: e.videoSource,
        audioGroups: e.audioGroups,
        durationMs:  Date.now() - e.startMs,
      };
    }
    return result;
  }

  scheduleChildren(event, clipDurSec, fps, onRecord) {
    const children = (event.children || []).filter(c => c.source === 'record' && c.record);
    if (!children.length) return () => {};

    const frameDur = 1000 / fps;
    const timers   = [];
    const slots    = [];

    // Assign slots upfront so same-event children with 'auto' don't collide
    const localReserved = new Set();
    const childSlots = children.map(child => {
      const r = child.record;
      if (r.slot && r.slot !== 'auto') return r.slot;
      const s = this._pickFreeSlot(localReserved);
      localReserved.add(s);
      return s;
    });

    for (let ci = 0; ci < children.length; ci++) {
      const child = children[ci];
      const r = child.record;
      const slot = childSlots[ci];
      slots.push(slot);

      let delayMs;
      if (r.delayFrames != null) {
        delayMs = Math.round(r.delayFrames * frameDur);
      } else if (r._startRelEnd && clipDurSec != null) {
        const offSec = r.delay ?? 0;
        delayMs = Math.max(0, Math.round((clipDurSec + offSec) * 1000));
      } else {
        delayMs = Math.round((r.delay ?? 0) * 1000);
      }

      let durMs = null;
      if (r.endOffsetFrames != null && clipDurSec != null) {
        const clipMs = clipDurSec * 1000;
        const endMs  = clipMs + (r.endOffsetFrames * frameDur);
        durMs = Math.max(0, endMs - delayMs);
      } else if (r._endRelEnd && clipDurSec != null) {
        const offSec = r.endOffset ?? 0;
        const endMs  = clipDurSec * 1000 + offSec * 1000;
        durMs = Math.max(0, endMs - delayMs);
      } else if (r.durationFrames != null) {
        durMs = Math.round(r.durationFrames * frameDur);
      } else if (r.duration != null) {
        durMs = Math.round(r.duration * 1000);
      }

      const startTimer = setTimeout(() => {
        const outPath = this.start(slot, {
          videoSource:  r.videoSource || 'pgm',
          audioGroups:  r.audioGroups || (r.audioGroup ? [r.audioGroup] : undefined),
          fileTemplate: r.fileTemplate || r.filename,
          overwrite:    r.overwrite ?? false,
          format:       r.format,
          videoBitrate: r.videoBitrate,
          title:        r.title || event.title || event.file?.split('/').pop() || '',
        });
        if (onRecord) onRecord({ action: 'start', slot, outputPath: outPath });

        if (durMs !== null && durMs > 0) {
          const stopTimer = setTimeout(() => {
            this.stop(slot);
            if (onRecord) onRecord({ action: 'stop', slot });
          }, durMs);
          timers.push(stopTimer);
        }
      }, delayMs);

      timers.push(startTimer);
    }

    return () => {
      for (const t of timers) clearTimeout(t);
      for (const s of slots) this.stop(s);
    };
  }
}

module.exports = RecordEngine;
