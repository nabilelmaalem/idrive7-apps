'use strict';
/**
 * Light Show - flash the car's exterior lamps in patterns, through the body controller's own lamp test functions
 * (lamps.js): emergency patterns (wig-wag and others, on lamps that are normally off while driving) and light
 * show patterns (any lamp, parked).
 *
 * Pages: Light Show (the pattern, start / stop, which lamps are lit now) and Lamp check (each lamp on for a moment
 * in turn, and whether the body controller took it: the lamps that refuse are left out of every pattern).
 *
 * Safety: Stop gives every lamp back to the car and ends the diagnostic session; if the app goes away without
 * that, the body controller ends the session itself a few seconds later (no tester present) and every lamp is the
 * car's own again. "Only while parked" (setting) stops a pattern as soon as the car moves.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { Diag } = require('./kit/diag');
const { LampLink, LAMPS, KEPT, LEDS, LED_CHANNELS, BY_ID, FN, NRC, LAYOUT, FLM_FLASH, BDC_FLASH, FLM_L, hex, why } = require('./lamps');
const { PATTERNS, PATTERN, Player, lampsOf } = require('./patterns');
const { findGateway, searchGateway, scanWifi } = require('./gateway');
const { DirectDiag } = require('./direct');
// 0.6: rate limiting, thermal limits and the one way back to the car; user sequences; manual control
const { RateLimiter, ThermalGuard, Guardian } = require('./safety');
const SEQ = require('./sequences');
const { Manual, TARGETS, TARGET, MODES, HZ_STEPS, BRIGHT_STEPS, COUNT_STEPS } = require('./manual');
const SEQ_FILE = 'light-sequences.json';

const W = 1600, H = 520;
const AMBER = '#ffad1f', RED = '#ff3030', WHITE = '#f4f7ff', FOG = '#fff2b0', GO = '#2fd27a';
const CHECK_ON_MS = 1200, CHECK_GAP_MS = 800;

/** Where each lamp sits on the car drawing: x -1 (left) .. 1 (right), y 0 (front) .. 1 (rear); its colour. */
const SPOT = {
    lowL: [-0.62, 0.04, WHITE], lowR: [0.62, 0.04, WHITE], highL: [-0.42, 0.03, WHITE], highR: [0.42, 0.03, WHITE],
    drlL: [-0.78, 0.07, WHITE], drlR: [0.78, 0.07, WHITE], fogL: [-0.7, 0.0, FOG], fogR: [0.7, 0.0, FOG],
    indFL: [-0.88, 0.1, AMBER], indFR: [0.88, 0.1, AMBER], indSL: [-1.04, 0.24, AMBER], indSR: [1.04, 0.24, AMBER],
    indRL: [-0.84, 0.93, AMBER], indRR: [0.84, 0.93, AMBER], tailL: [-0.74, 0.97, RED], tailR: [0.74, 0.97, RED],
    brakeL: [-0.6, 0.95, RED], brakeR: [0.6, 0.95, RED], brakeM: [0, 0.82, RED], rfogL: [-0.4, 1.0, RED], rfogR: [0.4, 1.0, RED],
    revL: [-0.24, 0.98, WHITE], revR: [0.24, 0.98, WHITE], plate: [0, 1.0, WHITE],
};

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const diag = new Diag(ctx.signals, log);
        diag.quiet = true; diag.busyMs = 60;
        diag.init();
        const link = new LampLink(diag, log);
        // every request through the rate limiter (safety.js): a token bucket, a gap per unit, a growing pause on
        // "busy" / no answer, and a breaker that ends the run after several failures in a row
        const limiter = new RateLimiter(Object.assign({ profile: settings.get('linkProfile') || 'normal', link: 'headunit' }, ctx.rateOpts));
        link.gate = limiter;
        // the car's gateway straight over Wi-Fi (an ENET cable in a travel router the head unit has joined): when it
        // answers, every lamp request goes that way (milliseconds, not ~300 ms); back to the head unit's own
        // transport when it goes away
        const direct = new DirectDiag(log, ctx.directOpts);
        direct.on('available', (a) => {
            if (a) { link.diag = direct; limiter.setLink('direct'); log.info('light show: lamps through the direct link (' + direct.proto + ' ' + direct.host + ')'); }
            else if (link.diag === direct) { link.diag = diag; limiter.setLink('headunit'); log.warn('light show: direct link gone: lamps through the head unit again'); }
        });
        // how long a lamp may stay lit (settings: high beam longest on, cool-down, most lit per minute)
        const thermal = new ThermalGuard();
        const thermalCfg = () => thermal.configure({ highBeamMaxS: settings.get('highBeamMaxS'), cooldownS: settings.get('cooldownS'), maxDuty: settings.get('maxDuty') });
        thermalCfg();
        async function tryDirect(hosts) {
            for (const h of hosts) {
                if (direct.available && direct.host === h) return true;
                if (await direct.connect(h)) { checked._direct = h; save(); return true; }
            }
            return false;
        }

        /* ---------- the lamp check's results, kept: { id: { ok, why, t } } ---------- */
        // (lamp-check.json: 0.1.0's lamps.json was made with a request layout the G05 refuses, so it isn't read)
        const FILE = path.join(ctx.dataDir || '.', 'lamp-check.json');
        let checked = {};
        try { checked = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (e) { /* none yet */ }
        const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(checked)); } catch (e) { log.warn('light show: ' + e.message); } };
        // a lamp works through its own output, or through its lamp function when that is its side's alone
        const sideFn = (id) => !!(checked[id] && checked[id].fn && FN[id] && Object.keys(FN).filter((k) => FN[k] === FN[id]).every((k) => BY_ID[k].side === BY_ID[id].side));
        // (the mirrors' side repeaters only light with their whole side's turn signals: never in a pattern)
        const usable = (id) => !BY_ID[id].outDark && (!checked[id] || checked[id].ok !== false || sideFn(id));
        // what the last check found: the output layout, each lamp's way (its output, or its headlight module)
        const restore = () => {
            if (checked._layout && LAYOUT[checked._layout]) link.layout = LAYOUT[checked._layout];
            link.timer = checked._timer || null;
            link.noRelease = !!checked._noRelease;
            LAMPS.forEach((l) => { link.how[l.id] = checked[l.id] && checked[l.id].how === 'flm' ? 'flm' : 'out'; });
        };
        restore();
        // the direct link found before: tried at start and every 30 s while it isn't up
        if (checked._direct) tryDirect([checked._direct]).catch(() => null);
        setInterval(() => { if (checked._direct && !direct.available && !player.running && !check.running) tryDirect([checked._direct]).catch(() => null); }, 30000);

        /* ---------- parked or moving (Vehicle2 speed) ---------- */
        let speed = null;
        ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: (v) => { const k = v && v.speedVehicleCentreOfGravity; if (typeof k === 'number' && k !== 65535) speed = k * 0.015625; },
        }, log, { pollMs: 2000 }).catch(() => null);
        const moving = () => speed !== null && speed > 3;

        /* ---------- the player ---------- */
        let lit = new Set(), frameAt = -1, startedAt = 0, stopWhy = '';
        const viaFn = (id) => !!(checked[id] && checked[id].ok === false && sideFn(id));
        const player = new Player(link, {
            log, usable, dark: darkAtStart, driving: () => guarded(), needsLayout: () => LAMPS.some((l) => link.how[l.id] !== 'flm' && usable(l.id) && !(checked[l.id] && checked[l.id].ok === false)), viaFn,
            // the thermal guard keeps a lamp that is cooling down dark for the frame
            allow: (id) => thermal.allow(id).ok,
            onFrame: (l, i) => { lit = new Set(l); frameAt = i; thermal.update(lit); guardian.beat(); },
            refused: (id, nrc) => {
                // refused during a pattern: left out until the next lamp check
                checked[id] = { ok: false, why: NRC[nrc] || 'NRC ' + hex(nrc), t: Date.now() }; save();
                log.warn('light show: ' + BY_ID[id].name + ' refused (' + checked[id].why + '): left out');
            },
        });

        /* ---------- manual control (the Manual page) ---------- */
        const manual = new Manual(link, {
            log, viaFn, thermal,
            // while driving with "keep headlights on": no LED channel (its dark half would dim the headlights)
            usable: (id) => usable(id) && !(BY_ID[id].led && guarded()),
            reason: (key) => (TARGET[key] && TARGET[key].led && guarded() ? 'not while driving (While driving: keep headlights on)' : ''),
            onFrame: (l) => { lit = new Set(l); guardian.beat(); },
            onForcedOff: (over) => { stopWhy = over.map((x) => BY_ID[x.id].name + ' off: ' + x.why).join('; '); },
            // Single flash done: everything back to the car
            onDone: () => { stopWhy = 'Done: ' + manual.count + (manual.count === 1 ? ' flash' : ' flashes'); returnToEcu(stopWhy); },
        });
        let manualFocus = 0;
        // the effect's mode and parameters live in the settings (kept across starts; the knob works in Settings too)
        const syncManual = () => {
            manual.mode = settings.get('manualMode') || 'solid';
            manual.hz = Number(settings.get('manualHz')) || 2;
            manual.brightness = Number(settings.get('manualBrightness')) || 100;
            manual.count = Number(settings.get('manualCount')) || 1;
        };
        syncManual();

        /* ---------- the one way back to the car ---------- */
        const guardian = new Guardian({ link, player, manual, log, verify: () => verifyBack() });
        guardian.installSignals(process);
        limiter.on('trip', (x) => {
            stopWhy = 'Stopped: the car stopped answering (' + x.failures + ' requests in a row) - every lamp handed back';
            guardian.returnToEcu('link unhealthy');
        });
        /** stop whatever runs and hand every lamp back (Stop, pause, leaving the screen, limits) */
        function returnToEcu(why) { if (why) stopWhy = why; return guardian.returnToEcu(why || 'stop'); }
        // leaving the screen, or an HMI popup (a call, a warning) covering it: everything goes back to the car
        if (ui.onVisible) ui.onVisible((st, on) => { if (!on && settings.get('stopWhenHidden') !== false && guardian.running()) returnToEcu('Stopped: the screen was left'); });
        if (ui.onFocus) ui.onFocus((st, on) => { if (!on && settings.get('stopWhenHidden') !== false && guardian.running()) returnToEcu('Stopped: an HMI popup covered the screen'); });

        /* ---------- sequences: the built-in patterns, the custom strobe, the user's sequences ---------- */
        const seqOpts = () => ({ maxFrameMs: (id) => thermal.maxFrameMs(id) });
        let sequences = [], seqProblems = [], seqMtime = -1;
        /** (again when the file changed) <data>/light-sequences.json, else the built-in ones */
        function loadSequences() {
            const file = path.join(ctx.dataDir || '.', SEQ_FILE);
            let mt = 0;
            try { mt = fs.statSync(file).mtimeMs; } catch (e) { mt = 0; }
            if (mt === seqMtime) return;
            seqMtime = mt;
            const r = mt ? SEQ.load(fs.readFileSync(file, 'utf8'), seqOpts()) : SEQ.load(JSON.stringify(SEQ.DEFAULTS), seqOpts());
            sequences = r.sequences; seqProblems = r.problems;
            log.info('light show: ' + sequences.length + ' sequences ' + (mt ? 'from ' + SEQ_FILE : '(built in)') + (r.problems.length ? ': ' + r.problems.join(' | ') : ''));
        }
        loadSequences();
        const allPatterns = () => PATTERNS.concat(sequences);
        /** the pattern selected (the custom strobe built from the settings now) */
        function pattern() {
            const id = settings.get('pattern');
            if (id === 'custom') {
                const r = SEQ.settingsStrobe({ strobeHz: settings.get('strobeHz'), pulseMs: settings.get('pulseMs'), strobeLamps: settings.get('strobeLamps'), loops: settings.get('loops') }, seqOpts());
                if (r.ok) return Object.assign(r.pattern, { id: 'custom', name: 'Custom strobe', what: Number(settings.get('strobeHz')) + ' Hz, ' + settings.get('pulseMs') + ' ms pulse, ' + settings.display('strobeLamps') });
            }
            return allPatterns().find((p) => p.id === id) || PATTERNS[0];
        }
        /** the Loop count setting for patterns without their own count (a sequence's file value wins) */
        const withLoops = (p) => (p.custom && p.id !== 'custom' ? p : Object.assign({}, p, { loops: Number(settings.get('loops')) || 0 }));
        const speedK = () => Number(settings.get('speed')) || 1;
        /** "Only while parked" (setting, on by default): every pattern, sequence and manual control. Off, they also run
         *  while driving - then the player never takes over the lamps the car drives with (low beams, daytime lights:
         *  between flashes lamps go back to the car, nothing is held dark at the start) and the headlights' own panic
         *  flashing patterns don't run (they flash the headlights off and on). */
        const parkedOnly = () => settings.get('parkedOnly') !== false;
        /** "While driving: keep headlights on" (setting, on by default): the guard above. Off, while driving the
         *  player may hold the low beams / daytime lights dark and the panic flashing patterns run, as when parked. */
        const keepHeadlights = () => settings.get('drivingGuard') !== false;
        const guarded = () => moving() && keepHeadlights();
        const needsParked = () => parkedOnly();
        async function start() {
            if (player.running || check.running) return;
            if (guardian.busy) await guardian.busy;              // (a teardown still running: after it)
            if (manual.running) await returnToEcu('');
            loadSequences();
            const p = withLoops(pattern());
            if (needsParked(p) && moving()) { stopWhy = 'Not started: the car is moving (Only while parked is on)'; return; }
            if (p.modes && guarded()) { stopWhy = 'Not started: ' + p.name + ' flashes the headlights off and on (While driving: keep headlights on is on)'; return; }
            stopWhy = ''; startedAt = Date.now(); limiter.reset(); guardian.beat();
            log.info('light show: ' + p.name + ' started' + (p.loops ? ', ' + p.loops + ' rounds' : ''));
            if (!player.start(p, speedK())) stopWhy = 'Still giving the lamps back from the last run: press Start / stop again in a moment';
        }
        async function startManual() {
            if (manual.running || check.running || scan.running) return manual.running;
            if (guardian.busy) await guardian.busy;              // (the last run still handing back: after it, not ignored)
            if (!manual.on.size) { stopWhy = 'Pick at least one light first'; return false; }
            if (player.running) await returnToEcu('');
            if (parkedOnly() && moving()) { stopWhy = 'Not started: the car is moving (Only while parked is on)'; return false; }
            stopWhy = ''; startedAt = Date.now(); limiter.reset(); guardian.beat();
            log.info('light show: manual control');
            return manual.start();
        }
        /** a light picked or unpicked on the Manual page (by a tap, the controller or a test). While an effect runs
         *  the change applies at once; the last one unpicked ends it (every lamp the car's again). */
        async function manualToggle(key) {
            const c = TARGET[key];
            if (!c || (!manual.isOn(key) && manual.why(key))) { stopWhy = c ? c.label + ': ' + manual.why(key) : ''; return false; }
            manual.toggle(key);
            if (!manual.on.size && manual.running) await returnToEcu('');
            return true;
        }
        /** RUN / STOP on the Manual page */
        async function manualRun() {
            if (manual.running) return returnToEcu('');
            syncManual();
            return startManual();
        }
        /** a mode or parameter changed on the page: kept in the settings, applied at once */
        function manualParam(key, value) {
            settings.set(key, value);
            syncManual();
            if (key === 'manualMode') manual.setMode(value);
        }
        const stepIn = (list, v, d) => { const i = list.indexOf(Number(v)); const j = Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i) + d)); return list[j]; };

        /* ---------- LED scan: which of the headlights' LED channels answer (and draw current) ---------- */
        const scan = { running: false, at: '', found: null };
        async function runLedScan(fromCheck) {
            if (scan.running || (check.running && !fromCheck) || player.running) return;
            // (it lights and darkens each headlight LED in turn: never while driving)
            if (moving()) { stopWhy = 'Scan LEDs: only while parked'; return; }
            if (manual.running) await returnToEcu('');
            scan.running = true; scan.found = { L: [], R: [] };
            limiter.reset();
            await link.start();
            try {
                for (const [S, ecu] of [['L', link.FLM_L], ['R', link.FLM_R]]) {
                    for (let ch = 1; ch <= LED_CHANNELS && scan.running; ch++) {
                        const id = 'led' + S + ch;
                        scan.at = BY_ID[id].name; lit = new Set([id]);
                        const r = await link.set(id, true, null, 1000, false, 100);
                        let mA = null;
                        if (r.ok) {
                            await new Promise((res) => setTimeout(res, 350));
                            const rd = await link.readLeds(ecu);
                            const c = rd && rd.find((x) => x.ch === ch);
                            mA = c ? c.mA : null;
                            await link.set(id, false);
                        }
                        // taken = usable (the read back, when there is one, says whether it drew current)
                        checked[id] = r.ok ? { ok: true, how: 'led', mA, t: Date.now() } : { ok: false, why: why(r), t: Date.now() };
                        if (r.ok) scan.found[S].push(ch);
                        // the module has no such routine (or doesn't answer): the rest of this side is the same
                        if (!r.ok && (r.nrc === null || r.nrc === 0x11 || r.nrc === 0x12 || r.nrc === 0x33)) {
                            for (let c2 = ch + 1; c2 <= LED_CHANNELS; c2++) checked['led' + S + c2] = { ok: false, why: why(r), t: Date.now() };
                            break;
                        }
                        await new Promise((res) => setTimeout(res, 150));
                    }
                    // the side's "all channels" works when any one channel does
                    checked['led' + S + '0'] = scan.found[S].length ? { ok: true, how: 'led', t: Date.now() } : { ok: false, why: 'no channel answered', t: Date.now() };
                }
                save();
            } finally {
                lit = new Set(); scan.running = false; scan.at = '';
                if (!fromCheck) await link.stop();
            }
        }
        /** A light show starts dark: the lamps that are on now (read from the body controller) are held off while it
         *  runs, so a flash is never a lamp that was on anyway. Only lamps the app can give back: normally-off ones,
         *  and the others (tail, plate) only when outputs are timed (they go back by themselves). Never the brake
         *  lights. Emergency patterns leave every other lamp alone. */
        async function darkAtStart(p) {
            if (p.kind !== 'show' || !link.layout || guarded()) return [];     // (driving, guard on: nothing held dark)
            const st = await link.readStates();
            if (!st) return [];
            const r = LAMPS.filter((l) => link.how[l.id] === 'out' && !l.outDark && st[l.out] && l.usual !== 'brake' && (!l.usual || link.timer)
                && !(checked[l.id] && checked[l.id].ok === false)).map((l) => l.id);
            return r;
        }
        /** Stop (and pause: there is no paused state that keeps lamps - pausing hands them back too) */
        async function stop(why) {
            if (!player.running && !manual.running) return;
            log.info('light show: stopped' + (why ? ' (' + why + ')' : ''));
            await returnToEcu(why === 'stopped' ? '' : why || '');
        }
        settings.onChange && settings.onChange((key) => {
            if (/^manual/.test(key)) { syncManual(); if (key === 'manualMode') manual.setMode(settings.get(key)); }
            if ((key === 'pattern' || /^(strobeHz|pulseMs|strobeLamps|loops)$/.test(key)) && player.running) player.setPattern(withLoops(pattern()));
            if (key === 'speed' && player.running) player.speed = speedK();
            if (key === 'linkProfile') limiter.setProfile(settings.get('linkProfile'));
            if (/^(highBeamMaxS|cooldownS|maxDuty)$/.test(key)) thermalCfg();
        });
        // the stops that don't need a button: moving, the time limit, a stalled link, a finished loop count
        let wasRunning = false;
        setInterval(() => {
            const running = player.running || manual.running;
            if (wasRunning && !player.running && player.finished && !manual.running && !guardian.busy) {
                stopWhy = 'Done: ' + player.rounds + (player.rounds === 1 ? ' round' : ' rounds');
                player.finished = false;
                verifyBack().catch(() => null);
            }
            wasRunning = running;
            if (!running) return;
            const p = player.running ? player.pattern : null;
            if (moving() && parkedOnly()) stop('Stopped: the car moved (Only while parked is on)');
            else if (guarded() && p && p.modes) stop('Stopped: the car moved - ' + p.name + ' flashes the headlights off and on (While driving: keep headlights on is on)');
            const lim = Number(settings.get('autoStop')) || 0;
            if (lim && Date.now() - startedAt > lim * 60000) stop('Stopped: time limit, ' + lim + ' min');
            // the thermal guard during a pattern: a lamp over its limit cools down (the player keeps it dark); manual
            // control asks it itself each pass
            if (player.running) { const over = thermal.over(); if (over.length) stopWhy = over.map((x) => BY_ID[x.id].name + ' resting: ' + x.why).join('; '); }
            guardian.watch();
        }, 250);

        /* ---------- the lamp check: each lamp on for a moment, in turn ---------- */
        const check = { running: false, at: -1, results: {} };
        async function runCheck() {
            if (check.running || player.running || guardian.busy) return;
            // (it takes over every lamp in turn for about a minute: never while driving - 0.5 didn't check)
            if (moving()) { stopWhy = 'Lamp check: only while parked'; return; }
            if (manual.running) await returnToEcu('');
            check.running = true; check.results = {};
            limiter.reset();
            await link.start();
            // the body controller's output request: the layout it takes (a moment on the rear left turn signal)
            link.layout = null; link.probed = null; link.noRelease = false; link.releaseForm = null;   // (measured afresh)
            check.at = -1; lit = new Set(['indRL']);
            await link.probe();
            lit = new Set();
            checked._layout = link.layout ? link.layout.id : null;
            checked._probed = link.probed;
            // whether its last byte is a time (the rear fog light on, its state read until it goes dark by itself)
            check.at = -1; check.step = 'Timing the outputs (rear fog light left)'; lit = new Set(['rfogL']);
            await link.probeTimer();
            lit = new Set(); check.step = null;
            checked._timer = link.timer; checked._timerTried = link.timerTried;
            // how fast the link can go: one at a time vs sent without waiting (the left reversing light blinks)
            check.step = 'Speed test (the left reversing light blinks)'; lit = new Set(['revL']);
            checked._speed = await link.speedTest(8);
            // whether the car's gateway answers on the car's Ethernet (as it does to tools on the OBD port)
            check.step = 'Looking for the gateway on the car network'; lit = new Set();
            try { checked._gateway = await findGateway(log, { timeoutMs: 1500 }); } catch (e) { checked._gateway = { error: String(e.message || e), found: [], interfaces: [] }; }
            check.step = null;
            for (let i = 0; i < LAMPS.length && check.running; i++) {
                const l = LAMPS[i];
                check.at = i; lit = new Set([l.id]);
                // 1. its headlight module (the front lamps: on the G05's LED headlights the body controller takes their
                // output requests and nothing lights), 2. its own output (body controller), 3. its lamp function
                let r = { ok: false, nrc: null }, how = null;
                const tried = [];
                if (l.flm) { link.how[l.id] = 'flm'; r = await link.set(l.id, true, null, CHECK_ON_MS); tried.push('headlight: ' + why(r)); if (r.ok) how = 'flm'; }
                if (!how && link.layout && !l.outDark && !l.usual) { link.how[l.id] = 'out'; r = await link.set(l.id, true, null, CHECK_ON_MS); tried.push('output: ' + why(r)); if (r.ok) how = 'out'; }
                let fnOk = false;
                if (!how) { const fr = await link.fn(l.id, CHECK_ON_MS); fnOk = fr.ok; if (FN[l.id]) tried.push('function: ' + why(fr)); }
                // what the body controller says its output is now (an output it took but didn't switch: read 0)
                let read = null;
                if (how === 'out') { await new Promise((res) => setTimeout(res, 300)); const st = await link.readStates(); read = st ? st[l.out] : null; }
                await new Promise((res) => setTimeout(res, CHECK_ON_MS));
                // back to the car. Refused: a lamp that is normally off is held dark (lamps.js); one the car keeps on
                // (brake, tail, plate) is never held dark - it's marked stuck and the page says what to do
                let gave = { ok: true };
                if (how === 'out') gave = await link.set(l.id, false, 'release');
                if (how === 'flm') gave = await link.set(l.id, false);
                link.how[l.id] = how === 'flm' ? 'flm' : 'out';
                lit = new Set();
                checked[l.id] = how ? { ok: true, how, back: gave.ok ? (gave.timed ? 'by itself' : 'ok') : why(gave), read, t: Date.now(), ms: r.ms }
                    : { ok: false, fn: fnOk, why: fnOk ? 'function only (both sides)' : tried.join(', ') || 'no way', t: Date.now() };
                log.info('lamp check: ' + l.name + ': ' + (how ? 'works by its ' + (how === 'flm' ? 'headlight module' : 'output') + ', ' + r.ms + ' ms' : checked[l.id].why) + ' [' + tried.join(', ') + ']');
                await new Promise((res) => setTimeout(res, CHECK_GAP_MS));
            }
            // the high beams lit by nothing so far: four other functions in the left headlight, A to D, 1.5 s each
            // the car's own flashing modes, A to E, 2.5 s each (one request, the unit flashes by itself): the driver says
            // which flashed - a fast strobe needs one of them (the car takes ~3 requests a second)
            const TRIES = [
                { what: 'left headlight, Panik-Modus', ecu: FLM_L, lv: FLM_FLASH.panic, lamps: ['highL', 'lowL'] },
                { what: 'left headlight, alarm flashing', ecu: FLM_L, lv: FLM_FLASH.alarm, lamps: ['highL', 'lowL'] },
                { what: 'left headlight, hold-up alarm', ecu: FLM_L, lv: FLM_FLASH.holdup, lamps: ['highL', 'lowL'] },
                { what: 'body controller, special flashing', fn: BDC_FLASH.special, lamps: ['indFL', 'indFR', 'indRL', 'indRR'] },
                { what: 'body controller, reversing flash', fn: BDC_FLASH.reversing, lamps: ['revL', 'revR'] },
            ];
            checked._flashTries = [];
            for (let i = 0; i < TRIES.length && check.running; i++) {
                const tr = TRIES[i], L = 'ABCDE'[i];
                check.at = -1; check.step = 'Flash try ' + L + ' of A-E: ' + tr.what + ' (did it flash?)'; lit = new Set(tr.lamps);
                const r = tr.ecu ? await link.lvTry(tr.ecu, tr.lv, 2) : await link.flashFn(tr.fn, 2500);
                checked._flashTries.push(L + ' ' + why(r));
                await new Promise((res) => setTimeout(res, 2500));
                if (tr.ecu) await link.lvTry(tr.ecu, tr.lv, 0);
                lit = new Set();
                await new Promise((res) => setTimeout(res, 800));
            }
            check.step = null;
            // 0.7: the headlights' single LED channels
            if (check.running) { check.step = 'LED channels: each one lit for a moment, left headlight then right'; await runLedScan(true); check.step = null; }
            // whether this body controller gives lamps back (kept: no give-back requests while patterns run if not)
            checked._noRelease = LAMPS.some((l) => checked[l.id] && checked[l.id].how === 'out' && checked[l.id].back && checked[l.id].back !== 'ok' && checked[l.id].back !== 'by itself');
            save();
            await link.stop();
            await verifyBack();
            check.running = false; check.at = -1;
        }
        /** after the lamps were given back: the brake lights read from the body controller (the pedal not pressed,
         *  they're off) - still on: stuck, whatever the replies said */
        async function verifyBack() {
            await new Promise((res) => setTimeout(res, 500));
            const st = await link.readStates();
            if (!st) return;
            ['brakeL', 'brakeR', 'brakeM'].forEach((id) => { if (st[BY_ID[id].out]) link.stuck.add(id); else link.stuck.delete(id); });
        }

        /* ---------- pages ---------- */
        const PAGES = ['Light Show', 'Lamp check', 'Network', 'Manual'];
        const MANUAL = 3;
        /* ---------- the Network page: the car's gateway searched for on the head unit's in-car networks ---------- */
        const netSearch = { running: false, result: checked._net || null, bcast: checked._gateway || null, t0: 0 };
        async function runNet() {
            if (netSearch.running) return;
            netSearch.running = true; netSearch.t0 = Date.now();
            try {
                netSearch.bcast = await findGateway(log, { timeoutMs: 1500 });
                netSearch.result = await searchGateway(log, { max: 160 });
                netSearch.wifi = await scanWifi();
                checked._net = netSearch.result; checked._gateway = netSearch.bcast; save();
                // a gateway found anywhere: connect (HSFZ, then DoIP) and keep it
                const hosts = Array.from(new Set(netSearch.bcast.found.map((f) => f.ip)
                    .concat(netSearch.result.open.map((o) => o.ip), netSearch.wifi.open.map((o) => o.ip))));
                netSearch.direct = hosts.length ? (await tryDirect(hosts) ? 'connected' : 'found ' + hosts.join(', ') + ' but no link: ' + direct.error) : 'no gateway found';
            } catch (e) { netSearch.result = { error: String(e.message || e) }; }
            netSearch.running = false;
        }
        let page = 0;
        ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; return render(); });
        // the bar's buttons do what fits the page: on Manual, Start / stop presses the item the controller is on and
        // Next pattern moves to the next item (the HMI's own buttons, so the iDrive knob, press and touch all work)
        ui.onClick('BTN_RUN', async () => {
            if (page === MANUAL) await pressItem(items()[manualFocus]);
            else if (page === 2) runNet();
            else if (page === 1) { if (check.running) check.running = false; else runCheck(); }
            else if (player.running) stop('stopped'); else start();        // (not awaited: the page draws at once)
            return render();
        });
        /** every lamp the body controller has an output for, given back (also ones held from an earlier run the app
         *  doesn't know of: brake lights left on), every give-back form tried; then the sessions ended */
        const back = { running: false, done: null };
        async function giveAllBack() {
            if (back.running) return;
            manual.allOff(); scan.running = false;
            if (player.running || manual.running) await returnToEcu('');
            check.running = false;
            back.running = true; back.done = null;
            limiter.reset();
            await link.start();
            link.releaseForm = null; link.releaseTried = [];
            let ok = 0, refused = 0;
            for (const l of LAMPS.concat(KEPT)) {
                link.how[l.id] = 'out';
                const r = await link.release(l.id, true);
                if (r.ok) ok++; else refused++;
                link.releaseForm = null;          // (every form again for the next lamp: one may take what another doesn't)
            }
            restore();
            // (0.5.1 started another 30 s direct-link timer here on every press: removed, the one at start does it)
            await link.stop();
            await verifyBack();
            back.running = false;
            back.done = ok + ' given back, ' + refused + ' refused' + (link.releaseTried.length ? ' (' + Array.from(new Set(link.releaseTried.map((x) => x.id + ' ' + x.why))).slice(0, 4).join(', ') + ')' : '');
            log.info('light show: give lamps back: ' + back.done);
        }
        ui.onClick('BTN_BACK', () => { giveAllBack(); return render(); });
        ui.onClick('BTN_PATTERN', () => {
            if (page === MANUAL) { manualFocus = (manualFocus + 1) % items().length; return render(); }
            // the patterns, the custom strobe, then the sequences (the file is read again when the list wraps)
            const all = allPatterns(), cur = settings.get('pattern');
            const i = all.findIndex((p) => p.id === cur);
            if (i === all.length - 1) loadSequences();
            const next = allPatterns()[(i + 1) % allPatterns().length];
            settings.set('pattern', next.id);
            if (player.running) player.setPattern(withLoops(pattern()));
            return render();
        });
        if (ctx.onTab) ctx.onTab((i) => { page = i; return render(); });
        // a tap on a Manual item presses it (touchscreen, where the kit runs the screen)
        if (ctx.onTap) ctx.onTap((x, y) => {
            if (page !== MANUAL) return null;
            const all = items(), i = all.findIndex((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
            if (i < 0) return null;
            manualFocus = i;
            return pressItem(all[i]).then(() => render());
        });
        /**
         * The Manual page's items, laid out like BimmerLink's: the effect (modes, RUN, Clear, Scan LEDs), its
         * parameters (speed, brightness, count: - and +), then the lights to drive (lamp groups; LED 1-9 and All, each
         * headlight). Each { kind, key, label, x, y, w, h }; the controller goes through them in this order.
         */
        function items() {
            const out = [], X = 40, R = 1560, G = 10;
            let x = X;
            MODES.forEach((m) => { out.push({ kind: 'mode', key: m.key, label: m.label, x, y: 92, w: 176, h: 54 }); x += 176 + G; });
            out.push({ kind: 'run', label: 'RUN', x, y: 92, w: 190, h: 54 }); x += 190 + G;
            out.push({ kind: 'clear', label: 'Clear', x, y: 92, w: 140, h: 54 }); x += 140 + G;
            out.push({ kind: 'scan', label: 'Scan LEDs', x, y: 92, w: R - x, h: 54 });
            [['manualHz', 'Speed', HZ_STEPS], ['manualBrightness', 'Brightness', BRIGHT_STEPS], ['manualCount', 'Flashes', COUNT_STEPS]].forEach(([key, label, list], j) => {
                const x0 = X + j * 400;
                out.push({ kind: 'step', key, list, d: -1, label: '-', x: x0, y: 156, w: 60, h: 52, name: label });
                out.push({ kind: 'step', key, list, d: 1, label: '+', x: x0 + 300, y: 156, w: 60, h: 52, name: label });
            });
            const row = (list, y) => { const w = (R - X - G * (list.length - 1)) / list.length; list.forEach((tg, i) => out.push({ kind: 'target', key: tg.key, label: tg.label, x: X + i * (w + G), y, w, h: 62 })); };
            row(TARGETS.filter((tg) => !tg.led), 220);
            row(TARGETS.filter((tg) => tg.led && tg.key[3] === 'L'), 292);
            row(TARGETS.filter((tg) => tg.led && tg.key[3] === 'R'), 364);
            return out;
        }
        async function pressItem(it) {
            if (!it) return;
            if (it.kind === 'mode') manualParam('manualMode', it.key);
            else if (it.kind === 'run') await manualRun();
            else if (it.kind === 'clear') { manual.allOff(); if (manual.running) await returnToEcu(''); }
            else if (it.kind === 'scan') { if (scan.running) scan.running = false; else runLedScan(); }
            else if (it.kind === 'step') manualParam(it.key, stepIn(it.list, settings.get(it.key), it.d));
            else if (it.kind === 'target') await manualToggle(it.key);
        }

        /** The car from above, front at the top, each lamp a dot (lit: bright and haloed). */
        function car(cv, t, cx, y0, w, h, on, mark) {
            cv.roundRect(cx - w / 2, y0, w, h, w * 0.22, withAlpha('#ffffff', 0.06));
            cv.strokeRoundRect(cx - w / 2, y0, w, h, w * 0.22, 2, withAlpha('#ffffff', 0.25));
            cv.roundRect(cx - w * 0.36, y0 + h * 0.22, w * 0.72, h * 0.16, 10, withAlpha('#ffffff', 0.08));     // windscreen
            cv.roundRect(cx - w * 0.34, y0 + h * 0.74, w * 0.68, h * 0.1, 10, withAlpha('#ffffff', 0.08));      // rear window
            cv.text('FRONT', cx, y0 - 10, 14, t.dim, { align: 'center', font: 'bold', spacing: 2 });
            LAMPS.forEach((l) => {
                const [sx, sy, col] = SPOT[l.id], x = cx + sx * w / 2, y = y0 + sy * h;
                const bad = checked[l.id] && checked[l.id].ok === false;
                if (on.has(l.id)) { cv.circle(x, y, 20, withAlpha(col, 0.25)); cv.circle(x, y, 11, col); }
                else cv.circle(x, y, 7, bad ? withAlpha(t.dim, 0.35) : withAlpha(col, 0.35));
                if (mark === l.id) cv.strokeRoundRect(x - 16, y - 16, 32, 32, 8, 2, t.text);
            });
            // the headlights' LED channels: a row of small dots under each headlight, lit ones bright
            LEDS.forEach((l) => {
                if (!l.led.ch || l.led.ch > 9) return;
                const sx = (l.side === 'L' ? -1 : 1) * (0.3 + l.led.ch * 0.07), x = cx + sx * w / 2, y = y0 + 0.13 * h;
                if (on.has(l.id) || on.has('led' + l.side + '0')) { cv.circle(x, y, 7, withAlpha(WHITE, 0.3)); cv.circle(x, y, 4, WHITE); }
                else cv.circle(x, y, 2.5, withAlpha(WHITE, 0.25));
            });
        }

        function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const p = pattern();
            const stats = link.stats;
            const linkLine = (link.diag === direct ? 'DIRECT ' + direct.proto.toUpperCase() + ' ' + direct.host + '   ·   ' : '')
                + 'Body controller: ' + (link.active ? 'session ' + (link.session || '...') : 'idle') + '   ·   '
                + stats.ok + ' ok, ' + stats.refused + ' refused, ' + stats.missed + ' unanswered' + (stats.ms ? '   ·   ' + Math.round(stats.ms) + ' ms a request' : '')
                + (diag.available ? '' : '   ·   diagnostic link not available')
                + '   ·   rate ' + limiter.profileName + (limiter.tripped ? ' TRIPPED' : limiter.backoff ? ', backing off ' + limiter.backoff + ' ms' : '');
            // what the player did, for a photo: frames shown, lamps it lit now, the last refusal
            const runLine = 'Frames ' + player.frames + (player.late ? ', link too slow ' + player.late + 'x' : '') + '   ·   lit now: '
                + (Array.from(lit).map((id) => BY_ID[id] ? BY_ID[id].name : id).join(', ') || 'none')
                + '   ·   last refused: ' + (stats.last || 'none') + (player.error ? '   ·   ERROR: ' + player.error : '');
            if (page === 0) {
                G.panel(cv, t, 24, 44, 1040, 468, 'Pattern');
                cv.text(p.name, 56, 140, 52, t.text, { font: 'bold' });
                cv.text(p.what, 56, 184, 22, t.dim, { literal: true });
                const kind = p.kind === 'emergency' ? 'EMERGENCY  ·  the car keeps its low beams, tail and brake lights'
                    : p.custom ? (p.id === 'custom' ? 'CUSTOM STROBE  ·  from Settings  ·  parked only' : 'YOUR SEQUENCE  ·  ' + SEQ_FILE + '  ·  parked only') : 'LIGHT SHOW  ·  takes over any lamp: parked';
                cv.text(kind, 56, 222, 18, p.kind === 'emergency' ? AMBER : t.dim, { font: 'bold', spacing: 1 });
                const run = player.running;
                cv.roundRect(56, 252, 300, 70, 14, run ? withAlpha(RED, 0.85) : withAlpha(GO, 0.85));
                cv.text(run ? 'RUNNING' : 'STOPPED', 206, 298, 30, '#ffffff', { align: 'center', font: 'bold', spacing: 2 });
                cv.text(run ? 'Start / stop button: stop. Every lamp goes back to the car.' : 'Start / stop button: start.  Next pattern: ' + (() => { const a = allPatterns(), i = a.findIndex((x) => x.id === p.id); return a[(i + 1) % a.length].name; })(),
                    380, 296, 20, t.text, { literal: true });
                const missing = lampsOf(p).filter((id) => !usable(id)).map((id) => BY_ID[id].name);
                const lines = [
                    'Speed x' + speedK() + '   ·   ' + (parkedOnly() ? 'only while parked' : 'also while driving' + (keepHeadlights() ? ' (headlights kept on)' : ' (headlights NOT guarded)')) + '   ·   '
                        + (Number(settings.get('autoStop')) ? 'stops after ' + settings.get('autoStop') + ' min' : 'no time limit')
                        + (run ? '   ·   running ' + Math.round((Date.now() - startedAt) / 1000) + ' s' + (player.late ? ', link too slow ' + player.late + 'x' : '') : '')
                        + (run && player.pattern && player.pattern.loops ? '   ·   round ' + Math.min(player.rounds + 1, player.pattern.loops) + ' of ' + player.pattern.loops : '')
                        + (p.custom && p.id !== 'custom' && seqProblems.length ? '   ·   ' + seqProblems.length + ' sequence note(s): see the log' : ''),
                    missing.length ? 'Left out (refused in the lamp check): ' + missing.join(', ') : Object.keys(checked).length ? 'Every lamp of this pattern passed the lamp check' : 'Lamp check not run yet: see the Lamp check page',
                    stopWhy || player.error || (link.noRelease ? 'This body controller holds lamps dark between flashes (no single release)' : ''),
                    linkLine,
                ];
                lines.forEach((s, i) => cv.text(s, 56, 360 + i * 30, 17, i === 2 && (stopWhy || player.error) ? t.warn : t.dim, { literal: true }));
                cv.text(runLine, 56, 486, 14, player.error ? t.warn : t.dim, { literal: true });
                G.panel(cv, t, 1088, 44, 488, 468, 'Lamps now');
                car(cv, t, 1332, 104, 250, 380, lit, null);
            } else if (page === MANUAL) {
                G.panel(cv, t, 24, 44, 1552, 468, 'Manual control');
                const S = t.sel || t.accent || GO;
                const running = manual.running;
                items().forEach((it, i) => {
                    const focus = i === manualFocus;
                    let fill = withAlpha('#ffffff', 0.08), txt = t.text, sub = null;
                    if (it.kind === 'mode') { if (manual.mode === it.key) { fill = withAlpha(S, 0.85); txt = '#ffffff'; } }
                    else if (it.kind === 'run') { fill = running ? withAlpha(RED, 0.9) : withAlpha(GO, 0.9); txt = '#ffffff'; }
                    else if (it.kind === 'scan' && scan.running) { fill = withAlpha(AMBER, 0.85); txt = '#ffffff'; }
                    else if (it.kind === 'target') {
                        const off = manual.why(it.key), sel = manual.isOn(it.key);
                        const tg = TARGET[it.key], ids = tg.ids, now = ids.some((id) => lit.has(id));
                        const hot = ids.map((id) => manual.blocked[id]).find((b) => b);
                        if (sel) { fill = withAlpha(S, now ? 0.95 : 0.55); txt = '#ffffff'; }
                        else if (off && !tg.led) { fill = withAlpha('#ffffff', 0.03); txt = withAlpha(t.dim, 0.6); }
                        sub = hot || (tg.led && checked[tg.ids[0]] ? (checked[tg.ids[0]].ok ? (checked[tg.ids[0]].mA ? checked[tg.ids[0]].mA + ' mA' : 'answers') : 'no answer') : tg.led ? 'not scanned' : off ? 'not available' : '');
                        if (now) cv.circle(it.x + it.w - 14, it.y + 14, 6, '#ffffff');
                    }
                    cv.roundRect(it.x, it.y, it.w, it.h, 12, fill);
                    if (focus) cv.strokeRoundRect(it.x - 3, it.y - 3, it.w + 6, it.h + 6, 14, 3, t.text);
                    const label = it.kind === 'run' ? (running ? 'STOP' : 'RUN') : it.kind === 'scan' && scan.running ? 'Scanning...' : it.label;
                    const big = it.kind === 'step' ? 30 : it.kind === 'target' ? 18 : 20;
                    cv.text(label, it.x + it.w / 2, it.y + (sub ? 28 : it.h / 2 + 8), big, txt, { align: 'center', font: 'bold', literal: true });
                    if (sub) cv.text(sub, it.x + it.w / 2, it.y + 50, 12, it.kind === 'target' && manual.isOn(it.key) ? '#ffffff' : t.dim, { align: 'center', literal: true });
                });
                // the parameters' values between their - and +
                const unit = { manualHz: ' Hz', manualBrightness: ' %', manualCount: '' };
                ['manualHz', 'manualBrightness', 'manualCount'].forEach((k, j) => {
                    const x0 = 40 + j * 400 + 70;
                    cv.text(['Speed', 'Brightness (LEDs)', 'Flashes (Single flash)'][j], x0 + 110, 174, 14, t.dim, { align: 'center', literal: true });
                    cv.text(String(settings.get(k)) + unit[k], x0 + 110, 200, 24, t.text, { align: 'center', font: 'bold', literal: true });
                });
                // what runs, and how fast the car really lets it
                const eff = manual.effHz(), asked = Number(settings.get('manualHz')) || 2;
                const limited = manual.mode !== 'solid' && eff < asked * 0.95;
                const modeName = (MODES.find((m) => m.key === manual.mode) || MODES[0]).label;
                cv.text((running ? 'RUNNING  ' : '') + modeName, 1220, 180, 20, running ? t.text : t.dim, { font: 'bold', literal: true });
                cv.text(scan.running ? 'Scanning: ' + scan.at
                    : manual.mode === 'solid' ? manual.on.size + ' picked, held' : limited ? Math.round(eff * 10) / 10 + ' Hz: the car\'s limit (asked ' + asked + ')' : manual.on.size + ' picked, ' + asked + ' Hz',
                    1220, 203, 14, limited ? t.warn : t.dim, { literal: true });
                const fc = items()[manualFocus];
                const hint = fc && fc.kind === 'target' && manual.why(fc.key) && !manual.isOn(fc.key) ? fc.label + ': ' + manual.why(fc.key)
                    : 'Pick lights, a mode and its speed, then RUN   ·   Next pattern: next item, Start / stop: press it   ·   Give lamps back: everything off';
                cv.text(hint, 40, 456, 15, fc && fc.kind === 'target' && manual.why(fc.key) ? t.warn : t.dim, { literal: true });
                cv.text((stopWhy || (parkedOnly() ? 'parked only' : 'also while driving') + '; stops when the screen is left') + '   ·   ' + linkLine, 40, 480, 12, stopWhy ? t.warn : t.dim, { literal: true });
            } else if (page === 2) {
                G.panel(cv, t, 24, 44, 1552, 468, 'Network');
                const r = netSearch.result, b = netSearch.bcast;
                cv.text(netSearch.running ? 'Searching... ' + Math.round((Date.now() - netSearch.t0) / 1000) + ' s (up to about a minute)'
                    : 'Start / stop button: search the car network for the gateway (nothing is sent but identification requests)', 56, 120, 22, t.text, { font: 'bold', literal: true });
                const L = [];
                if (b) L.push(['Interfaces', (b.interfaces || []).join('   ')]);
                if (r && r.routes) L.push(['Routes', r.routes.join('   ')]);
                if (r && r.neighbours) L.push(['Neighbours', r.neighbours.join('   ') || 'none in the ARP table']);
                if (b) L.push(['Broadcast', b.found.length ? b.found.map((f) => f.proto + ' ' + f.ip + ' ' + f.text).join('; ') : 'no answer' + (b.error ? ' (' + b.error + ')' : '')]);
                if (r && r.tried !== undefined) {
                    L.push(['Asked directly', r.tried + ' addresses: ' + (r.answered.length ? r.answered.map((a) => a.ip + ' ' + a.text).join('; ') : 'no DoIP answer')]);
                    L.push(['Ports open', r.open.length ? r.open.map((o) => o.ip + ':' + o.port).join('   ') : 'none of 13400 / 6801 / 6811 on any of them']);
                }
                if (netSearch.wifi) L.push(['Wi-Fi', (netSearch.wifi.nets.length ? netSearch.wifi.nets.join(', ') + ': ' : 'no Wi-Fi client network  ')
                    + (netSearch.wifi.open.length ? netSearch.wifi.open.map((o) => o.ip + ':' + o.port).join('   ') : 'no diagnostic port open')]);
                L.push(['Direct link', direct.available ? direct.proto.toUpperCase() + ' ' + direct.host + (direct.vin ? '  VIN ' + direct.vin : '') + '  -  the lamps go this way'
                    : (netSearch.direct || 'not connected') + (checked._direct ? '  (last: ' + checked._direct + ')' : '')]);
                if (r && r.error) L.push(['Error', r.error]);
                // long lines wrapped at ~170 characters
                let y = 170;
                L.forEach(([k, v]) => {
                    cv.text(k, 56, y, 17, t.dim, { font: 'bold', literal: true });
                    const parts = String(v).match(/.{1,170}(\s|$)/g) || [''];
                    parts.slice(0, 4).forEach((ln) => { cv.text(ln.trim(), 230, y, 15, t.text, { literal: true }); y += 22; });
                    y += 6;
                });
            } else {
                G.panel(cv, t, 24, 44, 1040, 468, 'Lamp check');
                const cur = check.at >= 0 ? LAMPS[check.at] : null;
                cv.text(check.running ? (check.step || (cur ? cur.name : 'Starting...')) : 'Each lamp on for a moment, in turn', 56, 130, check.step ? 32 : 40, t.text, { font: 'bold', literal: true });
                cv.text(check.running ? (check.at + 1) + ' of ' + LAMPS.length + '   ·   Start / stop button: stop the check'
                    : 'Start / stop button: run it (about ' + Math.round(LAMPS.length * (CHECK_ON_MS + CHECK_GAP_MS) / 1000) + ' s). Watch or film the car: the order is the list below.', 56, 170, 20, t.dim, { literal: true });
                // the list in three columns: tick (took it), cross (refused, why), dot (not checked)
                LAMPS.forEach((l, i) => {
                    const col = Math.floor(i / 8), row = i % 8, x = 56 + col * 336, y = 214 + row * 32;
                    const c = checked[l.id], now = check.running && check.at === i;
                    // a drawn mark (the car's font has no tick or cross): green works, amber refused, white now, grey not checked
                    const mc = now ? t.text : !c ? withAlpha(t.dim, 0.5) : c.ok ? GO : t.warn;
                    if (now || !c) cv.circle(x + 8, y - 6, now ? 8 : 5, mc);
                    else cv.roundRect(x, y - 14, 18, 16, 4, mc);
                    cv.text((i + 1) + '. ' + l.name, x + 26, y, 17, now ? t.text : t.dim, { literal: true });
                    if (c && !c.ok) cv.text(c.why, x + 26, y + 15, 12, t.warn, { literal: true });
                    else if (c && c.ok) {
                        const gaveOk = !c.back || c.back === 'ok' || c.back === 'by itself';
                        const readTxt = c.read === 1 ? '  ·  read on' : c.read === 0 ? '  ·  read OFF' : '';
                        cv.text((c.how === 'flm' ? 'headlight module' : 'own output') + readTxt + (gaveOk ? (c.back === 'by itself' ? '  ·  back by itself' : '') : '  ·  not given back: ' + c.back),
                            x + 26, y + 15, 12, gaveOk && c.read !== 0 ? t.dim : t.warn, { literal: true });
                    }
                });
                // the output layouts the body controller was offered, and what it said to each
                const pr = check.running && link.probed ? link.probed : checked._probed;
                const prLine = pr ? 'Output request: ' + pr.map((x) => x.id + ' ' + x.why).join('  ·  ') + (checked._layout || (check.running && link.layout) ? '' : '  -  none taken') : '';
                const tm = check.running ? link.timer : checked._timer, tt = check.running ? link.timerTried : checked._timerTried;
                const tmLine = tt ? 'Time byte: ' + tt.join(', ') + (tm ? '  -  ' + tm.unitMs + ' ms a step: lamps go back by themselves' : '  -  not a time') : '';
                const hb = checked._flashTries ? '   ·   Flash tries: ' + checked._flashTries.join(', ') : '';
                const sp = checked._speed, gw = checked._gateway;
                const spLine = (sp ? 'Speed: one at a time ' + sp.seqMs + ' ms a request; sent without waiting: ' + sp.pipe.taken + ' of ' + sp.pipe.sent + ' taken, '
                    + sp.pipe.answered + ' answered, ' + sp.pipe.ms + ' ms each (' + Object.keys(sp.pipe.verdicts).map((k) => k + ' ' + sp.pipe.verdicts[k]).join(', ') + ')' : '')
                    + (gw ? '   ·   Gateway: ' + (gw.found.length ? gw.found.map((f) => f.proto + ' ' + f.ip + ' ' + f.text).join('; ') : 'none answered') + ' [' + (gw.interfaces || []).join(', ') + ']' + (gw.error ? ' ' + gw.error : '') : '');
                cv.text(prLine, 56, 462, 12, (checked._layout || (check.running && link.layout)) ? GO : t.warn, { literal: true });
                cv.text(tmLine + hb, 56, 477, 12, tm ? GO : t.dim, { literal: true });
                cv.text(spLine, 56, 492, 12, gw && gw.found && gw.found.length ? GO : t.dim, { literal: true });
                cv.text(linkLine, 56, 507, 12, t.dim, { literal: true });
                G.panel(cv, t, 1088, 44, 488, 468, 'Now on');
                car(cv, t, 1332, 104, 250, 380, lit, cur && cur.id);
            }
            // lamps the body controller wouldn't give back (brake / tail / plate): the driver must know
            if (link.stuck.size || back.running || back.done) {
                const stuck = Array.from(link.stuck).map((id) => BY_ID[id].name);
                const msg = back.running ? 'Giving every lamp back to the car...'
                    : stuck.length ? 'ON / NOT GIVEN BACK: ' + stuck.join(', ') + ' (brake pedal not pressed). Press Give lamps back; if they stay on, switch the car off and on.'
                        : 'Give lamps back: ' + back.done;
                cv.roundRect(24, 44, 1552, 34, 6, stuck.length ? withAlpha(RED, 0.9) : withAlpha(t.panel || '#202634', 0.95));
                cv.text(msg, 40, 67, 18, '#ffffff', { font: 'bold', literal: true });
            }
            G.frame(cv, t, PAGES, page, []);
            return ui.image('MAIN_GFX', cv);
        }
        // while this page is shown and nothing runs: the brake lights read every 3 s (a stuck one shows in red)
        let drawnT = 0;
        setInterval(() => {
            if (Date.now() - drawnT < 2000 && !player.running && !check.running && !back.running && link.layout && !link.active) verifyBack().catch(() => null);
        }, 3000);
        ctx.loop('MAIN', 8, () => { drawnT = Date.now(); return render(); });
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
        process.on('exit', () => { if (player.running || manual.running || check.running) log.warn('light show: closing while running: the body controller gives the lamps back in a few seconds'); });
        return { player, link, check, back, net: netSearch, direct, stop, start, runCheck, giveAllBack, pages: () => page,
            manual, manualToggle, manualRun, manualParam, items, pressItem, scan, runLedScan, limiter, thermal, guardian, sequences: () => sequences, seqProblems: () => seqProblems, pattern, loadSequences };
    },
});
