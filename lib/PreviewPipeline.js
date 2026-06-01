'use strict';
const { Pipeline }     = require('gst-kit');
const { EventEmitter } = require('events');

// 1×1 black JPEG placeholder — shown until first real frame arrives
const PLACEHOLDER = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U' +
  'HRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIA' +
  'AhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABgUEA//EAB8QAAIBBAMBAAAAAAAAAAAAAAA' +
  'DBAQFERH/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/a' +
  'AAwDAQACEQMRAD8Amqr9RuaTqE5WT3F1iy5lxNNDFJJHG0jIhKqzBVJIBIGST+5oAB/' +
  '/9k=', 'base64'
);

const PREVIEW_FPS = 5;

class PreviewPipeline extends EventEmitter {
  constructor() {
    super();
    this.pipeline  = null;
    this._running  = false;
    this._frame    = PLACEHOLDER;
    this._clients  = new Set();
    this._appsink  = null;
    this._unsub    = null;
  }

  _log(m, l='info') { this.emit('log', { level:l, msg:`[preview] ${m}` }); }

  async start() {
    if (this._running) return true;

    // appsink replaces multifilesink + file polling:
    // - no /tmp dependency, no fs.existsSync/mtime polling
    // - onSample callback fires instantly for each new frame
    const pipeStr =
      `intervideosrc channel=preview timeout=3000000000 ` +
      `! videoconvert ! videorate ` +
      `! video/x-raw,format=I420,framerate=${PREVIEW_FPS}/1 ` +
      `! videoscale ! video/x-raw,width=640,height=360 ` +
      `! jpegenc quality=70 ` +
      `! appsink name=previewSink max-buffers=2 drop=true sync=false emit-signals=true`;

    try {
      const p = new Pipeline(pipeStr);
      const r = await p.play();
      if (r.result !== 'failure') {
        this.pipeline = p;
        const sink = p.getElementByName('previewSink');
        if (sink) {
          this._appsink = sink;
          this._unsub = sink.onSample(sample => {
            if (!this._running || !sample?.buffer) return;
            const buf = sample.buffer;
            if (buf.length > 200 && buf[0] === 0xFF && buf[1] === 0xD8) {
              this._frame = buf;
              this._pushToClients(buf);
            }
          });
          this._log(`läuft — appsink ${PREVIEW_FPS}fps`);
        } else {
          this._log('previewSink element nicht gefunden', 'warn');
        }
      } else {
        const m = await p.busPop(400);
        this._log(`Pipeline fehlgeschlagen: ${m?.errorMessage || '?'} → Platzhalter`, 'warn');
        try { await p.stop(); } catch {}
      }
    } catch(e) {
      this._log(`${e.message} → Platzhalter`, 'warn');
    }

    this._running = true;
    return true;
  }

  _pushToClients(buf) {
    const hdr = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`;
    for (const res of this._clients) {
      try { res.write(hdr); res.write(buf); res.write('\r\n'); }
      catch { this._clients.delete(res); }
    }
  }

  addClient(res) {
    this._clients.add(res);
    if (this._frame) {
      try {
        const hdr = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${this._frame.length}\r\n\r\n`;
        res.write(hdr); res.write(this._frame); res.write('\r\n');
      } catch {}
    }
  }

  removeClient(res) { this._clients.delete(res); }

  get frame()   { return this._frame; }
  get running() { return this._running; }

  async stop() {
    this._running = false;
    if (this._unsub) { try { this._unsub(); } catch {} this._unsub = null; }
    this._appsink = null;
    if (this.pipeline) {
      const p = this.pipeline; this.pipeline = null;
      try { await p.stop(-1); } catch {}
    }
  }
}

module.exports = { PreviewPipeline };
