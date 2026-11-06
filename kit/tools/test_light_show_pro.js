'use strict';

// Light Show 0.6 additions (apps/light_show): the rate limiter, the thermal guard, the Guardian's teardown, the
// sequence compiler, loop counts, manual control, and the app wired together (Manual page, leaving the screen,
// a sequence file on the car). test_light_show.js still covers everything 0.5 did.
//   node kit/tools/test_light_show_pro.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const APP = path.join(ROOT, 'apps', 'light_show');
const SPEC = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));

let passed = 0;
async function check(name, fn) {
    try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + ': ' + (e && e.stack || e).toString().split('\n').slice(0, 3).join(' | ')); process.exitCode = 1; }
}
const hexs = (b) => b.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* a fake clock: now() and sleep(ms) that advances it */
function clock() { const c = { t: 1000000 }; c.now = () => c.t; c.sleep = async (ms) => { c.t += ms; }; return c; }

/* the car as far as these tests need it: every unit takes every request (the 0.5 test has the picky one) */
const sent = [];
const car = { answer: true, nrc: null };
class OkDiag extends EventEmitter {
    constructor() { super(); this.available = true; }
    init() {}
    async send() { return 'NO_ERROR'; }
    async physical(target, sid, data) {
        sent.push([target, sid].concat(data));
        await new Promise((r) => setImmediate(r));
        if (!car.answer) return null;
        if (car.nrc) return [0x7F, sid, car.nrc];
        if (sid === 0x22 && data[0] === 0xD6 && data[1] === 0xDB) { const st = []; for (let c = 0; c < 15; c++) st.push(100, 0, 120, 30, 1); return [0x62, 0xD6, 0xDB].concat(st); }
        if (sid === 0x22) { const st = []; for (let i = 0; i < 0x45; i++) st.push(0); return [0x62, data[0], data[1]].concat(st); }
        return [sid + 0x40].concat(data.slice(0, sid === 0x2F || sid === 0x2E ? 2 : sid === 0x31 ? 3 : 1));
    }
}
const stubs = { './kit/mgu': { run(a) { stubs.app = a; } }, './kit/diag': { Diag: OkDiag } };
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (stubs[req]) return stubs[req];
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};

(async () => {
    const L = require(path.join(APP, 'lamps.js'));
    const P = require(path.join(APP, 'patterns.js'));
    const SAFE = require(path.join(APP, 'safety.js'));
    const SEQ = require(path.join(APP, 'sequences.js'));
    const MAN = require(path.join(APP, 'manual.js'));

    /* ---------------- rate limiter ---------------- */
    await check('rate limiter: a burst, then requests spaced at the profile\'s rate, a gap per unit', async () => {
        const c = clock(), rl = new SAFE.RateLimiter({ profile: 'normal', link: 'headunit', now: c.now, sleep: c.sleep });
        const at = [];
        for (let i = 0; i < 10; i++) { await rl.acquire(0x40); at.push(c.t); }
        const span = at[9] - at[0];
        // 4 a second with a burst of 2: 10 requests take at least (10 - 2) / 4 s
        assert(span >= 1900 && span <= 2600, 'span ' + span);
        at.slice(1).forEach((t, i) => assert(t - at[i] >= 60, 'gap ' + (t - at[i])));
    });
    await check('rate limiter: busy / unanswered requests back off (doubling), an answer clears it; a refusal is not trouble', async () => {
        const c = clock(), rl = new SAFE.RateLimiter({ now: c.now, sleep: c.sleep });
        rl.report(0x40, { ok: false, nrc: 0x21 }); assert.strictEqual(rl.backoff, 250);
        rl.report(0x40, { ok: false, nrc: null }); assert.strictEqual(rl.backoff, 500);
        rl.report(0x40, { ok: false, nrc: 0x31 }); assert.strictEqual(rl.failures, 0, 'out of range: the unit answered');
        rl.report(0x40, { ok: true }); assert.strictEqual(rl.backoff, 0);
    });
    await check('rate limiter: trips after 6 failures in a row; then only teardown requests get through', async () => {
        const c = clock(), rl = new SAFE.RateLimiter({ now: c.now, sleep: c.sleep });
        let tripped = 0; rl.on('trip', () => tripped++);
        for (let i = 0; i < 6; i++) rl.report(0x40, { ok: false, nrc: null });
        assert(rl.tripped && tripped === 1);
        await assert.rejects(rl.acquire(0x40), /tripped/);
        await rl.acquire(0x40, { teardown: true });
        rl.reset(); await rl.acquire(0x40);
    });
    await check('rate limiter: the direct link allows more', async () => {
        const c = clock(), rl = new SAFE.RateLimiter({ now: c.now, sleep: c.sleep, link: 'direct' });
        for (let i = 0; i < 21; i++) await rl.acquire(0x40);
        assert(c.t - 1000000 <= 1100, 'took ' + (c.t - 1000000));
    });
    await check('LampLink: every request through the limiter; a tripped breaker blocks, link.stop still gets through', async () => {
        const c = clock(), rl = new SAFE.RateLimiter({ now: c.now, sleep: c.sleep });
        const link = new L.LampLink(new OkDiag(), { info() {}, warn() {} });
        link.gate = rl;
        sent.length = 0;
        await link.start();
        assert(rl.stats.granted >= 1);
        for (let i = 0; i < 6; i++) rl.report(0x40, { ok: false, nrc: null });
        const r = await link.request(0x40, [0x22, 0xE3, 0xB9]);
        assert(r.blocked && !r.ok, 'blocked');
        await link.stop();
        assert(sent.some((x) => hexs(x) === '40 10 01'), 'default session sent: ' + sent.map(hexs).join(' | '));
    });

    /* ---------------- thermal guard ---------------- */
    await check('thermal: a high beam on longer than allowed is over its limit and cools down', async () => {
        const c = clock(), th = new SAFE.ThermalGuard({ now: c.now });
        th.configure({ highBeamMaxS: 5, cooldownS: 10, maxDuty: 0.5 });
        th.update(new Set(['highL'])); c.t += 4000;
        assert.strictEqual(th.over().length, 0);
        c.t += 1500;
        const o = th.over();
        assert(o.length === 1 && o[0].id === 'highL', JSON.stringify(o));
        th.update(new Set());
        assert(!th.allow('highL').ok && /cooling/.test(th.allow('highL').why));
        c.t += 10001;
        assert(th.allow('highL').ok);
        assert(th.allow('fogL').ok, 'other lamps unaffected');
    });
    await check('thermal: duty - lit for more than its share of the last minute', async () => {
        const c = clock(), th = new SAFE.ThermalGuard({ now: c.now });
        th.configure({ highBeamMaxS: 15, maxDuty: 0.3 });
        for (let i = 0; i < 5; i++) { th.update(new Set(['highR'])); c.t += 4000; th.update(new Set()); c.t += 500; }
        assert(!th.allow('highR').ok && /duty/.test(th.allow('highR').why), th.allow('highR').why);
    });

    /* ---------------- sequences ---------------- */
    await check('sequences: groups, strobe, alternate, chase and repeat compile to frames with the right times', async () => {
        const r = SEQ.compile({ id: 't', name: 'T', loops: 2, steps: [
            { on: ['high', 'fogL'], ms: 300 }, { ms: 100 },
            { strobe: { on: ['fog'], hz: 2, duty: 0.5, ms: 1000 } },
            { alternate: { a: ['turnL'], b: ['turnR'], hz: 1, ms: 2000 } },
            { chase: { order: ['indFL', 'indFR'], stepMs: 150, rounds: 2 } },
            { repeat: 2, steps: [{ on: ['reverse'], ms: 200 }, { ms: 200 }] },
        ] });
        assert(r.ok, r.errors.join(' | '));
        const f = r.pattern.frames;
        assert.deepStrictEqual(f[0], { ms: 300, on: ['highL', 'highR', 'fogL'] });
        assert.deepStrictEqual(f[1], { ms: 100, on: [] });
        assert.strictEqual(f.slice(2, 6).map((x) => x.ms + ':' + x.on.length).join(), '250:2,250:0,250:2,250:0');
        assert.strictEqual(f.slice(6, 10).map((x) => x.ms + ':' + x.on[0]).join(), '500:indFL,500:indFR,500:indFL,500:indFR');
        assert.strictEqual(f.slice(10, 14).map((x) => x.on[0]).join(), 'indFL,indFR,indFL,indFR');
        assert.strictEqual(f.slice(14).map((x) => x.ms + ':' + x.on.length).join(), '200:2,200:0,200:2,200:0');
        assert(r.pattern.id === 'seq:t' && r.pattern.kind === 'show' && r.pattern.loops === 2);
    });
    await check('sequences: the car\'s limits clamped with a warning (too short, too fast)', async () => {
        const r = SEQ.compile({ id: 'c', steps: [{ on: ['high'], ms: 10 }, { strobe: { on: ['fog'], hz: 40, ms: 500 } }] });
        assert(r.ok && r.pattern.frames.every((x) => x.ms >= SEQ.MIN_STEP_MS));
        assert(r.warnings.some((w) => /shorter than/.test(w)) && r.warnings.some((w) => /faster than/.test(w)), r.warnings.join(' | '));
    });
    await check('sequences: fades, tail / plate / brake / puddle lights and unknown names refused with the reason', async () => {
        const r = SEQ.compile({ id: 'x', steps: [{ on: ['tail'], ms: 200, fadeMs: 100 }, { on: ['brakeL', 'puddle', 'nope'], ms: 100 }] });
        assert(!r.ok && !r.pattern);
        const e = r.errors.join(' | ');
        assert(/fades are not possible/.test(e) && /tail lights/.test(e) && /brake lights/.test(e) && /puddle/.test(e) && /unknown lamp "nope"/.test(e), e);
    });
    await check('sequences: a frame holding the high beams past the thermal limit is split', async () => {
        const th = new SAFE.ThermalGuard(); th.configure({ highBeamMaxS: 5 });
        const r = SEQ.compile({ id: 'h', steps: [{ on: ['high', 'fog'], ms: 9000 }] }, { maxFrameMs: (id) => th.maxFrameMs(id) });
        assert(r.ok);
        assert.strictEqual(r.pattern.frames.map((x) => x.ms + ':' + x.on.join('+')).join(), '5000:highL+highR+fogL+fogR,4000:fogL+fogR');
        assert(r.warnings.some((w) => /thermal limit/.test(w)));
    });
    await check('sequences: a file keeps the good sequences, names the bad ones; defaults and the settings strobe compile', async () => {
        const r = SEQ.load(JSON.stringify({ sequences: [{ id: 'good', steps: [{ on: ['drl'], ms: 500 }] }, { id: 'Bad id', steps: [] }, { id: 'good', steps: [{ ms: 100 }] }] }));
        assert.deepStrictEqual(r.sequences.map((s) => s.id), ['seq:good']);
        assert(r.problems.some((p) => /id:/.test(p)) && r.problems.some((p) => /used twice/.test(p)), r.problems.join(' | '));
        assert(/not JSON/.test(SEQ.load('{').problems[0]));
        const d = SEQ.load(JSON.stringify(SEQ.DEFAULTS));
        assert.strictEqual(d.sequences.length, SEQ.DEFAULTS.length, d.problems.join(' | '));
        const s = SEQ.settingsStrobe({ strobeHz: 4, pulseMs: 100, strobeLamps: 'front', loops: '3' });
        assert(s.ok && s.pattern.loops === 3 && s.pattern.frames[0].ms === 100 && s.pattern.frames[1].ms === 150, JSON.stringify(s.pattern.frames.slice(0, 2)));
    });

    /* ---------------- the player: loop counts, thermal allow ---------------- */
    function fakeLink() {
        const log = [];
        return { log, how: {}, layout: L.LAYOUT['03 E A 00'], active: false, noRelease: false, timer: null,
            async start() { this.active = true; return true; }, async stop() { this.active = false; log.push('stop'); },
            async set(id, on) { log.push(id + (on ? '+' : '-')); return { ok: true }; },
            async fn(id, ms) { log.push('fn ' + L.FN[id] + ' ' + ms); return { ok: true }; },
            async burst() { return []; }, async readStates() { return null; } };
    }
    await check('player: a pattern with loops stops by itself after that many rounds, every lamp back', async () => {
        const link = fakeLink();
        const pl = new P.Player(link, { wait: () => Promise.resolve() });
        pl.start({ id: 'seq:x', kind: 'show', loops: 3, frames: [{ ms: 10, on: ['fogL'] }, { ms: 10, on: [] }] }, 1);
        await pl.loop;
        assert(!pl.running && pl.finished && pl.rounds === 3, 'rounds ' + pl.rounds);
        assert.strictEqual(link.log.filter((x) => x === 'fogL+').length, 3);
        assert.strictEqual(link.log[link.log.length - 1], 'stop');
    });
    await check('player: a lamp the thermal guard holds back stays dark', async () => {
        const link = fakeLink();
        const pl = new P.Player(link, { wait: () => Promise.resolve(), allow: (id) => id !== 'highL' });
        pl.start({ id: 'x', kind: 'show', loops: 2, frames: [{ ms: 10, on: ['highL', 'highR'] }, { ms: 10, on: [] }] }, 1);
        await pl.loop;
        assert(!link.log.includes('highL+') && link.log.includes('highR+'), link.log.join(' '));
    });

    /* ---------------- manual control ---------------- */
    await check('manual: Solid - high beams held (the headlight function sent again before it runs out); tail refused with the reason', async () => {
        const c = clock(), link = fakeLink();
        link.how = { highL: 'flm', highR: 'flm' };
        const m = new MAN.Manual(link, { now: c.now, wait: c.sleep });
        assert(!m.set('tail', true) && /tail/.test(m.why('tail')));
        assert(m.set('high', true));
        m.mode = 'solid'; m.running = true; m.t0 = c.t;
        for (let i = 0; i < 75; i++) { await m.step(c.t); c.t += 40; }      // 3 s
        const on = link.log.filter((x) => x === 'highL+').length;
        assert(on >= 3 && on <= 5 && !link.log.includes('highL-'), 'sent ' + on + 'x: ' + link.log.join(' '));
    });
    await check('manual: Blink at 2 Hz - on half, off half, ~2 times a second (a fast link)', async () => {
        const c = clock(), link = fakeLink(); link.stats = { ms: 20 };
        const m = new MAN.Manual(link, { now: c.now, wait: c.sleep });
        m.set('fog', true); m.mode = 'blink'; m.hz = 2; m.running = true; m.t0 = c.t;
        for (let i = 0; i < 75; i++) { await m.step(c.t); c.t += 40; }      // 3 s
        const on = link.log.filter((x) => x === 'fogL+').length, off = link.log.filter((x) => x === 'fogL-').length;
        assert(on === 6 && off >= 5, on + ' on, ' + off + ' off');
    });
    await check('manual: the effect slows to what the car can take (300 ms a request), and says so', async () => {
        const link = fakeLink(); link.stats = { ms: 300 };
        const m = new MAN.Manual(link, {});
        m.set('high', true); m.set('fog', true); m.mode = 'blink'; m.hz = 8;
        // 4 lamps, on and off a period: 8 requests of 300 ms: at most ~0.38 Hz
        assert(m.effHz() < 0.5 && m.effHz() > 0.3, 'eff ' + m.effHz());
        m.allOff(); m.set('ledL0', true);           // a whole headlight in one request
        assert(m.effHz() > 1.4, 'one target: ' + m.effHz());
    });
    await check('manual: Strobe - short flashes; Single flash x3 - three flashes, then done', async () => {
        const c = clock(), link = fakeLink(); link.stats = { ms: 20 };
        let done = 0;
        const m = new MAN.Manual(link, { now: c.now, wait: c.sleep, onDone: () => done++ });
        m.set('reverse', true); m.mode = 'flash'; m.count = 3; m.hz = 2; m.running = true; m.t0 = c.t;
        for (let i = 0; i < 100 && !m.done; i++) { await m.step(c.t); c.t += 40; }
        assert(m.done && link.log.filter((x) => x === 'revL+').length === 3, link.log.join(' '));
        assert(!m.lit.size, 'all dark at the end');
        const s2 = fakeLink(); s2.stats = { ms: 20 };
        const st = new MAN.Manual(s2, { now: c.now, wait: c.sleep });
        st.set('reverse', true); st.mode = 'strobe'; st.hz = 2; st.running = true; st.t0 = c.t;
        let litTicks = 0;
        for (let i = 0; i < 25; i++) { await st.step(c.t); if (st.lit.has('revL')) litTicks++; c.t += 40; }    // 1 s
        assert(litTicks >= 4 && litTicks <= 8, 'lit ' + litTicks + ' of 25 ticks');
    });
    await check('manual: Pulse on LED channels steps the brightness up and down; lamps without dimming blink', async () => {
        const c = clock(), sent2 = [];
        const link = fakeLink(); link.stats = { ms: 20 };
        link.set = async (id, on, offAs, ms, par, pwm) => { sent2.push(id + (on ? '@' + pwm : '-')); return { ok: true }; };
        const m = new MAN.Manual(link, { now: c.now, wait: c.sleep });
        m.set('ledL3', true); m.set('fog', true); m.mode = 'pulse'; m.hz = 1; m.brightness = 80; m.running = true; m.t0 = c.t;
        for (let i = 0; i < 30; i++) { await m.step(c.t); c.t += 40; }      // a period and a bit
        const levels = sent2.filter((x) => /^ledL3@/.test(x)).map((x) => Number(x.split('@')[1]));
        assert.deepStrictEqual(levels.slice(0, 7), [20, 40, 60, 80, 60, 40, 20], levels.join());
        assert(sent2.includes('fogL@undefined') && sent2.includes('fogL-'), sent2.join(' '));
    });
    await check('manual: a whole headlight and its single LEDs are one or the other; hazards and turn signals too', async () => {
        const m = new MAN.Manual(fakeLink(), {});
        m.set('ledL2', true); m.set('ledL0', true);
        assert(m.isOn('ledL0') && !m.isOn('ledL2'));
        m.set('ledL5', true); assert(!m.isOn('ledL0') && m.isOn('ledL5'));
        m.set('ledR0', true); assert(m.isOn('ledL5') && m.isOn('ledR0'), 'other side unaffected');
        m.set('hazard', true); m.set('turnL', true); assert(!m.isOn('hazard') && m.isOn('turnL'));
    });
    await check('manual: the thermal guard switches a lamp off and says why', async () => {
        const c = clock(), link = fakeLink(), th = new SAFE.ThermalGuard({ now: c.now });
        th.configure({ highBeamMaxS: 3, cooldownS: 10 });
        let forced = [];
        const m = new MAN.Manual(link, { now: c.now, wait: c.sleep, thermal: th, onForcedOff: (o) => { forced = forced.concat(o); } });
        m.set('high', true); m.running = true; m.t0 = c.t;
        for (let i = 0; i < 100; i++) { await m.step(c.t); c.t += 40; }
        assert(forced.some((x) => x.id === 'highL') && link.log.includes('highL-') && /cooling/.test(m.blocked.highL));
    });
    await check('LED channels: the requests as the SGBD describes them; time never over 2 s; stop routine at the end', async () => {
        const link = new L.LampLink(new OkDiag(), { info() {}, warn() {} });
        sent.length = 0;
        await link.start();
        await link.set('ledL4', true, null, 1000, false, 60);
        await link.set('ledR0', true, null, 300, false, 100);
        await link.set('ledL4', false);
        await link.stop();
        const s2 = sent.map(hexs);
        assert(s2.includes('43 31 01 A5 4B 04 3C 02') && s2.includes('44 31 01 A5 4B 00 64 01') && s2.includes('43 31 01 A5 4B 04 00 01'), s2.join(' | '));
        assert(s2.includes('43 31 02 A5 4B') && s2.includes('44 31 02 A5 4B') && s2.includes('43 10 01'), s2.join(' | '));
        assert(!s2.some((x) => / 31 01 A5 4B .. .. (0[3-9A-F]|[1-9A-F].)$/.test(x)), 'no time over 2 s');
    });

    /* ---------------- guardian ---------------- */
    await check('guardian: one teardown at a time (calls during one wait for it), player and manual stopped, link stopped', async () => {
        const link = fakeLink(); link.active = true;
        const pl = new P.Player(link, { wait: (ms) => sleep(Math.min(ms, 5)) });
        const m = new MAN.Manual(link, {});
        const g = new SAFE.Guardian({ link, player: pl, manual: m, verify: async () => { link.log.push('verify'); } });
        pl.start({ id: 'x', kind: 'show', frames: [{ ms: 20, on: ['fogL'] }, { ms: 20, on: [] }] }, 1);
        await sleep(15);
        const a = g.returnToEcu('a'), b = g.returnToEcu('b');
        assert.strictEqual(a, b, 'same teardown');
        await a; await g.verifying;
        assert(!pl.running && !link.active && g.count === 1 && link.log.includes('verify'));
    });
    await check('guardian: a player that stops producing frames is ended; SIGTERM gives the lamps back, then the signal ends the app as before', async () => {
        const c = clock(), link = fakeLink(); link.active = true;
        const pl = { running: true, ending: false, async stop() { this.running = false; } };
        const g = new SAFE.Guardian({ link, player: pl }, { now: c.now, stallMs: 5000 });
        // slow but answering (a frame of many lamps, ~300 ms a request): not a stall
        link.stats = { ok: 0, refused: 0 };
        g.beat();
        for (let i = 0; i < 8; i++) { c.t += 1000; link.stats.ok++; await g.watch(); }
        assert(pl.running, 'answered requests keep it going');
        c.t += 6000;
        await g.watch();
        assert(!pl.running && /stalled/.test(g.lastReason), g.lastReason);
        // SIGTERM: lamps back first, then the same signal again with the handler gone (ends as it would without it)
        const proc = new EventEmitter(); let killed = null; proc.pid = 4242; proc.kill = (pid, sig) => { killed = pid + ' ' + sig + ' ' + proc.listenerCount(sig); };
        link.active = true; pl.running = true;
        g.installSignals(proc, 1000);
        proc.emit('SIGTERM');
        await sleep(20);
        assert(killed === '4242 SIGTERM 0' && !link.active && g.lastReason === 'SIGTERM', killed);
    });

    /* ---------------- the app ---------------- */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'light-show-pro-'));
    fs.writeFileSync(path.join(dir, 'lamp-check.json'), JSON.stringify({ _layout: '03 E A 00', _noRelease: true,
        highL: { ok: true, how: 'flm' }, highR: { ok: true, how: 'flm' }, lowL: { ok: true, how: 'flm' }, lowR: { ok: true, how: 'flm' } }));
    fs.writeFileSync(path.join(dir, 'light-sequences.json'), JSON.stringify([{ id: 'mine', name: 'Mine', loops: 1, steps: [{ on: ['high'], ms: 60 }, { ms: 60 }] }, { id: 'broken', steps: [{ on: ['tail'], ms: 100 }] }]));
    const S = {}; SPEC.settings.forEach((s) => { S[s.key] = s.default; });
    const loops = {}, clicks = {}, warns = [], listeners = [], vis = [], taps = [];
    let speedCb = null;
    const ctx = {
        app: {}, ui: { onClick: (id, fn) => { clicks[id] = fn; }, text() {}, image: async () => {}, onVisible: (f) => vis.push(f), onFocus() {} },
        settings: { get: (k) => S[k], set: (k, v) => { S[k] = v; listeners.forEach((f) => f(k, v)); }, onChange: (f) => listeners.push(f), display: (k) => String(S[k]) },
        log: { info() {}, warn: (m) => warns.push(m), error: (m, e) => warns.push(m + ' ' + e) },
        spec: SPEC, dataDir: dir, directOpts: { connectTimeoutMs: 50 }, rateOpts: { sleep: () => Promise.resolve() },
        signals: { watch: (iface, inst, h) => { if (h.statusCarSpeed2) speedCb = h.statusCarSpeed2; return Promise.resolve({}); } },
        onTab() {}, onTap: (f) => taps.push(f), loop: (name, fps, fn) => { loops[name] = fn; },
        theme: () => require(path.join(KIT, 'themes')).theme('m_tricolour'), canvas: (w, h) => new (require(path.join(KIT, 'record')).Recorder)(w, h),
    };
    require(path.join(APP, 'main.js'));
    const app = await stubs.app.start(ctx);
    const toPage = async (n) => { for (let i = 0; i < 4 && app.pages() !== n; i++) await clicks.BTN_PAGE(); };

    await check('app: the sequence file read - the good one listed after the patterns, the broken one named', async () => {
        const ids = app.sequences().map((s) => s.id);
        assert.deepStrictEqual(ids, ['seq:mine']);
        assert(app.seqProblems().some((p) => /broken/.test(p) && /tail/.test(p)), app.seqProblems().join(' | '));
        S.pattern = 'custom';
        for (let i = 0; i < 40 && S.pattern !== 'seq:mine'; i++) await clicks.BTN_PATTERN();
        assert.strictEqual(S.pattern, 'seq:mine', 'Next pattern reaches the sequence');
    });
    await check('app: a sequence with a loop count runs, ends by itself, every lamp handed back', async () => {
        sent.length = 0;
        await clicks.BTN_RUN();
        for (let i = 0; i < 100 && (app.player.running || app.player.ending); i++) await sleep(20);
        assert(!app.player.running && app.player.rounds === 1, 'rounds ' + app.player.rounds);
        const s = sent.map(hexs);
        assert(s.some((x) => /^43 2E D6 DC 00 0F 0[12]/.test(x)) && s.some((x) => /^44 2E D6 DC 00 0F 0[12]/.test(x)), s.join(' | '));
        assert(s.some((x) => x === '40 10 01'), 'default session at the end');
    });
    const pick = async (key) => { const all = app.items(), k = all.findIndex((x) => x.kind === 'target' && x.key === key); await app.pressItem(all[k]); };
    const press = async (kind, key) => { const it = app.items().find((x) => x.kind === kind && (key === undefined || x.key === key)); await app.pressItem(it); };
    await check('app: the Manual page draws; Next pattern moves the focus, Start / stop presses the item', async () => {
        await toPage(3);
        await loops.MAIN();
        assert(!warns.some((w) => /TypeError|ReferenceError|is not a function/.test(w)), warns.join(' | '));
        const all = app.items();
        assert(all.filter((x) => x.kind === 'mode').length === 5 && all.filter((x) => x.kind === 'target').length === 29, all.length + ' items');
        // controller: to the Blink pill (2nd item), press it
        await clicks.BTN_PATTERN(); await clicks.BTN_RUN();
        assert.strictEqual(S.manualMode, 'blink');
        await press('mode', 'solid');
    });
    await check('app: pick High beams, RUN (Solid) - the headlight modules lit; STOP hands everything back', async () => {
        await pick('high');
        sent.length = 0;
        await press('run'); await sleep(150);
        assert(app.manual.running && sent.map(hexs).some((x) => /^43 2E D6 DC 00 0F/.test(x)), sent.map(hexs).join(' | '));
        await loops.MAIN();
        await press('run');
        assert(!app.manual.running && sent.map(hexs).some((x) => /10 01$/.test(x)));
    });
    await check('app: Scan LEDs finds the channels; LED 3 left blinks at the brightness set; parameters kept in settings', async () => {
        await app.runLedScan();
        assert(app.scan.found.L.length === 15 && app.scan.found.R.length === 15, JSON.stringify(app.scan.found));
        await pick('high');                                    // (unpick)
        await pick('ledL3');
        await press('mode', 'blink');
        for (let i = 0; i < 3; i++) await press('step', 'manualBrightness');      // (the first matching is -: 100 -> 70)
        assert.strictEqual(S.manualBrightness, 70);
        sent.length = 0;
        await press('run'); await sleep(1200);
        const s2 = sent.map(hexs);
        assert(s2.some((x) => x === '43 31 01 A5 4B 03 46 01') && s2.some((x) => x === '43 31 01 A5 4B 03 00 01'), s2.join(' | '));
        await press('run');
        assert(!app.manual.running && sent.map(hexs).includes('43 31 02 A5 4B'));
        await loops.MAIN();
        assert(!warns.some((w) => /TypeError|ReferenceError|is not a function/.test(w)), warns.join(' | '));
        await press('clear');
    });
    await check('app: Single flash - the flashes, then everything back to the car by itself', async () => {
        await pick('ledR0'); await press('mode', 'flash');
        S.manualCount = 2; S.manualHz = 4; listeners.forEach((f) => f('manualHz'));
        sent.length = 0;
        await press('run');
        for (let i = 0; i < 100 && app.manual.running; i++) await sleep(20);
        const s2 = sent.map(hexs);
        assert(!app.manual.running && s2.filter((x) => /^44 31 01 A5 4B 00 46/.test(x)).length === 2, s2.join(' | '));
        assert(s2.includes('44 31 02 A5 4B'));
        await press('clear'); await press('mode', 'solid'); S.manualHz = 2; S.manualBrightness = 100; listeners.forEach((f) => f('manualHz'));
    });
    await check('app: tail lights: not offered (the reason given)', async () => {
        const ok = await app.manualToggle('tail');
        assert(!ok && !app.manual.running);
    });
    await check('app: leaving the screen while an effect runs hands everything back', async () => {
        await pick('high'); await press('run');
        await sleep(100);
        assert(app.manual.running);
        sent.length = 0;
        vis.forEach((f) => f('MAIN', false));
        await app.guardian.busy;
        assert(!app.manual.running && !app.link.active, 'stopped');
        assert(sent.map(hexs).some((x) => /10 01$/.test(x)), sent.map(hexs).join(' | '));
    });
    await check('app: manual control won\'t start while the car moves (Only while parked on)', async () => {
        speedCb({ speedVehicleCentreOfGravity: 20 / 0.015625 });
        await press('run');
        assert(!app.manual.running);
        speedCb({ speedVehicleCentreOfGravity: 0 });
    });
    await check('app: Only while parked on: nothing starts while the car moves', async () => {
        await toPage(0);
        S.pattern = 'wigwag'; S.parkedOnly = true;
        speedCb({ speedVehicleCentreOfGravity: 30 / 0.015625 });
        sent.length = 0;
        await clicks.BTN_RUN(); await sleep(50);
        assert(!app.player.running && !sent.some((x) => x[1] === 0x2E || x[1] === 0x2F), sent.map(hexs).join(' | '));
        await app.manualRun();
        assert(!app.manual.running, 'manual refused');
    });
    await check('app: Only while parked off: a light show runs while driving, the low beams never touched', async () => {
        S.pattern = 'all'; S.parkedOnly = false;
        sent.length = 0;
        await clicks.BTN_RUN(); await sleep(400);
        assert(app.player.running, 'running while driving');
        await clicks.BTN_RUN();
        for (let i = 0; i < 100 && (app.player.running || app.player.ending); i++) await sleep(20);
        const s2 = sent.map(hexs);
        assert(s2.some((x) => /2E D6 DC 00 0F 0[12]$/.test(x)), 'high beams flashed: ' + s2.join(' | '));
        assert(!s2.some((x) => /2E D6 DC 00 (05|33) /.test(x)), 'low beams / daytime lights untouched: ' + s2.join(' | '));
    });
    await check('app: Only while parked off: manual control works while driving', async () => {
        await app.manualRun(); await sleep(100);
        assert(app.manual.running);
        await app.manualRun();
        assert(!app.manual.running);
        app.manual.allOff();
    });
    await check('app: keep headlights on switched off: while driving a show may take over the low beams, panic flashing runs', async () => {
        S.drivingGuard = false; S.pattern = 'all';
        sent.length = 0;
        await clicks.BTN_RUN(); await sleep(400);
        await clicks.BTN_RUN();
        for (let i = 0; i < 100 && (app.player.running || app.player.ending); i++) await sleep(20);
        assert(sent.map(hexs).some((x) => /2E D6 DC 00 05 /.test(x)), 'low beams switched: ' + sent.map(hexs).join(' | '));
        S.pattern = 'hstrobe'; sent.length = 0;
        await clicks.BTN_RUN(); await sleep(100);
        assert(app.player.running, 'panic flashing runs');
        await clicks.BTN_RUN();
        for (let i = 0; i < 100 && (app.player.running || app.player.ending); i++) await sleep(20);
        S.drivingGuard = true;
    });
    await check('app: keep headlights on (default): LED channels not offered while driving, offered again when it is off', async () => {
        assert(/not while driving/.test(app.manual.why('ledL3')) && app.manual.idsOf('ledL3').length === 0, app.manual.why('ledL3'));
        S.drivingGuard = false;
        assert.strictEqual(app.manual.idsOf('ledL3').length, 1);
        S.drivingGuard = true;
    });
    await check('app: while driving, Scan LEDs and the Lamp check don\'t start', async () => {
        sent.length = 0;
        await app.runLedScan(); await app.runCheck();
        assert(!app.scan.running && !app.check.running && !sent.some((x) => x[1] === 0x31 || x[1] === 0x2F), sent.map(hexs).join(' | '));
    });
    await check('LED channels: given back (the driving guard) - the routine stopped, never dimmed for a second', async () => {
        const link = new L.LampLink(new OkDiag(), { info() {}, warn() {} });
        sent.length = 0;
        await link.start();
        await link.set('ledL4', true, null, 1000, false, 80);
        await link.set('ledL5', true, null, 1000, false, 80);
        await link.set('ledL6', true, null, 1000, false, 80);
        await link.set('ledL6', false);                         // (a blink's dark half: 0 % for a second)
        await link.set('ledL4', false, 'release');
        await link.set('ledL5', false, 'release');               // (already stopped: nothing more sent)
        let s2 = sent.map(hexs);
        assert(s2.filter((x) => x === '43 31 02 A5 4B').length === 1, 'one stop for the module: ' + s2.join(' | '));
        assert(!s2.includes('43 31 01 A5 4B 04 00 01') && !link.held.size && !link.ledEcus.size, s2.join(' | '));
        sent.length = 0;
        await link.stop();
        s2 = sent.map(hexs);
        assert(!s2.includes('43 31 02 A5 4B'), 'nothing left to stop: ' + s2.join(' | '));
    });
    await check('manual: the driving guard taking a picked LED away stops its headlight once, also mid dark half', async () => {
        const c = clock(), link = new L.LampLink(new OkDiag(), { info() {}, warn() {} });
        let driving = false;
        const m = new MAN.Manual(link, { now: c.now, wait: c.sleep, usable: (id) => !(L.BY_ID[id].led && driving) });
        await link.start();                                     // (its first answer sets the link's speed: fast here)
        m.set('ledL2', true); m.set('ledL3', true); m.mode = 'blink'; m.hz = 1; m.running = true; m.t0 = c.t;
        for (let i = 0; i < 16; i++) { await m.step(c.t); c.t += 40; }         // into the dark half
        assert(!m.lit.size && link.ledEcus.has(0x43), 'dark half, headlight still driven');
        sent.length = 0; driving = true;
        await m.step(c.t); await m.step(c.t + 40);
        const s2 = sent.map(hexs);
        assert(s2.filter((x) => x === '43 31 02 A5 4B').length === 1 && !link.ledEcus.size, s2.join(' | '));
        await link.stop();
    });
    await check('thermal: an LED channel may be held 2 minutes (the car runs them all night)', async () => {
        const c = clock(), th = new SAFE.ThermalGuard({ now: c.now });
        th.update(new Set(['ledL1'])); c.t += 90000;
        assert.strictEqual(th.over().length, 0);
        c.t += 31000;
        assert.strictEqual(th.over()[0].id, 'ledL1');
    });
    await check('presets: Side Show Strobe and POV Strobe - known lamps only, in the Settings list, POV marked parked only', async () => {
        ['sideshow', 'pov'].forEach((id) => {
            const p = P.PATTERN[id];
            assert(p && p.kind === 'show' && p.frames.length > 10, id);
            p.frames.forEach((fr) => fr.on.forEach((x) => assert(L.BY_ID[x] && !L.BY_ID[x].usual || L.BY_ID[x].led, id + ': ' + x)));
            assert(SPEC.settings.find((x) => x.key === 'pattern').options.some((o) => o[0] === id), id + ' in Settings');
        });
        assert(P.PATTERN.pov.parked && !P.PATTERN.sideshow.parked);
    });
    await check('app: POV Strobe never runs while the car moves, even with Only while parked off; Side Show Strobe does', async () => {
        S.parkedOnly = false; S.pattern = 'pov';
        sent.length = 0;
        await clicks.BTN_RUN(); await sleep(50);
        assert(!app.player.running && !sent.some((x) => x[1] === 0x2E || x[1] === 0x31), sent.map(hexs).join(' | '));
        S.pattern = 'sideshow';
        await clicks.BTN_RUN(); await sleep(300);
        assert(app.player.running, 'side show runs');
        await clicks.BTN_RUN();
        for (let i = 0; i < 100 && (app.player.running || app.player.ending); i++) await sleep(20);
    });
    await check('app: keep headlights on (default): headlight panic flashing never starts while driving', async () => {
        S.pattern = 'hstrobe';
        sent.length = 0;
        await clicks.BTN_RUN(); await sleep(50);
        assert(!app.player.running && !sent.some((x) => x[1] === 0x2E), sent.map(hexs).join(' | '));
        speedCb({ speedVehicleCentreOfGravity: 0 }); S.parkedOnly = true;
    });
    await check('app: the custom strobe follows the settings', async () => {
        S.pattern = 'custom'; S.strobeHz = 4; S.pulseMs = 100; S.strobeLamps = 'fog'; S.loops = '5';
        const p = app.pattern();
        assert(p.id === 'custom' && p.loops === 5 && p.frames[0].ms === 100 && p.frames[0].on.join() === 'fogL,fogR', JSON.stringify(p.frames[0]));
        await toPage(0); await loops.MAIN();
        assert(!warns.some((w) => /TypeError|ReferenceError|is not a function/.test(w)), warns.join(' | '));
    });

    console.log(passed + ' checks passed');
    process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
