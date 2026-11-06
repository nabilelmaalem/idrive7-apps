#!/usr/bin/env python3
"""light_seq.py - Light Show sequences on the PC: check a sequence file, see its timeline, put it on the car.

    python3 kit/tools/light_seq.py example > my-show.json      # a file to start from
    python3 kit/tools/light_seq.py check my-show.json          # errors, warnings, timeline, lamp load
    python3 kit/tools/light_seq.py push my-show.json --host 172.16.222.97 --key ~/.ssh/mgu_root_key

The file is compiled by the app's own compiler (apps/light_show/sequences.js, run with Node), so what this tool
accepts is exactly what the car accepts - one source of truth for groups, limits and clamps.

push copies it to the Light Show app's data folder on the head unit as light-sequences.json (found by the lamp
check's lamp-check.json next to it; run the lamp check once first), owned by the app's own user. The app reads it
again the next time a pattern starts or Next pattern wraps around - no restart, no rebuild.

Only Python 3.6+ standard library, Node 14+, and the OpenSSH client (for push).
"""
import argparse
import json
import os
import shlex
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
APP = os.path.join(ROOT, 'apps', 'light_show')
REMOTE_NAME = 'light-sequences.json'
REQUEST_MS = 300          # one request through the head unit's own diagnostic transport (measured on a G05)

# the JS side: compile every sequence of the file with the thermal clamp at the default settings
NODE = r"""
const path = require('path'), fs = require('fs');
const Module = require('module');
const load = Module._load;
Module._load = function (r, p, m) {            // lamps.js needs nothing from the kit; stub it in case
    if (r.startsWith('./kit/')) return {};
    return load.call(this, r, p, m);
};
const app = process.argv[1], file = process.argv[2], spec = JSON.parse(process.argv[3]);
const SEQ = require(path.join(app, 'sequences.js'));
const { ThermalGuard } = require(path.join(app, 'safety.js'));
const th = new ThermalGuard(); th.configure(spec);
const text = fs.readFileSync(file, 'utf8');
let list;
try { const j = JSON.parse(text); list = Array.isArray(j) ? j : j && j.sequences; } catch (e) { console.log(JSON.stringify({ fatal: 'not JSON: ' + e.message })); process.exit(0); }
if (!Array.isArray(list)) { console.log(JSON.stringify({ fatal: 'expected a list of sequences, or { "sequences": [...] }' })); process.exit(0); }
const out = list.map((s) => {
    const r = SEQ.compile(s, { maxFrameMs: (id) => th.maxFrameMs(id) });
    return { id: s && s.id, ok: r.ok, errors: r.errors, warnings: r.warnings, pattern: r.pattern,
        limits: r.pattern ? Object.fromEntries(Array.from(new Set([].concat(...r.pattern.frames.map((f) => f.on)))).map((id) => [id, th.cls(id)])) : {} };
});
console.log(JSON.stringify({ results: out, groups: SEQ.GROUPS }));
"""

EXAMPLE = {
    "sequences": [
        {"id": "arrival", "name": "Arrival", "loops": 1, "steps": [
            {"on": ["drl"], "ms": 600},
            {"ms": 200},
            {"chase": {"order": ["indFL", "fogL", "highL", "highR", "fogR", "indFR"], "stepMs": 150, "rounds": 1}},
            {"strobe": {"on": ["high"], "hz": 3, "duty": 0.4, "ms": 1200}},
            {"on": ["low", "drl"], "ms": 1500},
            {"ms": 300}
        ]},
        {"id": "side_wave", "name": "Side wave", "loops": 0, "speed": 1, "steps": [
            {"repeat": 2, "steps": [{"on": ["left"], "ms": 300}, {"ms": 150}]},
            {"repeat": 2, "steps": [{"on": ["right"], "ms": 300}, {"ms": 150}]},
            {"alternate": {"a": ["turnL", "fogL"], "b": ["turnR", "fogR"], "hz": 2, "ms": 2000}},
            {"ms": 500}
        ]}
    ]
}


def compile_file(path, args):
    spec = {'highBeamMaxS': args.high_beam_max_s, 'cooldownS': args.cooldown_s, 'maxDuty': args.max_duty}
    try:
        p = subprocess.run(['node', '-e', NODE, APP, os.path.abspath(path), json.dumps(spec)],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=60)
    except FileNotFoundError:
        sys.exit('Node.js is needed (the app\'s own compiler runs in it): https://nodejs.org')
    if p.returncode != 0:
        sys.exit('compiler failed:\n' + p.stderr)
    return json.loads(p.stdout)


def timeline(pattern, width=72):
    """one line a lamp: '#' lit, '.' dark, over one round, scaled to width characters"""
    frames = pattern['frames']
    total = sum(f['ms'] for f in frames) or 1
    lamps = []
    for f in frames:
        for i in f['on']:
            if i not in lamps:
                lamps.append(i)
    rows = []
    for lamp in lamps:
        line, t = [], 0
        for f in frames:
            n = max(1, round(f['ms'] * width / total)) if f['ms'] * width / total >= 0.5 else 0
            line.append(('#' if lamp in f['on'] else '.') * n)
            t += f['ms']
        rows.append('  %-7s %s' % (lamp, ''.join(line)[:width]))
    return rows, total


def report(res, args):
    if 'fatal' in res:
        print('ERROR: ' + res['fatal'])
        return False
    good = True
    seen = set()
    for r in res['results']:
        label = r['id'] or '(no id)'
        print('=' * 78)
        if not r['ok']:
            good = False
            print('%s: NOT USABLE' % label)
            for e in r['errors']:
                print('  error:   ' + e)
            continue
        p = r['pattern']
        if p['id'] in seen:
            good = False
            print('%s: id used twice - the car keeps only the first' % label)
            continue
        seen.add(p['id'])
        print('%s - "%s": %s' % (label, p['name'], p['what']))
        for w in r['warnings']:
            print('  warning: ' + w)
        rows, total = timeline(p)
        print('  one round, %.2f s:' % (total / 1000.0))
        print('\n'.join(rows))
        # how the car will keep up: each frame sends at least one request per lamp that changes
        changes, prev = 0, set()
        for f in p['frames'] + p['frames'][:1]:
            cur = set(f['on'])
            changes += len(cur ^ prev)
            prev = cur
        need = changes * REQUEST_MS
        if need > total:
            print('  pace:    ~%d lamp switches a round need ~%.1f s through the head unit (%d ms each): the car '
                  'will play this %.1fx slower. An ENET direct link (Network page) is ~20x faster.'
                  % (changes, need / 1000.0, REQUEST_MS, need / float(total)))
        # lamp load against the thermal limits: lit share of one round, the longest unbroken on time
        for lamp, lim in sorted(r['limits'].items()):
            lit = sum(f['ms'] for f in p['frames'] if lamp in f['on'])
            longest, run = 0, 0
            for f in p['frames'] * 2:
                run = run + f['ms'] if lamp in f['on'] else 0
                longest = max(longest, run)
            share = lit / float(total)
            if share > lim['duty'] or longest > lim['maxOnMs']:
                print('  thermal: %s lit %d%% (limit %d%%), longest %.1f s (limit %.1f s): the app will rest it, '
                      'it goes dark for %d s at times' % (lamp, share * 100, lim['duty'] * 100, longest / 1000.0,
                                                          lim['maxOnMs'] / 1000.0, lim['coolMs'] / 1000))
    print('=' * 78)
    return good


def ssh_base(args, tool):
    cmd = [tool, '-o', 'ConnectTimeout=8']
    if args.key:
        cmd += ['-i', os.path.expanduser(args.key)]
    cmd += [('-p' if tool == 'ssh' else '-P'), str(args.port)]
    for o in args.ssh_opt or []:
        cmd += ['-o', o]
    return cmd


def push(path, args):
    res = compile_file(path, args)
    if not report(res, args):
        if not args.force:
            sys.exit('Not pushed: fix the errors above (or --force to send it anyway; the car leaves out bad sequences).')
    target = '%s@%s' % (args.user, args.host)
    # the app's data folder: where the lamp check left lamp-check.json (oap_<uid>/data of the Light Show app)
    find = "for f in /var/opt/public/oap/oap_*/data/lamp-check.json; do [ -f \"$f\" ] && dirname \"$f\"; done"
    p = subprocess.run(ssh_base(args, 'ssh') + [target, find], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       universal_newlines=True, timeout=30)
    dirs = [d for d in p.stdout.split() if d]
    if p.returncode != 0 and not dirs:
        sys.exit('ssh failed: ' + p.stderr.strip())
    if not dirs:
        sys.exit('No Light Show data folder found: open the app on the car and run its Lamp check once, then try again.')
    if len(dirs) > 1:
        print('Several Light Show data folders (%s): using the first. Pass --dir to choose.' % ', '.join(dirs))
    d = args.dir or dirs[0]
    tmp = '/tmp/' + REMOTE_NAME
    subprocess.run(ssh_base(args, 'scp') + [path, '%s:%s' % (target, tmp)], check=True, timeout=60)
    dst = d.rstrip('/') + '/' + REMOTE_NAME
    # same owner as the folder (the app runs as its own user and must read it), then into place in one rename
    script = ('set -e; o=$(stat -c %%u:%%g %s); cp %s %s.new; chown "$o" %s.new; chmod 0644 %s.new; mv %s.new %s; rm -f %s; echo "$o"'
              % tuple(shlex.quote(x) for x in (d, tmp, dst, dst, dst, dst, dst, tmp)))
    p = subprocess.run(ssh_base(args, 'ssh') + [target, script], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       universal_newlines=True, timeout=30)
    if p.returncode != 0:
        sys.exit('copy on the car failed: ' + p.stderr.strip())
    print('On the car: %s (owner %s). The app reads it at the next Start, or when Next pattern wraps around.'
          % (dst, p.stdout.strip()))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd')
    sub.add_parser('example', help='print an example file')
    for name in ('check', 'push'):
        sp = sub.add_parser(name)
        sp.add_argument('file')
        sp.add_argument('--high-beam-max-s', type=float, default=8, help='as the app setting (8)')
        sp.add_argument('--cooldown-s', type=float, default=20, help='as the app setting (20)')
        sp.add_argument('--max-duty', type=float, default=0.5, help='as the app setting (0.5)')
        if name == 'push':
            sp.add_argument('--host', default='172.16.222.97', help='head unit (the car hotspot default)')
            sp.add_argument('--port', type=int, default=22)
            sp.add_argument('--user', default='root')
            sp.add_argument('--key', help='root\'s private SSH key')
            sp.add_argument('--ssh-opt', action='append', help='extra ssh -o option, repeatable')
            sp.add_argument('--dir', help='the app\'s data folder on the car, if several were found')
            sp.add_argument('--force', action='store_true', help='push even with errors')
    args = ap.parse_args()
    if args.cmd == 'example':
        print(json.dumps(EXAMPLE, indent=2))
    elif args.cmd == 'check':
        sys.exit(0 if report(compile_file(args.file, args), args) else 1)
    elif args.cmd == 'push':
        push(args.file, args)
    else:
        ap.print_help()


if __name__ == '__main__':
    main()
