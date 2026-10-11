'use strict';
// Frame-rate conversion ('videorate' | 'blend' via avvideofilter), lib/FrameRateChain.js.
// Run: npm test   (GStreamer tests are skipped when avvideofilter is not installed;
// set GST_PLUGIN_PATH like env/avvideofilter.env to include it.)
const test   = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('child_process');

const FrameRateChain = require('../lib/FrameRateChain');
const { frameRateChainStr } = FrameRateChain;
const MasterPipeline = require('../lib/MasterPipeline');
const PlayerPipeline = require('../lib/PlayerPipeline');

function hasPlugin() {
  try { execFileSync('gst-inspect-1.0', ['avvideofilter'], { stdio: 'ignore', timeout: 5000 }); return true; }
  catch { return false; }
}
const PLUGIN = hasPlugin();

// Runs a gst-launch description to EOS; returns { ok, out }.
function gstRun(desc) {
  const r = spawnSync('gst-launch-1.0', ['-q', ...desc.split(/\s+/)], { encoding: 'utf8', timeout: 30000 });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

function withPlugin(available, fn) {
  const prev = FrameRateChain.isAvVideoFilterAvailable();
  FrameRateChain.setAvVideoFilterAvailable(available);
  try { return fn(); } finally { FrameRateChain.setAvVideoFilterAvailable(prev); }
}

test('videorate unless blend is asked for and the plugin is available', () => {
  withPlugin(true, () => {
    assert.strictEqual(frameRateChainStr('videorate', 25), 'videorate');
    assert.strictEqual(frameRateChainStr(undefined, 25, { width: 1920, height: 1080 }), 'videorate');
  });
  withPlugin(false, () => {
    assert.strictEqual(frameRateChainStr('blend', 25), 'videorate');
    assert.strictEqual(frameRateChainStr('blend', 25, { width: 1920, height: 1080 }), 'videorate');
  });
});

test('blend for players: avvideofilter only', () => {
  withPlugin(true, () => {
    assert.strictEqual(frameRateChainStr('blend', 25), 'avvideofilter filter-desc="framerate=fps=25"');
  });
});

test('blend for live inputs: size pinned, leaky queue, one input frame of latency', () => {
  const el = withPlugin(true, () => frameRateChainStr('blend', 50, { width: 1280, height: 720 }));
  assert.match(el, /^video\/x-raw,width=1280,height=720 ! queue leaky=downstream/);
  assert.match(el, /avvideofilter filter-desc="framerate=fps=50" latency-input-frames=1$/);
});

test('blend for live inputs throws when the channel format is missing', () => {
  withPlugin(true, () => {
    assert.throws(() => frameRateChainStr('blend', 25, {}), /width\/height\/fps missing/);
    assert.throws(() => frameRateChainStr('blend', undefined, { width: 1920, height: 1080 }), /width\/height\/fps missing/);
  });
});

test('player: rate stage after "!", warns when blend falls back', () => {
  const p = new PlayerPipeline('player1', { frameRateConversion: 'blend' });
  const warnings = [];
  p._log = (msg, level) => { if (level === 'warn') warnings.push(msg); };
  assert.strictEqual(withPlugin(true, () => p._buildFrameRateChain(25)), '! avvideofilter filter-desc="framerate=fps=25"');
  assert.strictEqual(warnings.length, 0);
  assert.strictEqual(withPlugin(false, () => p._buildFrameRateChain(25)), '! videorate');
  assert.strictEqual(warnings.length, 1);
});

test('master: live rate stage from the channel format', () => {
  const m = new MasterPipeline({ width: 1280, height: 720, fps: 50, frameRateConversion: 'blend' });
  withPlugin(true, () => assert.strictEqual(m._buildLiveFrameRateChain(),
    frameRateChainStr('blend', 50, { width: 1280, height: 720 })));
});

// The master's live chain: source -> scaleToFit -> rate stage -> channel caps.
// A source whose size differs from the channel failed with not-negotiated
// before the size was pinned in front of avvideofilter.
for (const [w, h, fps] of [[1280, 720, 30], [1920, 1080, 25], [720, 576, 50]]) {
  test(`live chain (blend): ${w}x${h}@${fps} into 1920x1080@25`, { skip: !PLUGIN && 'avvideofilter not installed' }, () => {
    const m = new MasterPipeline({ width: 1920, height: 1080, fps: 25, frameRateConversion: 'blend' });
    const rate = withPlugin(true, () => m._buildLiveFrameRateChain());
    const { ok, out } = gstRun(
      `videotestsrc num-buffers=${fps * 2} ! video/x-raw,width=${w},height=${h},framerate=${fps}/1 ` +
      `! videoconvert ! ${m._scaleToFit()} ! ${rate} ! video/x-raw,width=1920,height=1080,framerate=25/1 ! fakesink`);
    assert.ok(ok, out);
  });
}
