# Light Show

Flashes the exterior lamps in patterns through BMW's own test functions, as the SGBDs for the G05's body controller
(`BDC_G05`, diagnostic address 0x40) and LED headlight modules (`FLM02_L` / `FLM02_R`, 0x43 / 0x44) describe them:

| What | Request | SGBD job |
| --- | --- | --- |
| one lamp output on / off (body controller, every lamp, each side its own) | `2F E3 B5` + a layout the lamp check finds | LICHT_AUSGANG_DIGITAL_STEUERN |
| that output back to the car | `2F E3 B5 00 <output>` | (return control to the ECU) |
| a light function in one headlight (front lamps, one module a side) | `2E D6 DC 00 <function> <seconds>` (0 s: off) | FLM_FUNKTION_LICHTVERTEILUNG |
| a lamp function for a time (both sides, except the turn signals) | `2E D5 42 00 <function> <time, 10 ms>` | LEUCHTEN_FUNKTION |
| session / keep-alive | `10 03`, `3E 00` every 2 s, `10 01` at stop | |

The SGBD names the output request's arguments (output, on / off) but not its layout, and the G05 refused the two
obvious ones (`2F E3 B5 <output> 01`: out of range, `2F E3 B5 03 <output> 01`: wrong length). The lamp check tries
the layouts in `lamps.js` (LAYOUTS) on the rear left turn signal and keeps the first one taken; the page shows what the
body controller said to each. Without one, the front lamps go through their headlight module (one a side) and the
turn signals through their side's own lamp function.

Nothing else can be sent: `check()` refuses any other request, or a request to another unit, before it reaches the
transport.

## Pages

- **Light Show**: the pattern (Next pattern, or Settings), Start / stop, the lamps lit now.
- **Lamp check**: first the output layout (the rear left turn signal blinks a few times), then each lamp on for
  1.2 s in turn (about 50 s, the order is the list on the page): front lamps by their headlight module first (on the
  G05's LED headlights the body controller takes their output requests and nothing lights), then by the body
  controller's output, else by the lamp function. Under each lamp: how it works, and whether it was given back. A lamp that only works through a both-sides function is left out of every pattern (the turn
  signals are the exception: left and right are separate functions).

## Patterns

- **Emergency** (wig-wag, wig-wag + fogs, double flash, front and rear, rear only, corner strobe): only lamps that
  are normally off while driving (high beams, fog lights, turn signals, rear fog and reversing lights). Between
  flashes each lamp goes back to the car, so the low beams, tail lights and brake lights stay the car's own (the
  brake pedal works as always).
- **Show** (chase, sweep, everything, blink): any lamp, held dark between flashes. For a parked car.

## What the lamp check measures

- **Output request layout**: `03 <output> <on/off> 00` on the G05 (the line at the bottom of the page).
- **Time byte**: whether that layout's last byte is an activation time - the rear fog light on with it set to 10, then
  1, its state read from the body controller (`22 E3 B9`, LICHT_AUSGANG_DIGITAL: a byte an output, by its number)
  until it goes dark by itself. If it does, every output is sent with a time and goes back to the car by itself:
  no give-back request (the G05 refuses every form of it: "conditions not correct").
- **Read on / read OFF** under each lamp: what the body controller says the output is while it should be lit.
- (The high beams use Fernlicht Modus 1a: an earlier check's tries in the left headlight found it - Fernlichtblinken
  was taken and nothing lit.)
- **Flash tries A-E** (2.5 s each): the car's own flashing modes, one request each - the left headlight's Panik-Modus,
  alarm flashing and hold-up alarm, the body controller's special flashing and reversing flash. The driver says which
  flashed. (The car takes one request at a time, ~300 ms each - several sent together, only the first is taken - so
  a fast strobe needs a mode that flashes by itself.)
- **Speed test**: eight on / off requests to the left reversing light one at a time (each waiting for its reply,
  as the patterns send), then eight sent as soon as the transport took the one before: whether the head unit's
  diagnostic transport queues requests (then patterns could go several times faster) or turns them away.
- **Gateway search** (`gateway.js`): the DoIP (13400) and HSFZ (6811) identification broadcasts on the car's
  Ethernet - whether the head unit can reach the gateway directly, the way OBD-port tools (BimmerLight: ENET / Wi-Fi
  adapters) do, for requests in milliseconds instead of ~300 ms. Discovery only.
- Afterwards the brake lights are read: still on (pedal not pressed) = stuck, a red bar on both pages.

A **light show** starts dark: lamps on before it (read from the body controller) are held off while it runs - never
the brake lights, and tail / plate lights only when outputs are timed. Emergency patterns leave other lamps alone.

## Network page

The thorough gateway search (`gateway.js` searchGateway): the head unit's interfaces, routes and ARP neighbours on
its in-car networks (BMW's 160.48.199.x VLANs on a G05), every neighbour and the usual unit addresses of each
network asked for DoIP identification directly (not broadcast) and tried on the diagnostic TCP ports 13400 (DoIP),
6801 / 6811 (HSFZ) - connect and close, nothing sent. A gateway that takes connections there would let the app send
lamp requests in milliseconds, as OBD-port tools do, instead of ~300 ms each through the head unit's transport (which
takes one request at a time: the speed test saw 7 of 8 turned away as busy when sent without waiting).

## Direct link (ENET cable + travel router)

`direct.js`: the car's gateway straight over Ethernet, as OBD-port tools reach it - HSFZ (TCP 6801, tester 0xF4)
or DoIP (TCP 13400, routing activation with tester 0x0EF3 / 0x0E80 / 0x00F4), proven with the gateway's VIN (22 F1 90).
For a head unit joined to the Wi-Fi of a travel router with an ENET cable in its LAN port (the car's gateway gets an
address by DHCP there). The Network page's search also tries every address of the head unit's Wi-Fi client network
(wlan0) on both ports, connects to a gateway it finds and keeps it: from then on every lamp request goes that way
(milliseconds, not ~300 ms), tried again at start and every 30 s, and back to the head unit's transport whenever the
link goes. The same requests (`check()` vets them all) either way.

## Lamps never switched

Brake, tail and number plate lights (the body controller won't give them back), and the low beams and daytime lights
by the body controller (only through their headlight module, which gives them back with a 0 s light function).

## Safety

- A lamp the car normally keeps on (brake, tail, plate) is never held dark. If the body controller won't take one
  back (a G05 kept its brake lights on after 0.2.0's check: ending the session did not give them back), the app
  tries every give-back form (`releases()` in lamps.js), and if none is taken it marks the lamp stuck: a red bar on
  both pages names it. **Give lamps back** (button) tries every form on every output, also for lamps held from an
  earlier run; if a lamp still stays on, switching the car off and on gives it back.

- Stop gives every lamp back and ends the diagnostic session.
- If the app goes away without stopping (closed, crashed, head unit restart), the body controller drops back to its
  default session a few seconds later (no tester present) and every lamp is the car's own again.
- **Only while parked** (setting, off for now): a pattern doesn't start, or stops, once the car moves (> 3 km/h).
  Meant to be on for a public light show release.
- **Stop by itself after** (setting): a time limit.

## 0.6: manual control, your own sequences, rate and thermal limits

New files: `safety.js` (rate limiter, thermal guard, Guardian), `sequences.js` (the sequence compiler and the
built-in sequences), `manual.js` (manual control). Tests: `kit/tools/test_light_show_pro.js`. On the PC:
`kit/tools/light_seq.py` (check a sequence file, see its timeline, copy it to the car).

### Manual page

Twelve tiles: low beams, high beams, daytime lights, fog lights, turn left / right, hazards (they blink, as the
car's do), rear fogs, reversing lights, and tail / plate / puddle lights greyed out with the reason. **Next
pattern** moves to the next tile, **Start / stop** switches it, a tap on a tile switches it, **Give lamps back**
turns everything off. Lamps are held by sending their timed functions again every 0.8 s; switching the last one off
ends the diagnostic session. Parked only, always.

### Sequences

`light-sequences.json` in the app's data folder (`python3 kit/tools/light_seq.py push my.json --key <key>`), or the
three built-in ones. Steps: `{ "on": [...], "ms" }`, `strobe` (hz, duty), `alternate` (a / b at hz), `chase`
(order, stepMs, rounds), `repeat` (nested up to 3 deep), and `loops` per sequence. Lamp ids from `lamps.js` or the
groups in `sequences.js` (`high`, `low`, `drl`, `fog`, `turnL`, `turnR`, `hazard`, `rearFog`, `reverse`, `front`,
`rear`, `left`, `right`, `all`). Fades are refused: the lamp test functions only switch on and off. Steps under
50 ms and strobes over 10 Hz are clamped; a frame holding a lamp past its thermal limit is split.

Through the head unit's own transport every lamp switch is one request of ~300 ms: a sequence with many changes a
round plays slower than written (the Player keeps the rhythm, frames get longer). `light_seq.py check` says by how
much. The direct link (Network page) is the fast path.

### Custom strobe

The pattern **Custom strobe** is built from Settings: Strobe speed (Hz), Pulse (on time, ms), Strobe lamps, Loop count.

### Safety

- **Rate limiter**: every request (patterns, manual, lamp check, tester present) waits for a token: 4 a second with
  a burst of 2 through the head unit (Normal; Safe 3, Fast 6), 20 a second on the direct link, and a gap per unit.
  "Busy" or unanswered requests double a pause (250 ms to 2 s); six in a row trip a breaker: the run stops and every
  lamp is handed back (the give-back requests always get through).
- **Thermal guard**: high beams at most 8 s on without a break and 50 % of any minute (Settings), then 20 s dark;
  fogs, signals and rear lamps have looser fixed limits. The player keeps a resting lamp dark; manual control
  switches it off and says why on its tile. These are app margins, not BMW figures.
- **Back to the car** (one teardown at a time): Stop, a finished loop count, the time limit (now 15 min by default),
  the car moving, leaving the screen or an HMI popup covering it (setting, on), a player with no frame for 5 s, the
  breaker, SIGTERM / SIGINT from the platform. If the app dies outright, the units' own session timeout (no tester
  present for ~5 s) hands every lamp back, as before.
- **Only while parked** (setting, now on by default) covers every pattern, sequence and manual control. Off, they
  also run while driving.
- **While driving: keep headlights on** (setting, on by default) applies only then: the player leaves the low beams
  and daytime lights to the car (no lamp held dark, lamps given back between flashes) and the headlights'
  panic-flashing patterns (Headlight strobe, Reverse flash) don't start, or stop when the car moves, since they
  flash the headlights off and on. Off, patterns behave while driving exactly as when parked.

## 0.7: Manual control like BimmerLink, the headlights' single LEDs

The Manual page is now: an effect (**Solid**, **Blink**, **Strobe**, **Pulse**, **Single flash**), **RUN / STOP**,
**Clear**, **Scan LEDs**; Speed (0.5-10 Hz), Brightness (LEDs, 10-100 %) and Flashes (Single flash) with - / +;
then the lights: the lamp groups, and each headlight's **LED 1-9** and **All** (every channel in one request).
Pick lights, an effect, its speed, RUN. Picks and parameters change a running effect at once; the effect and its
parameters are also in Settings (kept, and the knob works there).

The single LEDs are the headlight modules' FLM_KANAL routine (FLM02 SGBD): `31 01 A5 4B <channel 0-15> <PWM %>
<seconds>` (the module drives the channel that long, then it is the car's own again), stop `31 02 A5 4B`, read back
`22 D6 DB` (each channel's PWM and current). check() allows only these, only to the headlight modules, the time 0-2 s
(never 255: "on for good"), PWM 0-100 %. Held channels are sent again every 0.8 s; Stop ends the routine in each
module; if the app dies, every channel goes back within 2 s. Which channel is which LED depends on the headlight:
**Scan LEDs** (also the end of the lamp check) lights each one in turn and keeps which answer, with their current.

Pulse steps an LED channel's brightness up and down (25-100-25 % of Brightness); lamps without dimming blink for it.
Every effect runs at the speed asked or, when the car can't take that many requests (~300 ms each through the
head unit), evenly at the fastest it can - the page says so ("the car's limit"). "All L / All R" or the direct link
are the way to go faster. The thermal guard treats LED channels as high beams.

While driving with **While driving: keep headlights on** (default), LED channels are not offered: some are the low
beams, and an effect's dark half would dim them.
