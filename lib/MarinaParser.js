'use strict';
/**
 * MarinaParser.js — Pebble Beach Marina .mpl Parser
 *
 * Reine JS-Implementierung (kein python3-Subprozess mehr) auf Basis des
 * vendored XmlLite-Parsers (lib/XmlLite.js). Ein einziger Parse-Durchlauf.
 *
 * Top-Level Events:
 *   PrimaryVideo  → player  (+ Grafik/Logo/AudioMix/VPS/Subtitle als Metadaten)
 *   Live          → live
 *   Comment       → comment
 *   PlaylistStart → block_start
 *   PlaylistEnd   → block_end
 *
 * Child-Events (werden als children[] am parent-Event gespeichert):
 *   VIZ           → grafik-Child mit Template-ID, Feldern und Timing
 *   LogoHD        → branding-Feld am parent (Kanalkennung/Logo)
 *   AudioMixer-ALL→ _marinaAudioMix (Voiceover/Audiomix-Info, für späteren Playback)
 *
 * Features am parent:
 *   AFD           → afd-Feld (Seitenverhältnis-Behandlung)
 *   VPS           → _marinaVPS (VPS-Code-Info)
 *   Subtitle      → subtitle.file (für subtitle-fab Plugin)
 *   AudioShuffle  → _marinaPreset (Audio-Track-Preset)
 *
 * Zusätzlich pro Event (für marina-sync On-Air-Abgleich):
 *   _marinaUid    — uid-Attribut des <event>
 *   _marinaState  — state-Attribut des <state>-Kindes (Null|Initialised|Cued|Cueing|Running|Done)
 *   _schedStartMs / _schedEndMs — ms seit Mitternacht (lokal), INKLUSIVE Frame-Feld
 *                    aus schedStartTime/schedEndTime ("YYYY-MM-DDTHH:MM:SS:FF")
 */

const XmlLite = require('./XmlLite');

// ── JS-Hilfsfunktionen ────────────────────────────────────────────────────────
let _seq = 0;
function genId() { return `marina_${Date.now()}_${++_seq}`; }

function attr(el, name, def = '') { return XmlLite.attrOf(el, name, def); }

function durationToSec(str) {
  if (!str) return null;
  const m = str.match(/^(\d+):(\d+):(\d+)(?::(\d+))?$/);
  if (!m) return null;
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
}

function extractTime(dtStr) {
  if (!dtStr) return null;
  const m = dtStr.match(/T(\d{2}:\d{2}:\d{2}(?::\d{2})?)$/);
  return m ? m[1] : null;
}

/** ms seit Mitternacht (lokal) aus "YYYY-MM-DDTHH:MM:SS:FF" — inkl. Frame-Feld. */
function schedTimeToMs(dtStr, fps) {
  if (!dtStr) return null;
  const m = dtStr.match(/T(\d{2}):(\d{2}):(\d{2}):(\d{2})$/);
  if (m) {
    const h = +m[1], mi = +m[2], sec = +m[3], ff = +m[4];
    return (h * 3600 + mi * 60 + sec) * 1000 + Math.round((ff / (fps || 25)) * 1000);
  }
  const m2 = dtStr.match(/T(\d{2}):(\d{2}):(\d{2})$/);
  if (m2) return (+m2[1] * 3600 + +m2[2] * 60 + +m2[3]) * 1000;
  return null;
}

function mapTransition(t) {
  t = (t || '').toLowerCase();
  if (t === 'mix' || t === 'dissolve') return 'mix';
  if (t === 'fade') return 'fade';
  return 'cut';
}

function mapTransitionSpeed(r) {
  r = (r || '').toLowerCase();
  if (r === 'slow') return 'slow';
  if (r === 'medium') return 'medium';
  return 'fast';
}

/** Übersetzt Marina AudioMixer-Preset auf internen Voiceover-Preset-Namen */
function mapMarinaPreset(preset) {
  if (!preset) return 'ST';
  // ST-ALL, ST, S → 'ST' (kein Ducking, Stereo-Mix)
  if (preset.startsWith('ST')) return 'ST';
  // AP-Presets direkt übernehmen wenn vorhanden
  if (preset.startsWith('AP')) return preset;
  return preset;
}

function mapAfd(marinaAfd) {
  if (!marinaAfd) return undefined;
  if (marinaAfd === '4:3')        return '4:3-pillarbox';
  if (marinaAfd === '14:9')       return '14:9-letterbox';
  if (marinaAfd === 'Letterbox')  return '4:3-letterbox';
  if (marinaAfd === 'Anamorphic') return 'anamorphic';
  return undefined;
}

/**
 * Wandelt Marina-VIZ-Child in internes grafik-Child-Format um.
 * Timing:
 *   +ParentStart  = delay ab Clip-Start
 *   -ParentEnd    = delay vor Clip-Ende
 *   +ParentEnd    = bis Clip-Ende
 *   -ParentEnd    = endOffset vor Clip-Ende
 *   Duration      = explizite Dauer
 */
function mapVizChild(viz) {
  const t = viz.timing || {};
  const fields = viz.fields || {};
  const grafik = {
    template:       viz.mediaName || viz.title || '',
    delay:          t.delaySec    || 0,
    _startRelEnd:   !!t.startRelEnd,
    _endRelEnd:     !!t.endRelEnd,
  };
  if (t.durationSec != null) grafik.duration = t.durationSec;
  if (t.endOffSec  != null) grafik.endOffset = t.endOffSec;
  // Template-Datenfelder direkt ins grafik-Objekt übernehmen
  for (const [k, v] of Object.entries(fields)) {
    if (k) grafik[k] = v;
  }
  if (viz.title && !grafik.template) grafik.template = viz.title;
  return { source: 'grafik', grafik };
}

// ── XML-Auswertung (Ersatz für den früheren Python/ElementTree-Pass) ─────────

function dur2sec(s) {
  if (!s || s === '$INHERIT$') return null;
  const m = s.match(/^(\d+):(\d+):(\d+)(?::(\d+))?$/);
  if (!m) return null;
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
}

function parseVizTiming(sched) {
  const startType = attr(sched, 'startType', '+ParentStart');
  const startOff  = attr(sched, 'startOffset', '00:00:00:00');
  const endType   = attr(sched, 'endType', '+ParentEnd');
  const endOff    = attr(sched, 'endOffset', '00:00:00:00');
  const delaySec     = dur2sec(startOff) || 0;
  const endOffSecRaw = dur2sec(endOff)   || 0;
  const startRelEnd  = startType === '-ParentEnd' || startType.startsWith('-ParentEnd');
  const endRelEnd    = endType === '-ParentEnd' || endType === '+ParentEnd';
  const durationSec  = endType === 'Duration' ? dur2sec(endOff) : null;
  return {
    delaySec,
    startRelEnd,
    endRelEnd,
    endOffSec: endRelEnd ? endOffSecRaw : null,
    durationSec,
  };
}

/** Kind-Events (VIZ/Logo/AudioMixer) eines PrimaryVideo/Live-Events auswerten. */
function parseChildEvents(evEl) {
  const children = [];
  for (const childEv of XmlLite.deep(evEl, 'event')) {
    const ctype = attr(childEv, 'type', '');
    const childProps = XmlLite.child(childEv, 'properties');
    if (!childProps) continue;
    const childSched  = XmlLite.child(childProps, 'schedule');
    const childEvInfo = XmlLite.child(childProps, 'event');
    const childMedia  = XmlLite.child(childProps, 'media');
    const childMs     = XmlLite.child(childProps, 'mediaStream');

    if (ctype === 'VIZ') {
      const cg = childMs ? XmlLite.child(childMs, 'cg') : null;
      const fields = {};
      if (cg) {
        for (const f of XmlLite.children(cg, 'f')) fields[attr(f, 'name')] = XmlLite.text(f) || '';
      }
      const timing = childSched ? parseVizTiming(childSched) : {};
      children.push({
        type:      'VIZ',
        title:     childEvInfo ? attr(childEvInfo, 'title') : '',
        mediaName: childMedia ? attr(childMedia, 'mediaName') : '',
        layer:     cg ? attr(cg, 'layer', 'Auto') : 'Auto',
        fields,
        timing,
      });
    } else if (ctype === 'LogoHD' || ctype === 'LogoSD' || ctype === 'LogoTV-Thek' || ctype === 'LogoUHD') {
      children.push({
        type:      ctype,
        mediaName: childMedia ? attr(childMedia, 'mediaName') : '',
      });
    } else if (ctype === 'AudioMixer-ALL') {
      const audioMixer = XmlLite.child(childProps, 'audioMixer');
      const timing = childSched ? parseVizTiming(childSched) : {};
      children.push({
        type:      'AudioMixer-ALL',
        title:     childEvInfo ? attr(childEvInfo, 'title') : '',
        mediaName: childMedia ? attr(childMedia, 'mediaName') : '',
        mixType:   audioMixer ? attr(audioMixer, 'type')   : '',
        preset:    audioMixer ? attr(audioMixer, 'preset') : '',
        timing,
      });
    }
  }
  return children;
}

/** Top-Level Marina-XML → flaches Zwischenformat (analog zum früheren Python-JSON). */
function extractRawEvents(xmlString, fps) {
  const root = XmlLite.parse(xmlString);
  const eventList = XmlLite.child(root, 'eventList');
  if (!eventList) return [];

  const results = [];
  for (const ev of eventList.children) {
    const etype   = attr(ev, 'type', '');
    const enabled = attr(ev, 'enabled', 'true').toLowerCase();
    if (enabled === 'false') continue;

    const props = XmlLite.child(ev, 'properties');
    if (!props) continue;

    const sched    = XmlLite.child(props, 'schedule');
    const evInfo   = XmlLite.child(props, 'event');
    const sw       = XmlLite.child(props, 'switch');
    const media    = XmlLite.child(props, 'media');
    const block    = XmlLite.child(props, 'block');
    const features = XmlLite.child(props, 'features');

    const title        = attr(evInfo, 'title');
    const reconcileKey = attr(evInfo, 'reconcileKey');
    const houseId      = attr(evInfo, 'houseId');

    const startType   = attr(sched, 'startType', 'Sequential');
    const startOffset = attr(sched, 'startOffset');
    const endType     = attr(sched, 'endType');
    const endOffset   = attr(sched, 'endOffset');

    const trans     = sw ? attr(sw, 'transition', 'Cut') : 'Cut';
    const transRate = sw ? attr(sw, 'rate', 'Fast')       : 'Fast';

    const srcEl   = sw ? XmlLite.child(sw, 'source') : null;
    const logical = srcEl ? XmlLite.child(srcEl, 'logical') : null;
    const liveSrc = logical ? attr(logical, 'name') : (srcEl ? attr(srcEl, 'name') : '');

    // Features
    let afdType     = '';
    let vpsInfo     = null;
    let subtitleId  = '';
    let audioPreset = '';

    if (features) {
      const afdFeat = XmlLite.childAttr(features, 'feature', 'type', 'AFD');
      if (afdFeat) {
        const ar = XmlLite.deepFirst(afdFeat, 'aspectRatio');
        afdType = ar ? attr(ar, 'type') : '';
      }

      const vpsFeat = XmlLite.childAttr(features, 'feature', 'type', 'VPS');
      if (vpsFeat) {
        const vpsEl = XmlLite.deepFirst(vpsFeat, 'vps');
        if (vpsEl) {
          vpsInfo = {
            aspectRatio:  attr(vpsEl, 'aspectRatio'),
            channelIdent: attr(vpsEl, 'channelIdent'),
            vpsCodeType:  attr(vpsEl, 'vpsCodeType'),
            dateTime:     attr(vpsEl, 'dateTime'),
            audio:        attr(vpsEl, 'audio'),
          };
        }
      }

      const subFeat = XmlLite.childAttr(features, 'feature', 'type', 'Subtitle');
      if (subFeat) {
        const subMedia = XmlLite.deepFirst(subFeat, 'media');
        subtitleId = subMedia ? attr(subMedia, 'mediaName') : '';
      }

      const asfFeat = XmlLite.childAttr(features, 'feature', 'type', 'AudioShuffle');
      if (asfFeat) {
        const tp = XmlLite.deepFirst(asfFeat, 'trackPreset');
        audioPreset = tp ? attr(tp, 'name') : '';
      }
    }

    // Comment-Text
    let commentText = '';
    if (evInfo) {
      const ct = XmlLite.child(evInfo, 'comment');
      if (ct && ct.text) commentText = ct.text.trim();
    }

    // Child events (VIZ, Logo, AudioMixer)
    const children = (etype === 'PrimaryVideo' || etype === 'Live') ? parseChildEvents(ev) : [];

    // Scheduling-State (für On-Air-Sync in marina-sync)
    const stateEl = XmlLite.child(ev, 'state');

    results.push({
      type:          etype,
      title,
      reconcileKey,
      houseId,
      startType,
      startOffset,
      endType,
      endOffset,
      mediaName:     media ? attr(media, 'mediaName') : '',
      blockName:     block ? attr(block, 'name')      : '',
      transition:    trans,
      transitionRate: transRate,
      liveSource:    liveSrc,
      afd:           afdType,
      vps:           vpsInfo,
      subtitleId,
      audioPreset,
      comment:       commentText,
      children,
      _marinaUid:    attr(ev, 'uid', ''),
      _marinaState:  stateEl ? attr(stateEl, 'state', '') : '',
      _schedStartMs: stateEl ? schedTimeToMs(attr(stateEl, 'schedStartTime'), fps) : null,
      _schedEndMs:   stateEl ? schedTimeToMs(attr(stateEl, 'schedEndTime'),   fps) : null,
    });
  }

  return results;
}

// ── Hauptfunktion ─────────────────────────────────────────────────────────────
function parseMarina(xmlString, fps = 25) {
  const raw = extractRawEvents(xmlString, fps);

  const events = [];
  for (const r of raw) {
    const fixTime    = r.startType === 'Fixed' ? extractTime(r.startOffset) : null;
    const durSec     = durationToSec(r.endOffset);
    const transition = mapTransition(r.transition);
    const transSpeed = mapTransitionSpeed(r.transitionRate);
    const afd        = mapAfd(r.afd);

    // ── Child events verarbeiten ──────────────────────────────────────────────
    const children = [];
    let branding    = undefined;
    let audioMix    = undefined;

    for (const ch of (r.children || [])) {
      if (ch.type === 'VIZ') {
        children.push(mapVizChild(ch));
      } else if (ch.type === 'LogoHD') {
        // LogoHD → branding-Feld (nur nicht-transparent)
        if (ch.mediaName && !ch.mediaName.toLowerCase().includes('transparent')) {
          branding = ch.mediaName;
        }
      } else if (ch.type === 'AudioMixer-ALL' && ch.mediaName) {
        // AudioMixer-ALL → voiceover child + Metadaten
        audioMix = { mediaName: ch.mediaName, title: ch.title, mixType: ch.mixType, preset: ch.preset };
        // Timing aus Marina: +ParentStart → 0, -ParentEnd → endRelEnd
        const t = ch.timing || {};
        children.push({
          source:       'voiceover',
          file:         ch.mediaName,
          preset:       mapMarinaPreset(ch.preset),
          delay:        t.delaySec    || 0,
          duration:     t.durationSec || null,
          endOffset:    t.endOffSec   || 0,
          _startRelEnd: !!t.startRelEnd,
          _endRelEnd:   !!t.endRelEnd,
          _marinaPreset: ch.preset || undefined,
        });
      }
    }

    const marinaMeta = {
      _marinaUid:    r._marinaUid    || undefined,
      _marinaState:  r._marinaState  || undefined,
      _schedStartMs: r._schedStartMs,
      _schedEndMs:   r._schedEndMs,
    };

    // ── PrimaryVideo ──────────────────────────────────────────────────────────
    if (r.type === 'PrimaryVideo') {
      events.push({
        id:           genId(),
        reconcileKey: r.reconcileKey || genId(),
        source:       'player',
        file:         r.mediaName || r.houseId || '',
        title:        r.title || undefined,
        som:          null,
        eom:          durSec != null ? durSec : null,
        startType:    fixTime ? 'fixtime' : 'sequential',
        startTime:    fixTime || null,
        endType:      r.endType === 'Hold' ? 'manual' : 'sequential',
        transition,
        transitionSpeed: transSpeed,
        afd:          afd || undefined,
        branding:     branding || undefined,
        children:     children.length ? children : undefined,
        subtitle:          r.subtitleId ? { file: r.subtitleId } : undefined,
        _marinaVPS:        r.vps        || undefined,
        _marinaPreset:     r.audioPreset ? r.audioPreset : undefined,
        _marinaAudioMix:   audioMix    || undefined,
        _state:       'pending',
        ...marinaMeta,
      });
    }

    // ── Live ──────────────────────────────────────────────────────────────────
    else if (r.type === 'Live') {
      events.push({
        id:           genId(),
        reconcileKey: r.reconcileKey || genId(),
        source:       'live',
        liveSource:   r.liveSource || '',
        liveSourceLabel: r.liveSource || '',
        title:        r.title || undefined,
        duration:     durSec != null ? durSec : 300,
        startType:    fixTime ? 'fixtime' : 'sequential',
        startTime:    fixTime || null,
        endType:      r.endType === 'Hold' ? 'manual' : 'sequential',
        transition,
        transitionSpeed: transSpeed,
        branding:       branding   || undefined,
        children:       children.length ? children : undefined,
        _marinaVPS:     r.vps      || undefined,
        _marinaAudioMix: audioMix  || undefined,
        _state:         'pending',
        ...marinaMeta,
      });
    }

    // ── Comment ───────────────────────────────────────────────────────────────
    else if (r.type === 'Comment') {
      events.push({
        id:           genId(),
        reconcileKey: r.reconcileKey || genId(),
        source:       'comment',
        title:        r.title || r.comment || '(Kommentar)',
        comment:      r.comment || r.title || '',
        _state:       'pending',
        ...marinaMeta,
      });
    }

    // ── PlaylistStart → block_start ───────────────────────────────────────────
    else if (r.type === 'PlaylistStart') {
      events.push({
        id:           genId(),
        reconcileKey: r.reconcileKey || genId(),
        source:       'block_start',
        title:        r.blockName || r.title || '',
        startType:    fixTime ? 'fixtime' : 'sequential',
        startTime:    fixTime || null,
        _state:       'pending',
        ...marinaMeta,
      });
    }

    // ── PlaylistEnd → block_end ───────────────────────────────────────────────
    else if (r.type === 'PlaylistEnd') {
      events.push({
        id:           genId(),
        reconcileKey: r.reconcileKey || genId(),
        source:       'block_end',
        title:        r.title || undefined,
        _state:       'pending',
        ...marinaMeta,
      });
    }
    // Alle anderen Typen (Page, LogoHD Top-Level, VPS, …) überspringen
  }

  return events;
}

module.exports = { parseMarina };
