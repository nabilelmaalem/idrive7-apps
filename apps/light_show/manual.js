'use strict';
/**
 * manual.js - Manual control: lamps and groups switched on and off by hand, held until switched off (or until the
 * thermal guard, the time limit, Stop, or leaving the screen ends them).
 *
 * Why a loop and not one request a lamp: most ways the car lets the app switch a lamp are timed. A headlight
 * module's light function runs for whole seconds (1-2 s), a body controller lamp function for a time, a timed
 * output goes back by itself. "Held" means sending them again before they run out. Outputs that stay put (no time
 * byte) are sent once. Turn signals blink here (on / off at BLINK_HZ) as they would on the car.
 *
 *   const m = new Manual(link, { usable, viaFn, thermal, onFrame, log });
 *   m.toggle('high');  m.set('hazard', true);  await m.start();  ...  await m.stop();
 *
 * Nothing here talks to the car but through LampLink (lamps.js check() vets every request) and so through the rate
 * limiter (safety.js).
 */
const { BY_ID, FN } = require('./lamps');
const { GROUPS, GROUP_NOTES } = require('./sequences');

const TICK_MS = 100;           // the loop
const REFRESH_MS = 800;        // timed lamps sent again this often (a headlight function runs 1 s, a timed output ~1 s)
const BLINK_HZ = 1.5;          // turn signals' blink (the car's own is ~1.5 Hz)

/** The tiles on the Manual page, in order (4 columns). ids: the lamps; blink: switched at BLINK_HZ;
 *  off: why it can't be switched (shown greyed with the reason). */
const CONTROLS = [
    { key: 'low', label: 'Low beams', ids: GROUPS.low },
    { key: 'high', label: 'High beams', ids: GROUPS.high },
    { key: 'drl', label: 'Daytime lights', ids: GROUPS.drl },
    { key: 'fog', label: 'Fog lights', ids: GROUPS.fog },
    { key: 'turnL', label: 'Turn left', ids: GROUPS.turnL, blink: true },
    { key: 'turnR', label: 'Turn right', ids: GROUPS.turnR, blink: true },
    { key: 'hazard', label: 'Hazards', ids: GROUPS.hazard, blink: true },
    { key: 'rearFog', label: 'Rear fogs', ids: GROUPS.rearFog },
    { key: 'reverse', label: 'Reversing', ids: GROUPS.reverse },
    { key: 'tail', label: 'Tail lights', ids: [], off: GROUP_NOTES.tail },
    { key: 'plate', label: 'Plate light', ids: [], off: GROUP_NOTES.plate },
    { key: 'puddle', label: 'Puddle / welcome', ids: [], off: GROUP_NOTES.puddle },
];
const CONTROL = {};
CONTROLS.forEach((c) => { CONTROL[c.key] = c; });

class Manual {
    /**
     * opts: { usable(id) -> bool, viaFn(id) -> bool (lit by its side's lamp function, dark again by itself),
     *         thermal (safety.js ThermalGuard), onFrame(lit Set), onForcedOff([{ id, why }]), log, now, wait }
     */
    constructor(link, opts) {
        this.link = link;
        this.opts = opts || {};
        this.now = this.opts.now || Date.now;
        this.wait = this.opts.wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.on = new Set();           // control keys switched on
        this.lit = new Set();          // lamp ids lit now (as far as the app knows)
        this.sentAt = {};              // id -> when last sent on
        this.blocked = {};             // id -> why it can't light now (thermal, refused)
        this.running = false;
        this.loop = null;
    }
    /** switched on? */
    isOn(key) { return this.on.has(key); }
    /** usable lamps of a control (the lamp check's verdicts) */
    lampsOf(key) { const c = CONTROL[key]; return c ? c.ids.filter((id) => !this.opts.usable || this.opts.usable(id)) : []; }
    /** why a control can't be used at all ('' if it can) */
    why(key) {
        const c = CONTROL[key];
        if (!c) return 'unknown';
        if (c.off) return c.off;
        if (!this.lampsOf(key).length) return 'none of its lamps passed the lamp check';
        return '';
    }
    set(key, on) {
        if (on && this.why(key)) return false;
        if (on) this.on.add(key); else this.on.delete(key);
        // hazards and a turn signal together: the hazards win (as on the car)
        if (on && key === 'hazard') { this.on.delete('turnL'); this.on.delete('turnR'); }
        if (on && (key === 'turnL' || key === 'turnR')) { this.on.delete('hazard'); this.on.delete(key === 'turnL' ? 'turnR' : 'turnL'); }
        return true;
    }
    toggle(key) { return this.set(key, !this.on.has(key)); }
    allOff() { this.on.clear(); }

    /** the lamps that should be lit at time t */
    desired(t) {
        const want = new Set();
        const phase = (t % (1000 / BLINK_HZ)) < (500 / BLINK_HZ);
        this.on.forEach((k) => {
            const c = CONTROL[k];
            if (c.blink && !phase) return;
            this.lampsOf(k).forEach((id) => want.add(id));
        });
        return want;
    }

    async start() {
        if (this.running) return false;
        this.running = true;
        await this.link.start();
        this.loop = this._run().catch((e) => { if (this.opts.log) this.opts.log.warn('manual: ' + (e && e.message || e)); });
        return true;
    }
    async stop() {
        if (!this.running) return;
        this.running = false;
        await this.loop;
        this.lit.clear();
        if (this.opts.onFrame) this.opts.onFrame(this.lit);
        if (this.opts.thermal) this.opts.thermal.update(this.lit);
        await this.link.stop();
    }
    async _run() {
        while (this.running) {
            const t0 = this.now();
            await this.step(t0);
            const left = TICK_MS - (this.now() - t0);
            if (left > 0) await this.wait(left);
        }
    }
    /** one pass: lamps going dark first, then the ones coming on or due again */
    async step(t) {
        const th = this.opts.thermal;
        let want = this.desired(t);
        // thermal: over a limit now -> dark and cooling; not allowed -> not lit
        if (th) {
            const over = th.over();
            if (over.length && this.opts.onForcedOff) this.opts.onForcedOff(over);
            over.forEach((x) => { this.blocked[x.id] = x.why; });
            want = new Set(Array.from(want).filter((id) => { const a = th.allow(id); if (!a.ok) this.blocked[id] = a.why; else delete this.blocked[id]; return a.ok; }));
        }
        for (const id of Array.from(this.lit)) {
            if (!this.running) return;
            if (want.has(id)) continue;
            // a lamp lit by its lamp function goes dark by itself; everything else is switched off (held dark: it
            // goes back to the car at Stop, when the session ends)
            if (!this.opts.viaFn || !this.opts.viaFn(id)) await this.link.set(id, false, 'off', TICK_MS);
            this.lit.delete(id);
        }
        const fnSent = new Set();
        for (const id of want) {
            if (!this.running) return;
            const timed = this._timed(id);
            const due = !this.lit.has(id) || (timed && t - (this.sentAt[id] || 0) >= REFRESH_MS);
            if (!due) continue;
            let r;
            if (this.opts.viaFn && this.opts.viaFn(id)) {
                // a side's lamp function lights the whole side: once a pass for each function
                if (fnSent.has(FN[id])) { this.lit.add(id); this.sentAt[id] = t; continue; }
                fnSent.add(FN[id]);
                r = await this.link.fn(id, this._fnMs(id));
            } else r = await this.link.set(id, true, null, REFRESH_MS + 200);
            if (r && r.ok) { this.lit.add(id); this.sentAt[id] = t; delete this.blocked[id]; }
            else if (r) this.blocked[id] = r.why || (r.nrc !== null && r.nrc !== undefined ? 'refused' : 'no answer');
        }
        if (th) th.update(this.lit);
        if (this.opts.onFrame) this.opts.onFrame(new Set(this.lit));
    }
    /** a lamp whose "on" runs out by itself (sent again every REFRESH_MS while held) */
    _timed(id) {
        if (this.opts.viaFn && this.opts.viaFn(id)) return true;
        return (this.link.how && this.link.how[id] === 'flm') || !!this.link.timer;
    }
    /** a lamp function's time: a blinking signal its half period, a held one past the next refresh */
    _fnMs(id) {
        const blinking = Array.from(this.on).some((k) => CONTROL[k].blink && CONTROL[k].ids.indexOf(id) >= 0);
        return blinking ? Math.round(500 / BLINK_HZ) : REFRESH_MS + 200;
    }
}

module.exports = { Manual, CONTROLS, CONTROL, TICK_MS, REFRESH_MS, BLINK_HZ, BY_ID };
