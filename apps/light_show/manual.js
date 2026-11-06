'use strict';
/**
 * manual.js - Manual control (0.7): pick targets, pick an effect, set its speed / brightness / count, run it.
 *
 *   targets   lamp groups (low, high, daytime, fog, turn L / R, hazards, rear fog, reversing) and the headlights'
 *             single LED channels (LED 1-9 left / right, "All L" / "All R": a whole headlight in one request)
 *   modes     solid   on, held (sent again before its time runs out)
 *             blink   on half the period, off half
 *             strobe  a short flash each period (a quarter of it, at least 60 ms)
 *             pulse   brightness up and down in steps (LED channels: PWM %); lamps without dimming blink instead
 *             flash   `count` flashes, then everything back to the car (BimmerLink's "Single flash" is count 1)
 *   params    hz (speed), brightness (LED channels, %), count (flash)
 *
 * The car can only take so many requests: ~300 ms each through the head unit, one at a time. An effect asking
 * for more (8 Hz on 10 targets) runs as fast as the link allows, evenly, instead of dropping requests at random -
 * effHz() says how fast that is, and the page shows it. Every request goes through LampLink (lamps.js check(),
 * the rate limiter); the thermal guard can keep a target dark.
 *
 *   const m = new Manual(link, { usable, viaFn, thermal, onFrame, onDone, log });
 *   m.toggle('high'); m.mode = 'blink'; m.hz = 2; await m.start(); ... await m.stop();
 */
const { BY_ID, FN } = require('./lamps');
const { GROUPS, GROUP_NOTES } = require('./sequences');

const TICK_MS = 40;            // the loop (state changes are only sent when due)
const REFRESH_MS = 800;        // held lamps / channels sent again this often (their on-times are 1-2 s)
const PULSE_STEPS = [0.25, 0.5, 0.75, 1, 0.75, 0.5];   // a pulse period's brightness steps (x brightness)
const MODES = [
    { key: 'solid', label: 'Solid' },
    { key: 'blink', label: 'Blink' },
    { key: 'strobe', label: 'Strobe' },
    { key: 'pulse', label: 'Pulse' },
    { key: 'flash', label: 'Single flash' },
];
const HZ_STEPS = [0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10];
const BRIGHT_STEPS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const COUNT_STEPS = [1, 2, 3, 4, 5, 10];

/** The targets, in the page's order. ids: the lamps / channels it drives. */
const led = (s, c) => ({ key: 'led' + s + c, label: c ? 'LED ' + c + ' ' + s : 'All ' + s, ids: ['led' + s + c], led: true, all: !c });
const TARGETS = [
    { key: 'low', label: 'Low beams', ids: GROUPS.low },
    { key: 'high', label: 'High beams', ids: GROUPS.high },
    { key: 'drl', label: 'Daytime', ids: GROUPS.drl },
    { key: 'fog', label: 'Fog', ids: GROUPS.fog },
    { key: 'turnL', label: 'Turn L', ids: GROUPS.turnL },
    { key: 'turnR', label: 'Turn R', ids: GROUPS.turnR },
    { key: 'hazard', label: 'Hazards', ids: GROUPS.hazard },
    { key: 'rearFog', label: 'Rear fog', ids: GROUPS.rearFog },
    { key: 'reverse', label: 'Reversing', ids: GROUPS.reverse },
].concat([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => led('L', c)), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => led('R', c)));
const TARGET = {};
TARGETS.forEach((t) => { TARGET[t.key] = t; });

class Manual {
    /**
     * opts: { usable(id) -> bool, viaFn(id) -> bool (lit by its side's lamp function, dark again by itself),
     *         thermal (safety.js ThermalGuard), onFrame(lit Set), onForcedOff([{ id, why }]), onDone(), log, now, wait }
     */
    constructor(link, opts) {
        this.link = link;
        this.opts = opts || {};
        this.now = this.opts.now || Date.now;
        this.wait = this.opts.wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.on = new Set();           // target keys selected
        this.mode = 'solid'; this.hz = 2; this.brightness = 100; this.count = 1;
        this.lit = new Set();          // ids lit now (as far as the app knows)
        this.level = {};               // id -> the % last sent (LED channels)
        this.sentAt = {};              // id -> when last sent on
        this.blocked = {};             // id -> why it can't light now (thermal, refused)
        this.running = false; this.done = false;
        this.t0 = 0; this.loop = null;
    }
    isOn(key) { return this.on.has(key); }
    /** the target's ids the lamp check didn't rule out */
    idsOf(key) { const t = TARGET[key]; return t ? t.ids.filter((id) => !this.opts.usable || this.opts.usable(id)) : []; }
    /** why a target can't be used ('' if it can) */
    why(key) {
        if (GROUP_NOTES[key]) return GROUP_NOTES[key];
        const t = TARGET[key];
        if (!t) return 'unknown';
        const r = this.opts.reason && this.opts.reason(key);       // (main.js: not while driving, ...)
        if (r) return r;
        if (!this.idsOf(key).length) return t.led ? 'this LED channel did not answer the LED scan' : 'none of its lamps passed the lamp check';
        return '';
    }
    set(key, on) {
        if (on && this.why(key)) return false;
        if (on) this.on.add(key); else this.on.delete(key);
        // hazards and a turn signal: one or the other (their lamps are the same)
        if (on && key === 'hazard') { this.on.delete('turnL'); this.on.delete('turnR'); }
        if (on && (key === 'turnL' || key === 'turnR')) this.on.delete('hazard');
        // a whole headlight and its single channels: one or the other
        const t = TARGET[key];
        if (on && t && t.led) {
            const side = key[3];
            TARGETS.filter((x) => x.led && x.key[3] === side && x.all !== t.all).forEach((x) => this.on.delete(x.key));
        }
        return true;
    }
    toggle(key) { return this.set(key, !this.on.has(key)); }
    allOff() { this.on.clear(); }
    setMode(m) { if (MODES.some((x) => x.key === m)) { this.mode = m; this.t0 = this.now(); this.done = false; } }

    /** every id the selected targets drive (each once) */
    ids() { const out = new Set(); this.on.forEach((k) => this.idsOf(k).forEach((id) => out.add(id))); return Array.from(out); }
    /** requests one switch of every target costs: a side's lamp function lights all of that side at once */
    _requestsPerSwitch() {
        const fns = new Set();
        let n = 0;
        this.ids().forEach((id) => {
            if (this.opts.viaFn && this.opts.viaFn(id)) { if (!fns.has(FN[id])) { fns.add(FN[id]); n++; } } else n++;
        });
        return n;
    }
    /** switches per period the mode makes (on and off, or the pulse's steps) */
    _switchesPerPeriod() { return this.mode === 'solid' ? 0 : this.mode === 'pulse' ? PULSE_STEPS.length : 2; }
    /** the period (ms) the effect really runs at: what was asked, or slower when the link can't keep up */
    periodMs() {
        const asked = 1000 / Math.max(0.1, this.hz);
        const st = this.link.stats || {};
        const reqMs = Math.max(20, st.ms || 300);
        const need = this._switchesPerPeriod() * this._requestsPerSwitch() * reqMs * 1.1;
        return Math.max(asked, need);
    }
    /** the speed the effect really runs at (Hz) */
    effHz() { return 1000 / this.periodMs(); }

    /** what each id should be at time t: { id: level 0-1 } (0: dark) */
    desired(t) {
        const P = this.periodMs(), dt = Math.max(0, t - this.t0), cyc = Math.floor(dt / P), ph = (dt % P) / P;
        let level;
        switch (this.mode) {
        case 'blink': level = ph < 0.5 ? 1 : 0; break;
        case 'strobe': level = ph < Math.max(0.25, 60 / P) ? 1 : 0; break;
        case 'pulse': level = PULSE_STEPS[Math.min(PULSE_STEPS.length - 1, Math.floor(ph * PULSE_STEPS.length))]; break;
        case 'flash': level = cyc < this.count && ph < 0.5 ? 1 : 0; if (cyc >= this.count) this.done = true; break;
        default: level = 1;
        }
        const out = {};
        this.ids().forEach((id) => {
            // lamps without dimming: a pulse is on for its brighter half
            const dim = BY_ID[id] && BY_ID[id].led;
            out[id] = dim ? level : (this.mode === 'pulse' ? (level >= 0.5 ? 1 : 0) : (level > 0 ? 1 : 0));
        });
        return out;
    }

    async start() {
        if (this.running) return false;
        this.running = true; this.done = false; this.t0 = this.now();
        await this.link.start();
        this.loop = this._run().catch((e) => { if (this.opts.log) this.opts.log.warn('manual: ' + (e && e.message || e)); });
        return true;
    }
    async stop() {
        if (!this.running) return;
        this.running = false;
        await this.loop;
        this.lit.clear(); this.level = {};
        if (this.opts.onFrame) this.opts.onFrame(this.lit);
        if (this.opts.thermal) this.opts.thermal.update(this.lit);
        await this.link.stop();
    }
    async _run() {
        while (this.running) {
            const t0 = this.now();
            await this.step(t0);
            if (this.done && this.running) { if (this.opts.onDone) this.opts.onDone(); break; }
            const left = TICK_MS - (this.now() - t0);
            if (left > 0) await this.wait(left);
        }
    }
    /** one pass: what changed since the last one is sent (dark first, then lit), held ones refreshed */
    async step(t) {
        const th = this.opts.thermal;
        const want = this.desired(t);
        if (th) {
            const over = th.over();
            if (over.length && this.opts.onForcedOff) this.opts.onForcedOff(over);
            over.forEach((x) => { this.blocked[x.id] = x.why; });
            Object.keys(want).forEach((id) => { if (want[id] > 0) { const a = th.allow(id); if (!a.ok) { this.blocked[id] = a.why; want[id] = 0; } } });
        }
        // dark: lit ones no longer wanted (or wanted at 0)
        for (const id of Array.from(this.lit)) {
            if (!this.running) return;
            if (want[id] > 0) continue;
            // an LED channel no longer usable (the driving guard): straight back to the car, not dark for a second
            const gone = BY_ID[id] && BY_ID[id].led && this.opts.usable && !this.opts.usable(id);
            if (!this.opts.viaFn || !this.opts.viaFn(id)) await this.link.set(id, false, gone ? 'release' : 'off', TICK_MS);
            this.lit.delete(id); delete this.level[id];
        }
        // lit: new, a new brightness, or due again
        const fnSent = new Set();
        const pct = (id) => Math.max(1, Math.round(this.brightness * want[id]));
        const holdMs = this.mode === 'solid' ? REFRESH_MS + 200 : Math.min(REFRESH_MS + 200, this.periodMs());
        for (const id of Object.keys(want)) {
            if (!this.running) return;
            if (!(want[id] > 0)) continue;
            const isLed = BY_ID[id] && BY_ID[id].led;
            const changed = !this.lit.has(id) || (isLed && this.level[id] !== pct(id));
            const due = this._timed(id) && t - (this.sentAt[id] || 0) >= REFRESH_MS;
            if (!changed && !due) continue;
            let r;
            if (this.opts.viaFn && this.opts.viaFn(id)) {
                // a side's lamp function lights the whole side: once a pass for each function
                if (fnSent.has(FN[id])) { this.lit.add(id); this.sentAt[id] = t; continue; }
                fnSent.add(FN[id]);
                r = await this.link.fn(id, this.mode === 'solid' ? REFRESH_MS + 200 : Math.round(this.periodMs() / 2));
            } else r = await this.link.set(id, true, null, holdMs, false, isLed ? pct(id) : undefined);
            if (r && r.ok) { this.lit.add(id); this.sentAt[id] = t; if (isLed) this.level[id] = pct(id); delete this.blocked[id]; }
            else if (r) this.blocked[id] = r.why || (r.nrc !== null && r.nrc !== undefined ? 'refused' : 'no answer');
        }
        if (th) th.update(this.lit);
        if (this.opts.onFrame) this.opts.onFrame(new Set(this.lit));
    }
    /** an id whose "on" runs out by itself (sent again every REFRESH_MS while held) */
    _timed(id) {
        const l = BY_ID[id];
        if (l && l.led) return true;
        if (this.opts.viaFn && this.opts.viaFn(id)) return true;
        return (this.link.how && this.link.how[id] === 'flm') || !!this.link.timer;
    }
}

module.exports = { Manual, TARGETS, TARGET, MODES, HZ_STEPS, BRIGHT_STEPS, COUNT_STEPS, TICK_MS, REFRESH_MS, PULSE_STEPS,
    // (0.6 names, kept for anything that still asks)
    CONTROLS: TARGETS, CONTROL: TARGET };
