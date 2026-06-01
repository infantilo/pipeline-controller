'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');

// Resolve ffprobe/ffmpeg binary: prefer $APPDIR/usr/bin when running as AppImage,
// then search PATH. Falls back to bare name (spawn error surfaced at call site).
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
const FFPROBE_BIN = _resolveBin('ffprobe');

// ── Audio track role classification ──────────────────────────────────────────

// Build trackIndex(0-based) → groupId map from preset routes.
// Route format: { from: 'mxf_ch1', to: ['pgm-stereo:L', ...] }
// mxf_ch1 = stream index 0, mxf_ch2 = stream index 1, ...
function _rolesFromPreset(preset) {
  const roles = {};
  for (const route of (preset?.routes || [])) {
    const m = /^mxf_ch(\d+)$/i.exec(route.from || '');
    if (!m) continue;
    const idx = parseInt(m[1]) - 1;
    for (const dest of (route.to || [])) {
      const groupId = dest.includes(':') ? dest.split(':')[0] : dest;
      if (groupId && roles[idx] === undefined) roles[idx] = groupId;
    }
  }
  return roles;
}

// Sequential fallback: assign groups in order of their channel count.
// e.g. pgm-stereo(2ch) → tracks 0,1; pgm-51(6ch) → tracks 2-7
function _rolesSequential(groups) {
  const roles = {};
  let idx = 0;
  for (const g of groups) {
    const ch = g.channels || 2;
    for (let c = 0; c < ch; c++) { roles[idx++] = g.id; }
  }
  return roles;
}

// audioConfig = { groups: [{id,channels},...], presets: {id:{routes:[...]}} }
function classifyAudio(tracks, audioConfig = {}) {
  const { groups = [], presets = {} } = audioConfig;
  const presetList = Object.values(presets);

  // Merge roles from ALL presets so every configured route gets a role
  const merged = {};
  for (const preset of presetList) {
    const r = _rolesFromPreset(preset);
    for (const [idx, role] of Object.entries(r)) {
      if (merged[idx] === undefined) merged[idx] = role;
    }
  }

  // Sequential fallback if no preset routes cover this index
  const seq = _rolesSequential(groups);
  const fallback = groups[0]?.id || 'unknown';

  return tracks.map((t, i) => ({
    ...t,
    role: merged[i] ?? seq[i] ?? fallback,
  }));
}

// ── ffprobe analysis ──────────────────────────────────────────────────────────

function runFfprobe(filePath, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', filePath];
    const proc = spawn(FFPROBE_BIN, args, { killSignal: 'SIGKILL' });
    let out = '', err = '', done = false;

    const finish = (code) => {
      if (done) return;
      done = true;
      try { proc.kill('SIGKILL'); } catch {}
      if (!out) return reject(new Error(`ffprobe kein Output (exit ${code}): ${err.slice(0, 200)}`));
      try { resolve(JSON.parse(out)); }
      catch(e) { reject(new Error('ffprobe JSON parse error: ' + e.message)); }
    };

    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('close', code => finish(code));
    proc.on('error', e => { if (!done) { done = true; reject(e); } });
    setTimeout(() => { if (!done) { done = true; try { proc.kill('SIGKILL'); } catch {} reject(new Error('ffprobe timeout')); } }, timeoutMs);
  });
}

function parseFfprobeResult(data) {
  const result = { duration: null, video: null, audio: [], tool: 'ffprobe' };

  const fmt = data.format || {};
  if (fmt.duration) result.duration = parseFloat(fmt.duration) || null;
  // Fallback: max stream-level duration (container header may omit it)
  if (!result.duration) {
    let max = 0;
    for (const s of (data.streams || [])) { const d = parseFloat(s.duration); if (d > max) max = d; }
    if (max > 0) result.duration = max;
  }

  if (fmt.tags?.timecode) result.startTimecode = fmt.tags.timecode.replace(';', ':');

  let audioIdx = 0;
  for (const s of (data.streams || [])) {
    if (s.codec_type === 'video' && !result.video) {
      result.video = {
        width:      s.width       || null,
        height:     s.height      || null,
        fps:        s.avg_frame_rate || s.r_frame_rate || '25/1',
        codec:      s.codec_name  || null,
        profile:    s.profile     || null,
        fieldOrder: s.field_order || null,
        pixFmt:     s.pix_fmt     || null,
        bitrate:    s.bit_rate ? parseInt(s.bit_rate) : null,
      };
      if (!result.startTimecode && s.tags?.timecode) result.startTimecode = s.tags.timecode.replace(';', ':');
    } else if (s.codec_type === 'audio') {
      result.audio.push({
        trackIndex: audioIdx++,
        channels:   s.channels   || 1,
        rate:       parseInt(s.sample_rate) || 48000,
        codec:      s.codec_name || null,
        bitrate:    s.bit_rate ? parseInt(s.bit_rate) : null,
      });
      if (!result.startTimecode && s.tags?.timecode) result.startTimecode = s.tags.timecode.replace(';', ':');
    } else if (s.codec_type === 'data') {
      if (!result.startTimecode && s.tags?.timecode) result.startTimecode = s.tags.timecode.replace(';', ':');
    }
  }

  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

const AUDIO_ONLY_EXT = /\.(wav|mp3|aac|flac|ogg|m4a)$/i;

async function analyzeFile(filePath, audioConfig = {}) {
  const ext      = path.extname(filePath);
  const audioOnly = AUDIO_ONLY_EXT.test(ext);

  const raw  = await runFfprobe(filePath, 10000);
  const info = parseFfprobeResult(raw);

  if (!info.duration && !info.video && !audioOnly) throw new Error('ffprobe: keine Mediadaten gefunden');
  if (audioOnly && !info.duration) throw new Error('ffprobe: keine Dauer gefunden');

  info.audio      = classifyAudio(info.audio || [], audioConfig);
  info.format     = ext.slice(1).toUpperCase();
  info.fileName   = path.basename(filePath);
  info.filePath   = filePath;
  info.som        = 0;
  info.eom        = info.duration || null;
  info.analyzedAt = Date.now();
  return info;
}

module.exports = { analyzeFile, classifyAudio };
