'use strict';
/**
 * patterns.js - the flash patterns and the player that runs one on the lamps (lamps.js).
 *
 * A pattern is frames: { on: [lamp ids lit in this frame], ms }. Between frames only the lamps that change are
 * sent. Two kinds:
 *   emergency: only lamps that are normally off while driving (high beams, fog lights, turn signals, rear fog,
 *              reversing lights); a lamp's dark phase gives it back to the car, so the low beams, tail lights and
 *              brake lights stay the car's own the whole time.
 *   show:      any lamp, held dark between flashes (parked: a light show).
 */
const { BY_ID, FLM_FLASH, BDC_FLASH } = require('./lamps');

const f = (ms, ...on) => ({ ms, on });
const PATTERNS = [
    { id: 'wigwag', name: 'Wig-wag', kind: 'emergency', what: 'High beams, left and right in turn',
        frames: [f(350, 'highL'), f(350, 'highR')] },
    { id: 'double', name: 'Double flash', kind: 'emergency', what: 'Two quick flashes left, then two right',
        frames: [f(90, 'highL'), f(70), f(90, 'highL'), f(160), f(90, 'highR'), f(70), f(90, 'highR'), f(160)] },
    { id: 'full', name: 'Front and rear', kind: 'emergency', what: 'High beams in turn, rear turn signals and rear fogs opposite',
        frames: [f(400, 'highL', 'indRR', 'rfogR'), f(400, 'highR', 'indRL', 'rfogL')] },
    { id: 'rear', name: 'Rear only', kind: 'emergency', what: 'Rear turn signals and rear fog lights in turn (pulled over, facing traffic)',
        frames: [f(350, 'indRL', 'rfogL'), f(350, 'indRR', 'rfogR')] },
    { id: 'corners', name: 'Corner strobe', kind: 'emergency', what: 'All turn signals, front and rear corners crossed',
        frames: [f(120, 'indFL', 'indRR'), f(80), f(120, 'indFL', 'indRR'), f(180), f(120, 'indFR', 'indRL'), f(80), f(120, 'indFR', 'indRL'), f(180)] },
    { id: 'chase', name: 'Chase', kind: 'show', what: 'Around the car, corner to corner',
        frames: [f(180, 'indFL', 'fogL'), f(180, 'indFR', 'fogR'), f(180, 'indSR', 'indRR'), f(180, 'indRL', 'indSL')] },
    { id: 'sweep', name: 'Sweep', kind: 'show', what: 'Across the front and back, out and back',
        frames: [f(140, 'indFL', 'rfogL'), f(140, 'fogL', 'revL'), f(140, 'highL'), f(140, 'highR'),
            f(140, 'fogR', 'revR'), f(140, 'indFR', 'rfogR'), f(140, 'fogR', 'revR'), f(140, 'highR'), f(140, 'highL'), f(140, 'fogL', 'revL')] },
    { id: 'all', name: 'Everything', kind: 'show', what: 'Every lamp on, then every lamp off',
        frames: [f(400, 'lowL', 'lowR', 'highL', 'highR', 'drlL', 'drlR', 'fogL', 'fogR', 'indFL', 'indFR', 'indSL', 'indSR', 'indRL', 'indRR',
            'rfogL', 'rfogR', 'revL', 'revR'), f(400)] },
    // burst: each frame's lamps lit by their lamp functions all at once (both sides together), each for the frame's
    // time and then dark by itself - fast, where switching a dozen lamps one by one (~300 ms a request) can't be
    { id: 'strobe', name: 'Strobe', kind: 'show', burst: true, what: 'Reversing, fog, low, high, daytime lights and turn signals, both sides, in quick turn',
        frames: [f(150, 'revL', 'fogL', 'lowL', 'highL', 'drlL', 'indFL', 'indFR'), f(150)] },
    // a whole side's turn signals (front, mirror, rear) by its own lamp function: one request a flash, dark again by
    // itself - the fastest side to side the car allows (it takes one request at a time, ~300 ms each)
    { id: 'sides', name: 'Side to side', kind: 'show', burst: true, what: 'A whole side\'s turn signals: two flashes left, two right',
        frames: [f(150, 'indFL'), f(60), f(150, 'indFL'), f(200), f(150, 'indFR'), f(60), f(150, 'indFR'), f(200)] },
    { id: 'blink', name: 'Blink', kind: 'show', what: 'Headlights and tail lights dark, then a flash, like a wink',
        frames: [f(600, 'drlL', 'drlR'), f(150), f(600, 'drlL', 'drlR'), f(150), f(120, 'highL', 'highR'), f(120), f(120, 'highL', 'highR'), f(500)] },
];
/* The car's own flashing modes (found by the lamp check's flash tries on a G05): one request and the unit flashes by
 * itself - both sides together even when one headlight module is asked (seen on the car), so light shows only - a headlight (L / R: its module) in panic mode or alarm flashing for whole seconds, the reversing lights'
 * flash for a time. The fast flashing the car allows: its diagnostic link takes ~3 requests a second. Frames: { ms,
 * act: [['L' | 'R', mode, seconds (0: off)] | ['fn', function, ms]] }, each act one request. */
const PANIC = FLM_FLASH.panic, ALARM = FLM_FLASH.alarm, REVFLASH = BDC_FLASH.reversing;
const m = (ms, ...act) => ({ ms, on: [], act });
PATTERNS.push(
    { id: 'hstrobe', name: 'Headlight strobe', kind: 'show', modes: true, what: 'Both headlights in their panic flashing, the reversing lights flashing',
        frames: [m(1800, ['L', PANIC, 2], ['R', PANIC, 2], ['fn', REVFLASH, 2000])] },
);
// 0.8: three presets (Side Show, Code 4, POV). They use each headlight's "all LED channels" (one request a headlight) next to the high beams and
// fogs, so they flash as hard as the link allows; lamps the lamp check ruled out are left out as always.
const burst = (n, ms, gap, lamps) => { const o = []; for (let i = 0; i < n; i++) o.push(f(ms, ...lamps), f(gap)); return o; };
// Side Show Strobe: every switchable lamp of one side as a very fast burst, then the other side, then both, then
// rapid left-right swaps. (Through the head unit each lamp costs ~300 ms a switch, so all of a side takes ~3 s a
// flash there: this one is made for the direct link; the page shows "link too slow" when it can't keep up.)
const SIDE_L = ['ledL0', 'highL', 'lowL', 'drlL', 'fogL', 'indFL', 'indSL', 'indRL', 'rfogL', 'revL'];
const SIDE_R = ['ledR0', 'highR', 'lowR', 'drlR', 'fogR', 'indFR', 'indSR', 'indRR', 'rfogR', 'revR'];
PATTERNS.push({ id: 'sideshow', name: 'Side Show Strobe', kind: 'show',
    what: 'Every light: very fast bursts left, then right, then both, then rapid left-right swaps',
    frames: [].concat(
        burst(4, 45, 45, SIDE_L), [f(90)],
        burst(4, 45, 45, SIDE_R), [f(90)],
        burst(4, 45, 45, SIDE_L), [f(90)],
        burst(4, 45, 45, SIDE_R), [f(90)],
        burst(4, 45, 45, SIDE_L.concat(SIDE_R)), [f(90)],
        [f(70, ...SIDE_L), f(70, ...SIDE_R), f(70, ...SIDE_L), f(70, ...SIDE_R), f(70, ...SIDE_L), f(70, ...SIDE_R),
            f(70, ...SIDE_L), f(70, ...SIDE_R), f(70, ...SIDE_L), f(70, ...SIDE_R), f(70, ...SIDE_L), f(70, ...SIDE_R)],
        [f(250)]) });
// Code 4 Strobe (from the t340i video, measured at 30 fps): double flashes of ~67 ms, side to side - car-left white
// (headlight LEDs, reversing light), car-right white, car-left amber / red (front turn signal, rear red), car-right
// amber / red - about 1.2 s a round. (The video's steady amber glow under it isn't held: the lamp test functions run
// out after 1-2 s and through the head unit a round is longer than that, so it would flicker out.)
const C4_WL = ['ledL0', 'revL'], C4_WR = ['ledR0', 'revR'], C4_AL = ['indFL', 'indRL', 'rfogL'], C4_AR = ['indFR', 'indRR', 'rfogR'];
const dbl = (lamps) => [f(67, ...lamps), f(67), f(67, ...lamps), f(100)];
PATTERNS.push({ id: 'code4', name: 'Code 4 Strobe', kind: 'show',
    what: 'Double flashes side to side: white left, white right, amber / red left, amber / red right',
    frames: [].concat(dbl(C4_WL), dbl(C4_WR), dbl(C4_AL), dbl(C4_AR)) });
// police-style: quad flashes side to side with the opposite rear fog, then a wig-wag. parked: never while the car
// moves, whatever the settings (emergency lights on a private car on the road are unlawful everywhere)
PATTERNS.push({ id: 'pov', name: 'POV Strobe', kind: 'show', parked: true,
    what: 'Police style: quad flashes side to side (opposite rear fog with each), then a wig-wag - parked only',
    frames: [].concat(
        burst(4, 50, 50, ['highL', 'ledL0', 'rfogR']), [f(100)],
        burst(4, 50, 50, ['highR', 'ledR0', 'rfogL']), [f(100)],
        burst(4, 50, 50, ['highL', 'ledL0', 'rfogR']), [f(100)],
        burst(4, 50, 50, ['highR', 'ledR0', 'rfogL']), [f(100)],
        [f(220, 'highL', 'ledL0', 'indFL', 'rfogR'), f(220, 'highR', 'ledR0', 'indFR', 'rfogL'),
            f(220, 'highL', 'ledL0', 'indFL', 'rfogR'), f(220, 'highR', 'ledR0', 'indFR', 'rfogL'),
            f(220, 'highL', 'ledL0', 'indFL', 'rfogR'), f(220, 'highR', 'ledR0', 'indFR', 'rfogL')]) });
// 0.6: the strobe built from the settings (Strobe speed, Pulse, Strobe lamps, Loop count): main.js swaps these
// frames for sequences.js settingsStrobe() when it starts
PATTERNS.push({ id: 'custom', name: 'Custom strobe', kind: 'show', custom: true, what: 'High beams (or the lamps set in Settings) at the strobe speed and pulse set in Settings',
    frames: [f(160, 'highL', 'highR'), f(173)] });
const PATTERN = {};
PATTERNS.forEach((p) => { PATTERN[p.id] = p; });

/** The lamps a pattern uses (each once). */
const lampsOf = (p) => Array.from(new Set([].concat(...p.frames.map((fr) => fr.on))));
/** An emergency pattern never takes over a lamp the car keeps on (or uses for braking) while driving. */
function safeForDriving(p) { return lampsOf(p).every((id) => BY_ID[id] && !BY_ID[id].usual); }

/**
 * Runs one pattern on the link until stopped.
 *   const pl = new Player(link, { usable(id) -> bool, viaFn(id) -> bool, onFrame(lit Set), log });
 *   viaFn(id): the lamp's own output is refused but its lamp function works and is its side's alone (the turn
 *   signals): lit with the function for the frame's time, which goes dark by itself
 *   pl.start(PATTERN.wigwag, 1);  pl.stop() -> Promise (every lamp back);  pl.running
 */
class Player {
    constructor(link, opts) {
        this.link = link; this.opts = opts || {};
        this.now = this.opts.now || Date.now;
        // a frame's wait ends early on stop (the lamps go back at once)
        this.wait = this.opts.wait || ((ms) => new Promise((r) => { const tm = setTimeout(r, ms); this.wake = () => { clearTimeout(tm); r(); }; }));
        this.wake = null;
        this.running = false; this.pattern = null; this.lit = new Set(); this.late = 0; this.frames = 0;
        this.stopping = null; this.error = null;
        this.rounds = 0; this.finished = false;     // 0.6: rounds done; finished: stopped after its loop count
    }
    /** false while the last run still gives its lamps back (a start then would run two at once) */
    start(pattern, speed) {
        if (this.running || this.ending) return false;
        this.pattern = pattern; this.speed = speed || 1; this.running = true; this.ending = true; this.error = null; this.frames = 0; this.late = 0;
        this.rounds = 0; this.finished = false;
        this.loop = this._run().catch((e) => { this.error = String(e.message || e); this.opts.log && this.opts.log.warn('light show: ' + this.error); })
            .then(() => this._end()).then(() => { this.ending = false; }, () => { this.ending = false; });
        return true;
    }
    /** stop, and give every lamp back */
    stop() {
        this.running = false;
        if (this.wake) this.wake();
        return this.loop || Promise.resolve();
    }
    setPattern(p) { this.pattern = p; }
    async _run() {
        const ok = await this.link.start();
        if (!this.link.layout && !this.link.probed && this.opts.needsLayout && this.opts.needsLayout()) await this.link.probe();
        // lamps held dark while it runs (a light show starts dark: lamps on before it don't stay on); timed outputs are
        // sent again each frame (they go back by themselves), held ones once
        const dark = new Set(this.opts.dark ? await this.opts.dark(this.pattern) : []);
        const darkSent = new Set();
        this.darkCount = dark.size;
        if (!ok && this.opts.log) this.opts.log.warn('light show: no extended session: trying the lamps anyway');
        let i = 0;
        while (this.running) {
            // each frame lasts its time from when it starts, or as long as its requests take when the car is slower:
            // an even rhythm at whatever pace the link allows (never hurrying later frames to catch up)
            const f0 = this.now();
            const p = this.pattern, fr = p.frames[i % p.frames.length];
            if (p.modes) {
                // flashing modes: each act one request, the unit flashes by itself
                const lit = new Set();
                for (const a of fr.act) {
                    if (!this.running) break;
                    if (a[0] === 'fn') { await this.link.flashFn(a[1], a[2] / this.speed); ['revL', 'revR'].forEach((x) => lit.add(x)); }
                    else { await this.link.lvTry(a[0] === 'L' ? this.link.FLM_L : this.link.FLM_R, a[1], a[2]); if (a[2]) ['lowX', 'highX'].forEach((x) => lit.add(x.replace('X', a[0]))); }
                }
                this.lit = lit;
                if (this.opts.onFrame) this.opts.onFrame(this.lit, i % p.frames.length);
                this.frames++;
                const left = f0 + fr.ms / this.speed - this.now();
                if (left > 0) await this.wait(left); else this.late++;
                i = this._next(i);
                continue;
            }
            if (p.burst) {
                // lamp functions, all at once, dark again by themselves
                if (fr.on.length) { await this.link.burst(fr.on, fr.ms / this.speed + 40); this.lit = new Set(fr.on.concat(fr.on.filter((id) => id !== 'indFL').map((id) => id.replace(/L$/, 'R')))); }
                else this.lit = new Set();
                if (this.opts.onFrame) this.opts.onFrame(this.lit, i % p.frames.length);
                this.frames++;
                const left = f0 + fr.ms / this.speed - this.now();
                if (left > 0) await this.wait(left); else this.late++;
                i = this._next(i);
                continue;
            }
            // (driving: every pattern as the emergency ones - lamps back to the car between flashes)
            const offAs = (p.kind === 'emergency' || this._driving()) && !this.link.noRelease ? 'release' : 'off';
            const want = new Set(fr.on.filter((id) => this._usable(id, p) && (!this.opts.allow || this.opts.allow(id))));
            for (const id of dark) {
                if (this._driving()) break;             // (driving: no lamp held dark)
                if (!this.running || want.has(id) || this.lit.has(id) || (darkSent.has(id) && !this.link.timer)) continue;
                const r = await this.link.set(id, false, 'off', fr.ms / this.speed);
                if (r.ok) darkSent.add(id);
            }
            // lamps going dark first (a frame never has two sides lit at once), then the ones coming on
            for (const id of Array.from(this.lit)) if (!want.has(id)) {
                // (an LED channel while driving with the guard: back to the car, never dimmed)
                if (!this._fn(id)) await this.link.set(id, false, BY_ID[id] && BY_ID[id].led && this._driving() ? 'release' : offAs);
                this.lit.delete(id);
            }
            // driving with the guard: any headlight LED channels still driven (a blink's dark half too) back at once
            if (this._driving() && this.link.ledEcus && this.link.ledEcus.size && this.link.releaseLeds) await this.link.releaseLeds();
            for (const id of want) {
                if (!this.running) break;
                if (this.lit.has(id)) continue;
                const r = this._fn(id) ? await this.link.fn(id, fr.ms / this.speed + 60) : await this.link.set(id, true, null, fr.ms / this.speed);
                if (r.ok) this.lit.add(id);
                else if (r.nrc !== null && this.opts.refused) this.opts.refused(id, r.nrc);
            }
            if (this.opts.onFrame) this.opts.onFrame(this.lit, i % p.frames.length);
            this.frames++;
            const left = f0 + fr.ms / this.speed - this.now();
            if (left > 0) await this.wait(left); else this.late++;        // (late: frames the link made longer)
            i = this._next(i);
        }
    }
    /** the next frame; after a pattern's last frame a round is done (loops: stop after that many) */
    _next(i) {
        const n = this.pattern.frames.length;
        if ((i + 1) % n === 0) {
            this.rounds++;
            if (this.opts.onRound) this.opts.onRound(this.rounds);
            if (this.pattern.loops && this.rounds >= this.pattern.loops) { this.running = false; this.finished = true; }
        }
        return i + 1;
    }
    /** the car is moving (opts.driving): the player then never takes over a lamp the car drives with */
    _driving() { return !!(this.opts.driving && this.opts.driving()); }
    _fn(id) { return !!(this.opts.viaFn && this.opts.viaFn(id)); }
    _usable(id, p) {
        const l = BY_ID[id];
        if (!l) return false;
        // held-dark lamps (no single release) that are normally on would stay dark: never in an emergency pattern
        // (and while driving: the low beams and daytime lights stay the car's, whatever the pattern)
        if ((p.kind === 'emergency' || this._driving()) && l.usual) return false;
        return !this.opts.usable || this.opts.usable(id);
    }
    async _end() {
        this.lit.clear();
        if (this.opts.onFrame) this.opts.onFrame(this.lit, -1);
        await this.link.stop();
    }
}

module.exports = { PATTERNS, PATTERN, Player, lampsOf, safeForDriving };
