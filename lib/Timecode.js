/**
 * Timecode.js — SMPTE HH:MM:SS:FF timecode utilities
 *
 * All internal values are in seconds (float).
 * TC strings are HH:MM:SS:FF.
 */

/**
 * Convert seconds to HH:MM:SS:FF string
 * @param {number} secs - seconds (float)
 * @param {number} fps  - frames per second (default 25)
 */
function toTC(secs, fps = 25) {
  if (secs == null || isNaN(secs) || secs < 0) return '00:00:00:00';
  const total  = Math.round(secs * fps); // total frames
  const ff     = total % fps;
  const totalS = Math.floor(total / fps);
  const ss     = totalS % 60;
  const totalM = Math.floor(totalS / 60);
  const mm     = totalM % 60;
  const hh     = Math.floor(totalM / 60);
  return [hh, mm, ss, ff].map(v => String(v).padStart(2, '0')).join(':');
}

/**
 * Parse HH:MM:SS:FF (or HH:MM:SS or MM:SS or plain seconds) to seconds
 * @param {string|number} input
 * @param {number} fps
 * @returns {number|null}
 */
function fromTC(input, fps = 25) {
  if (input == null || input === '') return null;
  if (typeof input === 'number') return input;
  const s = String(input).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s); // plain seconds
  const parts = s.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 4) return parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / fps;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

/**
 * Format duration for display: always HH:MM:SS:FF
 */
function fmtDur(secs, fps = 25) {
  return toTC(secs, fps);
}

module.exports = { toTC, fromTC, fmtDur };
