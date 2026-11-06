'use strict';
/**
 * sequences.js - user light sequences: a small JSON timeline compiled into the Player's frames (patterns.js).
 *
 * File: <app data>/light-sequences.json (on the car), or the DEFAULTS below. Either a list of sequences or
 * { "sequences": [...] }. kit/tools/light_seq.py checks a file on the PC and copies it to the car.
 *
 *   {
 *     "id": "welcome",              unique, [a-z0-9_]
 *     "name": "Welcome",            shown on the page
 *     "loops": 3,                   0: until stopped (the auto-stop limit still applies)
 *     "speed": 1,                   multiplies every time (the Speed setting multiplies again)
 *     "steps": [ step, ... ]
 *   }
 *
 * Steps (times in ms):
 *   { "on": ["high", "fogL"], "ms": 300 }                 these lamps lit, every other lamp of the sequence dark
 *   { "ms": 200 }                                         all dark
 *   { "strobe": { "on": ["high"], "hz": 4, "duty": 0.5, "ms": 2000 } }       flash on / off at hz
 *   { "alternate": { "a": ["turnL"], "b": ["turnR"], "hz": 2, "ms": 3000 } } a, then b, at hz
 *   { "chase": { "order": ["indFL", "indFR", "indRR", "indRL"], "stepMs": 150, "rounds": 2 } }
 *   { "repeat": 3, "steps": [ ... ] }                     the inner steps three times (nested up to 3 deep)
 *
 * Lamp names: any lamp id from lamps.js (highL, fogR, revL, ...) or a group below. Lamps are switched on and off:
 * the car's lamp test functions have no dimming, so there is no fade (a "fadeMs" key is refused, not faked).
 *
 * The compiler clamps what the car can't do: steps shorter than MIN_STEP_MS, strobes faster than MAX_HZ, a frame
 * holding a lamp longer than the thermal guard allows (split into on / forced-off), more than MAX_FRAMES frames.
 * Every clamp is a warning the page and the PC tool show.
 */
const { BY_ID, LAMPS } = require('./lamps');

const MIN_STEP_MS = 50;
const MAX_STEP_MS = 60000;
const MAX_HZ = 10;
const MAX_FRAMES = 2000;
const MAX_DEPTH = 3;

/** Groups: names that stand for several lamps. turnL / turnR are a whole side (front, mirror, rear: the lamp
 *  function lights them together on the cars seen so far). tail, plate and puddle have no ids here: see GROUP_NOTES. */
const GROUPS = {
    low: ['lowL', 'lowR'],
    high: ['highL', 'highR'],
    drl: ['drlL', 'drlR'],
    fog: ['fogL', 'fogR'],
    turnL: ['indFL', 'indSL', 'indRL'],
    turnR: ['indFR', 'indSR', 'indRR'],
    hazard: ['indFL', 'indSL', 'indRL', 'indFR', 'indSR', 'indRR'],
    rearFog: ['rfogL', 'rfogR'],
    reverse: ['revL', 'revR'],
    front: ['lowL', 'lowR', 'highL', 'highR', 'drlL', 'drlR', 'fogL', 'fogR', 'indFL', 'indFR'],
    rear: ['indRL', 'indRR', 'rfogL', 'rfogR', 'revL', 'revR'],
    left: ['lowL', 'highL', 'drlL', 'fogL', 'indFL', 'indSL', 'indRL', 'rfogL', 'revL'],
    right: ['lowR', 'highR', 'drlR', 'fogR', 'indFR', 'indSR', 'indRR', 'rfogR', 'revR'],
    all: LAMPS.map((l) => l.id),
};
/** Names people will try that the app can't switch, and why (an error that says so, not "unknown lamp"). */
const GROUP_NOTES = {
    tail: 'tail lights: the body controller would not give them back on the cars tested (a lamp the car needs at night is never held)',
    plate: 'number plate light: as the tail lights',
    brake: 'brake lights: never switched',
    puddle: 'puddle / welcome lights: no output for them is known yet (they sit in the mirrors / door handles, not on the lamp outputs used here)',
    welcome: 'puddle / welcome lights: as puddle',
};

/** Built-in sequences (shown after the patterns; a file on the car replaces them). */
const DEFAULTS = [
    { id: 'welcome', name: 'Welcome', loops: 1, steps: [
        { on: ['drl'], ms: 600 }, { ms: 200 },
        { chase: { order: ['indFL', 'fogL', 'highL', 'highR', 'fogR', 'indFR'], stepMs: 140, rounds: 1 } },
        { strobe: { on: ['high'], hz: 3, duty: 0.4, ms: 1200 } },
        { on: ['low', 'drl'], ms: 1500 }, { ms: 300 },
    ] },
    { id: 'goodbye', name: 'Goodbye', loops: 1, steps: [
        { on: ['low', 'drl', 'reverse'], ms: 1200 },
        { repeat: 2, steps: [{ on: ['hazard'], ms: 400 }, { ms: 300 }] },
        { on: ['drl'], ms: 800 }, { ms: 300 },
    ] },
    { id: 'pulse_front', name: 'Front pulse', loops: 0, steps: [
        { strobe: { on: ['high', 'fog'], hz: 2, duty: 0.3, ms: 2000 } }, { ms: 600 },
        { alternate: { a: ['fogL', 'indFL'], b: ['fogR', 'indFR'], hz: 2.5, ms: 2400 } }, { ms: 600 },
    ] },
];

/** lamp names -> lamp ids (groups expanded, each once); unknown names into errors */
function expand(names, errors, where) {
    const out = new Set();
    (Array.isArray(names) ? names : [names]).forEach((n) => {
        if (typeof n !== 'string') { errors.push(where + ': lamp names are text'); return; }
        if (GROUPS[n]) GROUPS[n].forEach((x) => out.add(x));
        else if (BY_ID[n] && LAMPS.some((l) => l.id === n)) out.add(n);
        else if (GROUP_NOTES[n] || BY_ID[n]) errors.push(where + ': "' + n + '" can\'t be switched - ' + (GROUP_NOTES[n] || GROUP_NOTES[n.replace(/[LRM]$/, '')] || 'kept by the car'));
        else errors.push(where + ': unknown lamp "' + n + '" (lamps: ' + LAMPS.map((l) => l.id).join(', ') + '; groups: ' + Object.keys(GROUPS).join(', ') + ')');
    });
    return Array.from(out);
}

const clampMs = (ms, warn, where) => {
    const n = Number(ms);
    if (!isFinite(n) || n <= 0) { warn.push(where + ': no time, ' + MIN_STEP_MS + ' ms used'); return MIN_STEP_MS; }
    if (n < MIN_STEP_MS) { warn.push(where + ': ' + n + ' ms is shorter than ' + MIN_STEP_MS + ' ms, raised'); return MIN_STEP_MS; }
    if (n > MAX_STEP_MS) { warn.push(where + ': ' + n + ' ms is longer than ' + MAX_STEP_MS / 1000 + ' s, cut'); return MAX_STEP_MS; }
    return Math.round(n);
};
const clampHz = (hz, warn, where) => {
    const n = Number(hz);
    if (!isFinite(n) || n <= 0) { warn.push(where + ': no frequency, 2 Hz used'); return 2; }
    if (n > MAX_HZ) { warn.push(where + ': ' + n + ' Hz is faster than ' + MAX_HZ + ' Hz, lowered'); return MAX_HZ; }
    return n;
};

/**
 * One sequence -> { ok, errors, warnings, pattern } where pattern is a Player pattern:
 *   { id: 'seq:<id>', name, kind: 'show', custom: true, loops, frames: [{ ms, on: [ids] }] }
 * opts: { maxFrameMs(id) -> ms (thermal clamp), speed (1) }
 */
function compile(seq, opts) {
    const o = opts || {};
    const errors = [], warnings = [], frames = [];
    if (!seq || typeof seq !== 'object') return { ok: false, errors: ['not a sequence object'], warnings, pattern: null };
    const id = String(seq.id || '');
    if (!/^[a-z0-9_]{1,32}$/.test(id)) errors.push('id: 1-32 of a-z, 0-9, _ (got "' + id + '")');
    const name = String(seq.name || id).slice(0, 40);
    const k = Number(seq.speed) > 0 ? Number(seq.speed) : 1;
    const loops = Math.max(0, Math.min(1000, Math.floor(Number(seq.loops) || 0)));
    const push = (ms, on) => { if (frames.length < MAX_FRAMES) frames.push({ ms: Math.max(MIN_STEP_MS, Math.round(ms / k)), on }); };

    function walk(steps, depth, path) {
        if (!Array.isArray(steps)) { errors.push(path + ': steps must be a list'); return; }
        if (depth > MAX_DEPTH) { errors.push(path + ': repeats nested more than ' + MAX_DEPTH + ' deep'); return; }
        steps.forEach((st, i) => {
            const w = path + '[' + i + ']';
            if (!st || typeof st !== 'object') { errors.push(w + ': not a step'); return; }
            if ('fadeMs' in st || 'fade' in st) errors.push(w + ': fades are not possible - the lamp test functions only switch on and off');
            if (st.repeat !== undefined) {
                const n = Math.floor(Number(st.repeat));
                if (!(n >= 1 && n <= 100)) { errors.push(w + ': repeat 1-100'); return; }
                for (let r = 0; r < n && frames.length < MAX_FRAMES; r++) walk(st.steps, depth + 1, w + '.steps');
                return;
            }
            if (st.strobe) {
                const s = st.strobe, on = expand(s.on, errors, w + '.strobe.on');
                const hz = clampHz(s.hz, warnings, w + '.strobe'), duty = Math.max(0.1, Math.min(0.9, Number(s.duty) || 0.5));
                const total = clampMs(s.ms || 1000, warnings, w + '.strobe'), per = 1000 / hz;
                const onMs = Math.max(MIN_STEP_MS, per * duty), offMs = Math.max(MIN_STEP_MS, per - onMs);
                if (per * duty < MIN_STEP_MS || per - per * duty < MIN_STEP_MS) warnings.push(w + '.strobe: ' + hz + ' Hz at ' + duty + ' duty needs steps under ' + MIN_STEP_MS + ' ms: slower than asked');
                for (let t = 0; t < total && frames.length < MAX_FRAMES; t += onMs + offMs) { push(onMs, on); push(offMs, []); }
                return;
            }
            if (st.alternate) {
                const s = st.alternate, a = expand(s.a, errors, w + '.alternate.a'), b = expand(s.b, errors, w + '.alternate.b');
                const hz = clampHz(s.hz, warnings, w + '.alternate'), total = clampMs(s.ms || 1000, warnings, w + '.alternate');
                const half = Math.max(MIN_STEP_MS, 500 / hz);
                for (let t = 0; t < total && frames.length < MAX_FRAMES; t += 2 * half) { push(half, a); push(half, b); }
                return;
            }
            if (st.chase) {
                const s = st.chase;
                const order = (Array.isArray(s.order) ? s.order : []).map((n, j) => expand([n], errors, w + '.chase.order[' + j + ']'));
                if (!order.length) { errors.push(w + '.chase: order is empty'); return; }
                const ms = clampMs(s.stepMs || 150, warnings, w + '.chase'), rounds = Math.max(1, Math.min(50, Math.floor(Number(s.rounds) || 1)));
                for (let r = 0; r < rounds; r++) order.forEach((on) => push(ms, on));
                return;
            }
            const on = st.on !== undefined ? expand(st.on, errors, w + '.on') : [];
            push(clampMs(st.ms, warnings, w), on);
        });
    }
    walk(seq.steps, 0, 'steps');
    if (!frames.length && !errors.length) errors.push('steps: nothing to show');
    if (frames.length >= MAX_FRAMES) warnings.push('more than ' + MAX_FRAMES + ' frames: cut');

    // thermal: a frame may not hold a lamp longer than the guard allows - split it, the lamp dark for the rest
    if (o.maxFrameMs) {
        for (let i = 0; i < frames.length; i++) {
            const f = frames[i];
            const lim = Math.min.apply(null, f.on.map((x) => o.maxFrameMs(x)).concat([Infinity]));
            if (f.ms > lim) {
                const hot = f.on.filter((x) => o.maxFrameMs(x) < f.ms);
                warnings.push('a ' + f.ms + ' ms frame holds ' + hot.join(', ') + ' longer than the thermal limit (' + lim + ' ms): split');
                frames.splice(i + 1, 0, { ms: f.ms - lim, on: f.on.filter((x) => hot.indexOf(x) < 0) });
                f.ms = lim;
            }
        }
    }
    const pattern = errors.length ? null : { id: 'seq:' + id, name, kind: 'show', custom: true, loops, frames,
        what: 'Custom sequence: ' + frames.length + ' frames, ' + (Math.round(frames.reduce((a, f) => a + f.ms, 0) / 100) / 10) + ' s a round' + (loops ? ', ' + loops + 'x' : ', until stopped') };
    return { ok: !errors.length, errors, warnings, pattern };
}

/** The file's text -> { sequences: [pattern], problems: ['<id>: ...'] }. A bad sequence is left out, the rest kept. */
function load(text, opts) {
    const problems = [], out = [];
    let list;
    try { const j = JSON.parse(text); list = Array.isArray(j) ? j : j && j.sequences; } catch (e) { return { sequences: [], problems: ['not JSON: ' + e.message] }; }
    if (!Array.isArray(list)) return { sequences: [], problems: ['expected a list of sequences, or { "sequences": [...] }'] };
    const seen = new Set();
    list.slice(0, 50).forEach((s, i) => {
        const r = compile(s, opts), label = (s && s.id) || '#' + i;
        if (r.ok && seen.has(r.pattern.id)) { problems.push(label + ': id used twice, left out'); return; }
        r.errors.forEach((e) => problems.push(label + ': ' + e));
        r.warnings.forEach((w) => problems.push(label + ' (warning): ' + w));
        if (r.ok) { seen.add(r.pattern.id); out.push(r.pattern); }
    });
    return { sequences: out, problems };
}

/** A strobe built from the settings (the "Custom strobe" pattern): lamps by group, hz, on time. */
const STROBE_SETS = { high: ['high'], fog: ['fog'], reverse: ['reverse'], turn: ['hazard'], front: ['high', 'fog', 'indFL', 'indFR'], all: ['high', 'fog', 'hazard', 'rearFog', 'reverse'] };
function settingsStrobe(s, opts) {
    const hz = Number(s.strobeHz) || 3, pulse = Number(s.pulseMs) || 160;
    const duty = Math.max(0.1, Math.min(0.9, pulse * hz / 1000));
    return compile({ id: 'custom', name: 'Custom strobe', loops: Number(s.loops) || 0,
        steps: [{ strobe: { on: STROBE_SETS[s.strobeLamps] || STROBE_SETS.high, hz, duty, ms: 1000 } }] }, opts);
}

module.exports = { compile, load, expand, settingsStrobe, GROUPS, GROUP_NOTES, DEFAULTS, STROBE_SETS, MIN_STEP_MS, MAX_HZ, MAX_FRAMES };
