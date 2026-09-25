# mcp-defold

MCP server for driving [Defold](https://defold.com) games through an in-game debug bridge. An MCP client can build the game, launch it, start a run, press inputs, and read the screen, state, and logs. Enough to playtest.

I built it because tests and simulators kept passing on builds of my own games that were broken or unplayable. Making the agent play the real build caught what they missed.

## Tools

| Tool | What it does |
|------|--------------|
| `defold_run` | Build with the bridge enabled and launch, detached. Returns when the bridge answers a ping from this server, not just when the run script says it should. The one exception is a ping that never leaves the per-port queue, which means another call is already connected there. Before launching it pings the port and refuses if anything accepts the dial: a bridged game already answers, the ping times out waiting for the slot (another call is connected), or the port is held by something that never answers, replies with something that is not JSON, replies with JSON that is not an object, or hangs up before replying. One test each. Only a refused dial (`BridgeUnreachable`) reads as an empty port. On a refusal, `defold_stop` first. When the holder did not answer, the refusal says that `defold_stop` cannot reach a wedged engine and gives the commands to find the process listening on the port, to end by hand. `skip_build` relaunches fast. |
| `defold_stop` | Quit the running game cleanly. |
| `defold_start` | Skip the front-end (title/chargen) and begin a run. `options` passes game-defined start options through. |
| `defold_input` | Press input triggers in order, then return the screen. |
| `defold_screen` | The current screen as a composed text frame. |
| `defold_state` | Compact game-state JSON (fields are game-defined). |
| `defold_log` | Tail of the game's mirrored debug log. |
| `defold_bridge` | Raw passthrough for game-specific bridge commands. |
| `defold_test` | Run the project's headless test suite, if configured. A non-zero exit is a tool error, not a result. `tail` widens the output window (default 12 lines). |

## Install

```bash
git clone https://github.com/haksanlulz/mcp-defold
cd mcp-defold
npm install
cp projects.example.json projects.json   # register your game
```

Runs directly with [`tsx`](https://github.com/privatenumber/tsx); no build step. [PowerShell 7](https://github.com/PowerShell/PowerShell) (`pwsh`, cross-platform) runs the run and test scripts, and the unit suite spawns it too. Skip the `projects.json` step and the server still starts: the first tool call is what tells you to copy the example.

Two Node floors, and they are different numbers.

- Runtime: `package.json` declares `engines: >=18` and the single runtime dependency agrees, but that bound is declared and hasn't been measured. CI runs 20 and 22; nothing here has been run on 18.
- Development: higher, and measured. `npm install` pulls vitest (4.1.11 as locked, `engines: ^20.0.0 || ^22.0.0 || >=24.0.0`), which pulls vite (8.2.2, `^20.19.0 || >=22.12.0`). Without `engine-strict` that's a warning, and this repo ships no `.npmrc`, so an install on 18 is untested, which isn't the same as known broken.

Node 20 or newer to work on it. Below that, treat the runtime bound as unverified.

## Use it from an MCP client

```json
{
  "mcpServers": {
    "defold": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/mcp-defold/index.ts"]
    }
  }
}
```

Env: `MCP_DEFOLD_PROJECTS` overrides the registry path; `MCP_DEFOLD_DEFAULT` picks the default project.

## A session

Four calls take an agent from nothing to a readable game. The frame below is real output from a private project, with its proper nouns replaced.

**`defold_run`** builds with the bridge compiled in, launches the engine detached, and returns once the bridge answers a ping from this server (with the queue exception noted in the table above):

```
== bob build (variant debug, bridge port 17890) ==
  bob build OK
== launching dmengine (detached, log: .defold-tools/last-bridged-run.out) ==
  pid 30032
== bridge LIVE on 127.0.0.1:17890 ==
```

**`defold_start`** begins a run. It exists because injected input can't reach a GUI front-end: a title screen or character creator has to be skipped through the bridge, since it can't be driven. `options` is whatever your game's bridge accepts, here `{"mode": "casual"}`:

```json
{"ok":true,"started":true}
```

**`defold_input`** presses triggers in order and returns the screen. This is `{"triggers": ["key_w", "key_w"]}`, two steps north into a fountain:

```
== village | Day 1, Hour 08 ==
HP 17 / 17 | Stamina 25 / 25
...................>....................
.,,,,,,.,,,,,,,,,,.:.,,,,,.,,,,,,,,,,,,.
.,,,,,.,,,,,,,,,,,.:.,,,,,,,,,,,,,,,,,,.
.,,,,,,,,,,,,,,,,,.:..,,,,,,,,,,,,,,,,,.
.,,,,,,,,,,,,,,,::::.,,,,,,,,,,,,,,,,,,.
..........T^^^^^:######^^^^^..........T.
T..........^^^T^:#__p_#^^^^^..........T.
...........^^^^^:##+###^^^^^............
T.........T.....::::...........T........
...................:....................
...............v.v.:....................
...................:....................
...................:...::::::::.........
.........::::::%v%%%%%v%.#####:.........
.........:#####%%%%%%%%%.#___#:.........
.........:#_S_#%%%%%%%%%.+_H_#:.........
>:::::::::#___+%%%%O%%%%.#___#:::::::::>
..........#_N_#%%%%@%%%%v#___#..........
..........#####%%%%v%%%%.#####..........
...............%%%%%%%%%................
....................:%..................
.................%K%:%%M%%..............
.................%%%:%%%%%..............
.................#+#:#+#.#+#............
.................#_#:#_#.#_#............
.................###:###.###............
....................:...................
~~~~~~~~~~~~~~~~*=========~~~~~~~~~~~~~~
~~~~~~~~~~~~~~~~*=========~~~~~~~~~~~~~~
~~~~~~~~~~~~~~~~~~~~~>~~~~~~~~~~~~~~~~~~
Contract: clear the west field — 0/3 — 14s
On the stone road | Silver 0 | Talents: none
The fountain bars the way.
```

The last line is the game's answer to the second press. This server renders nothing. The frame is text the game's own bridge composes, so an agent reads whatever a player would. **`defold_screen`** returns the same frame without pressing anything, **`defold_state`** returns the fields the game chooses to expose as JSON, and **`defold_stop`** quits the game cleanly.

## What your game has to provide

Two things, both on the game side (this server is just the client):

1. **An in-game bridge:** newline-delimited JSON over localhost TCP answering `ping` / `screen` / `state` / `input` / `start` / `log` / `quit`. Protocol in [PROTOCOL.md](PROTOCOL.md); working skeleton in [example/bridge.lua](example/bridge.lua). Gate it behind a debug flag so it never ships in release builds.
2. **A run script:** builds with the bridge compiled in, launches the engine detached, prints `bridge LIVE on <port>`.

The screen is text on purpose: compose whatever view carries your game's state (an ASCII map + HUD for a roguelike, a score readout for an arcade game).

## Limitations

- Screens are text frames composed by the game's bridge; there are no pixel screenshots.
- `defold_input` presses and releases each trigger; nothing can be held down.
- Bridge input drives the in-game controller and can't reach the GUI front-end; `defold_start` exists because injected input can't get past menus.
- Run and test scripts are invoked through `pwsh`; there is no other runner.
- Bridge calls are serialized per port, because the bridge answers one client per frame. Parallel tool calls queue rather than overlap, and each one's timeout covers its wait as well as its socket time.
- That serialization is per call, not per tool. `defold_input` makes one call per trigger plus one for the screen, so a `defold_screen` fired in parallel can return a frame from the middle of the sequence. Drive one tool at a time when the order matters.

## Testing

```bash
npm test          # vitest: tool handlers against a fake in-process bridge (no Defold needed)
npm run smoke     # spawn the real server over stdio and exercise its error paths (offline)
npm run typecheck
```

Two tiers, both offline. `npm test` is the unit tier: 66 tests in 2 files, run in about twenty seconds. Ten of them spawn a real `pwsh` to exercise the exit-code, marker and `skip_build` paths, so PowerShell 7 is a requirement of the unit tier as well as of the run scripts. One of the ten spends eight of those seconds waiting out a real queue timeout, which is the behaviour it is there to pin. `npm run smoke` spawns the real server as a child process over stdio and checks its error paths and the run-script marker contract; it needs no Defold install and no network. `npm run typecheck` reads index.ts, server.ts, smoke.ts and the tests, so the smoke harness is typechecked by the step that runs before it.

Counts, measured 2026-09-15:

- app: 744 lines (`find . -maxdepth 1 -name '*.ts' -not -name '*.test.ts' -not -name 'smoke.ts' | xargs wc -l`; index.ts + server.ts). smoke.ts is another 298 lines of test harness.
- tests: 1228 lines (`find test -name '*.test.ts' | xargs wc -l`), 66 `it()` blocks.

What they cover, by layer. The TCP bridge layer: timeout, unreachable port, non-JSON reply, a reply that parses into something other than an object (`null`, a number, a string, an array), a 70 KB reply split across chunks, a bridge that hangs up before replying (what a game quitting mid-request produces), a `frame` field that is not a string, five concurrent calls against a bridge that serves one at a time, a queued call's deadline, that a call which gives up while queued still frees the slot behind it, and which cause and which figure a timeout message carries in each of the two cases (queued, and dialed after a wait; the second is also measured as elapsed time, so the remaining-budget arithmetic can't be dropped without a test noticing). The registry loader: missing file, missing fields, non-string testScript, duplicate ports. The marker scan: each of its three verdicts, the precedence between them, and both of the paths that reach `defold_run` (failure marker, and an exit with no marker at all). The tool handlers: every tool driven through a real MCP client against a fake bridge that speaks the wire protocol, including input ordering, the failing-trigger message, argument validation on every argument the tools take (`triggers`, `options`, `args` and `cmd`, the wrong-typed `tail` and `skip_build` that are rejected rather than coerced, and `project`, where both a non-string and an empty string are errors rather than a silent fall-back to the default), a project name that is an `Object.prototype` key, the refuse-to-double-launch preflight in six cases (the ping answered, a ping that never leaves the queue, and a port that accepts the dial and then never answers, sends non-JSON, sends JSON that is not an object, or hangs up), the post-marker confirmation in all three of its outcomes (a bridge that answers, a port with nothing on it, and a ping still queued behind another call), the missing-root check, `defold_log`'s tail default, `defold_run`'s `skip_build`, `defold_bridge`'s frame-or-JSON branch, and `MCP_DEFOLD_DEFAULT` project selection. `defold_test`'s exit-code handling runs real `pwsh` scripts. A source-level guard pins the import surface to the stdio transport and the runtime dependency list to one entry.

Mutation probes, both re-run against the 66-test suite on 2026-09-15. Swapping the spread order in `defold_start`, so a caller's `options.cmd` overrides the fixed `start` command, turned exactly one test red: `defold_start options cannot override the start command`, with the other 65 green. Inverting the precedence in `markerVerdict`, so a failure marker outranks a success marker, turned exactly one test red: `lets success outrank a failure printed earlier in the run`, with the other 65 green. The source was restored after each run. Every fix in this suite's history carries its own probe in the commit that added it. These two are re-measured here because a green count is only true of the suite it was counted on.

Assertion policy: assert behavior and payloads, never that a function was called. A grep for `toHaveBeenCalled` finds zero sites in this suite; nothing was pruned.

## AI assistance

This project was built with AI assistance (Claude). Correctness was established by the test suite (tool handlers driven end-to-end through a real MCP client against a fake in-process bridge that speaks the actual wire protocol, plus failure-path tests for the TCP layer), an offline smoke run that spawns the real server over stdio and checks its error paths (`npm run smoke`), and playtesting my own games with it. I review the code and am responsible for it.

## License

MIT © Abishai James. Defold is a trademark of the Defold Foundation; this project is unofficial.
