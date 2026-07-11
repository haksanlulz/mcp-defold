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
| `defold_test` | Run the project's headless test suite, if configured. |

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

## Develop

```bash
npm test          # vitest: tool handlers against a fake in-process bridge (no Defold needed)
npm run typecheck
```

## License

MIT © Abishai James. Defold is a trademark of the Defold Foundation; this project is unofficial.
