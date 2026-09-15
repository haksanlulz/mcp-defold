import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import net from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bridgeCall,
  createServer,
  loadProjects,
  markerVerdict,
  translateSpawnError,
  type Project,
} from "../server.js";

// A fake in-process bridge: answers the wire protocol so tool handlers can be
// tested end to end without Defold, a build, or a real game.
let bridgePort = 0;
let bridgeServer: net.Server;
const received: any[] = [];

function fakeBridgeResponse(req: any): any {
  switch (req.cmd) {
    case "ping":
      return { ok: true };
    case "screen":
      return { frame: "day 1  hp 10/10\n@ . . ." };
    case "state":
      return { location: "start", hp: 10 };
    case "input":
      if (req.trigger === "key_broken") return { error: "no such trigger" };
      return { ok: true, trigger: req.trigger };
    case "start":
      return { ok: true, got: req };
    case "log":
      return { lines: ["INFO boot", "DEBUG tick"] };
    case "quit":
      return { ok: true };
    default:
      return { echo: req };
  }
}

beforeAll(async () => {
  bridgeServer = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("utf-8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const req = JSON.parse(buf.slice(0, nl));
        received.push(req);
        sock.write(JSON.stringify(fakeBridgeResponse(req)) + "\n");
        sock.end();
      }
    });
  });
  await new Promise<void>((r) => bridgeServer.listen(0, "127.0.0.1", () => r()));
  bridgePort = (bridgeServer.address() as net.AddressInfo).port;
});

afterAll(() => bridgeServer.close());

async function connectTo(server: ReturnType<typeof createServer>): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function connectWith(proj: Project): Promise<Client> {
  return connectTo(createServer({ testgame: proj }));
}

async function connect(): Promise<Client> {
  return connectWith({ root: ".", port: bridgePort, runScript: "run.ps1" });
}

// Bind an ephemeral port then release it, so a later connect is refused
// deterministically (no game, nothing listening).
async function deadPort(): Promise<number> {
  const srv = net.createServer();
  const port = await new Promise<number>((r) =>
    srv.listen(0, "127.0.0.1", () => r((srv.address() as net.AddressInfo).port)),
  );
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

function textOf(res: any): string {
  return res.content[0].text;
}

/* ---------------------------------------------- run-script fixtures (pwsh) */

// A cold pwsh start can exceed vitest's 5s default on its own.
const PWSH_TIMEOUT = 30_000;
const scriptDirs: string[] = [];

// Write a throwaway project whose run script is `body`.
function scriptProject(body: string, port: number, key: "runScript" | "testScript" = "runScript"): Project {
  const dir = mkdtempSync(join(tmpdir(), "mcpdefold-script-"));
  scriptDirs.push(dir);
  const file = key === "runScript" ? "r.ps1" : "t.ps1";
  writeFileSync(join(dir, file), body);
  return { root: dir, port, runScript: "r.ps1", ...(key === "testScript" ? { testScript: "t.ps1" } : {}) };
}

// A run script that only CLAIMS the bridge is live. Every real one pings
// first, but this server cannot verify that a given script does.
function markerOnlyProject(port: number): Project {
  return scriptProject(`Write-Output 'bridge LIVE on ${port}'\n`, port);
}

// A bridge that hangs up on its FIRST caller and answers every one after.
// defold_run pings twice for opposite reasons: the preflight must see a
// bridge that is NOT live (or it refuses to launch at all), the post-marker
// check must see one that IS. One fixture answers both, with no timing race.
async function lateBridge(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets: net.Socket[] = [];
  let seen = 0;
  const srv = net.createServer((sock) => {
    sockets.push(sock);
    sock.on("error", () => {});
    if (++seen === 1) return void sock.destroy(); // no game yet
    sock.on("data", () => {
      sock.write(JSON.stringify({ ok: true }) + "\n");
      sock.end();
    });
  });
  const port = await new Promise<number>((r) =>
    srv.listen(0, "127.0.0.1", () => r((srv.address() as net.AddressInfo).port)),
  );
  return {
    port,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        srv.close(() => r());
      }),
  };
}

// A bridge that hangs up on its FIRST caller -- so defold_run's preflight sees
// no live game -- and then accepts every later caller without ever replying.
// Whoever dials second therefore holds this port's one call slot for as long
// as the test needs, which is what puts a later call in the queue.
async function slotHoldingBridge(): Promise<{
  port: number;
  firstDial: Promise<void>;
  close: () => Promise<void>;
}> {
  const sockets: net.Socket[] = [];
  let seen = 0;
  let announce!: () => void;
  const firstDial = new Promise<void>((r) => (announce = r));
  const srv = net.createServer((sock) => {
    sockets.push(sock);
    sock.on("error", () => {});
    if (++seen === 1) {
      sock.destroy(); // no game yet
      announce();
    }
    // Every caller after the first: accepted, never answered.
  });
  const port = await new Promise<number>((r) =>
    srv.listen(0, "127.0.0.1", () => r((srv.address() as net.AddressInfo).port)),
  );
  return {
    port,
    firstDial,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        srv.close(() => r());
      }),
  };
}

afterAll(() => {
  // defold_run deliberately does not wait for the script to exit, so on
  // Windows the child can still hold its cwd when the suite ends. A temp dir
  // left behind is not a failure; failing the suite over it would be.
  for (const d of scriptDirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch { /* the OS will reap it */ }
  }
});

describe("mcp-defold server", () => {
  it("exposes all nine tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "defold_bridge",
      "defold_input",
      "defold_log",
      "defold_run",
      "defold_screen",
      "defold_start",
      "defold_state",
      "defold_stop",
      "defold_test",
    ]);
  });

  it("defold_screen returns the composed frame as plain text", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "defold_screen", arguments: {} });
    expect(textOf(res)).toContain("@ . . .");
  });

  it("defold_state returns the state JSON", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "defold_state", arguments: {} });
    expect(JSON.parse(textOf(res))).toEqual({ location: "start", hp: 10 });
  });

  it("defold_input presses triggers in order, then returns the screen", async () => {
    const client = await connect();
    const before = received.length;
    const res = await client.callTool({
      name: "defold_input",
      arguments: { triggers: ["key_w", "key_e"] },
    });
    const mine = received.slice(before);
    expect(mine.map((r) => r.cmd)).toEqual(["input", "input", "screen"]);
    expect(mine[0].trigger).toBe("key_w");
    expect(mine[1].trigger).toBe("key_e");
    expect(textOf(res)).toContain("day 1");
  });

  it("defold_input names the failing trigger and what was already applied", async () => {
    const client = await connect();
    await expect(
      client.callTool({
        name: "defold_input",
        arguments: { triggers: ["key_w", "key_broken", "key_e"] },
      }),
    ).rejects.toThrow(/input 'key_broken' failed.*already applied: key_w/);
  });

  it("defold_input rejects an empty trigger list", async () => {
    const client = await connect();
    await expect(
      client.callTool({ name: "defold_input", arguments: { triggers: [] } }),
    ).rejects.toThrow(/non-empty/);
  });

  it("defold_input rejects a non-string trigger by index, sending nothing", async () => {
    // Coerced, this pressed the trigger '7' and the game's "no such trigger"
    // came back blaming the bridge for a mistake made by the client.
    const client = await connect();
    const before = received.length;
    await expect(
      client.callTool({ name: "defold_input", arguments: { triggers: ["key_w", 7] } }),
    ).rejects.toThrow(/triggers\[1\] must be a non-empty string, got number/);
    expect(received.length).toBe(before);
  });

  it("defold_start rejects an array of options", async () => {
    // typeof [] is "object", so this used to spread into {"0": 1, "1": 2}.
    const client = await connect();
    const before = received.length;
    await expect(
      client.callTool({ name: "defold_start", arguments: { options: [1, 2] } }),
    ).rejects.toThrow(/options must be an object, got an array/);
    expect(received.length).toBe(before);
  });

  it("defold_bridge rejects an array of args", async () => {
    const client = await connect();
    const before = received.length;
    await expect(
      client.callTool({ name: "defold_bridge", arguments: { cmd: "advance", args: [1, 2] } }),
    ).rejects.toThrow(/args must be an object, got an array/);
    expect(received.length).toBe(before);
  });

  it("defold_bridge rejects a non-string cmd, sending nothing", async () => {
    // Coerced, an object arrived at the game as the command '[object Object]'
    // and a number as '7' -- the same defect the trigger list shed, left in
    // place for the tool with the widest input surface.
    const client = await connect();
    const before = received.length;
    await expect(
      client.callTool({ name: "defold_bridge", arguments: { cmd: { evil: true } } }),
    ).rejects.toThrow(/needs a 'cmd' string, got object/);
    await expect(
      client.callTool({ name: "defold_bridge", arguments: { cmd: 7 } }),
    ).rejects.toThrow(/needs a 'cmd' string, got number/);
    await expect(
      client.callTool({ name: "defold_bridge", arguments: { cmd: "" } }),
    ).rejects.toThrow(/needs a 'cmd' string, got an empty string/);
    expect(received.length).toBe(before);
  });

  it("defold_start merges options into the bridge start request", async () => {
    const client = await connect();
    const res = await client.callTool({
      name: "defold_start",
      arguments: { options: { seed: 42, mode: "casual" } },
    });
    const body = JSON.parse(textOf(res));
    expect(body.got.seed).toBe(42);
    expect(body.got.mode).toBe("casual");
  });

  it("defold_start options cannot override the start command", async () => {
    const client = await connect();
    const res = await client.callTool({
      name: "defold_start",
      arguments: { options: { cmd: "evil", seed: 1 } },
    });
    // the declared command wins over a colliding options key
    expect(JSON.parse(textOf(res)).got.cmd).toBe("start");
  });

  it("defold_bridge passes through arbitrary commands", async () => {
    const client = await connect();
    const res = await client.callTool({
      name: "defold_bridge",
      arguments: { cmd: "advance", args: { seconds: 30 } },
    });
    const body = JSON.parse(textOf(res));
    expect(body.echo.cmd).toBe("advance");
    expect(body.echo.seconds).toBe(30);
  });

  it("defold_log joins the returned lines", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "defold_log", arguments: {} });
    expect(textOf(res)).toBe("INFO boot\nDEBUG tick");
  });

  it("rejects an unknown project", async () => {
    const client = await connect();
    await expect(
      client.callTool({ name: "defold_screen", arguments: { project: "nope" } }),
    ).rejects.toThrow(/unknown project/);
  });

  it("rejects an Object.prototype key as an unknown project", async () => {
    // A registry is a plain object -- JSON.parse'd, or a caller's literal --
    // so a bare index on one of these names hands back an inherited function
    // or Object.prototype itself. Truthy, so the unknown-project guard never
    // fired and a Project-shaped nothing reached net.createConnection, whose
    // 'The "options" or "port" or "path" argument must be specified' names
    // neither the project nor the fix.
    const client = await connect();
    for (const project of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      await expect(
        client.callTool({ name: "defold_screen", arguments: { project } }),
      ).rejects.toThrow(new RegExp(`unknown project '${project}'\\. Registered: testgame`));
    }
  });

  it("defold_test errors when the project has no testScript", async () => {
    const client = await connect();
    await expect(
      client.callTool({ name: "defold_test", arguments: {} }),
    ).rejects.toThrow(/no testScript/);
  });

  it("defold_run refuses when a bridged game already answers on the port", async () => {
    // connect() points testgame at the live fake bridge, so the preflight ping
    // succeeds and defold_run must refuse rather than launch a second instance.
    const client = await connect();
    await expect(
      client.callTool({ name: "defold_run", arguments: {} }),
    ).rejects.toThrow(/already running on port .*defold_stop/);
  });

  it("defold_run refuses when the preflight ping times out waiting for the slot", async () => {
    // A concurrent bridge call holds the port's slot, so the preflight ping
    // spends its whole budget queued and never dials. Reading that as "nothing
    // answered" launched a second engine over a running game: a call can only
    // hold the slot by having connected, so a queue timeout is evidence FOR a
    // live bridge. With the bug the run script is spawned and the error is
    // "run failed" instead.
    const sockets: net.Socket[] = [];
    const srv = net.createServer((sock) => {
      sockets.push(sock);
      sock.on("error", () => {});
    });
    const port = await new Promise<number>((r) =>
      srv.listen(0, "127.0.0.1", () => r((srv.address() as net.AddressInfo).port)),
    );
    // Occupies the slot past the preflight's own 2000ms budget.
    const holder = bridgeCall({ cmd: "screen" }, port, 2500).catch(() => {});
    try {
      const client = await connectWith({ root: ".", port, runScript: "r.ps1" });
      await expect(
        client.callTool({ name: "defold_run", arguments: {} }),
      ).rejects.toThrow(/already running on port .*defold_stop/);
    } finally {
      await holder;
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => srv.close(() => r()));
    }
    // Not PWSH_TIMEOUT: nothing here spawns pwsh unless the guard is gone, and
    // that constant is what the pwsh-backed test count is measured by. This
    // only needs room for the 2.5s the holder occupies the slot.
  }, 15_000);

  it("defold_run reports a clear error when the project root is missing", async () => {
    // Point at a dead port so the preflight passes, then the pre-spawn disk
    // check must fire instead of a raw spawn ENOENT.
    const port = await deadPort();
    const client = await connectWith({ root: "C:/mcp-defold-no-such-root", port, runScript: "run.ps1" });
    await expect(
      client.callTool({ name: "defold_run", arguments: {} }),
    ).rejects.toThrow(/project root .* not found: check the path in projects\.json/);
  });

  it("defold_test reports a clear error when the project root is missing", async () => {
    // defold_test has no preflight; the pre-spawn disk check in runPwsh guards it.
    const client = await connectWith({
      root: "C:/mcp-defold-no-such-root",
      port: bridgePort,
      runScript: "run.ps1",
      testScript: "t.ps1",
    });
    await expect(
      client.callTool({ name: "defold_test", arguments: {} }),
    ).rejects.toThrow(/project root .* not found/);
  });
});

// These spawn a real pwsh, because the exit code is the whole subject and a
// fake runner would be testing the fake. PowerShell 7 is already a hard
// requirement of this server (every run and test script is invoked through it)
// and the GitHub ubuntu runner image ships it, so the suite stays offline
// without becoming machine-specific.
describe("defold_test exit code", () => {
  const suite = (body: string) => scriptProject(body, bridgePort, "testScript");

  it("returns the tail as a normal result when the suite passes", async () => {
    const client = await connectWith(suite("Write-Output 'Total: 20 run, 0 failed'\nexit 0\n"));
    const res = await client.callTool({ name: "defold_test", arguments: {} });
    expect(textOf(res)).toContain("exit 0");
    expect(textOf(res)).toContain("20 run, 0 failed");
  }, PWSH_TIMEOUT);

  it("reports a failing suite as a failed tool call naming the exit code", async () => {
    const client = await connectWith(suite("Write-Output 'Total: 20 run, 1 failed'\nexit 1\n"));
    await expect(
      client.callTool({ name: "defold_test", arguments: {} }),
    ).rejects.toThrow(/test suite failed: exit 1/);
  }, PWSH_TIMEOUT);

  it("tail widens the window that would otherwise drop the failure line", async () => {
    // The assertion fails first, then 20 more lines scroll past it: the
    // 12-line default window cannot show the line that names the failure.
    const client = await connectWith(suite(
      "Write-Output 'BANNER-FAILURE hp was 9 expected 10'\n" +
      "1..20 | ForEach-Object { Write-Output \"noise $_\" }\n" +
      "exit 1\n",
    ));
    const narrow = await client
      .callTool({ name: "defold_test", arguments: {} })
      .catch((e: Error) => e);
    expect(String(narrow)).toMatch(/exit 1/);
    expect(String(narrow)).not.toContain("BANNER-FAILURE");

    const wide = await client
      .callTool({ name: "defold_test", arguments: { tail: 40 } })
      .catch((e: Error) => e);
    expect(String(wide)).toContain("BANNER-FAILURE");
  }, PWSH_TIMEOUT);
});

describe("defold_run confirms the bridge itself", () => {
  it("errors when the marker is printed but nothing is listening", async () => {
    const port = await deadPort();
    const client = await connectWith(markerOnlyProject(port));
    await expect(
      client.callTool({ name: "defold_run", arguments: {} }),
    ).rejects.toThrow(new RegExp(`defold_run:.*no bridge answered on port ${port}`, "s"));
  }, PWSH_TIMEOUT);

  it("reports a run script that prints the failure marker", async () => {
    // The scan decides here, while the script is still running, so there is no
    // exit code to report -- unlike the no-marker case below.
    const port = await deadPort();
    const client = await connectWith(
      scriptProject("Write-Output 'FAIL: bob could not resolve dependencies'\nexit 1\n", port),
    );
    const err = await client.callTool({ name: "defold_run", arguments: {} }).catch((e: Error) => e);
    expect(String(err)).toMatch(/run failed:/);
    expect(String(err)).toContain("bob could not resolve dependencies");
    expect(String(err)).not.toMatch(/exit \d/);
  }, PWSH_TIMEOUT);

  it("carries the script's exit code when it dies without a marker", async () => {
    // bob and java say what went wrong in the exit code; the marker scan used
    // to drop it, leaving "run failed:" and 2000 characters of output.
    const port = await deadPort();
    const client = await connectWith(
      scriptProject("Write-Output 'bob.jar: cannot find main'\nexit 3\n", port),
    );
    await expect(
      client.callTool({ name: "defold_run", arguments: {} }),
    ).rejects.toThrow(/run failed \(exit 3\)/);
  }, PWSH_TIMEOUT);

  it("succeeds when the bridge answers after the marker", async () => {
    const b = await lateBridge();
    try {
      const client = await connectWith(markerOnlyProject(b.port));
      const res = await client.callTool({ name: "defold_run", arguments: {} });
      expect(textOf(res)).toContain("bridge LIVE on");
    } finally {
      await b.close();
    }
  }, PWSH_TIMEOUT);

  it("reads a queued post-marker ping the way the preflight reads one", async () => {
    // The preflight treats a queue timeout as proof that a bridge IS there:
    // the slot is only held by a call that connected. The confirmation ping
    // thirty lines later used to hand the same timeout to a blanket catch and
    // report "no bridge answered", failing a launch that worked -- and the
    // retry that answer invites is then refused as "already running".
    const b = await slotHoldingBridge();
    const held: Promise<unknown>[] = [];
    try {
      const client = await connectWith(scriptProject(
        "Start-Sleep -Milliseconds 1200\n" + `Write-Output 'bridge LIVE on ${b.port}'\n`,
        b.port,
      ));
      const call = client.callTool({ name: "defold_run", arguments: {} });
      // Only once the preflight has dialed -- otherwise the holder would be in
      // the slot first and the preflight itself would refuse the launch.
      await b.firstDial;
      held.push(bridgeCall({ cmd: "ping" }, b.port, 20_000).catch(() => {}));
      expect(textOf(await call)).toContain("bridge LIVE on");
    } finally {
      await b.close();
      await Promise.all(held);
    }
  }, PWSH_TIMEOUT);
});

// The three verdicts decide whether defold_run reports a launched game or a
// failed one. Until this was a function, the only thing pinning them was the
// smoke's grep of server.ts for two string literals -- which stays green even
// if the scan stops consulting either regex.
// Five things the README, PROTOCOL.md or a tool schema promises, and that
// nothing drove until now.
describe("documented behaviour with no other coverage", () => {
  it("defold_log asks for 40 lines by default", async () => {
    const client = await connect();
    const before = received.length;
    await client.callTool({ name: "defold_log", arguments: {} });
    expect(received.slice(before)).toEqual([{ cmd: "log", tail: 40 }]);
  });

  it("defold_log passes an explicit tail through, and ignores a useless one", async () => {
    const client = await connect();
    let before = received.length;
    await client.callTool({ name: "defold_log", arguments: { tail: 5 } });
    expect(received.slice(before)).toEqual([{ cmd: "log", tail: 5 }]);

    before = received.length;
    await client.callTool({ name: "defold_log", arguments: { tail: 0 } });
    expect(received.slice(before)).toEqual([{ cmd: "log", tail: 40 }]);
  });

  it("rejects a wrong-typed tail instead of coercing it to a window", async () => {
    // Number(true) is 1 and Number([5]) is 5, so coercion turned a client
    // mistake into a silently different window. On defold_test that is the
    // DEF-1 harm re-entered through the argument DEF-1 added to prevent it:
    // a one-line tail drops the assertion that failed.
    const client = await connect();
    const before = received.length;
    const wrong: [unknown, string][] = [
      [true, "boolean"],
      [[5], "an array"],
      [" 7 ", "string"],
      ["1e1", "string"],
    ];
    for (const [tail, got] of wrong) {
      await expect(
        client.callTool({ name: "defold_log", arguments: { tail } as any }),
      ).rejects.toThrow(`tail must be a number, got ${got}`);
    }
    expect(received.slice(before)).toEqual([]); // and nothing reached the game
  });

  it("rejects a wrong-typed skip_build instead of reading it for truthiness", async () => {
    // The string "false" is truthy, so this flag could silently relaunch the
    // LAST build: the agent then drives a game that does not contain the
    // change it just made, and no output says so. Checked before the preflight
    // ping, so a call that cannot run never dials the port.
    const client = await connect();
    const before = received.length;
    for (const [skip_build, got] of [["false", "string"], [0, "number"], [[true], "an array"]] as [unknown, string][]) {
      await expect(
        client.callTool({ name: "defold_run", arguments: { skip_build } as any }),
      ).rejects.toThrow(`skip_build must be true or false, got ${got}`);
    }
    expect(received.slice(before)).toEqual([]);
  });

  it("defold_run passes -SkipBuild to the run script when asked", async () => {
    // The flag only exists on the far side of pwsh, so read it back from the
    // script's own stdout rather than from anything this process can see.
    const b = await lateBridge();
    try {
      const proj = scriptProject(
        "param([switch]$SkipBuild)\n" +
        "Write-Output \"skipbuild=$SkipBuild\"\n" +
        `Write-Output 'bridge LIVE on ${b.port}'\n`,
        b.port,
      );
      const client = await connectWith(proj);
      const res = await client.callTool({ name: "defold_run", arguments: { skip_build: true } });
      expect(textOf(res)).toContain("skipbuild=True");
    } finally {
      await b.close();
    }
  }, PWSH_TIMEOUT);

  it("defold_run leaves -SkipBuild off by default", async () => {
    const b = await lateBridge();
    try {
      const proj = scriptProject(
        "param([switch]$SkipBuild)\n" +
        "Write-Output \"skipbuild=$SkipBuild\"\n" +
        `Write-Output 'bridge LIVE on ${b.port}'\n`,
        b.port,
      );
      const client = await connectWith(proj);
      const res = await client.callTool({ name: "defold_run", arguments: {} });
      expect(textOf(res)).toContain("skipbuild=False");
    } finally {
      await b.close();
    }
  }, PWSH_TIMEOUT);

  it("MCP_DEFOLD_DEFAULT picks which project an unqualified call targets", async () => {
    // 'first' is registration order's default and points at nothing; 'second'
    // is the live fake bridge. The frame can only come from the env var.
    const prev = process.env.MCP_DEFOLD_DEFAULT;
    const dead = await deadPort();
    try {
      process.env.MCP_DEFOLD_DEFAULT = "second";
      const client = await connectTo(createServer({
        first: { root: ".", port: dead, runScript: "r.ps1" },
        second: { root: ".", port: bridgePort, runScript: "r.ps1" },
      }));
      expect(textOf(await client.callTool({ name: "defold_screen", arguments: {} }))).toContain("@ . . .");

      delete process.env.MCP_DEFOLD_DEFAULT;
      const fallback = await connectTo(createServer({
        first: { root: ".", port: dead, runScript: "r.ps1" },
        second: { root: ".", port: bridgePort, runScript: "r.ps1" },
      }));
      await expect(
        fallback.callTool({ name: "defold_screen", arguments: {} }),
      ).rejects.toThrow(new RegExp(`bridge unreachable on 127\\.0\\.0\\.1:${dead}`));
    } finally {
      if (prev === undefined) delete process.env.MCP_DEFOLD_DEFAULT;
      else process.env.MCP_DEFOLD_DEFAULT = prev;
    }
  });

  it("defold_bridge returns a frame as text and everything else as JSON", async () => {
    const client = await connect();
    const framed = await client.callTool({ name: "defold_bridge", arguments: { cmd: "screen" } });
    expect(textOf(framed)).toBe("day 1  hp 10/10\n@ . . .");

    const other = await client.callTool({ name: "defold_bridge", arguments: { cmd: "advance" } });
    expect(JSON.parse(textOf(other)).echo.cmd).toBe("advance");
  });

  it("bridgeCall names a bridge that hung up before replying", async () => {
    // Exactly what a game quitting mid-request produces, which is defold_stop's
    // ordinary race. It was the only bridgeCall failure path without a test.
    const srv = net.createServer((sock) => {
      sock.on("error", () => {});
      sock.on("data", () => sock.end());
    });
    const port = await new Promise<number>((r) =>
      srv.listen(0, "127.0.0.1", () => r((srv.address() as net.AddressInfo).port)),
    );
    try {
      await expect(bridgeCall({ cmd: "quit" }, port, 2000))
        .rejects.toThrow(/bridge closed before completing a reply/);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("a hang-up mid-reply reports what arrived before it", async () => {
    const srv = net.createServer((sock) => {
      sock.on("error", () => {});
      sock.on("data", () => {
        sock.write('{"ok":tr'); // no newline: the reply never completes
        sock.end();
      });
    });
    const port = await new Promise<number>((r) =>
      srv.listen(0, "127.0.0.1", () => r((srv.address() as net.AddressInfo).port)),
    );
    try {
      await expect(bridgeCall({ cmd: "quit" }, port, 2000))
        .rejects.toThrow(/bridge closed before completing a reply \(got: \{"ok":tr\)/);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe("markerVerdict", () => {
  const SUCCESS = /bridge LIVE on /;
  const FAILURE = /^FAIL:/m;

  it("reads the success marker", () => {
    expect(markerVerdict("building...\nbridge LIVE on 17890\n", SUCCESS, FAILURE)).toBe("ok");
  });

  it("reads the failure marker", () => {
    expect(markerVerdict("building...\nFAIL: bob could not resolve\n", SUCCESS, FAILURE)).toBe("fail");
  });

  it("reads output with neither marker as undecided", () => {
    expect(markerVerdict("building...\nstill building\n", SUCCESS, FAILURE)).toBe("none");
    expect(markerVerdict("", SUCCESS, FAILURE)).toBe("none");
  });

  it("lets success outrank a failure printed earlier in the run", () => {
    // A step failed and the script recovered: the game is up, which is the
    // question defold_run is asking.
    expect(markerVerdict("FAIL: retrying\nbridge LIVE on 17890\n", SUCCESS, FAILURE)).toBe("ok");
  });

  it("requires the failure marker at the start of a line", () => {
    expect(markerVerdict("note: do not FAIL: here\n", SUCCESS, FAILURE)).toBe("none");
  });
});

describe("concurrent bridge calls", () => {
  // Shaped like the documented bridge: one client at a time. The reference
  // implementation is server:listen(1) accepting at most one client per
  // update() tick, so an overlapping caller is dropped rather than queued.
  // Here that surfaces as a hang-up, which is what makes an unserialized
  // client fail loudly instead of quietly interleaving.
  async function oneAtATimeBridge(): Promise<{
    port: number;
    overlaps: () => number;
    close: () => Promise<void>;
  }> {
    const sockets: net.Socket[] = [];
    let busy = false;
    let overlaps = 0;
    const srv = net.createServer((sock) => {
      sockets.push(sock);
      sock.on("error", () => {});
      if (busy) {
        overlaps++;
        sock.destroy();
        return;
      }
      busy = true;
      sock.on("data", () => {
        // Hold the slot long enough that five unserialized calls must collide.
        setTimeout(() => {
          sock.write(JSON.stringify({ frame: "day 1  hp 10/10" }) + "\n");
          sock.end();
          busy = false;
        }, 20);
      });
    });
    const port = await new Promise<number>((r) =>
      srv.listen(0, "127.0.0.1", () => r((srv.address() as net.AddressInfo).port)),
    );
    return {
      port,
      overlaps: () => overlaps,
      close: () =>
        new Promise<void>((r) => {
          for (const s of sockets) s.destroy();
          srv.close(() => r());
        }),
    };
  }

  it("five at once all get their frame, and none overlap on the wire", async () => {
    const b = await oneAtATimeBridge();
    try {
      const client = await connectWith({ root: ".", port: b.port, runScript: "r.ps1" });
      const results = await Promise.all(
        Array.from({ length: 5 }, () => client.callTool({ name: "defold_screen", arguments: {} })),
      );
      expect(results.map(textOf)).toEqual(Array(5).fill("day 1  hp 10/10"));
      expect(b.overlaps()).toBe(0);
    } finally {
      await b.close();
    }
  });

  it("a queued call's timeout covers the wait, not only the socket", async () => {
    // A server that accepts and never answers, so the first call occupies the
    // slot for its whole budget. The second asked for less time than that: it
    // must hear back at its own deadline rather than at the first one's.
    const sockets: net.Socket[] = [];
    const srv = net.createServer((sock) => {
      sockets.push(sock);
      sock.on("error", () => {});
    });
    const port = await new Promise<number>((r) =>
      srv.listen(0, "127.0.0.1", () => r((srv.address() as net.AddressInfo).port)),
    );
    try {
      const t0 = Date.now();
      const first = bridgeCall({ cmd: "ping" }, port, 400).catch((e: Error) => e);
      const second = await bridgeCall({ cmd: "ping" }, port, 150).catch((e: Error) => e);
      const waited = Date.now() - t0;
      expect(String(second)).toMatch(/bridge timeout after 150ms/);
      expect(String(second)).toMatch(/still queued/);
      expect(waited).toBeLessThan(350); // i.e. before the first call's 400ms
      expect(String(await first)).toMatch(/bridge timeout after 400ms/);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("a call that waited its turn reports its own budget and blames the game", async () => {
    // First caller is answered after a beat; the second therefore waits, then
    // dials with less than its budget left. Both halves of its message have
    // been wrong: the figure (the remainder, which matches no timeout any
    // caller set) and the cause (a queue it has by then left).
    const sockets: net.Socket[] = [];
    let seen = 0;
    const srv = net.createServer((sock) => {
      sockets.push(sock);
      sock.on("error", () => {});
      const nth = ++seen;
      sock.on("data", () => {
        if (nth > 1) return; // later callers get silence: they time out dialing
        setTimeout(() => {
          sock.write(JSON.stringify({ ok: true }) + "\n");
          sock.end();
        }, 250);
      });
    });
    const port = await new Promise<number>((r) =>
      srv.listen(0, "127.0.0.1", () => r((srv.address() as net.AddressInfo).port)),
    );
    try {
      const t0 = Date.now();
      const first = bridgeCall({ cmd: "ping" }, port, 2000);
      const second = bridgeCall({ cmd: "ping" }, port, 400).catch((e: Error) => e);
      expect(await first).toEqual({ ok: true });
      const e = await second;
      const waited = Date.now() - t0;
      expect(String(e)).toMatch(/bridge timeout after 400ms/); // not the ~150ms remainder
      expect(String(e)).toMatch(/is the game running\? use defold_run/);
      expect(String(e)).not.toMatch(/still queued/);
      // The budget covers the wait AS WELL AS the socket: ~250ms queued plus
      // what is LEFT of 400ms, not 250ms plus a fresh 400ms. Without this the
      // remaining-budget arithmetic can be deleted and the suite stays green.
      expect(waited).toBeLessThan(500);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe("translateSpawnError", () => {
  it("translates pwsh ENOENT into a PATH error", () => {
    const e: NodeJS.ErrnoException = Object.assign(new Error("spawn pwsh ENOENT"), { code: "ENOENT" });
    expect(translateSpawnError(e).message).toMatch(/PowerShell 7 \(pwsh\) not found on PATH/);
  });

  it("passes non-ENOENT spawn errors through with context", () => {
    const e: NodeJS.ErrnoException = Object.assign(new Error("boom"), { code: "EACCES" });
    expect(translateSpawnError(e).message).toMatch(/failed to launch pwsh: boom/);
  });
});

describe("loadProjects", () => {
  it("loads and validates a registry file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpdefold-"));
    const file = join(dir, "projects.json");
    writeFileSync(file, JSON.stringify({ g: { root: ".", port: 1, runScript: "r.ps1" } }));
    expect(Object.keys(loadProjects(file))).toEqual(["g"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws a copy-the-example hint when the registry is missing", () => {
    expect(() => loadProjects(join(tmpdir(), "mcpdefold-definitely-missing.json"))).toThrow(/projects\.example\.json/);
  });

  it("rejects duplicate ports across projects", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpdefold-"));
    const file = join(dir, "projects.json");
    writeFileSync(file, JSON.stringify({
      a: { root: ".", port: 17890, runScript: "r.ps1" },
      b: { root: ".", port: 17890, runScript: "r.ps1" },
    }));
    expect(() => loadProjects(file)).toThrow(/reuses port/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an entry missing required fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpdefold-"));
    const file = join(dir, "projects.json");
    writeFileSync(file, JSON.stringify({ bad: { root: "." } }));
    expect(() => loadProjects(file)).toThrow(/needs root, port, and runScript/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a non-string testScript", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpdefold-"));
    const file = join(dir, "projects.json");
    writeFileSync(file, JSON.stringify({ g: { root: ".", port: 1, runScript: "r.ps1", testScript: 5 } }));
    expect(() => loadProjects(file)).toThrow(/testScript/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("bridgeCall failure paths", () => {
  // A server that accepts the connection but never replies: forces the timeout.
  // Track the accepted sockets so close() can destroy them, otherwise srv.close()
  // waits forever on the connection the client abandons when it times out.
  async function silentServer(): Promise<{ port: number; close: () => Promise<void> }> {
    const sockets: net.Socket[] = [];
    const srv = net.createServer((sock) => {
      sockets.push(sock);
      sock.on("error", () => {}); // swallow ECONNRESET when the client bails
    });
    const port = await new Promise<number>((r) =>
      srv.listen(0, "127.0.0.1", () => r((srv.address() as net.AddressInfo).port)),
    );
    return {
      port,
      close: () =>
        new Promise<void>((r) => {
          for (const s of sockets) s.destroy();
          srv.close(() => r());
        }),
    };
  }

  it("bridgeCall rejects with a timeout when the bridge never replies", async () => {
    const s = await silentServer();
    try {
      // The cause matters as much as the number. Nothing was queued ahead of
      // this call, so it must be told to check the game, not to blame a queue
      // it never sat in -- the ordinary timeout, and the actionable message.
      const e = await bridgeCall({ cmd: "ping" }, s.port, 100).catch((err: Error) => err);
      expect(String(e)).toMatch(/bridge timeout after 100ms/);
      expect(String(e)).toMatch(/is the game running\? use defold_run/);
      expect(String(e)).not.toMatch(/still queued/);
    } finally {
      await s.close();
    }
  });

  it("bridgeCall rejects as unreachable when nothing is listening", async () => {
    const port = await deadPort();
    await expect(bridgeCall({ cmd: "ping" }, port, 1000)).rejects.toThrow(/bridge unreachable/);
  });

  it("bridgeCall rejects when the bridge sends a non-JSON line", async () => {
    const srv = net.createServer((sock) => {
      sock.on("error", () => {}); // swallow ECONNRESET when the client destroys its side
      sock.on("data", () => {
        sock.write("this is not json\n");
        sock.end();
      });
    });
    const port = await new Promise<number>((r) =>
      srv.listen(0, "127.0.0.1", () => r((srv.address() as net.AddressInfo).port)),
    );
    try {
      await expect(bridgeCall({ cmd: "ping" }, port, 1000)).rejects.toThrow(/non-JSON/);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("bridgeCall reassembles a large reply split across TCP chunks", async () => {
    const blob = "x".repeat(70000); // larger than one TCP segment: exercises the chunk buffer
    const srv = net.createServer((sock) => {
      sock.on("error", () => {}); // swallow ECONNRESET when the client destroys its side
      sock.on("data", () => {
        const payload = JSON.stringify({ ok: true, blob });
        const half = Math.floor(payload.length / 2);
        // deliver the JSON in pieces with the newline delimiter last, so the
        // "wait for the newline byte" reassembly path is what stitches it back
        sock.write(payload.slice(0, half));
        sock.write(payload.slice(half));
        sock.write("\n");
        sock.end();
      });
    });
    const port = await new Promise<number>((r) =>
      srv.listen(0, "127.0.0.1", () => r((srv.address() as net.AddressInfo).port)),
    );
    try {
      const res = await bridgeCall({ cmd: "ping" }, port, 2000);
      expect(res.ok).toBe(true);
      expect(res.blob).toHaveLength(70000);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});
