'use strict';
/**
 * InterlaceChain.js — gemeinsame interlace-Kette für DeckLink-Interlaced-Modi.
 *
 * Wird von lib/OutputEngine.js (Zusatz-Ausgänge) und lib/MasterPipeline.js
 * (PGM-Video-Sink) genutzt — eine Implementierung, keine Code-Duplikation.
 *
 * Mode-Daten stammen aus den decklinkvideosink Sink-Template-Caps
 * (gst-inspect-1.0 decklinkvideosink, GStreamer 1.22):
 *   1080i*: 1920x1080, PAR 1/1,   colorimetry bt709
 *   pal:    720x576,   PAR 12/11, colorimetry bt601, chroma-site mpeg2
 *   ntsc:   720x486,   PAR 10/11, colorimetry bt601, chroma-site mpeg2
 * fps = FRAME-Rate des Modes (interleaved), fieldRate = Feldrate = 2×fps.
 *
 * Kettendesign (per Negotiation-Test mit GStreamer 1.22 verifiziert):
 *   videorate zieht IMMER auf die Feldrate (2×Mode-Framerate) hoch, dann
 *   `interlace field-pattern=1:1` (je Input-Frame ein Feld → halbiert auf
 *   Mode-Framerate, interlace-mode=interleaved).
 *   - Master 50p → 1080i50: videorate passthrough, echtes Interlacing (volle
 *     Bewegungsauflösung, 50 Felder/s).
 *   - Master 25p → 1080i50: videorate dupliziert 25→50, beide Felder eines
 *     Frames stammen aus demselben Progressiv-Bild → effektiv psF. Gleiches
 *     Ergebnis wie field-pattern=2:2, aber EINE Kette für beide Master-fps
 *     (Master-fps ist in OutputEngine zur Bauzeit unbekannt). Beide Fälle
 *     verhandeln sauber (kein not-negotiated), ebenso pal/ntsc inkl. SD-PAR.
 */

// mode → Caps-Daten (Frame-Rate als Fraction-String, PAR aus Sink-Template)
const INTERLACED_MODES = {
  '1080i50':   { w: 1920, h: 1080, fps: '25/1',       fieldRate: '50/1',       par: '1/1'   },
  '1080i5994': { w: 1920, h: 1080, fps: '30000/1001', fieldRate: '60000/1001', par: '1/1'   },
  '1080i60':   { w: 1920, h: 1080, fps: '30/1',       fieldRate: '60/1',       par: '1/1'   },
  'pal':       { w: 720,  h: 576,  fps: '25/1',       fieldRate: '50/1',       par: '12/11' },
  'ntsc':      { w: 720,  h: 486,  fps: '30000/1001', fieldRate: '60000/1001', par: '10/11' },
};

function isInterlacedMode(mode) {
  return Object.prototype.hasOwnProperty.call(INTERLACED_MODES, mode);
}

/**
 * Baut das Pipeline-Fragment "videorate ! caps ! interlace ! caps" für einen
 * interlaced DeckLink-Mode. Erwartet progressiven Input in beliebiger fps
 * (nach videoconvert/videoscale); liefert interleaved Frames in Mode-Framerate.
 */
function interlaceChainStr(mode) {
  const m = INTERLACED_MODES[mode];
  if (!m) throw new Error(`InterlaceChain: kein interlaced Mode "${mode}"`);
  const parCaps = `,pixel-aspect-ratio=${m.par}`;
  return (
    `videorate` +
    ` ! video/x-raw,width=${m.w},height=${m.h},framerate=${m.fieldRate}${parCaps}` +
    ` ! interlace top-field-first=true field-pattern=1:1` +
    ` ! video/x-raw,interlace-mode=interleaved,width=${m.w},height=${m.h},framerate=${m.fps}${parCaps}`
  );
}

module.exports = { INTERLACED_MODES, isInterlacedMode, interlaceChainStr };
