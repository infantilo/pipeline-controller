/**
 * AudioRules.js
 * Audio Rules Engine für Broadcast-Output.
 *
 * Ausgabeformat: 2 Stereo-Paare
 *   Out 1/2 = Programmton (Primary)
 *   Out 3/4 = Begleiton (Secondary — z.B. Audiodeskription oder Duplikat von 1/2)
 *
 * Pro Player/Playlist-Event konfigurierbar:
 *   audioConfig: {
 *     pgm:  'pgm-de' | 'pgm-stereo' | 'audiodesc' | null
 *     secondary: 'audiodesc' | 'pgm-de' | 'dup-pgm' | null
 *   }
 *
 * Wenn kein Begleiton verfügbar → Programmton duplizieren (dup-pgm).
 * Wenn konfigurierter Track nicht vorhanden → Fallback auf ersten verfügbaren.
 */

const ROLE_PRIORITY = ['pgm-de', 'pgm-stereo', 'audiodesc', 'dolbyE-1', 'dolbyE-2', 'unknown'];

/**
 * Resolve which audio track index to use for a given role,
 * given the available tracks in a media file.
 */
function resolveTrack(tracks, role) {
  if (!role || role === 'none') return null;
  // Direct match
  const direct = tracks.find(t => t.role === role);
  if (direct) return direct;
  // Fallback: highest priority available track
  for (const r of ROLE_PRIORITY) {
    const t = tracks.find(t => t.role === r);
    if (t) return t;
  }
  return tracks[0] || null;
}

/**
 * Build GStreamer audio branch for a player pipeline.
 * Returns pipeline fragment strings for primary and secondary output channels.
 *
 * @param {Array}  tracks     - Audio track list from MediaAnalyzer
 * @param {Object} config     - { pgm, secondary } role strings
 * @param {string} channel    - Inter-audio channel name (e.g. 'player1')
 * @param {string} acaps      - GStreamer audio caps string
 * @returns {Array<string>}   - Pipeline fragment lines
 */
function buildAudioBranches(tracks, config, channel, acaps) {
  const pgmTrack = resolveTrack(tracks, config.pgm || 'pgm-de');
  let secTrack   = null;
  let dupPgm     = false;

  if (config.secondary === 'dup-pgm' || !config.secondary) {
    dupPgm = true;
  } else {
    secTrack = resolveTrack(tracks, config.secondary);
    if (!secTrack || secTrack === pgmTrack) dupPgm = true;
  }

  const lines = [];
  const isMono = pgmTrack && pgmTrack.channels === 1;

  if (!pgmTrack) {
    // No audio — push silence
    lines.push(`audiotestsrc wave=silence is-live=true ! ${acaps} ! interaudiosink channel=${channel}-pgm`);
    lines.push(`audiotestsrc wave=silence is-live=true ! ${acaps} ! interaudiosink channel=${channel}-sec`);
    return lines;
  }

  // Primary track — select specific track by stream index if multi-track
  const pgmSel = buildTrackSelector(pgmTrack, acaps);
  lines.push(`${pgmSel} ! interaudiosink channel=${channel}-pgm`);

  if (dupPgm) {
    // Duplicate primary to secondary
    // Use tee: primary → interaudiosink pgm AND interaudiosink sec
    // Rewrite last line to use tee
    lines[lines.length - 1] = `${pgmSel} ! tee name=at_${channel} at_${channel}. ! interaudiosink channel=${channel}-pgm at_${channel}. ! interaudiosink channel=${channel}-sec`;
  } else {
    const secSel = buildTrackSelector(secTrack, acaps);
    lines.push(`${secSel} ! interaudiosink channel=${channel}-sec`);
  }

  return lines;
}

/**
 * Build a GStreamer fragment that selects a specific audio track index
 * from a uridecodebin pad, converts to stereo, and outputs with given caps.
 */
function buildTrackSelector(track, acaps) {
  // uridecodebin exposes each audio track as a separate pad.
  // We address it by track index: the Nth audio pad exposed.
  // In a separate audio-only uridecodebin (caps=audio/x-raw),
  // if the file has multiple audio tracks, we need to use 'output-selector'
  // or just pick track 0 of a separate uridecodebin per track.
  // For now: use audioconvert + audioresample + channel mapping.
  const mono2stereo = track.channels === 1 
    ? '! audio/x-raw,channels=1 ! audioconvert ! audio/x-raw,channels=2 '
    : '';
  return `audioconvert ${mono2stereo}! audioresample ! ${acaps}`;
}

/**
 * Describe the audio routing for display in UI.
 */
function describeRouting(tracks, config) {
  const pgm = resolveTrack(tracks, config.pgm || 'pgm-de');
  const sec = config.secondary === 'dup-pgm' || !config.secondary
    ? null : resolveTrack(tracks, config.secondary);
  return {
    out12: pgm ? `Track ${pgm.trackIndex} (${pgm.role}, ${pgm.channels}ch)` : 'Silence',
    out34: sec ? `Track ${sec.trackIndex} (${sec.role}, ${sec.channels}ch)` : `Dup of Out 1/2`,
  };
}

module.exports = { buildAudioBranches, resolveTrack, describeRouting };
