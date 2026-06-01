/**
 * OGraf Hinweiskette (Info Chain / Bug Chain)
 * Zeigt Hinweise SEQUENZIELL (einen nach dem anderen) oben mittig an.
 * Parameter: NeueFolge, NeueSerie, Untertitel, Zweikanalton, DD (je 0 oder 1)
 */

const DEFAULT_STATE = {
  NeueFolge: 0,
  NeueSerie: 0,
  Untertitel: 0,
  Zweikanalton: 0,
  DD: 0,
  durationPerHint: 3000,        // Millisekunden pro Hinweis
  textColor: "rgba(255, 255, 255, 0.80)",
  ratio: "16:9"
};

const STYLE_TEXT = `
:host {
  position: absolute;
  inset: 0;
  display: block;
  pointer-events: none;
  font-family: "Inter", "Segoe UI", Arial, sans-serif;
  overflow: hidden;
}

.hinweiskette {
  position: absolute;
  top: 48px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1000;
}

.hinweis {
  background: rgba(0, 0, 0, 1);     /* deutlich transparenter */
  color: var(--text-color);
  padding: 10px 26px;
  border-radius: 6px;
  font-size: 23px;
  font-weight: 600;
  white-space: nowrap;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6);
  opacity: 0;
  transform: translateY(-25px);
  transition: all 0.4s cubic-bezier(0.23, 1, 0.32, 1);
  text-shadow: 0 2px 6px rgba(0,0,0,0.7);
}

.hinweis.show {
  opacity: 1;
  transform: translateY(0);
}
`;

class Hinweiskette extends HTMLElement {
  constructor() {
    super();
    this._state = { ...DEFAULT_STATE };
    this._timeoutIds = [];
    this._isPlaying = false;

    const root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE_TEXT;
    root.appendChild(style);

    this.container = document.createElement("div");
    this.container.className = "hinweiskette";
    root.appendChild(this.container);
  }

  async load(params) {
    if (params.renderType !== "realtime") {
      return { statusCode: 400, statusMessage: "Only realtime supported" };
    }

    this._state = { ...DEFAULT_STATE, ...(params.data || {}) };
    this.style.setProperty('--text-color', this._state.textColor);
    return { statusCode: 200 };
  }

  async dispose() {
    this._stopAll();
    this.shadowRoot.innerHTML = "";
    return { statusCode: 200 };
  }

  async playAction(params) {
    this._stopAll();
    await this._startChain();
    return { statusCode: 200 };
  }

  async stopAction(params) {
    this._stopAll();
    return { statusCode: 200 };
  }

  async updateAction(params) {
    this._state = { ...this._state, ...(params?.data || {}) };
    this.style.setProperty('--text-color', this._state.textColor);
    return { statusCode: 200 };
  }

  _stopAll() {
    this._timeoutIds.forEach(id => clearTimeout(id));
    this._timeoutIds = [];
    this.container.innerHTML = "";
    this._isPlaying = false;
  }

  async _startChain() {
    if (this._isPlaying) return;
    this._isPlaying = true;

    const hints = [];

    if (this._state.NeueFolge)   hints.push("Neue Folge");
    if (this._state.NeueSerie)   hints.push("Neue Serie");
    if (this._state.Untertitel)  hints.push("Untertitel");
    if (this._state.Zweikanalton) hints.push("Zweikanalton");
    if (this._state.DD)          hints.push("Dolby Digital");

    if (hints.length === 0) {
      this._isPlaying = false;
      return;
    }

    const duration = Math.max(800, this._state.durationPerHint);

    for (let text of hints) {
      // Alten Hinweis entfernen, bevor neuer kommt
      this.container.innerHTML = "";

      const el = document.createElement("div");
      el.className = "hinweis";
      el.textContent = text;
      this.container.appendChild(el);

      // Einblenden
      requestAnimationFrame(() => {
        el.classList.add("show");
      });

      // Warten für die Dauer des Hinweises
      await new Promise(resolve => {
        const timeout = setTimeout(resolve, duration);
        this._timeoutIds.push(timeout);
      });

      // Ausblenden vor dem nächsten Hinweis
      el.classList.remove("show");

      // Kurze Pause für den Übergang
      await new Promise(resolve => setTimeout(resolve, 400));
    }

    // Abschließendes Aufräumen
    setTimeout(() => {
      if (this._isPlaying) this.container.innerHTML = "";
      this._isPlaying = false;
    }, 500);
  }
}

export default Hinweiskette;