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
        if (sid === 0x22) { const st = []; for (let i = 0; i < 0x45; i++) st.push(0); return [0x62, data[0], data[1]].concat(st); }
        return [sid + 0x40].concat(data.slice(0, sid === 0x2F || sid === 0x2E ? 2 : 1));
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
    await check('manual: high beams held (headlight function sent again before it runs out), hazards blink by side function once a pass', async () => {
        const c = clock(), link = fakeLink();
        link.how = { highL: 'flm', highR: 'flm' };
        const m = new MAN.Manual(link, { now: c.now, wait: c.sleep, viaFn: (id) => /^ind/.test(id) });
        assert(m.set('high', true) && m.set('hazard', true));
        assert(!m.set('tail', true) && /tail/.test(m.why('tail')), 'tail refused');
        m.running = true;
        for (let i = 0; i < 30; i++) { await m.step(c.t); c.t += 100; }      // 3 s
        const highOn = link.log.filter((x) => x === 'highL+').length;
        assert(highOn >= 3 && highOn <= 5, 'high beam sent ' + highOn + 'x in 3 s');
        const fns = link.log.filter((x) => /^fn/.test(x));
        assert(fns.length >= 8, 'hazard flashes: ' + fns.join(' '));
        assert(fns.every((x) => / 333$/.test(x)), 'blink half period');
        // one request a side a pass, never one for each of front / mirror / rear
        const perPass = link.log.join(' ').split('fn 6').length - 1;
        assert(perPass === fns.filter((x) => /^fn 6/.test(x)).length);
    });
    await check('manual: a turn signal cancels the other and the hazards; the thermal guard switches a lamp off', async () => {
        const c = clock(), link = fakeLink(), th = new SAFE.ThermalGuard({ now: c.now });
        th.configure({ highBeamMaxS: 3, cooldownS: 10 });
        let forced = [];
        const m = new MAN.Manual(link, { now: c.now, wait: c.sleep, thermal: th, onForcedOff: (o) => { forced = forced.concat(o); } });
        m.set('hazard', true); m.set('turnL', true);
        assert(!m.isOn('hazard') && m.isOn('turnL'));
        m.set('turnR', true); assert(!m.isOn('turnL') && m.isOn('turnR'));
        m.allOff(); m.set('high', true); m.running = true;
        for (let i = 0; i < 40; i++) { await m.step(c.t); c.t += 100; }
        assert(forced.some((x) => x.id === 'highL'), 'forced off');
        assert(link.log.includes('highL-'), 'switched off: ' + link.log.slice(-6).join(' '));
        assert(/cooling/.test(m.blocked.highL), m.blocked.highL);
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
    await check('guardian: a player that stops producing frames is ended; SIGTERM gives the lamps back, then exits 0', async () => {
        const c = clock(), link = fakeLink(); link.active = true;
        const pl = { running: true, ending: false, async stop() { this.running = false; } };
        const g = new SAFE.Guardian({ link, player: pl }, { now: c.now, stallMs: 5000 });
        g.beat(); c.t += 6000;
        await g.watch();
        assert(!pl.running && /stalled/.test(g.lastReason));
        const proc = new EventEmitter(); let code = null; proc.exit = (x) => { code = x; };
        link.active = true; pl.running = true;
        g.installSignals(proc, 1000);
        proc.emit('SIGTERM');
        await sleep(20);
        assert(code === 0 && !link.active && g.lastReason === 'SIGTERM');
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
    await check('app: the Manual page draws; Next pattern moves the focus; Start / stop switches the tile; the last off ends the session', async () => {
        await toPage(3);
        await loops.MAIN();
        assert(!warns.some((w) => /TypeError|ReferenceError|is not a function/.test(w)), warns.join(' | '));
        await clicks.BTN_PATTERN();                       // Low beams -> High beams
        sent.length = 0;
        await clicks.BTN_RUN();
        await sleep(150);
        assert(app.manual.running && app.manual.isOn('high'));
        assert(sent.map(hexs).some((x) => /^43 2E D6 DC 00 0F/.test(x)), sent.map(hexs).join(' | '));
        await loops.MAIN();
        await clicks.BTN_RUN();
        assert(!app.manual.running);
        assert(sent.map(hexs).slice(-6).some((x) => x === '43 10 01' || x === '40 10 01'), sent.map(hexs).slice(-6).join(' | '));
    });
    await check('app: tail lights on the Manual page: not switched, the reason shown', async () => {
        const ok = await app.manualToggle('tail');
        assert(!ok && !app.manual.running);
    });
    await check('app: leaving the screen while holding a lamp hands everything back', async () => {
        await app.manualToggle('high');
        await sleep(100);
        assert(app.manual.running);
        sent.length = 0;
        vis.forEach((f) => f('MAIN', false));
        await app.guardian.busy;
        assert(!app.manual.running && !app.link.active, 'stopped');
        assert(sent.map(hexs).some((x) => /10 01$/.test(x)), sent.map(hexs).join(' | '));
    });
    await check('app: manual control won\'t start while the car moves', async () => {
        speedCb({ speedVehicleCentreOfGravity: 20 / 0.015625 });
        await app.manualToggle('high');
        assert(!app.manual.running);
        speedCb({ speedVehicleCentreOfGravity: 0 });
        app.manual.allOff();
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
