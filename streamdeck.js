/**
 * streamdeck.js — Stream Deck WebHID Integration
 *
 * Erfordert Chrome/Edge 89+ (WebHID).
 * Die offizielle Elgato Stream Deck Software muss geschlossen sein
 * (sie hält das HID-Gerät exklusiv).
 *
 * Plugin-Erweiterung: StreamDeck.registerPage({ id, name, icon, color?,
 *   condition?:()=>bool, getLayout(ctx)=>ButtonDef[][] })
 *
 * ctx = { cols, contentRows, sub, nav(id,sub?), nextSub(), prevSub() }
 * ButtonDef = { icon?, label?, sublabel?, bg?, textColor?, ind?, action? }
 *   ind: 'onair'|'cued'|'live'|'play'
 */
'use strict';

(function () {

const SD = window.StreamDeck = {};

// ── Model Definitions ─────────────────────────────────────────────────────────
const VENDOR_ID = 0x0fd9;
// inOff = byte offset in WebHID inputreport data where button states start
// mirror = physical key index uses mirrored column order
// imgMirror = BMP pixel data needs horizontal flip
// For 'bmp' models the Mini write protocol differs from MK.2
const MODELS = {
  0x006d: { name:'Stream Deck MK.2', cols:5, rows:3, imgSize:72,  fmt:'jpeg', inOff:2, mirror:false, imgMirror:false, proto:'mk2'  },
  0x006c: { name:'Stream Deck XL',   cols:8, rows:4, imgSize:96,  fmt:'jpeg', inOff:2, mirror:false, imgMirror:false, proto:'mk2'  },
  0x0084: { name:'Stream Deck +',    cols:4, rows:4, imgSize:120, fmt:'jpeg', inOff:2, mirror:false, imgMirror:false, proto:'mk2'  },
  0x0063: { name:'Stream Deck Mini', cols:3, rows:2, imgSize:80,  fmt:'bmp',  inOff:0, mirror:true,  imgMirror:true,  proto:'mini' },
  0x0060: { name:'Stream Deck MK.1', cols:5, rows:3, imgSize:72,  fmt:'bmp',  inOff:1, mirror:true,  imgMirror:false, proto:'mk1'  },
};

// ── State ─────────────────────────────────────────────────────────────────────
let _dev    = null;
let _model  = null;
let _pages  = new Map();  // id → PageDef (registration order = menu order)
let _page   = 'home';
let _sub    = 0;
let _prints = [];         // fingerprint[physical_btn_idx]
let _acts   = [];         // action[physical_btn_idx]
let _busy   = false;
let _pending= false;
let _timer  = null;

// ── Public API ────────────────────────────────────────────────────────────────

/** Register a page (built-in and plugin pages use the same API). */
SD.registerPage = function(def) {
  _pages.set(def.id, def);
  _schedule();
};

SD.unregisterPage = function(id) {
  _pages.delete(id);
  if (_page === id) _nav('home');
  _schedule();
};

SD.navigateTo    = (id, sub = 0) => _nav(id, sub);
SD.isConnected   = () => !!_dev;
SD.getModel      = () => _model;
SD.scheduleRender= _schedule;

// ── Connection ────────────────────────────────────────────────────────────────

SD.connect = async function() {
  if (!navigator?.hid) {
    alert('WebHID nicht verfügbar — nur Chrome/Edge unterstützt');
    return;
  }
  try {
    const filters = Object.keys(MODELS).map(k => ({ vendorId: VENDOR_ID, productId: +k }));
    const devs = await navigator.hid.requestDevice({ filters });
    if (!devs.length) return;
    await _open(devs[0]);
  } catch(e) {
    console.warn('[SD] connect:', e.message);
  }
};

SD.disconnect = async function() {
  if (!_dev) return;
  try { _dev.removeEventListener('inputreport', _onInput); await _dev.close(); } catch {}
  _dev = null; _model = null;
  _updToolbar();
};

async function _open(dev) {
  const m = MODELS[dev.productId];
  if (!m) return;
  if (!dev.opened) await dev.open();
  _dev   = dev;
  _model = m;
  const n = m.cols * m.rows;
  _prints = Array(n).fill('');
  _acts   = Array(n).fill(null);
  _dev.addEventListener('inputreport', _onInput);
  await _setBrightness(70);
  _schedule();
  _updToolbar();
  console.log('[SD] connected:', m.name, `${m.cols}×${m.rows}`);
}

// Auto-reconnect on USB plug-in
navigator.hid?.addEventListener('connect', async e => {
  if (_dev || e.device.vendorId !== VENDOR_ID) return;
  const all = await navigator.hid.getDevices().catch(() => []);
  const sd  = all.find(d => d.vendorId === VENDOR_ID && MODELS[d.productId]);
  if (sd) await _open(sd);
});
navigator.hid?.addEventListener('disconnect', e => {
  if (e.device === _dev) { _dev = null; _model = null; _updToolbar(); }
});

// ── Input Handling ────────────────────────────────────────────────────────────

function _onInput(e) {
  const data = new Uint8Array(e.data.buffer);
  const off  = _model.inOff;
  const n    = _model.cols * _model.rows;
  for (let i = 0; i < n; i++) {
    if (data[off + i] === 1 && _acts[i]) {
      try { _acts[i](); } catch(err) { console.warn('[SD] action error:', err); }
    }
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────

function _nav(id, sub = 0) { _page = id; _sub = sub; _schedule(); }
function _nextSub() { _sub++; _schedule(); }
function _prevSub() { _sub = Math.max(0, _sub - 1); _schedule(); }

// ── Render Scheduling (debounced) ─────────────────────────────────────────────

function _schedule() {
  if (_timer) return;
  _timer = setTimeout(() => {
    _timer = null;
    _render().catch(e => console.warn('[SD] render error:', e));
  }, 100);
}

// ── Grid Builder ──────────────────────────────────────────────────────────────

function _buildGrid() {
  const { cols, rows } = _model;
  const contentRows    = Math.max(0, rows - 2);
  const pageDef        = _pages.get(_page);
  const grid           = [];

  // Row 0: menu
  grid.push(_menuRow(cols));

  // Middle rows: page content
  if (contentRows > 0) {
    const ctx = { cols, contentRows, sub: _sub, nav: _nav, nextSub: _nextSub, prevSub: _prevSub };
    let content = [];
    try { content = pageDef?.getLayout(ctx) || []; } catch(e) { console.warn('[SD] layout error:', e); }
    while (content.length < contentRows) content.push(_eRow(cols));
    for (let r = 0; r < contentRows; r++) grid.push(content[r] || _eRow(cols));
  }

  // Last row: playlist controls
  grid.push(_playlistRow(cols));
  return grid;
}

function _menuRow(cols) {
  const row   = _eRow(cols);
  const pages = [..._pages.values()].filter(p => p.id !== 'home' && (!p.condition || p.condition()));

  let slot = 0;
  if (_page !== 'home') {
    row[slot++] = { icon:'🏠', label:'Home', bg:'#0f172a', action:() => _nav('home') };
  }
  for (const p of pages) {
    if (slot >= cols - (_sub > 0 ? 1 : 0)) break;
    const active = _page === p.id;
    row[slot++] = {
      icon: p.icon, label: p.name,
      bg: active ? (p.color || '#4f46e5') : '#1e293b',
      action: () => _nav(p.id),
    };
  }
  // Sub-page back arrow in last menu slot if needed
  if (_sub > 0) row[cols - 1] = { icon:'◀', label:'', bg:'#1e293b', action: _prevSub };
  return row;
}

function _playlistRow(cols) {
  const row      = _eRow(cols);
  const running  = !!window.S?.playlist?.running;
  const pl       = window.S?.plData || [];
  const idx      = window.S?.playlist?.currentIndex ?? -1;
  const curEv    = pl[idx];
  const nextEv   = pl[idx + 1];
  const isLive   = curEv && (curEv.liveSource || (curEv.source && curEv.source !== 'black' && curEv.source !== 'smpte'));

  const playBtn = {
    icon: running ? '⏸' : '▶',
    label: running ? 'STOP' : 'PLAY',
    bg: running ? '#991b1b' : '#166534',
    sublabel: running ? _readCounter() : null,
    action: () => running ? window.stopPlaylist?.() : window.startPlaylist?.(),
  };

  if (cols === 3) {
    // Mini: compact 3-button playlist row
    row[0] = { icon:'⏮', label:'Prev',  bg:'#1e293b', action:() => window.plGoPrev?.() };
    row[1] = playBtn;
    row[2] = { icon:'⏭', label:'Next',  bg:'#1e293b', action:() => window.playNext?.() };
    return row;
  }

  // 5-col (MK.2): center-aligned
  if (cols === 5) {
    row[0] = { icon:'⏮', label:'Prev',      bg:'#1e293b', action:() => window.plGoPrev?.() };
    row[1] = playBtn;
    row[2] = { icon:'⏭', label:'Next',      bg:'#1e293b', action:() => window.playNext?.() };
    row[3] = { icon:'🔴', label:'Next Live', bg:'#6d28d9', action:() => window.playNextLive?.() };
    row[4] = nextEv ? {
      icon: '⏩', label: _evName(nextEv), bg:'#1e293b', sublabel:'nächstes',
    } : _eBtn();
    return row;
  }

  // 8-col (XL): full row
  row[0] = { icon:'⏮', label:'Prev',      bg:'#1e293b', action:() => window.plGoPrev?.() };
  row[1] = playBtn;
  row[2] = { icon:'⏭', label:'Next',      bg:'#1e293b', action:() => window.playNext?.() };
  row[3] = { icon:'🔴', label:'Next Live', bg:'#6d28d9', action:() => window.playNextLive?.() };
  row[4] = {
    icon: isLive ? '📡' : '🎞',
    label: _evName(curEv), bg:'#1e293b',
    sublabel: running ? _readCounter() : null,
    ind: running ? (isLive ? 'live' : 'onair') : null,
  };
  row[5] = nextEv ? { icon:'⏩', label:_evName(nextEv), bg:'#1e293b', sublabel:'nächstes' } : _eBtn();
  row[6] = { icon:'⏺', label:'Record',  bg:'#374151', action:() => document.getElementById('btn-record-panel')?.click() };
  row[7] = { icon:'📺', label:'Preview', bg:'#374151', action:() => window.togglePreview?.() };
  return row;
}

function _readCounter() {
  // Read counter from the counter strip if available
  const el = document.querySelector('.cs-slot .cs-time, .cs-countdown');
  return el?.textContent?.trim()?.slice(0, 8) || null;
}

function _evName(ev) {
  if (!ev) return '—';
  const n = ev.title || ev.file?.replace(/\.[^.]+$/, '') || ev.source || '?';
  return n.length > 10 ? n.slice(0, 9) + '…' : n;
}

// ── Built-in Pages ────────────────────────────────────────────────────────────

// HOME
SD.registerPage({
  id:'home', name:'Home', icon:'🏠', color:'#1e40af',
  getLayout({ cols, contentRows }) {
    const pages = [..._pages.values()].filter(p => p.id !== 'home' && (!p.condition || p.condition()));
    const row1  = _eRow(cols);
    pages.slice(0, cols).forEach((p, i) => {
      row1[i] = { icon:p.icon, label:p.name, bg:p.color || '#1e293b', action:() => _nav(p.id) };
    });
    const rows = [row1];
    // Status overview in remaining rows
    if (contentRows >= 2) {
      const sRow = _eRow(cols);
      const running = !!window.S?.playlist?.running;
      sRow[0] = { icon: running ? '▶' : '⏸', label: running ? 'LÄUFT' : 'GESTOPPT', bg: running ? '#166534' : '#374151' };
      const gfxCount = (window._grafikActiveMap?.size || 0);
      if (gfxCount) sRow[1] = { icon:'📺', label:`${gfxCount} Grafik`, bg:'#78350f', ind:'onair' };
      const scte = window._scte35State;
      if (scte?.inBreak) sRow[2] = { icon:'🔴', label:'SCTE BREAK', bg:'#7f1d1d', ind:'onair' };
      const brd = window.S?.master?.currentBranding;
      if (brd) sRow[3] = { icon:'🎨', label: brd.replace(/\.[^.]+$/,''), bg:'#064e3b' };
      rows.push(sRow);
    }
    while (rows.length < contentRows) rows.push(_eRow(cols));
    return rows;
  }
});

// ASSETS
SD.registerPage({
  id:'assets', name:'Assets', icon:'🎬', color:'#0f766e',
  getLayout({ cols, contentRows, sub, nextSub, prevSub }) {
    const live     = window.S?.config?.liveSources || [];
    const assets   = window.S?.assets || [];
    const pl       = window.S?.plData || [];
    const idx      = window.S?.playlist?.currentIndex ?? -1;
    const curEv    = pl[idx];
    const onAirSrc = curEv?.liveSource || curEv?.source;
    const onAirFile= curEv?.file || null;
    const rows     = [];

    if (contentRows === 1) {
      // Standard (5×3): single row — sub=0 shows live sources, sub≥1 shows assets
      const row = _eRow(cols);
      if (sub === 0) {
        live.slice(0, cols - 1).forEach((ls, i) => {
          const onAir = onAirSrc === ls.id;
          row[i] = {
            icon: onAir ? '🔴' : '📡', label: ls.label || ls.id,
            bg: onAir ? '#7f1d1d' : '#0c4a6e', ind: onAir ? 'onair' : null,
            action: () => window.switchLive?.(ls.id),
          };
        });
        if (assets.length) row[cols-1] = { icon:'🎞', label:'Assets ▶', bg:'#374151', action: nextSub };
      } else {
        const pp  = cols - 2;
        const off = (sub - 1) * pp;
        assets.slice(off, off + pp).forEach((a, i) => {
          const onAir = onAirFile && _assetMatch(a, onAirFile);
          row[i] = {
            icon: onAir ? '🔴' : '🎞', label: _aName(a),
            bg: onAir ? '#7f1d1d' : '#1e293b',
            ind: onAir ? 'onair' : null,
            sublabel: onAir ? _readCounter() : _dur(a.duration),
            action: () => _playAsset(a),
          };
        });
        row[cols-2] = sub > 1 ? { icon:'◀', label:'', bg:'#374151', action: prevSub } : _eBtn();
        row[cols-1] = off + pp < assets.length ? { icon:'▶', label:'Mehr', bg:'#374151', action: nextSub } : _eBtn();
      }
      rows.push(row);
    } else {
      // XL (8×4): row 0 = live sources, row 1+ = assets
      const lRow = _eRow(cols);
      live.slice(0, cols).forEach((ls, i) => {
        const onAir = onAirSrc === ls.id;
        lRow[i] = {
          icon: onAir ? '🔴' : '📡', label: ls.label || ls.id,
          bg: onAir ? '#7f1d1d' : '#0c4a6e', ind: onAir ? 'onair' : null,
          action: () => window.switchLive?.(ls.id),
        };
      });
      rows.push(lRow);

      // Asset rows (paginated), last 2 slots of last row = navigation
      const assetContent = contentRows - 1;
      const perPage = cols * assetContent - 2;
      const off = sub * perPage;
      let ai = 0;
      for (let r = 0; r < assetContent; r++) {
        const aRow = _eRow(cols);
        for (let c = 0; c < cols; c++) {
          const isLastRow = r === assetContent - 1;
          const isNavSlot = isLastRow && c >= cols - 2;
          if (isNavSlot) {
            if (c === cols - 2) aRow[c] = sub > 0 ? { icon:'◀', bg:'#374151', action: prevSub } : _eBtn();
            else                aRow[c] = off + perPage < assets.length ? { icon:'▶', bg:'#374151', action: nextSub } : _eBtn();
            continue;
          }
          const a = assets[off + ai++];
          if (!a) continue;
          const onAir = onAirFile && _assetMatch(a, onAirFile);
          aRow[c] = {
            icon: onAir ? '🔴' : '🎞', label: _aName(a),
            bg: onAir ? '#7f1d1d' : '#1e293b',
            ind: onAir ? 'onair' : null,
            sublabel: onAir ? _readCounter() : _dur(a.duration),
            action: () => _playAsset(a),
          };
        }
        rows.push(aRow);
      }
    }
    return rows;
  }
});

function _assetMatch(a, file) {
  const fn = a.fileName || '';
  return fn === file || fn.replace(/\.[^.]+$/,'') === file.replace(/\.[^.]+$/,'');
}
function _aName(a) {
  const n = a.title || a.fileName?.replace(/\.[^.]+$/,'') || '?';
  return _trunc(n, 10);
}
function _dur(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2,'0')}`;
}
function _playAsset(a) {
  // Queue or direct-play: use whatever the UI provides
  if (window.playAssetDirect) return window.playAssetDirect(a);
  // Fallback: open media library modal or add to playlist
  if (window.addToPlaylist) return window.addToPlaylist(a);
}

// GRAFIK / OGRAF
SD.registerPage({
  id:'ograf', name:'Grafik', icon:'📺', color:'#92400e',
  getLayout({ cols, contentRows, sub, nextSub }) {
    const activeMap = window._grafikActiveMap || new Map();
    const tpls      = window.GRAFIK_TEMPLATES_META || [];
    const onAirIds  = [...activeMap.keys()];
    const rows      = [];

    // Row 0: on-air graphics — tap to immediately hide that template
    const gRow = _eRow(cols);
    if (onAirIds.length === 0) {
      gRow[0] = { icon:'—', label:'Keine Grafiken', bg:'#111', textColor:'#555' };
    } else {
      const visible = onAirIds.slice(sub * (cols - 1), sub * (cols - 1) + (cols - 1));
      visible.forEach((tplId, i) => {
        gRow[i] = {
          icon:'🖼', label: tplId.replace('lowerThird','LT').replace('fullscreen','FS').replace('ticker','Ticker'),
          bg:'#78350f', ind:'onair', sublabel:'▶ Aus',
          action: async () => {
            const sel = document.getElementById('grafik-tpl-sel');
            if (sel) { sel.value = tplId; window._updateGrafikPanelState?.(tplId); }
            await window.grafikHide?.();
          },
        };
      });
      if (onAirIds.length > cols - 1)
        gRow[cols-1] = { icon:'▶', label:'', bg:'#374151', action: nextSub };
    }
    rows.push(gRow);

    if (contentRows >= 2) {
      // Row 1: template browser (select active template, not take)
      const tRow = _eRow(cols);
      const browsable = tpls.filter(t => !t.hidden);
      browsable.slice(0, cols).forEach((t, i) => {
        const onAir = activeMap.has(t.id);
        tRow[i] = {
          icon: onAir ? '🔴' : '🖼',
          label: t.id.replace('lowerThird','LT').replace('fullscreen','FS').replace('ticker','Ticker'),
          bg: onAir ? '#78350f' : '#1e293b',
          ind: onAir ? 'onair' : null,
          action: () => {
            const sel = document.getElementById('grafik-tpl-sel');
            if (sel) { sel.value = t.id; window._updateGrafikPanelState?.(t.id); }
          },
        };
      });
      rows.push(tRow);
    }

    // Action row: Take / Takeout / Continue
    if (contentRows >= 2) {
      const actRow = _eRow(cols);
      actRow[0] = { icon:'▶',  label:'Take',    bg:'#15803d', action:() => window.grafikShow?.()    };
      actRow[1] = { icon:'⏹', label:'Takeout',  bg:'#b91c1c', action:() => window.grafikHide?.()   };
      actRow[2] = { icon:'⏩', label:'Continue', bg:'#1d4ed8', action:() => window.grafikContinue?.() };
      rows.push(actRow);
    } else {
      // Standard with 1 content row: overwrite with action row
      rows[0] = _eRow(cols);
      rows[0][0] = { icon:'▶',  label:'Take',    bg:'#15803d', action:() => window.grafikShow?.()    };
      rows[0][1] = { icon:'⏹', label:'Takeout',  bg:'#b91c1c', action:() => window.grafikHide?.()   };
      rows[0][2] = { icon:'⏩', label:'Continue', bg:'#1d4ed8', action:() => window.grafikContinue?.() };
      // Remaining slots: on-air status
      onAirIds.slice(0, cols - 3).forEach((id, i) => {
        rows[0][3 + i] = { icon:'🖼', label:_trunc(id,8), bg:'#78350f', ind:'onair' };
      });
    }

    while (rows.length < contentRows) rows.push(_eRow(cols));
    return rows;
  }
});

// SCTE-35 (only shown if plugin is active)
SD.registerPage({
  id:'scte35', name:'SCTE-35', icon:'📡', color:'#6d28d9',
  condition: () => !!window._plugins?.find(p => p.id === 'scte35' && p.enabled),
  getLayout({ cols, contentRows }) {
    const st  = window._scte35State || {};
    const rows = [];

    const statusRow = _eRow(cols);
    statusRow[0] = {
      icon: st.inBreak ? '🔴' : '🟢',
      label: st.inBreak ? 'IN BREAK' : 'ON-AIR',
      bg: st.inBreak ? '#7f1d1d' : '#14532d',
      ind: st.inBreak ? 'onair' : null,
    };
    if (st.target) statusRow[1] = { icon:'📌', label:st.target, bg:'#1e293b', sublabel:`PID ${st.pid||'?'}` };
    if (st.lastCue) statusRow[2] = {
      icon: st.lastCue.dir === 'out' ? '📤' : '📥',
      label: st.lastCue.dir?.toUpperCase(),
      bg:'#1e293b',
      sublabel: st.lastCue.dur ? `${st.lastCue.dur}s` : null,
    };
    rows.push(statusRow);

    if (contentRows >= 2) {
      const actRow = _eRow(cols);
      actRow[0] = { icon:'📤', label:'Cue OUT', bg:'#b45309', action:() => window.scte35ManualCue?.('out') };
      actRow[1] = { icon:'📥', label:'Cue IN',  bg:'#15803d', action:() => window.scte35ManualCue?.('in')  };
      actRow[2] = { icon:'💓', label:'Null',    bg:'#1e3a5f', action:() => window.scte35ManualCue?.('null') };
      // Duration quick-set
      const durEl = () => document.getElementById('scte35-manual-dur');
      const getDur = () => parseFloat(durEl()?.value || '0');
      actRow[3] = { icon:'⏱', label:`${getDur()}s`, bg:'#374151', sublabel:'Dur', action:() => {
        const d = durEl();
        if (!d) return;
        const v = parseFloat(prompt('Duration (s):', d.value) || d.value);
        if (!isNaN(v) && v >= 0) { d.value = v; }
        _schedule();
      }};
      rows.push(actRow);
    } else {
      // 1 content row: merge status + actions
      const row = _eRow(cols);
      row[0] = { icon: st.inBreak ? '🔴' : '🟢', label: st.inBreak ? 'BREAK' : 'ON-AIR', bg: st.inBreak ? '#7f1d1d' : '#14532d', ind: st.inBreak ? 'onair' : null };
      row[1] = { icon:'📤', label:'Cue OUT', bg:'#b45309', action:() => window.scte35ManualCue?.('out') };
      row[2] = { icon:'📥', label:'Cue IN',  bg:'#15803d', action:() => window.scte35ManualCue?.('in')  };
      row[3] = { icon:'💓', label:'Null',    bg:'#1e3a5f', action:() => window.scte35ManualCue?.('null') };
      rows.push(row);
    }

    while (rows.length < contentRows) rows.push(_eRow(cols));
    return rows;
  }
});

// BRANDING
SD.registerPage({
  id:'branding', name:'Branding', icon:'🎨', color:'#065f46',
  getLayout({ cols, contentRows, sub, nextSub, prevSub }) {
    const list    = window.S?.branding || [];
    const current = window.S?.master?.currentBranding || null;
    const rows    = [];

    // Status row
    const sRow = _eRow(cols);
    sRow[0] = {
      icon: current ? '🏷' : '—',
      label: current ? _trunc(current.replace(/\.[^.]+$/,''), 10) : 'Kein Branding',
      bg: current ? '#064e3b' : '#1e293b',
      ind: current ? 'onair' : null,
    };
    if (current) {
      sRow[1] = { icon:'⏹', label:'Aus', bg:'#991b1b', action:() => window.swBrandingOff?.() };
    }
    rows.push(sRow);

    if (contentRows >= 2) {
      const pp  = cols * (contentRows - 1) - 2;
      const off = sub * pp;
      let bi = 0;
      for (let r = 0; r < contentRows - 1; r++) {
        const bRow = _eRow(cols);
        for (let c = 0; c < cols; c++) {
          const isLastRow = r === contentRows - 2;
          if (isLastRow && c === cols - 2) { bRow[c] = sub > 0 ? { icon:'◀', bg:'#374151', action: prevSub } : _eBtn(); continue; }
          if (isLastRow && c === cols - 1) { bRow[c] = off + pp < list.length ? { icon:'▶', bg:'#374151', action: nextSub } : _eBtn(); continue; }
          const b = list[off + bi++];
          if (!b) continue;
          const file   = b.file || b;
          const name   = typeof b === 'object' ? (b.label || file.replace(/\.[^.]+$/,'')) : String(b).replace(/\.[^.]+$/,'');
          const active = current === file;
          bRow[c] = {
            icon: active ? '✅' : '🎨', label: _trunc(name, 10),
            bg: active ? '#064e3b' : '#1e293b', ind: active ? 'onair' : null,
            action: () => {
              const sel = document.getElementById('sw-branding-sel');
              if (sel) sel.value = file;
              window.swBrandingOn?.();
            },
          };
        }
        rows.push(bRow);
      }
    }

    while (rows.length < contentRows) rows.push(_eRow(cols));
    return rows;
  }
});

// ── Render Engine ─────────────────────────────────────────────────────────────

async function _render() {
  if (!_dev || !_model) return;
  if (_busy) { _pending = true; return; }
  _busy = true;
  try {
    const { cols, rows } = _model;
    const grid = _buildGrid();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const logical  = r * cols + c;
        const physical = _model.mirror ? r * cols + (cols - 1 - c) : logical;
        const def = grid[r]?.[c] || _eBtn();
        const fp  = _fp(def);
        if (fp === _prints[physical]) continue;
        _prints[physical] = fp;
        _acts[physical]   = def.action || null;
        try {
          const img = await _renderBtn(def);
          await _sendImg(physical, img);
        } catch(e) { console.warn(`[SD] btn ${physical}:`, e.message); }
      }
    }
  } finally {
    _busy = false;
    if (_pending) { _pending = false; _schedule(); }
  }
}

function _fp(def) {
  return `${def.icon}|${def.label}|${def.sublabel}|${def.bg}|${def.ind}`;
}

// ── Button Image Renderer ─────────────────────────────────────────────────────

async function _renderBtn(def) {
  const size = _model.imgSize;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = def.bg || '#111111';
  ctx.fillRect(0, 0, size, size);

  // Indicator bar (top 5px)
  if (def.ind) {
    ctx.fillStyle = { onair:'#ef4444', cued:'#f59e0b', live:'#dc2626', play:'#22c55e' }[def.ind] || '#6b7280';
    ctx.fillRect(0, 0, size, 5);
  }

  const hasIcon  = !!def.icon;
  const hasLabel = !!def.label;
  const hasSub   = !!def.sublabel;

  // Vertical layout zones
  const iconY  = size * (hasLabel ? (hasSub ? 0.30 : 0.36) : 0.50);
  const labelY = size * (hasSub ? 0.62 : (hasIcon ? 0.74 : 0.50));
  const subY   = size * 0.86;

  if (hasIcon) {
    ctx.font = `${Math.floor(size * (hasLabel ? 0.36 : 0.50))}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(def.icon, size / 2, iconY);
  }

  if (hasLabel) {
    ctx.font = `bold ${Math.max(9, Math.floor(size * 0.16))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = def.textColor || '#ffffff';
    ctx.fillText(_trunc(def.label, 10), size / 2, labelY);
  }

  if (hasSub) {
    ctx.font = `${Math.max(8, Math.floor(size * 0.13))}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#9ca3af';
    ctx.fillText(_trunc(def.sublabel, 12), size / 2, subY);
  }

  if (_model.fmt === 'bmp') return _canvasToBMP(canvas, size);

  // JPEG
  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.85));
  return new Uint8Array(await blob.arrayBuffer());
}

// ── BMP Encoder (Mini / MK.1) ─────────────────────────────────────────────────

function _canvasToBMP(canvas, size) {
  const ctx  = canvas.getContext('2d');
  const imgD = ctx.getImageData(0, 0, size, size).data;
  const row  = size * 3;
  const buf  = new Uint8Array(54 + row * size);
  const dv   = new DataView(buf.buffer);

  buf[0]=0x42; buf[1]=0x4D;
  dv.setUint32(2, buf.length, true);
  dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18,  size, true);
  dv.setInt32(22,  size, true); // positive = bottom-to-top (standard BMP)
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  dv.setUint32(34, row * size, true);

  let off = 54;
  for (let r = size - 1; r >= 0; r--) {      // bottom-to-top rows
    for (let c = 0; c < size; c++) {
      const sc = _model.imgMirror ? size - 1 - c : c;  // horizontal flip for Mini
      const si = (r * size + sc) * 4;
      buf[off++] = imgD[si+2]; // B
      buf[off++] = imgD[si+1]; // G
      buf[off++] = imgD[si+0]; // R
    }
  }
  return buf;
}

// ── HID Image Send ────────────────────────────────────────────────────────────

async function _sendImg(physIdx, data) {
  if (!_dev) return;
  if (_model.proto === 'mk2') return _sendImgMK2(physIdx, data);
  if (_model.proto === 'mini') return _sendImgMini(physIdx, data);
  // MK1: not fully supported, skip silently
}

async function _sendImgMK2(physIdx, data) {
  // Total report = 1024 bytes (reportId 0x02 + 1023 bytes data)
  // Header in data: 8 bytes, payload: 1015 bytes
  const PAYLOAD = 1015;
  let pkt = 0, off = 0;
  while (off < data.length || pkt === 0) {
    const chunk  = data.slice(off, off + PAYLOAD);
    off         += chunk.length;
    const isLast = off >= data.length;

    const buf = new Uint8Array(1023);
    buf[0] = 0x07;
    buf[1] = physIdx;
    buf[2] = isLast ? 1 : 0;
    buf[3] = chunk.length & 0xff;
    buf[4] = chunk.length >> 8;
    buf[5] = pkt & 0xff;
    buf[6] = pkt >> 8;
    // buf[7] = 0x00 (padding)
    buf.set(chunk, 8);

    await _dev.sendReport(0x02, buf);
    pkt++;
    if (isLast) break;
  }
}

async function _sendImgMini(physIdx, data) {
  // Mini protocol: 16-byte header per packet, payload = 1007 bytes
  const PAYLOAD = 1007;
  let pkt = 0, off = 0;
  while (off < data.length || pkt === 0) {
    const chunk  = data.slice(off, off + PAYLOAD);
    off         += chunk.length;
    const isLast = off >= data.length;

    const buf = new Uint8Array(1023);
    buf[0] = 0x02;
    buf[1] = 0x01;
    buf[2] = pkt & 0xff;   // page number (0-indexed here, some implementations use 1-indexed)
    buf[3] = 0x00;
    buf[4] = isLast ? 1 : 0;
    buf[5] = physIdx;
    // buf[6..15] = 0x00
    buf.set(chunk, 16);

    await _dev.sendReport(0x02, buf);
    pkt++;
    if (isLast) break;
  }
}

async function _setBrightness(pct) {
  if (!_dev) return;
  const d = new Uint8Array(16);
  d[0] = 0x08; d[1] = Math.min(100, Math.max(0, pct));
  try { await _dev.sendFeatureReport(0x03, d); } catch {}
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function _eRow(cols) { return Array.from({ length: cols }, () => _eBtn()); }
function _eBtn()     { return { bg:'#000000', action: null }; }
function _trunc(s, n) { if (!s) return s; return s.length > n ? s.slice(0, n-1) + '…' : s; }

// ── Toolbar Button ────────────────────────────────────────────────────────────

function _updToolbar() {
  const btn = document.getElementById('btn-streamdeck');
  if (!btn) return;
  btn.title = _dev
    ? `Stream Deck: ${_model.name} (${_model.cols}×${_model.rows}) — klicken zum Trennen`
    : 'Stream Deck verbinden (WebHID, Chrome/Edge)';
  btn.style.opacity = _dev ? '1' : '0.5';
  btn.style.color   = _dev ? 'var(--accent)' : '';
}

SD.toggleConnect = async function() {
  if (_dev) await SD.disconnect();
  else      await SD.connect();
};

// ── Periodic refresh for counters & dynamic state ─────────────────────────────
setInterval(_schedule, 1500);

})(); // IIFE end
