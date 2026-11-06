'use strict';
/**
 * lamps.js - the car's exterior lamps, one by one, through BMW's own test functions, as the SGBDs for the G05's
 * body controller (BDC_G05, address 0x40) and its LED headlight modules (FLM02_L / FLM02_R, 0x43 / 0x44) describe
 * them:
 *
 *   body controller, LICHT_AUSGANG_DIGITAL_STEUERN: 0x2F (I/O control) on 0xE3B5, one lamp output at a time
 *   (TAB_LEUCHTEN_AUSGANG_DIGITAL_ARG: every lamp, each side its own). The SGBD names the arguments (output, on /
 *   off) but not the request's exact layout, and the G05 refused the two obvious ones (2F E3 B5 <output> 01: "out
 *   of range"; 2F E3 B5 03 <output> 01: "wrong length"), so the link tries the LAYOUTS below on one lamp and keeps
 *   the first the unit takes. Back to the car: 2F E3 B5 00 <output> (return control to the ECU), or 2F E3 B5 00.
 *
 *   headlight modules, FLM_FUNKTION_LICHTVERTEILUNG: 0x2E on 0xD6DC, a light function in THAT headlight for a
 *   time: 2E D6 DC <function, 2 bytes> <seconds> (TAB_LF_LV_FRONT_ARG). One module a side, so the front lamps
 *   can be split left / right this way when the body controller's outputs refuse. Off: the same with 0 seconds.
 *
 *   body controller, LEUCHTEN_FUNKTION: 0x2E on 0xD542, a lamp function for a time (both sides at once, except the
 *   turn signals): 2E D5 42 <function, 2 bytes> <time, 10 ms>. The lamp check's last try.
 *
 * Every unit used gets the extended session (10 03), kept with tester present (3E 00) every 2 s. If the app stops
 * talking the units drop back to their default session within a few seconds and every lamp is the car's own again.
 * Only these requests are ever built: check() refuses anything else before it reaches the transport.
 */
const BDC = 0x40, FLM_L = 0x43, FLM_R = 0x44;
const OUT_DID = [0xE3, 0xB5], FN_DID = [0xD5, 0x42], LV_DID = [0xD6, 0xDC];
const TP_MS = 2000;                       // tester present (the session ends after ~5 s without)

/** The lamps. out: body controller output; flm: { ecu, lv } its headlight module's light function; side: which
 *  side; usual: what the lamp normally is while driving at night ('on' / 'brake': the emergency patterns never take
 *  it over). */
// (high beam: Fernlicht Modus 1a - on a G05 Fernlichtblinken 0x45 was taken and nothing lit; 1a, 2a and 3a lit)
const HIGH = 0x0F, LOW = 0x05, DRL = 0x33, BLINK = 0x49;     // Fernlicht 1a, Abblendlicht LV5, Tagfahrlicht, Blinken
const LAMPS = [
    { id: 'lowL', out: 0x01, flm: { ecu: FLM_L, lv: LOW }, name: 'Low beam left', end: 'front', side: 'L', usual: 'on' },
    { id: 'lowR', out: 0x02, flm: { ecu: FLM_R, lv: LOW }, name: 'Low beam right', end: 'front', side: 'R', usual: 'on' },
    { id: 'highL', out: 0x07, flm: { ecu: FLM_L, lv: HIGH }, name: 'High beam left', end: 'front', side: 'L' },
    { id: 'highR', out: 0x08, flm: { ecu: FLM_R, lv: HIGH }, name: 'High beam right', end: 'front', side: 'R' },
    { id: 'drlL', out: 0x03, flm: { ecu: FLM_L, lv: DRL }, name: 'Daytime light left', end: 'front', side: 'L', usual: 'on' },
    { id: 'drlR', out: 0x04, flm: { ecu: FLM_R, lv: DRL }, name: 'Daytime light right', end: 'front', side: 'R', usual: 'on' },
    { id: 'fogL', out: 0x0B, name: 'Fog light left', end: 'front', side: 'L' },
    { id: 'fogR', out: 0x0C, name: 'Fog light right', end: 'front', side: 'R' },
    { id: 'indFL', out: 0x0D, flm: { ecu: FLM_L, lv: BLINK }, name: 'Turn signal front left', end: 'front', side: 'L' },
    { id: 'indFR', out: 0x0E, flm: { ecu: FLM_R, lv: BLINK }, name: 'Turn signal front right', end: 'front', side: 'R' },
    // (outDark: seen on a G05, the body controller takes the request and nothing lights - the mirrors' repeaters
    // aren't on its outputs: only the left / right turn signal function reaches them)
    { id: 'indSL', out: 0x10, outDark: true, name: 'Side repeater left', end: 'side', side: 'L' },
    { id: 'indSR', out: 0x11, outDark: true, name: 'Side repeater right', end: 'side', side: 'R' },
    // (the rear turn signals: on a G05 their outputs were taken and nothing lit, like the mirrors')
    { id: 'indRL', out: 0x20, outDark: true, name: 'Turn signal rear left', end: 'rear', side: 'L' },
    { id: 'indRR', out: 0x21, outDark: true, name: 'Turn signal rear right', end: 'rear', side: 'R' },
    { id: 'rfogL', out: 0x1C, name: 'Rear fog light left', end: 'rear', side: 'L' },
    { id: 'rfogR', out: 0x1D, name: 'Rear fog light right', end: 'rear', side: 'R' },
    { id: 'revL', out: 0x1E, name: 'Reversing light left', end: 'rear', side: 'L' },
    { id: 'revR', out: 0x1F, name: 'Reversing light right', end: 'rear', side: 'R' },
];
/** Lamps never switched: the brake, tail and number plate lights (on a G05 they stayed on every time - the body
 *  controller won't give them back). Only read (the brake lights: stuck?) and offered every give-back form by Give
 *  lamps back. */
const KEPT = [
    { id: 'tailL', out: 0x14, name: 'Tail light left', end: 'rear', side: 'L', usual: 'on' },
    { id: 'tailR', out: 0x15, name: 'Tail light right', end: 'rear', side: 'R', usual: 'on' },
    { id: 'plate', out: 0x22, name: 'Number plate light', end: 'rear', side: 'M', usual: 'on' },
    { id: 'brakeL', out: 0x18, name: 'Brake light left', end: 'rear', side: 'L', usual: 'brake' },
    { id: 'brakeR', out: 0x19, name: 'Brake light right', end: 'rear', side: 'R', usual: 'brake' },
    { id: 'brakeM', out: 0x23, name: 'Third brake light', end: 'rear', side: 'M', usual: 'brake' },
];
const BY_ID = {};
LAMPS.concat(KEPT).forEach((l) => { BY_ID[l.id] = l; });
// high beam alternatives the lamp check tries in the left headlight (A-D on its page: which lit is told back by the
// driver): Fernlichtblinken, Fernlicht Modus 1a / 2a / 3a
const HIGH_TRIES = [0x45, 0x0F, 0x11, 0x13];
// the headlights' own flashing modes (one request, the module flashes by itself): the lamp check's flash tries
const FLM_FLASH = { panic: 0x48, alarm: 0x47, holdup: 0x46 };   // Panik-Modus, DWA-Blinken, Überfallalarm
const LVS = [HIGH, LOW, DRL, BLINK].concat(HIGH_TRIES, Object.values(FLM_FLASH));
const STATE_DID = [0xE3, 0xB9];           // LICHT_AUSGANG_DIGITAL: one byte an output (its number), 1 on

/** Lamp functions (TAB_LEUCHTEN_FUNKTION_ARG) for 0xD542. */
const FN = { lowL: 0x03, lowR: 0x03, highL: 0x05, highR: 0x05, drlL: 0x04, drlR: 0x04, fogL: 0x08, fogR: 0x08,
    indFL: 0x06, indSL: 0x06, indRL: 0x06, indFR: 0x07, indSR: 0x07, indRR: 0x07,
    rfogL: 0x0E, rfogR: 0x0E, revL: 0x0F, revR: 0x0F };

/** The body controller's own flashing functions (0xD542): SPECIAL_FUNCTION_FLASHING, REVERSING_FLASH */
const BDC_FLASH = { special: 0x1C, reversing: 0x1B };

/** The body controller output request's layouts tried, in order (after 2F E3 B5; E output, A 01 on / 00 off). */
const LAYOUTS = [
    { id: 'E A', b: ['E', 'A'] },
    { id: '03 E A', b: [0x03, 'E', 'A'] },
    { id: '03 E A 00', b: [0x03, 'E', 'A', 'T'] },           // (T: 00 so far; the lamp check measures whether it's a time)
    { id: '03 00 E A', b: [0x03, 0x00, 'E', 'A'] },
    { id: '03 E A FF', b: [0x03, 'E', 'A', 0xFF] },
    { id: '03 E A 00 00', b: [0x03, 'E', 'A', 0x00, 0x00] },
    { id: '03 E', b: [0x03, 'E'] },
];
const LAYOUT = {};
LAYOUTS.forEach((x) => { LAYOUT[x.id] = x; });
const PROBE_LAMP = 'revL';                // a lamp every car has, harmless to flash parked: the layout probe's

const NRC = { 0x10: 'refused', 0x11: 'not supported', 0x12: 'not supported', 0x13: 'wrong length', 0x22: 'conditions not correct',
    0x31: 'out of range', 0x33: 'locked (security access)', 0x7E: 'not in this session', 0x7F: 'not in this session' };
const hex = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const why = (r) => (r.ok ? 'ok' : r.nrc !== null ? NRC[r.nrc] || 'NRC ' + hex(r.nrc) : 'no answer');

const fill = (lay, l, a, t) => lay.b.map((x) => (x === 'E' ? l.out : x === 'A' ? a : x === 'T' ? (t || 0) : x));
const req = {
    out: (l, lay, on, t) => [0x2F].concat(OUT_DID, fill(lay, l, on ? 1 : 0, t)),
    status: () => [0x22].concat(STATE_DID),
    release: (l) => [0x2F].concat(OUT_DID, [0x00, l.out]),
    releaseShort: () => [0x2F].concat(OUT_DID, [0x00]),
    /** the ways to give an output back, tried in turn until one is taken (then kept): the output layout with the
     *  action 0x40 (the older body controllers' job, STEUERN_LEUCHTENAUSGANG_DIGITAL: 0 off, 1 on, 0x40 return
     *  control to the ECU), return control to the ECU with the output, the layout with 00 for its control
     *  parameter, return control alone */
    releases: (l, lay) => {
        const out = [];
        if (lay && lay.b.indexOf('A') >= 0) out.push({ id: 'A=40', b: [0x2F].concat(OUT_DID, fill(lay, l, 0).map((x, i) => (lay.b[i] === 'A' ? 0x40 : x))) });
        out.push({ id: '00 E', b: req.release(l) });
        if (lay && lay.b[0] === 0x03) out.push({ id: '00 ' + lay.id.slice(3), b: [0x2F].concat(OUT_DID, [0x00], fill(lay, l, 0).slice(1)) });
        out.push({ id: '00', b: req.releaseShort() });
        return out;
    },
    lv: (lv, s) => [0x2E].concat(LV_DID, [0x00, lv, s]),
    fn: (fn, ms) => { const t = Math.max(1, Math.min(32700, Math.round(ms / 10))); return [0x2E].concat(FN_DID, [0x00, fn, t >> 8, t & 0xFF]); },
    session: (s) => [0x10, s],
    tp: () => [0x3E, 0x00],
};

/** Throws unless the request is one of the above, to the unit it belongs to. */
function check(target, bytes) {
    const bad = () => new Error('light show: request not allowed: ' + hex(target) + ': ' + bytes.map(hex).join(' '));
    if ([BDC, FLM_L, FLM_R].indexOf(target) < 0) throw new Error('light show: only the body controller and the headlight modules');
    const [sid, a] = bytes, key = bytes.map(hex).join(' ');
    if (sid === 0x10 && bytes.length === 2 && (a === 0x01 || a === 0x03)) return;
    if (sid === 0x3E && bytes.length === 2 && a === 0x00) return;
    if (target === BDC) {
        if (key === '22 E3 B9') return;
        const outs = LAMPS.map((l) => l.out), all = outs.concat(KEPT.map((l) => l.out));
        // an output request: a layout's shape (E a lamp output, A on / off / 0x40, T any time byte, the rest as is),
        // or one with 00 for its control parameter; or return control (00, 00 <output>)
        // (the kept lamps - brake, tail, plate: only the give-back forms - 0x40, or control parameter 00 - never on or off)
        const fits = (body, shape, back) => body.length === shape.length && shape.every((x, i) => (x === 'E' ? (back ? all : outs).indexOf(body[i]) >= 0
            : x === 'A' ? (back ? [0, 0x40] : [0, 1, 0x40]).indexOf(body[i]) >= 0 : x === 'T' ? true : body[i] === x));
        if (sid === 0x2F && bytes[1] === OUT_DID[0] && bytes[2] === OUT_DID[1]) {
            const body = bytes.slice(3), ai = (lay) => lay.b.indexOf('A');
            if (LAYOUTS.some((lay) => fits(body, lay.b) && (all.indexOf(body[lay.b.indexOf('E')]) < 0 || outs.indexOf(body[lay.b.indexOf('E')]) >= 0 || body[ai(lay)] === 0x40))) return;
            if (LAYOUTS.some((lay) => fits(body, lay.b, true) && body[ai(lay)] === 0x40)) return;
            if (LAYOUTS.some((lay) => lay.b[0] === 0x03 && fits(body, [0x00].concat(lay.b.slice(1)), true))) return;
            if (fits(body, [0x00]) || fits(body, [0x00, 'E'], true)) return;
        }
        if (Object.values(FN).concat(Object.values(BDC_FLASH)).some((f) => req.fn(f, 10).slice(0, 5).map(hex).join(' ') === bytes.slice(0, 5).map(hex).join(' ') && bytes.length === 7)) return;
        throw bad();
    }
    if (sid === 0x2E && bytes.length === 6 && bytes[1] === LV_DID[0] && bytes[2] === LV_DID[1] && bytes[3] === 0x00 && LVS.indexOf(bytes[4]) >= 0 && bytes[5] <= 2) return;
    throw bad();
}

/**
 * The link to the lamps: one request at a time, the sessions kept, every lamp it took over given back.
 *   const link = new LampLink(diag, log);
 *   await link.start();                  // the body controller's extended session (tester present)
 *   await link.probe();                  // the output request's layout, once: link.layout (null: none taken)
 *   link.how[id] = 'out' | 'flm';        // how a lamp is switched (the lamp check finds it; default 'out')
 *   await link.set('highL', true, 0, ms);  await link.set('highL', false, 'release' | 'off');
 *   await link.stop();                   // every lamp back to the car, default sessions
 */
class LampLink {
    constructor(diag, log, opts) {
        this.diag = diag; this.log = log; this.opts = opts || {};
        this.held = new Set();            // lamps taken over and not given back
        this.active = false; this.session = null; this.releaseForm = null; this.noRelease = false;
        this.stuck = new Set();           // lamps the unit wouldn't give back (the page says: cycle the ignition)
        this.releaseTried = [];           // [{ id, why }] the give-back forms tried
        this.layout = null; this.probed = null;   // the layout taken; the probe's results [{ id, why }]
        this.how = {};
        this.FLM_L = FLM_L; this.FLM_R = FLM_R;
        this.modes = new Set();           // headlight flashing modes on ('ecu:lv')
        this.sessions = new Set();        // units in the extended session
        this.stats = { sent: 0, ok: 0, refused: 0, missed: 0, ms: 0, last: null };
        this.queue = Promise.resolve(); this.tp = null; this.lastSent = {};
        // 0.6: the rate limiter (safety.js RateLimiter, set by main.js; null: none). teardown: giving lamps back -
        // the limiter lets those through even when its breaker has tripped
        this.gate = null; this.teardown = false;
    }
    /** one request, in turn (parallel: now, beside whatever is in flight); resolves with { ok, nrc, ms, reply } */
    request(target, bytes, parallel) {
        check(target, bytes);
        const run = async () => {
            // the rate limiter first (its wait isn't counted in the request's time); a tripped breaker blocks
            // everything but the teardown's requests
            if (this.gate) {
                try { await this.gate.acquire(target, { teardown: this.teardown }); }
                catch (e) { this.stats.last = String(e.message || e); return { ok: false, nrc: null, ms: 0, reply: null, blocked: true }; }
            }
            const result = await send();
            if (this.gate) this.gate.report(target, result);
            return result;
        };
        const send = async () => {
            const t0 = Date.now(), sid = bytes[0], data = bytes.slice(1);
            const echo = data.slice(0, sid === 0x2F || sid === 0x2E ? 2 : 1);
            const accept = (u) => (u[0] === sid + 0x40 && echo.every((x, i) => u[i + 1] === x)) || (u[0] === 0x7F && u[1] === sid);
            this.stats.sent++; this.lastSent[target] = t0;
            let u = null;
            try { u = await this.diag.physical(target, sid, data, this.opts.timeoutMs || 800, accept, { maxRetries: 1, retryBaseMs: 60, pendingTimeoutMs: 1000, callTimeoutMs: 1500 }); }
            catch (e) { this.stats.last = String(e.message || e); }
            const ms = Date.now() - t0;
            this.stats.ms = this.stats.ms ? this.stats.ms * 0.8 + ms * 0.2 : ms;
            if (!u) { this.stats.missed++; return { ok: false, nrc: null, ms, reply: null }; }
            if (u[0] === 0x7F) { this.stats.refused++; this.stats.last = hex(target) + ' ' + bytes.slice(0, 3).map(hex).join(' ') + ': ' + (NRC[u[2]] || 'NRC ' + hex(u[2])); return { ok: false, nrc: u[2], ms, reply: u }; }
            this.stats.ok++;
            return { ok: true, nrc: null, ms, reply: u };
        };
        // (parallel: no - on a G05 the transport took one of several requests sent together and dropped the rest;
        // every request waits its turn)
        const p = this.queue.then(run, run);
        this.queue = p.catch(() => null);
        return p;
    }
    /** a unit into the extended session (once), kept there by tester present */
    async enter(target) {
        if (this.sessions.has(target)) return true;
        const r = await this.request(target, req.session(0x03));
        this.sessions.add(target);                // (tried: not again, whatever the answer)
        if (target === BDC) this.session = r.ok ? 'extended' : 'default (' + why(r) + ')';
        this.log.info('light show: ' + hex(target) + ' session ' + (r.ok ? 'extended' : why(r)));
        return r.ok;
    }
    async start() {
        if (this.active) return true;
        this.active = true;
        clearInterval(this.tp);
        this.tp = setInterval(() => {
            if (!this.active) return;
            this.sessions.forEach((t) => { if (Date.now() - (this.lastSent[t] || 0) > TP_MS * 0.75) this.request(t, req.tp()); });
        }, TP_MS / 2);
        return this.enter(BDC);
    }
    /** finds the output request's layout the body controller takes (on the rear left turn signal, a moment each) */
    async probe() {
        if (this.probed) return this.layout;
        const l = BY_ID[PROBE_LAMP];
        this.probed = [];
        for (const lay of (this.layout ? [this.layout] : LAYOUTS)) {
            const r = await this.request(BDC, req.out(l, lay, true));
            this.probed.push({ id: lay.id, why: why(r) });
            if (r.ok) {
                this.layout = lay;
                await new Promise((res) => setTimeout(res, 300));
                await this.request(BDC, req.out(l, lay, false));
                await this.release(PROBE_LAMP);
                break;
            }
        }
        this.log.info('light show: output layouts ' + this.probed.map((p) => p.id + ': ' + p.why).join(', '));
        if (!this.layout) this.log.warn('light show: the body controller took no output layout');
        return this.layout;
    }
    /** the lamp outputs as the body controller has them now: states[output number] 1 on / 0 off, or null */
    async readStates() {
        const r = await this.request(BDC, req.status());
        if (!r.ok || !r.reply || r.reply.length < 10) return null;
        this.states = r.reply.slice(3); this.statesT = Date.now();
        return this.states;
    }
    /**
     * Whether the output layout's last byte is a time: the rear fog light on with it set (10, then 1), its state read
     * every 200 ms; if it goes dark by itself, the time it took gives the unit. this.timer = { unitMs, ms, t } or
     * null; this.timerTried = what was seen. A timed output goes back by itself: no give-back request needed.
     */
    async probeTimer() {
        this.timer = null; this.timerTried = [];
        if (!this.layout || this.layout.b.indexOf('T') < 0) { this.timerTried.push('no time byte in the layout'); return null; }
        const l = BY_ID.rfogL;
        for (const t of [10, 1]) {
            const r = await this.request(BDC, req.out(l, this.layout, true, t));
            if (!r.ok) { this.timerTried.push('T=' + t + ': ' + why(r)); continue; }
            const t0 = Date.now();
            let was = false, gone = null;
            const win = this.opts.timerWindowMs || 3500;
            while (Date.now() - t0 < win) {
                await new Promise((res) => setTimeout(res, 200));
                const st = await this.readStates();
                if (!st) { this.timerTried.push('T=' + t + ': status not read'); break; }
                if (st[l.out]) was = true;
                else if (was) { gone = Date.now() - t0; break; }
            }
            this.timerTried.push('T=' + t + ': ' + (gone !== null ? 'dark after ' + gone + ' ms' : was ? 'still on after ' + (win / 1000) + ' s' : 'never read on'));
            if (gone !== null) {
                // the unit from the time: 10 ms, 100 ms or 1 s a step
                const unit = gone / t;
                this.timer = { unitMs: unit < 40 ? 10 : unit < 400 ? 100 : 1000, ms: gone, t };
                break;
            }
            await this.request(BDC, req.out(l, this.layout, false, 0));
            await this.release('rfogL');
        }
        this.log.info('light show: output time byte: ' + this.timerTried.join(', ') + (this.timer ? ' -> ' + this.timer.unitMs + ' ms a step' : ''));
        return this.timer;
    }
    /** the time byte for ms (with a margin for the next frame's request), when the layout's last byte is a time */
    _t(ms) {
        if (!this.timer) return 0;
        return Math.max(1, Math.min(255, Math.ceil(((ms || 1000) + 250) / this.timer.unitMs)));
    }
    /** on = true / false; off as 'release' (the car's own again) or 'off' (held dark). ms: how long the frame is
     *  (a headlight module's function is set for whole seconds: 1, or 2 for a long frame). */
    async set(id, on, offAs, ms, parallel) {
        const l = BY_ID[id];
        if (!l) return { ok: false, nrc: null, ms: 0 };
        if (this.how[id] === 'flm' && l.flm) {
            await this.enter(l.flm.ecu);
            const r = await this.request(l.flm.ecu, req.lv(l.flm.lv, on ? (ms > 900 ? 2 : 1) : 0), parallel);
            if (r.ok) { if (on) this.held.add(id); else this.held.delete(id); }
            return r;
        }
        if (!this.layout) return { ok: false, nrc: null, ms: 0, why: 'no output layout' };
        // a lamp the car keeps on (low beam, daytime light) never by the body controller's output: on a G05 it
        // won't give one back (only through its headlight module, above)
        if (l.usual) return { ok: false, nrc: null, ms: 0, why: 'kept' };
        if (on || offAs === 'off') {
            const r = await this.request(BDC, req.out(l, this.layout, on, this._t(ms)), parallel);
            if (r.ok && !this.timer) this.held.add(id);        // (timed: it goes back by itself)
            return r;
        }
        // timed: dark for a moment, then it goes back to the car by itself (no give-back request; and the flash
        // ends now, not when its own time runs out)
        if (this.timer) { const r = await this.request(BDC, req.out(l, this.layout, false, this._t(0))); r.timed = true; return r; }
        return this.release(id);
    }
    async release(id, force) {
        const l = BY_ID[id];
        if (this.how[id] === 'flm') return this.set(id, false);
        // known not to give lamps back (the G05: every form "conditions not correct"): no give-back requests (four
        // of them a lamp, ~1.2 s); a lamp that is normally off goes dark instead. force (Give lamps back): try anyway
        if (this.noRelease && !force) {
            if (!l.usual && this.layout) { const o = await this.request(BDC, req.out(l, this.layout, false, 0)); if (o.ok) this.held.add(id); }
            if (l.usual) this.stuck.add(id);
            return { ok: false, nrc: 0x22, ms: 0, skipped: true };
        }
        const forms = req.releases(l, this.layout);
        const list = this.releaseForm ? forms.filter((f) => f.id === this.releaseForm) : forms;
        let r = { ok: false, nrc: null };
        for (const f of list) {
            r = await this.request(BDC, f.b);
            if (!this.releaseForm) this.releaseTried.push({ id: f.id, why: why(r) });
            if (r.ok) {
                if (!this.releaseForm) { this.releaseForm = f.id; this.log.info('light show: outputs given back with ' + f.id); }
                break;
            }
            if (r.nrc === null) break;            // no answer: not a matter of the layout
        }
        if (r.ok) {
            if (this.releaseForm === '00') this.held.clear(); else this.held.delete(id);
            this.stuck.delete(id); this.noRelease = false;
            return r;
        }
        if (r.nrc !== null && !this.noRelease) {
            this.noRelease = true;
            this.log.warn('light show: ' + l.name + ' not given back (' + why(r) + ')');
        }
        // a lamp that is normally off goes dark now; one the car keeps on (tail, plate, BRAKE) can't be left held:
        // it's marked stuck, and the page tells the driver to cycle the ignition
        if (r.nrc !== null && !l.usual && this.layout) { const o = await this.request(BDC, req.out(l, this.layout, false)); if (o.ok) this.held.add(id); }
        if (l.usual) this.stuck.add(id);
        return r;
    }
    /**
     * A flash of these lamps' functions, all at once: each lamp function once (both sides - the turn signals a side
     * each), sent together, every one for ms and then the car's own again by itself (nothing to switch off).
     */
    async burst(ids, ms) {
        const codes = Array.from(new Set(ids.map((id) => FN[id]).filter((c) => c !== undefined)));
        const out = [];
        for (const c of codes) out.push(await this.request(BDC, req.fn(c, ms)));       // (one at a time: see request)
        return out;
    }
    /**
     * How fast the link can go (the lamp check's speed test, on the left reversing light):
     *   seq:  on / off requests one after another, each waiting for its reply (how the patterns send now);
     *   pipe: the same requests each sent as soon as the transport took the one before (its replies counted as they
     *         come): whether the head unit's transport queues requests or turns them away.
     * Returns { seqMs (a request), pipe: { sent, taken, answered, ms, verdicts } }.
     */
    async speedTest(n) {
        n = n || 8;
        const l = BY_ID[PROBE_LAMP], lay = this.layout;
        if (!lay) return null;
        await this.queue;
        const t0 = Date.now();
        for (let i = 0; i < n; i++) await this.request(BDC, req.out(l, lay, i % 2 === 0, 0));
        const seqMs = (Date.now() - t0) / n;
        // pipelined: straight to the transport, not through the queue (nothing else is sent meanwhile)
        let answered = 0, taken = 0;
        const verdicts = {};
        const onFrame = (f) => { if (f.ecu === BDC && f.uds[0] === 0x6F) answered++; };
        this.diag.on('frame', onFrame);
        const t1 = Date.now();
        for (let i = 0; i < n; i++) {
            const b = req.out(l, lay, i % 2 === 0, 0);
            check(BDC, b);
            let v;
            try { v = await this.diag.send(BDC, b[0], b.slice(1), { maxRetries: 0, callTimeoutMs: 1500 }); } catch (e) { v = 'error'; }
            verdicts[v] = (verdicts[v] || 0) + 1;
            if (/NO_ERROR|PENDING|^0$|^1$/.test(String(v))) taken++;
        }
        const sendMs = Date.now() - t1;
        await new Promise((res) => setTimeout(res, 1500));
        this.diag.removeListener('frame', onFrame);
        await this.request(BDC, req.out(l, lay, false, 0));
        const r = { seqMs: Math.round(seqMs), pipe: { sent: n, taken, answered, ms: Math.round(sendMs / n), verdicts } };
        this.log.info('light show: speed ' + JSON.stringify(r));
        return r;
    }
    /** a body controller flashing function (BDC_FLASH) for ms */
    flashFn(code, ms) { return this.request(BDC, req.fn(code, ms)); }
    /** one headlight module's light function for s seconds (0: off): the lamp check's tries, and the flashing
     *  modes the patterns run (kept in this.modes until switched off: stop() switches off any left) */
    async lvTry(ecu, lv, s) {
        await this.enter(ecu);
        const r = await this.request(ecu, req.lv(lv, s));
        const k = ecu + ':' + lv;
        if (s) this.modes.add(k); else this.modes.delete(k);
        return r;
    }
    /** a body controller lamp function for ms (both sides, except the turn signals), then the car's own again */
    fn(id, ms) { return FN[id] ? this.request(BDC, req.fn(FN[id], ms)) : Promise.resolve({ ok: false, nrc: null, ms: 0 }); }
    /** every lamp back to the car, then the default sessions (which give back anything left) */
    async stop() {
        if (!this.active) return;
        const was = this.teardown;
        this.teardown = true;                     // (through the rate limiter whatever its state)
        try { await this._stop(); } finally { this.teardown = was; }
    }
    async _stop() {
        for (const id of Array.from(this.held)) await this.release(id);
        for (const id of Array.from(this.stuck)) await this.release(id);       // once more
        for (const k of Array.from(this.modes)) { const [e, lv] = k.split(':').map(Number); await this.lvTry(e, lv, 0); }
        clearInterval(this.tp); this.tp = null;
        for (const t of Array.from(this.sessions)) await this.request(t, req.session(0x01));
        this.sessions.clear();
        this.held.clear();
        this.active = false;
        this.log.info('light show: lamps given back to the car');
    }
}

module.exports = { LampLink, FLM_FLASH, BDC_FLASH, LAMPS, KEPT, BY_ID, FN, NRC, LAYOUTS, LAYOUT, HIGH_TRIES, BDC, FLM_L, FLM_R, req, check, hex, why };
