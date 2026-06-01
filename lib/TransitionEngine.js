'use strict';

const DEFAULT_SPEEDS = { fast: 500, medium: 1000, slow: 2000 };

class TransitionEngine {
  constructor(master, speeds) {
    this.master  = master;
    this._speeds = Object.assign({}, DEFAULT_SPEEDS, speeds);
    this._log    = null;
  }

  setSpeeds(speeds) { Object.assign(this._speeds, speeds); }
  log(m, l = 'info') { if (this._log) this._log(m, l); }
  durationMs(speed)  { return this._speeds[speed] ?? this._speeds.fast; }

  async transition(targetPad, type = 'cut', speed = 'fast') {
    const ms = this.durationMs(speed);
    switch (type) {
      case 'v-fade':
        this.log(`v-fade [${speed}] → pad${targetPad}`);
        await this.master.vFadeTo(targetPad, ms);
        break;
      case 'fade-cut':
        this.log(`fade-cut [${speed}] → pad${targetPad}`);
        await this.master.fadeCutTo(targetPad, ms);
        break;
      case 'cut-fade':
        this.log(`cut-fade [${speed}] → pad${targetPad}`);
        await this.master.cutFadeTo(targetPad, ms);
        break;
      case 'xfade':
        this.log(`xfade [${speed}] → pad${targetPad}`);
        await this.master.xFadeTo(targetPad, ms);
        break;
      case 'cut':
      default:
        this.master.switchTo(targetPad);
        this.log(`cut → pad${targetPad}`, 'debug');
    }
  }
}

module.exports = TransitionEngine;
