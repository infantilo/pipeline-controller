'use strict';
/**
 * MarinaParser.js — Pebble Beach Marina .mpl Parser
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
 */

const { spawnSync } = require('child_process');

// ── Python-Hilfsskript ────────────────────────────────────────────────────────
const PYTHON_SCRIPT = `
import sys, json, xml.etree.ElementTree as ET

def attr(el, name, default=''):
    return el.get(name, default) if el is not None else default

def dur2sec(s):
    if not s or s == '$INHERIT$': return None
    import re
    m = re.match(r'^(\\d+):(\\d+):(\\d+)(?::(\\d+))?$', s)
    if not m: return None
    return int(m.group(1))*3600 + int(m.group(2))*60 + int(m.group(3))

def extract_time(dt):
    import re
    if not dt: return None
    m = re.search(r'T(\\d{2}:\\d{2}:\\d{2}(?::\\d{2})?)$', dt)
    return m.group(1) if m else None

def parse_viz_timing(sched):
    start_type = attr(sched, 'startType', '+ParentStart')
    start_off  = attr(sched, 'startOffset', '00:00:00:00')
    end_type   = attr(sched, 'endType', '+ParentEnd')
    end_off    = attr(sched, 'endOffset', '00:00:00:00')
    delay_sec     = dur2sec(start_off) or 0
    end_off_sec   = dur2sec(end_off)   or 0
    start_rel_end = start_type.startswith('-ParentEnd') or start_type == '-ParentEnd'
    end_rel_end   = end_type == '-ParentEnd' or end_type == '+ParentEnd'
    duration_sec  = dur2sec(end_off) if end_type == 'Duration' else None
    return {
        'delaySec':    delay_sec,
        'startRelEnd': start_rel_end,
        'endRelEnd':   end_rel_end,
        'endOffSec':   end_off_sec if end_rel_end else None,
        'durationSec': duration_sec,
    }

def parse_children(ev_el):
    children = []
    for child_ev in ev_el.findall('.//event'):
        ctype = child_ev.get('type', '')
        child_props = child_ev.find('properties')
        if child_props is None: continue
        child_sched  = child_props.find('schedule')
        child_evinfo = child_props.find('event')
        child_media  = child_props.find('media')
        child_ms     = child_props.find('mediaStream')

        if ctype == 'VIZ':
            cg = child_ms.find('cg') if child_ms is not None else None
            fields = {}
            if cg is not None:
                for f in cg.findall('f'):
                    fields[attr(f, 'name')] = f.text or ''
            timing = parse_viz_timing(child_sched) if child_sched is not None else {}
            children.append({
                'type':      'VIZ',
                'title':     attr(child_evinfo, 'title') if child_evinfo is not None else '',
                'mediaName': attr(child_media, 'mediaName') if child_media is not None else '',
                'layer':     attr(cg, 'layer', 'Auto') if cg is not None else 'Auto',
                'fields':    fields,
                'timing':    timing,
            })
        elif ctype in ('LogoHD', 'LogoSD', 'LogoTV-Thek', 'LogoUHD'):
            children.append({
                'type':      ctype,
                'mediaName': attr(child_media, 'mediaName') if child_media is not None else '',
            })
        elif ctype == 'AudioMixer-ALL':
            audiomixer = child_props.find('audioMixer')
            timing = parse_viz_timing(child_sched) if child_sched is not None else {}
            children.append({
                'type':      'AudioMixer-ALL',
                'title':     attr(child_evinfo, 'title') if child_evinfo is not None else '',
                'mediaName': attr(child_media, 'mediaName') if child_media is not None else '',
                'mixType':   attr(audiomixer, 'type')   if audiomixer is not None else '',
                'preset':    attr(audiomixer, 'preset') if audiomixer is not None else '',
                'timing':    timing,
            })
    return children

xml_str = sys.stdin.read()
root = ET.fromstring(xml_str)
event_list = root.find('eventList')
if event_list is None:
    print(json.dumps([])); sys.exit(0)

results = []
for ev in event_list:
    etype   = ev.get('type', '')
    enabled = ev.get('enabled', 'true').lower()
    if enabled == 'false': continue

    props  = ev.find('properties')
    if props is None: continue

    sched    = props.find('schedule')
    ev_info  = props.find('event')
    sw       = props.find('switch')
    media    = props.find('media')
    block    = props.find('block')
    features = props.find('features')

    title         = attr(ev_info, 'title')
    reconcile_key = attr(ev_info, 'reconcileKey')
    house_id      = attr(ev_info, 'houseId')

    start_type   = attr(sched, 'startType', 'Sequential')
    start_offset = attr(sched, 'startOffset')
    end_type     = attr(sched, 'endType')
    end_offset   = attr(sched, 'endOffset')

    trans      = attr(sw, 'transition', 'Cut') if sw is not None else 'Cut'
    trans_rate = attr(sw, 'rate', 'Fast')       if sw is not None else 'Fast'

    src_el  = sw.find('source')  if sw is not None else None
    logical = src_el.find('logical') if src_el is not None else None
    live_src = attr(logical, 'name') if logical is not None else attr(src_el, 'name') if src_el is not None else ''

    # Features
    afd_type      = ''
    vps_info      = None
    subtitle_id   = ''
    audio_preset  = ''

    if features is not None:
        afd_feat = features.find('feature[@type="AFD"]')
        if afd_feat is not None:
            ar = afd_feat.find('.//aspectRatio')
            afd_type = attr(ar, 'type') if ar is not None else ''

        vps_feat = features.find('feature[@type="VPS"]')
        if vps_feat is not None:
            vps_el = vps_feat.find('.//vps')
            if vps_el is not None:
                vps_info = {
                    'aspectRatio':   attr(vps_el, 'aspectRatio'),
                    'channelIdent':  attr(vps_el, 'channelIdent'),
                    'vpsCodeType':   attr(vps_el, 'vpsCodeType'),
                    'dateTime':      attr(vps_el, 'dateTime'),
                    'audio':         attr(vps_el, 'audio'),
                }

        sub_feat = features.find('feature[@type="Subtitle"]')
        if sub_feat is not None:
            sub_media = sub_feat.find('.//media')
            subtitle_id = attr(sub_media, 'mediaName') if sub_media is not None else ''

        asf_feat = features.find('feature[@type="AudioShuffle"]')
        if asf_feat is not None:
            tp = asf_feat.find('.//trackPreset')
            audio_preset = attr(tp, 'name') if tp is not None else ''

    # Comment-Text
    comment_text = ''
    if ev_info is not None:
        ct = ev_info.find('comment')
        if ct is not None and ct.text:
            comment_text = ct.text.strip()

    # Child events (VIZ, Logo, AudioMixer)
    children = parse_children(ev) if etype in ('PrimaryVideo', 'Live') else []

    results.append({
        'type':          etype,
        'title':         title,
        'reconcileKey':  reconcile_key,
        'houseId':       house_id,
        'startType':     start_type,
        'startOffset':   start_offset,
        'endType':       end_type,
        'endOffset':     end_offset,
        'mediaName':     attr(media, 'mediaName') if media is not None else '',
        'blockName':     attr(block, 'name')      if block is not None else '',
        'transition':    trans,
        'transitionRate': trans_rate,
        'liveSource':    live_src,
        'afd':           afd_type,
        'vps':           vps_info,
        'subtitleId':    subtitle_id,
        'audioPreset':   audio_preset,
        'comment':       comment_text,
        'children':      children,
    })

print(json.dumps(results))
`;

// ── JS-Hilfsfunktionen ────────────────────────────────────────────────────────
let _seq = 0;
function genId() { return `marina_${Date.now()}_${++_seq}`; }

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

// ── Hauptfunktion ─────────────────────────────────────────────────────────────
function parseMarina(xmlString) {
  const result = spawnSync('python3', ['-c', PYTHON_SCRIPT], {
    input: xmlString, encoding: 'utf8', timeout: 30000,
  });
  if (result.error) throw new Error('Python3 nicht verfügbar: ' + result.error.message);
  if (result.status !== 0) throw new Error('Parse-Fehler: ' + (result.stderr || '').slice(0, 300));

  let raw;
  try { raw = JSON.parse(result.stdout); }
  catch (e) { throw new Error('JSON-Parse-Fehler: ' + e.message); }

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
      });
    }
    // Alle anderen Typen (Page, LogoHD Top-Level, VPS, …) überspringen
  }

  return events;
}

module.exports = { parseMarina };
