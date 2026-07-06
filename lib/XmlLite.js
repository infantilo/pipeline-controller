'use strict';
/**
 * XmlLite.js — minimaler, vendored XML-Parser (kein npm-Paket).
 *
 * Ausreichend für Marina .mpl Dateien (bis 7.5MB, 2000+ Events): Elemente,
 * Attribute (single/double quotes), Text, Selbstschließer. XML-Deklaration,
 * Kommentare, DOCTYPE und CDATA werden übersprungen bzw. korrekt behandelt.
 * Entities &amp; &lt; &gt; &quot; &apos; &#NN; &#xHH; werden dekodiert.
 *
 * Ein einziger Durchlauf, index-basiert (kein Tokenizing per Regex-Zeichen) —
 * String.indexOf() ist V8-nativ und linear, daher deutlich unter 1s für 7.5MB.
 *
 * Bei nicht wohlgeformtem XML (z.B. abgeschnittene Datei) wird ein Error
 * geworfen statt still falsche Daten zu liefern.
 *
 * API:
 *   parse(xmlString) → { tag, attrs, children:[...], text } (Root-Element)
 *   attrOf(node, name, def)         — Attributwert oder Default
 *   child(node, tag)                — erstes direktes Kind-Element mit Tag
 *   childAttr(node, tag, aName, aVal) — erstes direktes Kind mit Tag UND Attribut=Wert
 *   children(node, tag)             — alle direkten Kind-Elemente mit Tag
 *   deep(node, tag)                 — alle Nachfahren (beliebige Tiefe) mit Tag
 *   deepFirst(node, tag)            — erster Nachfahre mit Tag oder null
 *   text(node)                      — node.text oder ''
 */

const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g;
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(str) {
  if (str.indexOf('&') === -1) return str;
  return str.replace(ENTITY_RE, (m, ent) => {
    if (ent[0] === '#') {
      const code = (ent[1] === 'x' || ent[1] === 'X')
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, ent) ? NAMED_ENTITIES[ent] : m;
  });
}

function isWs(c) { return c === 32 || c === 9 || c === 10 || c === 13; }
function isNameChar(c) {
  // Buchstaben, Ziffern, _ - . : (ausreichend für Marina-Tag/Attributnamen)
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) ||
         c === 95 || c === 45 || c === 46 || c === 58;
}

function parse(xmlString) {
  const s   = String(xmlString);
  const len = s.length;
  let i = 0;

  function fail(msg) {
    throw new Error(`XmlLite: ${msg} (Position ${i}/${len})`);
  }

  function skipWs() { while (i < len && isWs(s.charCodeAt(i))) i++; }

  // Überspringt Prolog/Kommentare/DOCTYPE zwischen Tags (Top-Level).
  function skipMisc() {
    for (;;) {
      skipWs();
      if (i >= len || s.charCodeAt(i) !== 60 /* < */) return;
      if (s.startsWith('<?', i)) {
        const end = s.indexOf('?>', i + 2);
        if (end === -1) fail('unterminierte Verarbeitungsanweisung (<? ... ?>)');
        i = end + 2; continue;
      }
      if (s.startsWith('<!--', i)) {
        const end = s.indexOf('-->', i + 4);
        if (end === -1) fail('unterminierter Kommentar (<!-- ... -->)');
        i = end + 3; continue;
      }
      if (s.startsWith('<!', i)) {
        // DOCTYPE o.ä. — naiv bis zum passenden '>' überspringen
        const end = s.indexOf('>', i + 2);
        if (end === -1) fail('unterminierte Deklaration (<! ... >)');
        i = end + 1; continue;
      }
      return; // echtes Element
    }
  }

  function readName() {
    const start = i;
    while (i < len && isNameChar(s.charCodeAt(i))) i++;
    if (i === start) fail('Element-/Attributname erwartet');
    return s.slice(start, i);
  }

  function parseAttrs() {
    const attrs = {};
    for (;;) {
      skipWs();
      if (i >= len) fail('unerwartetes Dateiende in Start-Tag (Datei unvollständig?)');
      const c = s.charCodeAt(i);
      if (c === 47 /* / */ || c === 62 /* > */) return attrs;
      const name = readName();
      skipWs();
      if (s.charCodeAt(i) !== 61 /* = */) fail(`"=" erwartet nach Attribut "${name}"`);
      i++; skipWs();
      const q = s.charCodeAt(i);
      if (q !== 34 && q !== 39) fail(`Anführungszeichen erwartet für Attribut "${name}"`);
      i++;
      const qc = String.fromCharCode(q);
      const end = s.indexOf(qc, i);
      if (end === -1) fail(`unterminierter Attributwert "${name}" (Datei unvollständig?)`);
      attrs[name] = decodeEntities(s.slice(i, end));
      i = end + 1;
    }
  }

  function parseElement() {
    // i zeigt auf '<'
    i++;
    const tag = readName();
    const attrs = parseAttrs();
    if (s.charCodeAt(i) === 47 /* / */) {
      if (s.charCodeAt(i + 1) !== 62 /* > */) fail(`"/>" erwartet für <${tag}>`);
      i += 2;
      return { tag, attrs, children: [], text: '' };
    }
    if (s.charCodeAt(i) !== 62 /* > */) fail(`">" erwartet für <${tag}>`);
    i++;

    const children  = [];
    const textParts = [];

    for (;;) {
      const ltIdx = s.indexOf('<', i);
      if (ltIdx === -1) fail(`Tag <${tag}> nicht geschlossen — Datei unvollständig/abgeschnitten?`);
      if (ltIdx > i) textParts.push(decodeEntities(s.slice(i, ltIdx)));
      i = ltIdx;

      if (s.startsWith('<!--', i)) {
        const end = s.indexOf('-->', i + 4);
        if (end === -1) fail('unterminierter Kommentar (<!-- ... -->)');
        i = end + 3; continue;
      }
      if (s.startsWith('<![CDATA[', i)) {
        const end = s.indexOf(']]>', i + 9);
        if (end === -1) fail('unterminiertes CDATA (Datei unvollständig?)');
        textParts.push(s.slice(i + 9, end));
        i = end + 3; continue;
      }
      if (s.charCodeAt(i + 1) === 47 /* / */) {
        i += 2;
        const closeName = readName();
        skipWs();
        if (s.charCodeAt(i) !== 62) fail(`">" erwartet in End-Tag </${closeName}>`);
        i++;
        if (closeName !== tag) fail(`Tag-Mismatch: <${tag}> geschlossen mit </${closeName}>`);
        return { tag, attrs, children, text: textParts.join('') };
      }
      if (s.charCodeAt(i + 1) === 63 /* ? */) {
        const end = s.indexOf('?>', i + 2);
        if (end === -1) fail('unterminierte Verarbeitungsanweisung (<? ... ?>)');
        i = end + 2; continue;
      }
      children.push(parseElement());
    }
  }

  skipMisc();
  if (i >= len || s.charCodeAt(i) !== 60) fail('kein Root-Element gefunden (leere/ungültige Datei)');
  const root = parseElement();
  skipMisc();
  return root;
}

// ── Query-Hilfsfunktionen (leichtgewichtiger Ersatz für ElementTree-API) ──────

function attrOf(node, name, def = '') {
  if (!node) return def;
  const v = node.attrs[name];
  return v !== undefined ? v : def;
}

function child(node, tag) {
  if (!node) return null;
  for (const c of node.children) if (c.tag === tag) return c;
  return null;
}

function childAttr(node, tag, aName, aVal) {
  if (!node) return null;
  for (const c of node.children) {
    if (c.tag === tag && c.attrs[aName] === aVal) return c;
  }
  return null;
}

function children(node, tag) {
  if (!node) return [];
  return node.children.filter(c => c.tag === tag);
}

function deep(node, tag, out = []) {
  if (!node) return out;
  for (const c of node.children) {
    if (c.tag === tag) out.push(c);
    deep(c, tag, out);
  }
  return out;
}

function deepFirst(node, tag) {
  if (!node) return null;
  for (const c of node.children) {
    if (c.tag === tag) return c;
    const found = deepFirst(c, tag);
    if (found) return found;
  }
  return null;
}

function text(node) { return node ? node.text : ''; }

module.exports = {
  parse, decodeEntities,
  attrOf, child, childAttr, children, deep, deepFirst, text,
};
