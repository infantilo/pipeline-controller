/**
 * DVE Lower Third — Lower-Third-Bar mit ausgewiesener DVE-Zone.
 *
 * Markiert ein Element mit data-dve-zone="box" — kein oGraf-Standard, sondern
 * eine projektinterne Konvention (siehe GrafixEngine._resolveDveZone()):
 * GrafixEngine liest getBoundingClientRect() dieses Elements und positioniert
 * darauf ein gleichzeitig geplantes Bild/Squeeze-Child (child.dve.zone="box").
 * Die Zone selbst bleibt transparent — die eigentlichen Pixel liefert das
 * verlinkte Child, das als eigener DOM-Layer darüber liegt.
 */

const DEFAULT_STATE = {
  name: "Studio Gast",
  title: "",
  accentColor: "#ff8c00",
  boxSide: "left",
};

const STYLE_TEXT = `
:host {
  position: absolute;
  inset: 0;
  display: block;
  pointer-events: none;
  font-family: "Roboto", "Arial", sans-serif;
  --accent: #ff8c00;
}
* { box-sizing: border-box; }

.bar {
  position: absolute;
  left: 80px; bottom: 80px;
  min-width: 560px;
  height: 120px;
  background: rgba(10, 12, 16, 0.82);
  border-left: 6px solid var(--accent);
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 0 32px;
  opacity: 0;
  transform: translateY(20px);
  transition: opacity .35s ease, transform .35s ease;
}
.bar.in { opacity: 1; transform: translateY(0); }

.name  { font-size: 34px; font-weight: 700; color: #fff; line-height: 1.15; }
.title { font-size: 20px; font-weight: 400; color: var(--accent); margin-top: 4px; }

/* DVE-Zone: 4:3-Box direkt über der Bar — reserviert für ein verlinktes Squeeze-Child. */
.dve-zone {
  position: absolute;
  bottom: 210px;
  width: 320px;
  height: 240px;
  border: 2px dashed rgba(255,255,255,0.0); /* unsichtbar im Sendebild, nur Layout-Anker */
  background: transparent;
  opacity: 0;
  transform: translateY(20px);
  transition: opacity .35s ease, transform .35s ease;
}
.dve-zone.in { opacity: 1; transform: translateY(0); }
.dve-zone.left  { left: 80px; }
.dve-zone.right { right: 80px; }
`;

class DveLowerThird extends HTMLElement {
  constructor() {
    super();
    this._state = { ...DEFAULT_STATE };
    const root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE_TEXT;

    const bar = document.createElement("div");
    bar.className = "bar";
    const name = document.createElement("div");
    name.className = "name";
    const title = document.createElement("div");
    title.className = "title";
    bar.append(name, title);

    const zone = document.createElement("div");
    zone.className = "dve-zone";
    zone.setAttribute("data-dve-zone", "box");

    root.append(style, bar, zone);
    this._el = { bar, name, title, zone };
  }

  async load(params) {
    this._state = { ...DEFAULT_STATE, ...(params?.data || {}) };
    this._applyState();
    return { statusCode: 200 };
  }

  async dispose() {
    this.shadowRoot.innerHTML = "";
    return { statusCode: 200 };
  }

  async playAction() {
    this._el.bar.classList.add("in");
    this._el.zone.classList.add("in");
    return { statusCode: 200, currentStep: 0 };
  }

  async stopAction() {
    this._el.bar.classList.remove("in");
    this._el.zone.classList.remove("in");
    return { statusCode: 200 };
  }

  async updateAction(params) {
    this._state = { ...this._state, ...(params?.data || {}) };
    this._applyState();
    return { statusCode: 200 };
  }

  async customAction() {
    return { statusCode: 200 };
  }

  _applyState() {
    const { name, title, accentColor, boxSide } = this._state;
    this._el.name.textContent = name;
    this._el.title.textContent = title;
    this._el.title.style.display = title ? "" : "none";
    if (accentColor) this.style.setProperty("--accent", accentColor);
    this._el.zone.classList.toggle("left", boxSide !== "right");
    this._el.zone.classList.toggle("right", boxSide === "right");
  }
}

export default DveLowerThird;
