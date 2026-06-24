'use strict';
/**
 * MxlSource.js
 *
 * EBU/AMWA DMF — Media eXchange Layer (https://github.com/dmf-mxl/mxl).
 * Liest verfügbare Flows aus einer MXL-Domain (Shared-Memory-Verzeichnis, z.B.
 * /dev/shm/mxl) per `mxl-info -d <domain> -l` aus — für die Live-Quellen-Auswahl
 * in der UI ("alle verfügbaren Feeds anzeigen").
 *
 * Routing/Selektion selbst läuft über das gst-mxl-rs Plugin (mxlsrc-Element,
 * Properties video-flow-id/audio-flow-id/domain) — siehe MasterPipeline._buildUriSrc
 * und server.js _buildUriLiveSrc (URI-Schema "mxl://<domain>?video=<uuid>&audio=<uuid>",
 * eigene Konvention dieses Projekts, NICHT die offizielle MXL-URI-Spec).
 */

const { execFile } = require('child_process');

const MXL_INFO_BIN = process.env.MXL_INFO_BIN || 'mxl-info';

// `mxl-info -d <domain> -l` Ausgabe-Format:
//   CAM1: mxl:///dev/shm/mxl/?id=...&id=...
//           video : 5fbec3b1-... - Camera 1
//           audio : b3bb5be7-... - Camera 1
const HEADER_RE = /^(\S+):\s*mxl:\/\//;
const FLOW_RE   = /^\s*(video|audio|data)\s*:\s*([0-9a-fA-F-]{36})\s*-\s*(.*)$/;

function parseFlowList(stdout) {
  const groups = [];
  let cur = null;
  for (const line of stdout.split('\n')) {
    const h = HEADER_RE.exec(line);
    if (h) { cur = { group: h[1], video: null, audio: null, data: null }; groups.push(cur); continue; }
    const f = FLOW_RE.exec(line);
    if (f && cur) cur[f[1]] = { id: f[2], label: f[3].trim() };
  }
  return groups;
}

/**
 * Listet alle Flow-Gruppen (typischerweise eine Kamera/Quelle = 1 Gruppe mit
 * video+audio Flow) in der angegebenen MXL-Domain.
 * @param {string} domain — Filesystem-Pfad zum MXL-Domain-Verzeichnis
 * @returns {Promise<Array<{group:string, video:{id,label}|null, audio:{id,label}|null, data:{id,label}|null}>>}
 */
function listFlows(domain) {
  return new Promise((resolve, reject) => {
    if (!domain) return reject(new Error('domain fehlt'));
    execFile(MXL_INFO_BIN, ['-d', domain, '-l'], { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.trim() || err.message));
      resolve(parseFlowList(stdout));
    });
  });
}

module.exports = { listFlows, parseFlowList };
