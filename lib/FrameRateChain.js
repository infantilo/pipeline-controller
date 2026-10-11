'use strict';
/**
 * FrameRateChain.js — frame-rate conversion stage, shared by lib/PlayerPipeline.js
 * (players) and lib/MasterPipeline.js (live inputs).
 *
 * Default is videorate, GStreamer's frame-rate converter (drops/duplicates
 * frames). With frameRateConversion 'blend', the optional avvideofilter plugin
 * (libavfilter framerate, blends frames) is used if server.js found it at
 * startup: https://github.com/emcodem/avvideofilter
 */

let avvideofilterAvailable = false;

function setAvVideoFilterAvailable(available) { avvideofilterAvailable = !!available; }
function isAvVideoFilterAvailable() { return avvideofilterAvailable; }

/**
 * Pipeline fragment converting to `fps` (without a leading "!").
 * live = { width, height } for live pipelines: avvideofilter then also gets
 * the size pinned in front, a leaky queue and latency-input-frames=1, which
 * it needs there (see the plugin's README, Usage).
 */
function frameRateChainStr(mode, fps, live = null) {
  if (mode !== 'blend' || !avvideofilterAvailable) return 'videorate';
  const filter = `avvideofilter filter-desc="framerate=fps=${fps}"`;
  if (!live) return filter;
  const { width, height } = live;
  if (!width || !height || !fps) {
    throw new Error(`FrameRateChain: width/height/fps missing (${width}x${height}@${fps})`);
  }
  return `video/x-raw,width=${width},height=${height} ! queue leaky=downstream max-size-buffers=3` +
         ` ! ${filter} latency-input-frames=1`;
}

module.exports = { setAvVideoFilterAvailable, isAvVideoFilterAvailable, frameRateChainStr };
