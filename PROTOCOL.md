# Bridge protocol

The server talks to your game over a TCP socket the game opens on localhost.
One JSON object per line, request → response. `example/bridge.lua` is a
working skeleton.

## Transport

- Game listens on `127.0.0.1:<port>` (the port you register in `projects.json`).
- Client sends one JSON line: `{"cmd": "...", ...args}\n`
- Game replies with one JSON line and can close the connection after.
- One client at a time is enough. The server serializes its calls per port, so
  it never has two connections open to one bridge; `example/bridge.lua` accepts
  at most one client per `update()` tick behind `listen(1)`. A bridge that
  accepts concurrently is fine, but nothing requires it.

## Commands the bridge must answer

| cmd | request extras | response |
|---|---|---|
| `ping` | — | `{"ok": true}` (liveness check, answered every time it is asked: by run scripts, by `defold_run`'s already-running preflight, and by `defold_run` again after the run script's marker to confirm a bridge really answers; reachable via `defold_bridge`) |
| `screen` | — | `{"frame": "<composed text view>"}` |
| `state` | — | any JSON object (position, health, flags: your call) |
| `input` | `"trigger": "<action id>"` | `{"ok": true}`; injects the action as pressed+released |
| `log` | `"tail": N` | `{"lines": ["...", ...]}` |
| `start` | any game-defined options | `{"ok": true}` (skip the front-end, begin a run) |
| `quit` | — | `{"ok": true}`, then exit |

Anything else is reachable through the `defold_bridge` passthrough tool, so
you can add game-specific commands (fast-forward the sim, grant an item,
teleport) without touching this server.

## The run script contract

`runScript` is any script in your project that:

1. builds the game with the bridge compiled in (a debug flag, a build variant,
   whatever your project uses),
2. launches the engine detached, and
3. prints `bridge LIVE on <port>` to stdout once the bridge answers ping,
   or a line starting `FAIL:` if it couldn't.

The server invokes it with `pwsh -NoProfile <runScript>` from the project
root (`-SkipBuild` is appended when `skip_build` is passed), so PowerShell 7
is required (pwsh runs on Windows, macOS, and Linux).

## Screen composition

`screen` returns text because text is what an agent can actually read. Compose
whatever view fits your game: an ASCII terrain-and-actors map with HUD lines
for a roguelike, a stats readout for an incremental, a scene description for
a narrative game. The frame is the screenshot; make it carry the state a
player would see.
