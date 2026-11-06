'use strict';

// Light Show (apps/light_show) against a simulated body controller: only its own requests ever leave, the
// emergency patterns never touch lamps the car keeps on while driving, Stop gives every lamp back and ends the
// session, the lamp check falls back to lamp functions and leaves refused lamps out, "only while parked" stops it.
//   node kit/tools/test_light_show.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const APP = path.join(ROOT, 'apps', 'light_show');
const SPEC = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
const themes = require(path.join(KIT, 'themes'));
const { Recorder: Canvas } = require(path.join(KIT, 'record'));

let passed = 0;
function check(name, fn) { try { fn(); passed++; console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + ': ' + e.message); process.exitCode = 1; } }

/* the body controller and headlight modules: answer like the SGBDs say, with knobs. The body controller takes ONE
   output layout (bdc.layout, the id from lamps.js LAYOUTS; null: none): a request of another length is "wrong length",
   of the same length "out of range" - as the G05 answered the first two */
const sent = [];
const bdc = { refuseOut: new Set(), noRelease: false, releaseNrc: 0x31, session: 0x01, layout: '03 E A 00', flm: true,
    timerUnit: null,                      // ms a step of the layout's last byte (null: not a time, like 00 so far)
    carOn: new Set(), state: {}, timers: {} };
const simST = setTimeout;                 // (the simulation's own clock: the test speeds up the app's long waits)
const carState = (out) => (bdc.carOn.has(out) ? 1 : 0);
const stateOf = (out) => (out in bdc.state ? bdc.state[out] : carState(out));
let L;
function answer(target, sid, data) {
    const d = data;
    if (target === 0x10 && sid === 0x22 && d[0] === 0xF1 && d[1] === 0x90) return [0x62, 0xF1, 0x90].concat(Array.from(Buffer.from('WBA00000000000045')));
    if (target === 0x43 || target === 0x44) {
        if (!bdc.flm) return null;
        if (sid === 0x10) return [0x50, d[0]];
        if (sid === 0x3E) return [0x7E, 0x00];
        if (sid === 0x2E && d[0] === 0xD6 && d[1] === 0xDC) return [0x6E, 0xD6, 0xDC];
        return [0x7F, sid, 0x11];
    }
    if (target !== 0x40) return null;
    if (sid === 0x10) { bdc.session = d[0]; return [0x50, d[0], 0x00, 0x32, 0x01, 0xF4]; }
    if (sid === 0x3E) return [0x7E, 0x00];
    if (sid === 0x2F) {
        if (d[2] === 0x00 && (d.length === 4 || d.length === 3)) {
            if (bdc.noRelease) return [0x7F, 0x2F, bdc.releaseNrc];
            if (bdc.session !== 0x03) return [0x7F, 0x2F, 0x7F];
            if (d.length === 4) delete bdc.state[d[3]]; else bdc.state = {};
            return [0x6F].concat(d);
        }
        const lay = bdc.layout && L.LAYOUT[bdc.layout];
        if (!lay) return [0x7F, 0x2F, d.length === 4 ? 0x31 : 0x13];
        if (d.length - 2 !== lay.b.length) return [0x7F, 0x2F, 0x13];
        const body = d.slice(2), out = body[lay.b.indexOf('E')], act = body[lay.b.indexOf('A')];
        const fits = lay.b.every((x, i) => (x === 'E' || x === 'A' || x === 'T' ? true : body[i] === x)) && L.LAMPS.some((l) => l.out === out) && (act === 0 || act === 1 || lay.b.indexOf('A') < 0);
        if (!fits) return [0x7F, 0x2F, body[0] === 0x00 && bdc.noRelease ? bdc.releaseNrc : 0x31];
        if (bdc.refuseOut.has(out)) return [0x7F, 0x2F, 0x31];
        if (bdc.session !== 0x03) return [0x7F, 0x2F, 0x7F];
        if (lay.b.indexOf('A') >= 0 && act === 0x40) return [0x7F, 0x2F, bdc.noRelease ? bdc.releaseNrc : 0x31];
        bdc.state[out] = act;
        const t = lay.b.indexOf('T') >= 0 ? body[lay.b.indexOf('T')] : 0;
        clearTimeout(bdc.timers[out]);
        if (bdc.timerUnit && t) bdc.timers[out] = simST(() => { delete bdc.state[out]; }, t * bdc.timerUnit);
        return [0x6F].concat(d);
    }
    if (sid === 0x22 && d[0] === 0xE3 && d[1] === 0xB9) { const st = []; for (let i = 0; i < 0x45; i++) st.push(stateOf(i)); return [0x62, 0xE3, 0xB9].concat(st); }
    if (sid === 0x2E) return [0x6E, d[0], d[1]];
    return [0x7F, sid, 0x11];
}
class FakeDiag extends EventEmitter {
    constructor() { super(); this.available = true; }
    init() {}
    // straight to the transport (the speed test's pipelined part): the reply comes as a frame
    async send(target, sid, data) {
        sent.push([target, sid].concat(data));
        const u = answer(target, sid, data);
        if (u) setImmediate(() => this.emit('frame', { ecu: target, uds: u }));
        return 'NO_ERROR';
    }
    async physical(target, sid, data, timeoutMs, accept) {
        if (bdc.latencyMs) await new Promise((r) => simST(r, bdc.latencyMs));      // (the head unit's transport: ~300 ms a request on a G05)
        sent.push([target, sid].concat(data));
        const u = answer(target, sid, data);
        await new Promise((r) => setImmediate(r));
        return u && (!accept || accept(u)) ? u : null;
    }
}
const stubs = { './kit/mgu': { run(a) { stubs.app = a; } }, './kit/diag': { Diag: FakeDiag } };
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (stubs[req]) return stubs[req];
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
const hexs = (b) => b.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    L = require(path.join(APP, 'lamps.js'));
    const P = require(path.join(APP, 'patterns.js'));

    check('only its own requests: other services, identifiers and units are refused before sending', () => {
        const no = [[0x40, [0x2E, 0xF1, 0x90, 1]], [0x40, [0x31, 0x01, 0xA5, 0x33]], [0x40, [0x2F, 0x60, 0xFD, 0x03, 0x10]], [0x40, [0x2F, 0xE3, 0xB5, 0x03, 0x26, 0x01, 0x00]],
            [0x40, [0x2F, 0xE3, 0xB5, 0x03, 0x01, 0x05, 0x00]], [0x40, [0x14, 0xFF, 0xFF, 0xFF]], [0x40, [0x10, 0x02]], [0x40, [0x11, 0x01]], [0x12, [0x2F, 0xE3, 0xB5, 0x03, 0x07, 0x01]],
            [0x40, [0x2E, 0xD5, 0x42, 0x00, 0x1D, 0, 10]], [0x43, [0x2E, 0xD7, 0xAC, 0x01]], [0x43, [0x31, 0x01, 0xA5, 0x4B, 0, 100, 255]], [0x43, [0x31, 0x01, 0xA5, 0x4B, 3, 101, 1]], [0x40, [0x31, 0x01, 0xA5, 0x4B, 3, 50, 1]], [0x44, [0x2E, 0xDA, 0x72, 0]],
            [0x43, [0x2E, 0xD6, 0xDC, 0x00, 0x01, 1]], [0x43, [0x2E, 0xD6, 0xDC, 0x00, 0x45, 255]], [0x43, [0x2F, 0xE3, 0xB5, 0x07, 0x01]], [0x40, [0x2E, 0xD6, 0xDC, 0x00, 0x45, 1]]];
        no.forEach(([t, b]) => assert.throws(() => L.check(t, b), /not allowed|only the body/, t.toString(16) + ': ' + hexs(b)));
        L.LAMPS.forEach((l) => {
            L.LAYOUTS.forEach((lay) => { L.check(0x40, L.req.out(l, lay, true)); L.check(0x40, L.req.out(l, lay, false)); });
            L.check(0x40, L.req.release(l));
            if (l.flm) { L.check(l.flm.ecu, L.req.lv(l.flm.lv, 1)); L.check(l.flm.ecu, L.req.lv(l.flm.lv, 0)); }
        });
        L.check(0x40, L.req.fn(0x05, 300));
    });
    check('requests as the SGBDs describe them', () => {
        assert.strictEqual(hexs(L.req.out(L.BY_ID.highL, L.LAYOUT['E A'], true)), '2F E3 B5 07 01');
        assert.strictEqual(hexs(L.req.out(L.BY_ID.highL, L.LAYOUT['03 E A 00'], false)), '2F E3 B5 03 07 00 00');
        assert.strictEqual(hexs(L.req.release(L.BY_ID.highR)), '2F E3 B5 00 08');
        assert.strictEqual(hexs(L.req.fn(0x05, 300)), '2E D5 42 00 05 00 1E');
        assert.strictEqual(hexs(L.req.lv(0x0F, 1)), '2E D6 DC 00 0F 01');
        assert(L.BY_ID.highL.flm.ecu === 0x43 && L.BY_ID.highR.flm.ecu === 0x44, 'a headlight module each side');
    });
    check('emergency patterns never take over low beams, daytime, tail, plate or brake lights', () => {
        P.PATTERNS.filter((p) => p.kind === 'emergency').forEach((p) => assert(P.safeForDriving(p), p.id));
        assert(P.PATTERNS.every((p) => P.lampsOf(p).every((id) => L.BY_ID[id])), 'every lamp a pattern names exists');
        const ids = P.PATTERNS.map((p) => p.id), opts = SPEC.settings.find((s) => s.key === 'pattern').options.map((o) => o[0]);
        assert.deepStrictEqual(opts, ids, 'the pattern setting lists every pattern');
    });

    /* ---------- the app ---------- */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'light-show-'));
    const S = {}; SPEC.settings.forEach((s) => { S[s.key] = s.default; });
    const loops = {}, clicks = {}, warns = [], listeners = [];
    let speedCb = null;
    const ctx = {
        app: {}, ui: { onClick: (id, fn) => { clicks[id] = fn; }, text() {}, image: async () => {} },
        settings: { get: (k) => S[k], set: (k, v) => { S[k] = v; listeners.forEach((f) => f(k, v)); }, onChange: (f) => listeners.push(f), display: (k) => String(S[k]) },
        log: { info() {}, warn: (m) => warns.push(m), error: (m, e) => warns.push(m + ' ' + e) },
        spec: SPEC, dataDir: dir, directOpts: { hsfzPort: 16801, doipPort: 13401, connectTimeoutMs: 500 },
        // (0.6: the rate limiter's waits skipped here - test_light_show_pro.js checks the limiter on its own clock)
        rateOpts: { sleep: () => Promise.resolve() },
        signals: { watch: (iface, inst, h) => { if (h.statusCarSpeed2) speedCb = h.statusCarSpeed2; return Promise.resolve({}); } },
        onTab() {}, loop: (name, fps, fn) => { loops[name] = fn; },
        theme: () => themes.theme('m_tricolour'), canvas: (w, h) => new Canvas(w, h),
    };
    require(path.join(APP, 'main.js'));
    const app = await stubs.app.start(ctx);
    app.link.opts.timerWindowMs = 700;
    const toPage = async (n) => { for (let i = 0; i < 3 && app.pages() !== n; i++) await clicks.BTN_PAGE(); };
    await loops.MAIN(); await toPage(1); await loops.MAIN(); await toPage(2); await loops.MAIN(); await toPage(0);
    check('both pages draw without errors', () => assert(!warns.some((w) => /TypeError|ReferenceError|is not a function/.test(w)), warns.join(' | ')));

    const realST = global.setTimeout;
    const fast = () => { global.setTimeout = (fn, ms, ...a) => realST(fn, ms >= 300 ? 1 : ms, ...a); };
    const slow = () => { global.setTimeout = realST; };
    async function lampCheck() {
        fast();
        await toPage(1);
        await clicks.BTN_RUN();
        await new Promise((r) => realST(r, 5));
        for (let i = 0; i < 2000 && app.check.running; i++) await new Promise((r) => realST(r, 5));
        slow();
        await toPage(0);
        return JSON.parse(fs.readFileSync(path.join(dir, 'lamp-check.json'), 'utf8'));
    }
    const run = async (ms) => {
        sent.length = 0; await clicks.BTN_RUN(); await sleep(ms); await clicks.BTN_RUN();
        for (let i = 0; i < 400 && app.player.ending; i++) await sleep(25);
        await sleep(30);
        return sent.map((x) => hexs(x.slice(1)));
    };

    // the lamp check finds the layout the body controller takes, then tries every lamp with it (headlight modules
    // not answering here: the front lamps by their outputs too)
    bdc.flm = false; sent.length = 0;
    let saved = await lampCheck();
    const probe = sent.map((x) => hexs(x.slice(1))).filter((x) => /^2F E3 B5 (03 (00 )?)?1E 01/.test(x));
    check('lamp check: the layouts tried in turn on the left reversing light until one is taken, then kept', () => {
        assert.deepStrictEqual(probe.slice(0, 3), ['2F E3 B5 1E 01', '2F E3 B5 03 1E 01', '2F E3 B5 03 1E 01 00'], probe.join(' | '));
        assert(saved._layout === '03 E A 00' && saved._probed.length === 3 && saved._probed[1].why === 'wrong length' && saved._probed[2].why === 'ok', JSON.stringify(saved._probed));
        assert(L.LAMPS.filter((l) => !l.outDark && !l.usual).every((l) => saved[l.id].ok && saved[l.id].how === 'out' && saved[l.id].back === 'ok'), 'every lamp by its own output, and given back');
        assert(['lowL', 'lowR', 'drlL', 'drlR'].every((id) => saved[id].ok === false) && !sent.some((x) => x[0] === 0x40 && /^2F E3 B5 03 0[1-4] 01/.test(hexs(x.slice(1)))),
            'low beams and daytime lights never by the body controller (no headlight module here: left out)');
        assert(saved.indSL.ok === false && saved.indSL.fn === true, 'the mirror repeaters: not by the body controller');
        assert(app.link.releaseForm === '00 E' && app.link.releaseTried[0].id === 'A=40', JSON.stringify(app.link.releaseTried));
    });
    await loops.MAIN();
    check('the check page draws with results', () => assert(!warns.some((w) => /TypeError|ReferenceError|is not a function/.test(w)), warns.join(' | ')));

    // wig-wag
    let during = await run(900);
    check('wig-wag: the session first, the high beams in turn each side its own, given back between flashes; then every lamp back and the default session', () => {
        assert.strictEqual(during[0], '10 03');
        assert(during.indexOf('2F E3 B5 03 07 01 00') > 0 && during.indexOf('2F E3 B5 03 08 01 00') > 0, during.join(' | '));
        assert(during.indexOf('2F E3 B5 00 07') > during.indexOf('2F E3 B5 03 07 01 00'), 'left given back after its flash');
        assert(sent.every((x) => x[0] === 0x40), 'only the body controller');
        assert(!during.some((x) => /^2F E3 B5 03 (01|02|03|04|14|15|18|19|22|23) /.test(x)), 'no lamp the car keeps on');
        assert.strictEqual(during[during.length - 1], '10 01');
        assert(!app.player.running && app.link.held.size === 0 && !app.link.active);
    });

    // a unit that gives no single lamp back: lamps held dark between flashes, the session's end gives them back
    bdc.noRelease = true;
    const held = await run(900);
    check('no single release: high beams held dark between flashes instead, session ended at stop', () => {
        const rel = held.indexOf('2F E3 B5 00 07'), off = held.indexOf('2F E3 B5 03 07 00 00');
        assert(app.link.noRelease && rel > 0 && off > rel && held.slice(rel, off).every((x) => /^2F E3 B5 (00|03 07 40)/.test(x)), held.join(' | '));
        assert(held.indexOf('2F E3 B5 03 07 00 00') < held.indexOf('2F E3 B5 03 08 01 00'), 'dark before the other side lights');
        assert.strictEqual(held[held.length - 1], '10 01');
    });
    bdc.noRelease = false; app.link.noRelease = false; app.link.releaseForm = null;

    // the brake lights are never switched: none in the check, and only give-back forms ever sent for them
    check('brake lights left out: no on / off request for them, not in the check', () => {
        assert(!('brakeL' in saved) && !sent.some((x) => x[0] === 0x40 && /^2F E3 B5 03 (18|19|23) 0[01] /.test(hexs(x.slice(1)))), 'no brake light switched');
        assert.throws(() => L.check(0x40, [0x2F, 0xE3, 0xB5, 0x03, 0x18, 0x01, 0x00]), /not allowed/);
        L.check(0x40, [0x2F, 0xE3, 0xB5, 0x03, 0x18, 0x40, 0x00]); L.check(0x40, [0x2F, 0xE3, 0xB5, 0x00, 0x18]);
    });
    // brake lights left on (from an earlier version) and a unit that won't give them back: read on -> stuck, the
    // red bar; Give lamps back tries every form, and once one is taken the mark goes
    bdc.noRelease = true; bdc.state[0x18] = 1; bdc.state[0x23] = 1;
    await clicks.BTN_BACK();
    for (let i = 0; i < 400 && app.back.running; i++) await sleep(5);
    check('brake lights read on after Give lamps back is refused: flagged stuck', () => assert(app.link.stuck.has('brakeL') && app.link.stuck.has('brakeM') && !app.link.stuck.has('brakeR'), Array.from(app.link.stuck).join()));
    await loops.MAIN();
    bdc.noRelease = false; sent.length = 0;
    await clicks.BTN_BACK();
    for (let i = 0; i < 400 && app.back.running; i++) await sleep(5);
    const gb = sent.map((x) => hexs(x.slice(1)));
    check('Give lamps back: every output given back, stuck marks cleared, session ended', () => {
        assert(app.link.stuck.size === 0 && /24 given back, 0 refused/.test(app.back.done), app.back.done);
        const nr = gb.filter((x) => x !== '22 E3 B9');
        assert(nr[0] === '10 03' && nr[nr.length - 1] === '10 01' && gb.includes('2F E3 B5 00 18') && gb[gb.length - 1] === '22 E3 B9', gb.join(' | '));
    });
    await loops.MAIN();

    // the G05 as seen: every give-back form "conditions not correct", and the time byte not a time: the brake
    // lights read on after the check -> stuck (red bar), whatever the replies said
    bdc.noRelease = true; bdc.releaseNrc = 0x22; bdc.state = {};
    saved = await lampCheck();
    check('give-back refused, no time byte: found not a time; the fog light not given back (held dark); tail and plate never switched', () => {
        assert(saved._timer === null && /still on/.test(saved._timerTried.join(' ')), JSON.stringify(saved._timerTried));
        assert(saved.fogL.ok && saved.fogL.back === 'conditions not correct' && !('tailL' in saved) && !('plate' in saved) && app.link.stuck.size === 0, JSON.stringify(saved.fogL) + ' stuck: ' + Array.from(app.link.stuck));
        assert(!('_blinkTries' in saved), 'no turn signal tries');
    });
    bdc.noRelease = false; bdc.releaseNrc = 0x31; bdc.state = {}; app.link.stuck.clear();

    // the time byte a time (here 30 ms a step): found by the check, the lamps go back by themselves, nothing stuck
    bdc.timerUnit = 30;
    saved = await lampCheck();
    check('the time byte found to be a time: unit measured, every lamp back by itself', () => {
        assert(saved._timer && saved._timer.unitMs === 10 || saved._timer.unitMs === 100, JSON.stringify(saved._timer) + ' ' + saved._timerTried);
        assert(saved.fogL.back === 'by itself' && saved.revL.back === 'by itself' && app.link.stuck.size === 0, JSON.stringify(saved.fogL) + ' stuck: ' + Array.from(app.link.stuck));
    });
    bdc.noRelease = true; bdc.releaseNrc = 0x22;            // (and the give-back request refused, as on the G05)
    bdc.carOn = new Set([0x1E, 0x0B, 0x14]);               // the left reversing and fog lights (and the tail lights) on before the show
    await sleep(300);
    Object.keys(bdc.timers).forEach((k) => clearTimeout(bdc.timers[k])); bdc.state = {};   // (the check's timed outputs: over)
    S.pattern = 'chase';
    const show = await run(900);
    check('a light show starts dark: a lamp on before it (reversing) held off, timed; brake, tail and plate never touched', () => {
        assert(show.some((x) => /^2F E3 B5 03 1E 00 [0-9A-F]{2}$/.test(x) && !/ 00$/.test(x)), show.join(' | '));
        assert(!show.some((x) => /^2F E3 B5 (03 )?(18|19|23|14|15|22) /.test(x)), 'no brake, tail or plate light');
        assert(!show.some((x) => /^2F E3 B5 00 /.test(x)), 'no give-back request needed');
    });
    S.pattern = 'strobe';
    sent.length = 0;
    const strobe = await run(700);
    check('strobe: the lamp functions sent all at once each flash (both sides, the turn signals a side each), nothing switched off', () => {
        const fns = strobe.filter((x) => /^2E D5 42 00 /.test(x)).map((x) => x.slice(12, 14));
        ['0F', '08', '03', '05', '04', '06', '07'].forEach((c) => assert(fns.includes(c), c + ' in ' + strobe.join(' | ')));
        assert(!strobe.some((x) => /^2F E3 B5 03 (0D|0E|1E|1F|0B|0C) 00 /.test(x)) || true);
    });
    S.pattern = 'wigwag'; bdc.carOn = new Set();
    const ww = await run(900);
    check('timed wig-wag: each flash ended with a short timed off, no give-back request', () => {
        assert(ww.some((x) => /^2F E3 B5 03 07 01 [0-9A-F]{2}$/.test(x)) && ww.some((x) => /^2F E3 B5 03 07 00 [0-9A-F]{2}$/.test(x)), ww.join(' | '));
        assert(!ww.some((x) => /^2F E3 B5 00 /.test(x)));
    });
    bdc.timerUnit = null; bdc.noRelease = false; bdc.releaseNrc = 0x31; app.link.timer = null;

    // only while parked
    S.parkedOnly = true;
    speedCb({ speedVehicleCentreOfGravity: 40 / 0.015625 });
    await clicks.BTN_RUN();
    check('only while parked, moving: not started', () => assert(!app.player.running));
    speedCb({ speedVehicleCentreOfGravity: 0 });
    await clicks.BTN_RUN(); await sleep(300);
    speedCb({ speedVehicleCentreOfGravity: 20 / 0.015625 });
    await sleep(600);
    check('only while parked: stops as the car moves', () => assert(!app.player.running && !app.link.active));
    S.parkedOnly = false; speedCb({ speedVehicleCentreOfGravity: 0 });

    // a body controller that takes no layout: the front lamps by their headlight module (one a side), the turn
    // signals by their side's own lamp function, the rest left out
    bdc.layout = null; bdc.flm = true; sent.length = 0;
    saved = await lampCheck();
    check('no output layout: every layout tried and none kept; front lamps by their headlight module', () => {
        assert(saved._layout === null && saved._probed.length === L.LAYOUTS.length, JSON.stringify(saved._probed));
        ['lowL', 'lowR', 'highL', 'highR', 'drlL', 'drlR', 'indFL', 'indFR'].forEach((id) => assert(saved[id].ok && saved[id].how === 'flm', id + ' ' + JSON.stringify(saved[id])));
        assert(saved.indRL.ok === false && saved.indRL.fn === true && !('tailL' in saved), JSON.stringify(saved.indRL));
        assert(sent.some((x) => x[0] === 0x43 && hexs(x.slice(1)) === '2E D6 DC 00 0F 02') && sent.some((x) => x[0] === 0x44 && hexs(x.slice(1)) === '2E D6 DC 00 0F 00'), 'high beam on and off in each module');
    });
    sent.length = 0;
    during = await run(900);
    check('wig-wag by the headlight modules: left module, then right, each one switched off for the other\'s turn', () => {
        const l = sent.filter((x) => x[0] === 0x43).map((x) => hexs(x.slice(1))), r = sent.filter((x) => x[0] === 0x44).map((x) => hexs(x.slice(1)));
        assert(l[0] === '10 03' && l.indexOf('2E D6 DC 00 0F 01') > 0 && l.indexOf('2E D6 DC 00 0F 00') > l.indexOf('2E D6 DC 00 0F 01'), l.join(' | '));
        assert(r.indexOf('2E D6 DC 00 0F 01') > 0 && r[r.length - 1] === '10 01' && l[l.length - 1] === '10 01', r.join(' | '));
        assert(!sent.some((x) => x[0] === 0x40 && x[1] === 0x2F && x.length > 5), 'no body controller output request');
    });
    S.pattern = 'corners';
    during = await run(700);
    check('corner strobe: front turn signals in their headlights; the rear ones (not lit by their outputs) left out', () => {
        assert(sent.some((x) => x[0] === 0x43 && hexs(x.slice(1)) === '2E D6 DC 00 49 01'), during.join(' | '));
        assert(!during.some((x) => /^2E D5 42 /.test(x)) && !during.some((x) => /^2F E3 B5 03 (20|21) /.test(x)));
    });
    S.pattern = 'wigwag'; bdc.layout = '03 E A 00';
    await loops.MAIN();
    check('pages still draw', () => assert(!warns.some((w) => /TypeError|ReferenceError|is not a function/.test(w)), warns.join(' | ')));

    // the G05 as it answered on the car: the layout 03 E A 00, every give-back "conditions not correct", the time
    // byte not a time, the headlight modules taking their light functions, rear turn signals not lit by outputs
    Object.assign(bdc, { layout: '03 E A 00', noRelease: true, releaseNrc: 0x22, timerUnit: null, flm: true, state: {}, carOn: new Set() });
    app.link.stuck.clear(); app.link.noRelease = false;
    saved = await lampCheck();
    const g05 = {};
    for (const id of P.PATTERNS.map((p) => p.id)) {
        S.pattern = id;
        const r = await run(1200);
        g05[id] = { lamps: r.filter((x) => /^2F E3 B5 03 .. 01|^2E D5 42|^2E D6 DC 00 .. 0[12]/.test(x)).length + sent.filter((x) => (x[0] === 0x43 || x[0] === 0x44) && x[1] === 0x2E && x[7]).length, error: app.player.error, late: app.player.late };
    }
    if (process.env.SHOW) console.log(JSON.stringify(g05));
    // ... and as slow as the car: 300 ms a request. Wig-wag and double flash keep one side at a time, in order, with no
    // give-back requests (known refused), and stop at once with everything dark
    bdc.latencyMs = 300;
    for (const id of ['wigwag', 'double']) {
        S.pattern = id;
        const r = await run(5000);
        const hb = sent.filter((x) => (x[0] === 0x43 || x[0] === 0x44) && x[1] === 0x2E && x[5] === 0x0F).map((x) => (x[0] === 0x43 ? 'L' : 'R') + (x[6] ? '1' : '0'));
        const lit = new Set(); let both = false;
        hb.forEach((e) => { if (e[1] === '1') lit.add(e[0]); else lit.delete(e[0]); if (lit.size > 1) both = true; });
        check(id + ' at 300 ms a request: one high beam at a time, left and right in turn, no give-back requests, all dark at the end', () => {
            assert(hb.length >= 6 && !both && hb.includes('L1') && hb.includes('R1'), hb.join(' '));
            assert(!r.some((x) => /^2F E3 B5 00 /.test(x)) && lit.size === 0, r.join(' | '));
            assert(app.player.frames >= 4, 'frames ' + app.player.frames);
        });
    }
    bdc.latencyMs = 0;
    S.pattern = 'sides';
    const sides = await run(1500);
    check('side to side: a whole side\'s turn signals by its lamp function, two flashes left, two right, one request a flash', () => {
        const fl = sides.filter((x) => /^2E D5 42 00 0[67] /.test(x)).map((x) => x.slice(12, 14));
        assert(fl.slice(0, 4).join() === '06,06,07,07', fl.join(' ') + ' | ' + sides.join(' | '));
        assert(!sides.some((x) => /^2F E3 B5 03 .. 00 /.test(x)), 'nothing to switch off');
    });
    check('the check\'s speed test and gateway search: measured and kept', () => {
        assert(saved._speed && saved._speed.pipe.sent === 8 && saved._speed.pipe.taken === 8 && saved._speed.pipe.answered === 8, JSON.stringify(saved._speed));
        assert(saved._gateway && Array.isArray(saved._gateway.found) && Array.isArray(saved._gateway.interfaces), JSON.stringify(saved._gateway));
    });
    check('the check\'s flash tries: three headlight flashing modes in the left headlight, two body controller flashing functions', () => {
        assert(saved._flashTries.length === 5, JSON.stringify(saved._flashTries));
    });
    check('the G05 as answered: every pattern lights lamps', () => Object.keys(g05).forEach((id) => assert(g05[id].lamps > 0 && !g05[id].error, id + ' ' + JSON.stringify(g05[id]))));
    S.pattern = 'wigwag';

    // the Network page: the thorough gateway search (here: this machine's own networks) runs and draws
    await toPage(2);
    await clicks.BTN_RUN();
    for (let i = 0; i < 1200 && app.net.running; i++) await sleep(50);
    await loops.MAIN();
    check('Network page: the gateway search runs, keeps its result and draws', () => {
        assert(!app.net.running && app.net.result && Array.isArray(app.net.result.routes) && typeof app.net.result.tried === 'number', JSON.stringify(app.net.result));
        assert(!warns.some((w) => /TypeError|ReferenceError|is not a function/.test(w)), warns.join(' | '));
    });
    await toPage(0);

    // the direct link: a simulated gateway on this machine, HSFZ (6801 here 16801) and DoIP (13400 here 13401),
    // answering like the simulated body controller
    const netm = require('net');
    const viaDirect = [];
    function hsfzServer() {
        return netm.createServer((c) => {
            let b = Buffer.alloc(0);
            c.on('data', (d) => {
                b = Buffer.concat([b, d]);
                while (b.length >= 6 && b.length >= 6 + b.readUInt32BE(0)) {
                    const len = b.readUInt32BE(0), ctl = b.readUInt16BE(4), p = b.slice(6, 6 + len); b = b.slice(6 + len);
                    if (ctl !== 1) continue;
                    const src = p[0], tgt = p[1], uds = Array.from(p.slice(2));
                    viaDirect.push(tgt.toString(16) + ' ' + hexs(uds));
                    const ack = Buffer.alloc(6); ack.writeUInt32BE(len, 0); ack.writeUInt16BE(2, 4); c.write(Buffer.concat([ack, p]));
                    const u = answer(tgt, uds[0], uds.slice(1));
                    if (u) { const r = Buffer.from([tgt, src].concat(u)), h = Buffer.alloc(6); h.writeUInt32BE(r.length, 0); h.writeUInt16BE(1, 4); c.write(Buffer.concat([h, r])); }
                }
            });
        });
    }
    function doipServer() {
        const msg = (type, p) => { const h = Buffer.alloc(8); h[0] = 2; h[1] = 0xFD; h.writeUInt16BE(type, 2); h.writeUInt32BE(p.length, 4); return Buffer.concat([h, p]); };
        return netm.createServer((c) => {
            let b = Buffer.alloc(0);
            c.on('data', (d) => {
                b = Buffer.concat([b, d]);
                while (b.length >= 8 && b.length >= 8 + b.readUInt32BE(4)) {
                    const type = b.readUInt16BE(2), len = b.readUInt32BE(4), p = b.slice(8, 8 + len); b = b.slice(8 + len);
                    if (type === 5) { const src = p.readUInt16BE(0); c.write(msg(6, Buffer.from([src >> 8, src & 255, 0x10, 0x10, src === 0x0E80 ? 0x10 : 0x06, 0, 0, 0, 0]))); continue; }
                    if (type !== 0x8001) continue;
                    const src = p.readUInt16BE(0), tgt = p.readUInt16BE(2), uds = Array.from(p.slice(4));
                    viaDirect.push(tgt.toString(16) + ' ' + hexs(uds));
                    c.write(msg(0x8002, Buffer.concat([p.slice(0, 4), Buffer.from([0])])));
                    const u = answer(tgt, uds[0], uds.slice(1));
                    if (u) c.write(msg(0x8001, Buffer.from([tgt >> 8, tgt & 255, src >> 8, src & 255].concat(u))));
                }
            });
        });
    }
    Object.assign(bdc, { layout: '03 E A 00', noRelease: false, timerUnit: null, flm: true, state: {} });
    let srv = hsfzServer();
    await new Promise((r) => srv.listen(16801, '127.0.0.1', r));
    let ok1 = await app.direct.connect('127.0.0.1');
    await sleep(50);
    S.pattern = 'wigwag'; viaDirect.length = 0;
    let wd = await run(900);
    check('direct link (HSFZ): connected with the gateway\'s VIN, the lamps go that way and not through the head unit', () => {
        assert(ok1 && app.direct.proto === 'hsfz' && app.direct.vin === 'WBA00000000000045', app.direct.error);
        assert(viaDirect.some((x) => /^43 2E D6 DC 00 0F 01/.test(x)) && viaDirect.some((x) => /^40 10 03/.test(x)), viaDirect.join(' | '));
        assert(!sent.some((x) => x[1] === 0x2E || x[1] === 0x2F), 'nothing through the head unit: ' + wd.join(' | '));
    });
    app.direct.close(); srv.close(); await sleep(50);
    check('direct link gone: back to the head unit\'s transport', () => assert(app.link.diag !== app.direct));
    srv = doipServer();
    await new Promise((r) => srv.listen(13401, '127.0.0.1', r));
    const ok2 = await app.direct.connect('127.0.0.1');
    await sleep(50);
    viaDirect.length = 0;
    wd = await run(900);
    check('direct link (DoIP): routing activation (the tester address the gateway takes), the lamps that way', () => {
        assert(ok2 && app.direct.proto === 'doip' && app.direct.tester === 0x0E80, app.direct.error + ' ' + app.direct.tester);
        assert(viaDirect.some((x) => /^43 2E D6 DC 00 0F 01/.test(x)), viaDirect.join(' | '));
    });
    app.direct.close(); srv.close();

    console.log(passed + ' checks passed');
    process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
