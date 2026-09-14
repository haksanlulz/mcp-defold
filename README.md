# mcp-defold

MCP server for driving [Defold](https://defold.com) games through an in-game debug bridge. An MCP client can build the game, launch it, start a run, press inputs, and read the screen, state, and logs. Enough to playtest.

I built it because tests and simulators kept passing on builds of my own games that were actually broken or unplayable. Making the agent play the real build caught what they missed.

## Tools

| Tool | What it does |
|------|--------------|
| `defold_run` | Build with the bridge enabled and launch, detached. Returns when the bridge answers. `skip_build` relaunches fast. |
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

Runs directly with [`tsx`](https://github.com/privatenumber/tsx); no build step. Requires Node 18+ and [PowerShell 7](https://github.com/PowerShell/PowerShell) (`pwsh`, cross-platform) for the run scripts.

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

## What your game has to provide

Two things, both on the game side (this server is just the client):

1. **An in-game bridge:** newline-delimited JSON over localhost TCP answering `ping` / `screen` / `state` / `input` / `start` / `log` / `quit`. Protocol in [PROTOCOL.md](PROTOCOL.md); working skeleton in [example/bridge.lua](example/bridge.lua). Gate it behind a debug flag so it never ships in release builds.
2. **A run script:** builds with the bridge compiled in, launches the engine detached, prints `bridge LIVE on <port>`.

The screen is text on purpose: compose whatever view carries your game's state (an ASCII map + HUD for a roguelike, a score readout for an arcade game).

## Limitations

- Screens are text frames composed by the game's bridge; there are no pixel screenshots.
- `defold_input` presses and releases each trigger; nothing can be held down.
- Bridge input drives the in-game controller, not the GUI front-end; `defold_start` exists because injected input can't get past menus.
- Run and test scripts are invoked through `pwsh`; there is no other runner.

## Testing

```bash
npm test          # vitest: tool handlers against a fake in-process bridge (no Defold needed)
npm run smoke     # spawn the real server over stdio and exercise its error paths (offline)
npm run typecheck
```

Two tiers, both offline. `npm test` is the unit tier: 31 tests in 2 files, run in about two seconds. Three of them spawn a real `pwsh` to exercise `defold_test`'s exit-code handling, so PowerShell 7 is a requirement of the unit tier as well as of the run scripts. `npm run smoke` spawns the real server as a child process over stdio and checks its error paths and the run-script marker contract; it needs no Defold install and no network.

Counts, measured 2026-09-14:

- app: 462 lines (`find . -maxdepth 1 -name '*.ts' -not -name '*.test.ts' -not -name 'smoke.ts' | xargs wc -l`; index.ts + server.ts). smoke.ts is another 259 lines of test harness.
- tests: 484 lines (`find test -name '*.test.ts' | xargs wc -l`), 31 `it()` blocks.

What they cover, by layer. The TCP bridge layer: timeout, unreachable port, non-JSON reply, and a 70 KB reply split across chunks. The registry loader: missing file, missing fields, non-string testScript, duplicate ports. The tool handlers: every tool driven through a real MCP client against a fake bridge that speaks the wire protocol, including input ordering, the failing-trigger message, the refuse-to-double-launch preflight, and the missing-root check. A source-level guard pins the import surface to the stdio transport and the runtime dependency list to one entry.

Mutation probes. 2026-09-11: swapping the spread order in `defold_start` so a caller's `options.cmd` overrides the fixed `start` command turned exactly one test red, `defold_start options cannot override the start command`, with the other 27 green. 2026-09-14: deleting the non-zero-exit throw from `defold_test` turned exactly the two exit-code tests red, with the other 29 green. The source was restored after each run.

Assertion policy: assert behavior and payloads, never that a function was called. A grep for `toHaveBeenCalled` finds zero sites in this suite; nothing was pruned.

## AI assistance

This project was built with AI assistance (Claude). Correctness was established by the test suite (tool handlers driven end-to-end through a real MCP client against a fake in-process bridge that speaks the actual wire protocol, plus failure-path tests for the TCP layer), an offline smoke run that spawns the real server over stdio and checks its error paths (`npm run smoke`), and playtesting my own games with it. I review the code and am responsible for it.

## License

MIT © Abishai James. Defold is a trademark of the Defold Foundation; this project is unofficial.
