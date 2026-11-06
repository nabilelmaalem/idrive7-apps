'use strict';
/**
 * safety.js - the guards around every lamp request (Light Show 0.6):
 *
 *   RateLimiter   how fast requests may leave for the car: a token bucket (requests a second, a small burst), a
 *                 minimum gap per unit, a growing pause after "busy" / unanswered requests, and a breaker that
 *                 trips after several failures in a row (the show then stops and every lamp goes back).
 *   ThermalGuard  how long a lamp may stay lit: a maximum continuous on time, a maximum share of a sliding window
 *                 (duty), and a cool-down after either is hit. Conservative software margins, not BMW figures:
 *                 the lamps' own electronics also derate, this keeps the app from leaning on that.
 *   Guardian      the one way back to the car: stop the player and manual control, give every lamp back, end the
 *                 diagnostic sessions, read the brake lights. Started by Stop, pause, leaving the screen, an HMI
 *                 popup, the limiter's breaker, a stalled player, the thermal guard, or SIGTERM / SIGINT.
 *
 * What none of this can cover: the app killed outright (kill -9, out of memory, an uncaught exception - the kit
 * exits at once). Then the body controller's own session timeout does it: no tester present for ~5 s and it drops
 * to its default session, which hands every lamp output back to the car. That is why nothing here ever puts a
 * unit in a session that outlives the app.
 *
 * Every class takes now() / sleep() so the tests can run it on a fake clock.
 */
const EventEmitter = require('events');

/* ------------------------------------------------------------------------------------------------------------ */
/* Rate limiting                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------ */

/** Link profiles (setting "linkProfile"). headunit: the MGU's own diagnostic transport, which takes one request at
 *  a time (~300 ms each on a G05) - the bucket only matters for bursts. direct: an ENET gateway over Wi-Fi. */
const PROFILES = {
    safe:   { headunit: { perSec: 3, burst: 1, gapMs: 120 }, direct: { perSec: 12, burst: 3, gapMs: 40 } },
    normal: { headunit: { perSec: 4, burst: 2, gapMs: 60 },  direct: { perSec: 20, burst: 4, gapMs: 25 } },
    fast:   { headunit: { perSec: 6, burst: 2, gapMs: 40 },  direct: { perSec: 30, burst: 6, gapMs: 15 } },
};
const BUSY_NRC = new Set([0x21, 0x78]);   // busy - repeat request, response pending

class RateLimiter extends EventEmitter {
    /**
     * opts: { profile: 'safe'|'normal'|'fast', link: 'headunit'|'direct', tripAfter (failures in a row, 6),
     *         backoffMs (first pause, 250), maxBackoffMs (2000), now, sleep }
     */
    constructor(opts) {
        super();
        const o = opts || {};
        this.now = o.now || Date.now;
        this.sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.tripAfter = o.tripAfter || 6;
        this.backoffBase = o.backoffMs || 250;
        this.maxBackoff = o.maxBackoffMs || 2000;
        this.profileName = o.profile || 'normal';
        this.linkKind = o.link || 'headunit';
        this._apply();
        this.tokens = this.cfg.burst;
        this.refillAt = this.now();
        this.lastTo = {};                  // target -> when the last request left
        this.backoff = 0;                  // pause before the next request (ms), grows on trouble
        this.failures = 0;                 // in a row
        this.tripped = false;
        this.stats = { granted: 0, waitedMs: 0, backoffs: 0, trips: 0 };
    }
    _apply() { this.cfg = (PROFILES[this.profileName] || PROFILES.normal)[this.linkKind] || PROFILES.normal.headunit; }
    setProfile(name) { this.profileName = PROFILES[name] ? name : 'normal'; this._apply(); this.tokens = Math.min(this.tokens, this.cfg.burst); }
    setLink(kind) { this.linkKind = kind === 'direct' ? 'direct' : 'headunit'; this._apply(); }
    /** clears the breaker (a new run starts healthy) */
    reset() { this.failures = 0; this.backoff = 0; this.tripped = false; }

    _refill() {
        const t = this.now(), dt = t - this.refillAt;
        if (dt > 0) { this.tokens = Math.min(this.cfg.burst, this.tokens + dt * this.cfg.perSec / 1000); this.refillAt = t; }
    }
    /** how long the next request to target has to wait now (0: may go) */
    waitFor(target) {
        this._refill();
        const t = this.now();
        const gap = this.lastTo[target] !== undefined ? this.lastTo[target] + this.cfg.gapMs - t : 0;
        const tok = this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) * 1000 / this.cfg.perSec);
        return Math.max(0, gap, tok, this.backoff);
    }
    /**
     * Resolves when a request to target may leave; rejects once the breaker has tripped (nothing more is sent but
     * what the Guardian sends with { teardown: true }: giving lamps back must always get through).
     */
    async acquire(target, opts) {
        const teardown = opts && opts.teardown;
        if (this.tripped && !teardown) throw new Error('rate limiter tripped: link unhealthy');
        for (let i = 0; i < 50; i++) {
            const w = teardown ? Math.max(0, (this.lastTo[target] || 0) + this.cfg.gapMs - this.now()) : this.waitFor(target);
            if (w <= 0) break;
            this.stats.waitedMs += w;
            await this.sleep(w);
            if (!teardown) this.backoff = 0;      // the pause is served once
        }
        this._refill();
        this.tokens = Math.max(0, this.tokens - 1);
        this.lastTo[target] = this.now();
        this.stats.granted++;
    }
    /** what came back: { ok, nrc } (nrc null and not ok: no answer) */
    report(target, r) {
        if (r && r.ok) { this.failures = 0; this.backoff = 0; return; }
        // a refusal for a reason (out of range, conditions not correct) is the unit answering: the link is healthy
        const trouble = !r || r.nrc === null || r.nrc === undefined || BUSY_NRC.has(r.nrc);
        if (!trouble) { this.failures = 0; return; }
        this.failures++;
        this.stats.backoffs++;
        this.backoff = Math.min(this.maxBackoff, this.backoff ? this.backoff * 2 : this.backoffBase);
        if (this.failures >= this.tripAfter && !this.tripped) {
            this.tripped = true; this.stats.trips++;
            this.emit('trip', { failures: this.failures, target });
        }
    }
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Thermal / duty guard                                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

/** Lamp classes. maxOnMs: continuous; duty: share of windowMs lit; coolMs: off this long after a limit is hit.
 *  'high' is overwritten from the settings (highBeamMaxS, cooldownS, maxDuty). */
const CLASSES = {
    high:    { maxOnMs: 8000,  duty: 0.5, windowMs: 60000, coolMs: 20000 },
    low:     { maxOnMs: 60000, duty: 0.9, windowMs: 60000, coolMs: 10000 },
    fog:     { maxOnMs: 30000, duty: 0.7, windowMs: 60000, coolMs: 15000 },
    signal:  { maxOnMs: 20000, duty: 0.8, windowMs: 60000, coolMs: 5000 },
    rear:    { maxOnMs: 30000, duty: 0.8, windowMs: 60000, coolMs: 10000 },
};
const CLASS_OF = (id) => (/^high/.test(id) ? 'high' : /^(low|drl)/.test(id) ? 'low' : /^fog/.test(id) ? 'fog'
    : /^ind/.test(id) ? 'signal' : 'rear');

class ThermalGuard {
    constructor(opts) {
        const o = opts || {};
        this.now = o.now || Date.now;
        this.classes = JSON.parse(JSON.stringify(CLASSES));
        this.onSince = {};     // id -> when it went on (lit now)
        this.history = {};     // id -> [[from, to], ...] within the window
        this.coolUntil = {};   // id -> no lighting before this time
        this.trips = [];       // [{ id, why, t }] (for the page)
    }
    /** settings: { highBeamMaxS, cooldownS, maxDuty } */
    configure(s) {
        const h = this.classes.high;
        if (s.highBeamMaxS) h.maxOnMs = Number(s.highBeamMaxS) * 1000;
        if (s.cooldownS) h.coolMs = Number(s.cooldownS) * 1000;
        if (s.maxDuty) h.duty = Number(s.maxDuty);
    }
    cls(id) { return this.classes[CLASS_OF(id)]; }
    _litMs(id, t) {
        const c = this.cls(id), from = t - c.windowMs;
        const h = (this.history[id] || []).filter((x) => x[1] > from);
        this.history[id] = h;
        let ms = h.reduce((a, x) => a + (x[1] - Math.max(x[0], from)), 0);
        if (this.onSince[id] !== undefined) ms += t - Math.max(this.onSince[id], from);
        return ms;
    }
    /** may this lamp light now? { ok, why } */
    allow(id) {
        const t = this.now(), c = this.cls(id);
        if (this.coolUntil[id] && t < this.coolUntil[id]) return { ok: false, why: 'cooling down ' + Math.ceil((this.coolUntil[id] - t) / 1000) + ' s' };
        if (this._litMs(id, t) >= c.duty * c.windowMs) return { ok: false, why: 'duty limit ' + Math.round(c.duty * 100) + '%' };
        return { ok: true };
    }
    /** the lamps lit now (a Set): starts and ends their on time */
    update(lit) {
        const t = this.now();
        Object.keys(this.onSince).forEach((id) => {
            if (!lit.has(id)) { (this.history[id] = this.history[id] || []).push([this.onSince[id], t]); delete this.onSince[id]; }
        });
        lit.forEach((id) => { if (this.onSince[id] === undefined) this.onSince[id] = t; });
    }
    /** the lit lamps over a limit now: [{ id, why }] - each one then cools down before it may light again */
    over() {
        const t = this.now(), out = [];
        Object.keys(this.onSince).forEach((id) => {
            const c = this.cls(id);
            let why = null;
            if (t - this.onSince[id] >= c.maxOnMs) why = 'on ' + Math.round(c.maxOnMs / 1000) + ' s without a break';
            else if (this._litMs(id, t) >= c.duty * c.windowMs) why = 'lit over ' + Math.round(c.duty * 100) + '% of the last ' + Math.round(c.windowMs / 1000) + ' s';
            if (why) { this.coolUntil[id] = t + c.coolMs; out.push({ id, why }); this.trips.push({ id, why, t }); }
        });
        if (this.trips.length > 20) this.trips.splice(0, this.trips.length - 20);
        return out;
    }
    /** the longest a frame may hold this lamp (the sequence compiler clamps to it) */
    maxFrameMs(id) { return this.cls(id).maxOnMs; }
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Guardian: the one way back                                                                                    */
/* ------------------------------------------------------------------------------------------------------------ */

class Guardian extends EventEmitter {
    /**
     * parts: { link, player, manual, verify: async () => void, log }
     * opts:  { stallMs (no frame for this long while running: stop, 5000), now }
     */
    constructor(parts, opts) {
        super();
        Object.assign(this, parts);
        const o = opts || {};
        this.now = o.now || Date.now;
        this.stallMs = o.stallMs || 5000;
        this.busy = null;                 // the teardown in progress (a Promise)
        this.lastReason = '';
        this.lastFrameAt = 0;
        this.count = 0;
    }
    /** the player / manual control showed a frame (the stall watchdog) */
    beat() { this.lastFrameAt = this.now(); const st = this.link && this.link.stats; this.lastDone = st ? st.ok + st.refused : 0; }
    /** something running that owns lamps? */
    running() { return !!((this.player && (this.player.running || this.player.ending)) || (this.manual && this.manual.running)); }
    /**
     * Give everything back. Calls made while one runs wait for it (one teardown at a time, never two talking to the
     * car at once). Resolves with the reason.
     */
    returnToEcu(reason) {
        if (this.busy) return this.busy;
        this.lastReason = reason || 'stop';
        this.count++;
        if (this.log) this.log.info('light show: return control to the ECUs (' + this.lastReason + ')');
        this.busy = (async () => {
            try {
                if (this.player && (this.player.running || this.player.ending)) await this.player.stop();
                if (this.manual && this.manual.running) await this.manual.stop();
                // link.stop(): every held lamp released (every give-back form), headlight modes switched off, default
                // sessions - each unit's default session hands every output back even where the release was refused
                if (this.link && this.link.active) { this.link.teardown = true; await this.link.stop(); this.link.teardown = false; }
            } catch (e) {
                if (this.log) this.log.warn('light show: teardown: ' + (e && e.message || e));
            } finally {
                this.busy = null;
                this.emit('done', this.lastReason);
            }
            // the check that everything went back (the brake lights read): after the teardown, so a new start isn't
            // held up by it (the link's queue keeps the two from overlapping on the car)
            if (this.verify) this.verifying = Promise.resolve().then(() => this.verify()).catch(() => null);
            return this.lastReason;
        })();
        return this.busy;
    }
    /** periodic: a run that stopped making progress is ended. Progress is a frame shown or a request answered
     *  (one frame of many lamps takes ~300 ms a lamp through the head unit: slow, not stuck) */
    watch() {
        if (!this.running() || this.busy) return null;
        const st = this.link && this.link.stats, done = st ? st.ok + st.refused : 0;
        if (done !== this.lastDone) { this.lastDone = done; this.lastFrameAt = this.now(); }
        if (this.lastFrameAt && this.now() - this.lastFrameAt > this.stallMs) return this.returnToEcu('stalled: nothing answered for ' + Math.round(this.stallMs / 1000) + ' s');
        return null;
    }
    /**
     * SIGTERM / SIGINT (MainApp stopping the app): give the lamps back first (at most graceMs), then end exactly as
     * without this handler - the handler removed and the same signal raised again, so MainApp sees the stop it
     * asked for (an exit it didn't expect makes it wipe the app's data, see the repo README 4.3).
     */
    installSignals(proc, graceMs) {
        const p = proc || process, g = graceMs || 1500;
        const handlers = {};
        const handler = (sig) => {
            let ended = false;
            const done = () => {
                if (ended) return; ended = true;
                p.removeListener(sig, handlers[sig]);
                try { p.kill(p.pid, sig); } catch (e) { try { p.exit(0); } catch (e2) { /* tests */ } }
            };
            if (!this.running() && !(this.link && this.link.active)) return done();
            const tm = setTimeout(done, g);
            this.returnToEcu(sig).then(() => { clearTimeout(tm); done(); });
        };
        ['SIGTERM', 'SIGINT'].forEach((s) => { handlers[s] = () => handler(s); p.on(s, handlers[s]); });
        return handler;
    }
}

module.exports = { RateLimiter, ThermalGuard, Guardian, PROFILES, CLASSES, CLASS_OF, BUSY_NRC };
