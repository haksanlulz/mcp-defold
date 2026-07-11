-- example/bridge.lua — skeleton in-game debug bridge for mcp-defold.
-- Drop into your project (e.g. main/debug/bridge.lua), require it from a
-- script that runs every frame, and fill in the game-specific hooks.
-- Gate it behind a debug flag so it never ships in a release build.
--
-- Protocol: newline-delimited JSON over localhost TCP. See PROTOCOL.md.

local M = {}

local PORT = 17890 -- match your projects.json entry

local server = nil
local client = nil
local buf = ""

-- ---- game-specific hooks: fill these in -----------------------------------

-- Compose the current screen as text. This is what the agent "sees".
local function compose_screen()
  -- TODO: build a text frame from your game state, e.g. an ASCII map + HUD.
  return "day 1  hp 10/10\n@ . . .\n. . # ."
end

-- Compact state as a table (serialized to JSON for the client).
local function read_state()
  -- TODO: return the fields an agent needs to reason about your game.
  return { location = "start", hp = 10, flags = {} }
end

-- Inject one input action as pressed + released.
local function inject_input(trigger)
  -- TODO: route to your input handling, e.g. by posting to your controller:
  -- msg.post("/player#controller", "bridge_input", { action = hash(trigger) })
  print("bridge input: " .. trigger)
end

-- Skip the front-end and begin a run. opts is the decoded start request.
local function start_run(opts)
  -- TODO: bypass title/menu screens and start a game with the given options.
  print("bridge start")
end

local function tail_log(n)
  -- TODO: return the last n lines of your mirrored log, if you keep one.
  -- Must be a list of strings: an empty Lua table encodes as a JSON object,
  -- not the array the protocol documents.
  return { "(log tail not wired: fill in tail_log)" }
end

-- ---- protocol plumbing (usually no changes needed) -------------------------

local function respond(req)
  if req.cmd == "ping" then
    return { ok = true }
  elseif req.cmd == "screen" then
    return { frame = compose_screen() }
  elseif req.cmd == "state" then
    return read_state()
  elseif req.cmd == "input" then
    inject_input(tostring(req.trigger))
    return { ok = true }
  elseif req.cmd == "start" then
    start_run(req)
    return { ok = true }
  elseif req.cmd == "log" then
    return { lines = tail_log(tonumber(req.tail) or 40) }
  elseif req.cmd == "quit" then
    msg.post("@system:", "exit", { code = 0 })
    return { ok = true }
  else
    return { error = "unknown cmd: " .. tostring(req.cmd) }
  end
end

function M.init()
  server = socket.tcp()
  server:setoption("reuseaddr", true)
  assert(server:bind("127.0.0.1", PORT))
  server:listen(1)
  server:settimeout(0) -- non-blocking accept
  print("bridge listening on " .. PORT)
end

-- Call every frame (from a script's update).
function M.update()
  if not server then return end
  if not client then
    client = server:accept()
    if client then client:settimeout(0) end
    return
  end
  local line, err, partial = client:receive("*l")
  if partial and #partial > 0 then buf = buf .. partial end
  if line then
    local ok, req = pcall(json.decode, buf .. line)
    buf = ""
    local res = ok and respond(req) or { error = "bad json" }
    client:send(json.encode(res) .. "\n")
    client:close()
    client = nil
  elseif err == "closed" then
    client = nil
    buf = ""
  end
end

return M
