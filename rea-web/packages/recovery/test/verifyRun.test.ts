import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { createServer, type Server } from "node:net";
import { mkdir, readFile, readdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { restoreReportSchema } from "@rea-web/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { restorePackage } from "../src/index.js";
import { cleanupTempDirs } from "./helpers.js";
import {
  HAS_DATABASE,
  baseOptions,
  createScratchDatabase,
  emptyDir,
  makePackage,
  nodeRun,
  psqlAdmin,
  scopeOf,
} from "./verifyFixture.js";

afterEach(cleanupTempDirs);

const isAlive = async (pid: number): Promise<boolean> => {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return !/^\d+ \(.*\) [ZX]/u.test(stat);
  } catch {
    return false;
  }
};

const listen = (): Promise<{ server: Server; port: number }> =>
  new Promise((resolve) => {
    const server = createServer((socket) => socket.end());
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        port:
          typeof address === "object" && address !== null ? address.port : 0,
      });
    });
  });

const CONNECT = `
const net = require('net');
const s = net.connect({ host: '127.0.0.1', port: Number(process.argv[1]) });
s.on('connect', () => { s.destroy(); process.exit(0); });
s.on('error', (e) => { console.error(e.code); process.exit(1); });
`;

describe("placeholders and working directories", () => {
  it("substitutes placeholders in argv and cwd, and records them in the report", async () => {
    const { root } = await makePackage({
      steps: [
        {
          id: "write",
          scope: "clean_build",
          cwd: "{{target}}",
          run: nodeRun(
            "require('fs').writeFileSync('seen.json', JSON.stringify(process.argv.slice(1)))",
            "{{target}}/sub",
            "{{package_root}}/manifest.json",
          ),
        },
      ],
    });
    const target = await emptyDir("subst");
    const report = await restorePackage(
      root,
      baseOptions({ scopes: ["clean_build"], target }),
    );
    const scope = scopeOf(report, "clean_build");
    expect(scope.status).toBe("clean_build_verified");
    const seen = JSON.parse(
      await readFile(join(target, "seen.json"), "utf8"),
    ) as string[];
    expect(seen[0]).toBe(`${await realpath(target)}/sub`);
    expect(seen[1]).toBe(`${root.replace(/\/$/u, "")}/manifest.json`);
    expect(scope.steps[0]?.argv.slice(-2)).toEqual(seen);
    expect(scope.steps[0]?.cwd).toBe(seen[0]?.replace(/\/sub$/u, ""));
    expect(JSON.stringify(report)).not.toContain("{{");
  });

  it("blocks a step whose cwd escapes its root through a symlink", async () => {
    const outside = await emptyDir("elsewhere");
    const { root } = await makePackage({
      steps: [
        {
          id: "link",
          scope: "clean_build",
          run: nodeRun(
            "require('fs').symlinkSync(process.argv[1], 'escape')",
            outside,
          ),
        },
        {
          id: "escape",
          scope: "clean_build",
          cwd: "{{target}}/escape",
          run: nodeRun("require('fs').writeFileSync('pwned.txt', 'x')"),
        },
      ],
    });
    const target = await emptyDir("confine");
    const report = await restorePackage(
      root,
      baseOptions({ scopes: ["clean_build"], target }),
    );
    const scope = scopeOf(report, "clean_build");
    expect(scope.steps.map((s) => s.status)).toEqual(["passed", "blocked"]);
    expect(scope.steps[1]?.reason).toContain("outside");
    expect(scope.status).toBe("blocked");
    expect(await readdir(outside)).toEqual([]);
  });

  it("blocks a behavior step whose working directory was never created", async () => {
    const { root } = await makePackage({
      steps: [
        {
          id: "behavior-x",
          scope: "behavior",
          cwd: "{{target}}/main",
          run: nodeRun("process.exit(0)"),
        },
      ],
    });
    const target = await emptyDir("nocwd");
    const report = await restorePackage(
      root,
      baseOptions({ scopes: ["behavior"], target }),
    );
    const scope = scopeOf(report, "behavior");
    expect(scope.status).toBe("blocked");
    expect(scope.steps[0]?.reason).toContain("does not exist");
  });

  it("symlinked targets are resolved before use", async () => {
    const real = await emptyDir("realtarget");
    const holder = await emptyDir("holder");
    await symlink(real, join(holder, "t"));
    const { root } = await makePackage({
      steps: [
        {
          id: "w",
          scope: "clean_build",
          run: nodeRun("require('fs').writeFileSync('ok.txt', 'x')"),
        },
      ],
    });
    const report = await restorePackage(
      root,
      baseOptions({ scopes: ["clean_build"], target: join(holder, "t") }),
    );
    expect(scopeOf(report, "clean_build").status).toBe("clean_build_verified");
    expect(await readdir(real)).toEqual(["ok.txt"]);
  });
});

describe("step environment", () => {
  it("passes only PATH, LANG, a private HOME/TMPDIR and declared, supplied names", async () => {
    const script =
      "require('fs').writeFileSync('env.json', JSON.stringify(process.env))";
    const { root } = await makePackage({
      steps: [
        {
          id: "plain",
          scope: "clean_build",
          run: nodeRun(script.replace("env.json", "plain.json")),
        },
        {
          id: "declared",
          scope: "clean_build",
          run: nodeRun(script.replace("env.json", "declared.json")),
          env_names: ["FIXTURE_TOKEN", "NOT_SUPPLIED"],
        },
      ],
    });
    const target = await emptyDir("env");
    const report = await restorePackage(
      root,
      baseOptions({
        scopes: ["clean_build"],
        target,
        stepEnv: {
          FIXTURE_TOKEN: "tok_supplied_by_operator",
          UNDECLARED: "no",
        },
      }),
    );
    expect(scopeOf(report, "clean_build").status).toBe("clean_build_verified");
    const plain = JSON.parse(
      await readFile(join(target, "plain.json"), "utf8"),
    ) as Record<string, string>;
    expect(Object.keys(plain).sort()).toEqual([
      "HOME",
      "LANG",
      "PATH",
      "TMPDIR",
    ]);
    expect(plain["LANG"]).toBe("C.UTF-8");
    expect(plain["HOME"]).not.toBe(process.env["HOME"]);
    const declared = JSON.parse(
      await readFile(join(target, "declared.json"), "utf8"),
    ) as Record<string, string>;
    expect(Object.keys(declared).sort()).toEqual([
      "FIXTURE_TOKEN",
      "HOME",
      "LANG",
      "PATH",
      "TMPDIR",
    ]);
    expect(declared["FIXTURE_TOKEN"]).toBe("tok_supplied_by_operator");
  });

  it("redacts operator-supplied values from output tails and refuses reserved names", async () => {
    const { root } = await makePackage({
      steps: [
        {
          id: "leaky",
          scope: "clean_build",
          run: nodeRun(
            "console.log('token=' + process.env.FIXTURE_TOKEN); console.error(process.env.FIXTURE_TOKEN)",
          ),
          env_names: ["FIXTURE_TOKEN"],
        },
      ],
    });
    const target = await emptyDir("redact");
    const report = await restorePackage(
      root,
      baseOptions({
        scopes: ["clean_build"],
        target,
        stepEnv: { FIXTURE_TOKEN: "x9" },
      }),
    );
    const step = scopeOf(report, "clean_build").steps[0];
    expect(step?.stdout_tail).toBe("token=[REDACTED]\n");
    expect(step?.stderr_tail).toBe("[REDACTED]\n");

    const reserved = await makePackage({
      steps: [
        {
          id: "ld",
          scope: "clean_build",
          run: nodeRun("process.exit(0)"),
          env_names: ["LD_PRELOAD"],
        },
      ],
    });
    const second = await emptyDir("reserved");
    const blocked = await restorePackage(
      reserved.root,
      baseOptions({
        scopes: ["clean_build"],
        target: second,
        stepEnv: { LD_PRELOAD: "/tmp/evil.so" },
      }),
    );
    expect(scopeOf(blocked, "clean_build").status).toBe("blocked");
    expect(scopeOf(blocked, "clean_build").steps[0]?.reason).toContain(
      "reserved",
    );
  });
});

describe("network classes", () => {
  it("denies outbound connects to a network:none step when isolation is available", async () => {
    const { server, port } = await listen();
    try {
      const { root } = await makePackage({
        steps: [
          {
            id: "connect",
            scope: "clean_build",
            run: nodeRun(CONNECT, String(port)),
            network: "none",
          },
        ],
      });
      const target = await emptyDir("net");
      const report = await restorePackage(
        root,
        baseOptions({ scopes: ["clean_build"], target }),
      );
      expect(restoreReportSchema.safeParse(report).success).toBe(true);
      const step = scopeOf(report, "clean_build").steps[0];
      if (report.network_isolation.available) {
        expect(report.network_isolation.mechanism).toBe(
          "linux-network-namespace",
        );
        expect(step?.network_isolated).toBe(true);
        expect(step?.status).toBe("failed");
        expect(step?.exit_code).toBe(1);
        expect(scopeOf(report, "clean_build").status).toBe("failed");
        expect(report.network_required.verdict).toBe("no");
      } else {
        expect(step?.network_isolated).toBe(false);
        expect(report.network_required.verdict).toBe("unknown");
      }
    } finally {
      server.close();
    }
  });

  it("runs the step unisolated, and says so, when isolation is disabled", async () => {
    const { server, port } = await listen();
    try {
      const { root } = await makePackage({
        steps: [
          {
            id: "connect",
            scope: "clean_build",
            run: nodeRun(CONNECT, String(port)),
          },
        ],
      });
      const target = await emptyDir("noniso");
      const report = await restorePackage(
        root,
        baseOptions({ scopes: ["clean_build"], target, isolation: "disabled" }),
      );
      const step = scopeOf(report, "clean_build").steps[0];
      expect(step).toMatchObject({ status: "passed", network_isolated: false });
      expect(report.network_isolation).toMatchObject({
        mechanism: "none",
        available: false,
      });
      expect(report.network_required.verdict).toBe("unknown");
      expect(report.network_required.reasons.join()).toContain(
        "without network isolation",
      );
    } finally {
      server.close();
    }
  });

  it("blocks registry and unknown steps unless allowed, and reports that network is needed", async () => {
    const { root } = await makePackage({
      steps: [
        {
          id: "clone",
          scope: "clean_build",
          run: nodeRun("require('fs').writeFileSync('first.txt','x')"),
        },
        {
          id: "install",
          scope: "clean_build",
          run: nodeRun("require('fs').writeFileSync('installed.txt','x')"),
          network: "registry",
        },
      ],
    });
    const target = await emptyDir("registry");
    const denied = await restorePackage(
      root,
      baseOptions({ scopes: ["clean_build"], target }),
    );
    const scope = scopeOf(denied, "clean_build");
    expect(scope.status).toBe("blocked");
    expect(scope.detail).toContain("package registry");
    expect(scope.steps.map((s) => [s.step_id, s.status])).toEqual([
      ["install", "blocked"],
    ]);
    expect(denied.network_required.verdict).toBe("yes");
    expect(await readdir(target)).toEqual([]);

    const wrongClass = await restorePackage(
      root,
      baseOptions({
        scopes: ["clean_build"],
        target,
        allowNetwork: ["unknown"],
      }),
    );
    expect(scopeOf(wrongClass, "clean_build").status).toBe("blocked");

    const allowed = await restorePackage(
      root,
      baseOptions({
        scopes: ["clean_build"],
        target,
        allowNetwork: ["registry"],
      }),
    );
    expect(scopeOf(allowed, "clean_build").status).toBe("clean_build_verified");
    const install = scopeOf(allowed, "clean_build").steps[1];
    expect(install).toMatchObject({
      network: "registry",
      network_isolated: false,
    });
    expect(allowed.network_required.verdict).toBe("yes");
    expect(allowed.network_required.reasons.join()).toContain("install");
  });

  it("treats an unclassified step like a registry step with its own allowance", async () => {
    const { root } = await makePackage({
      steps: [
        {
          id: "mystery",
          scope: "clean_build",
          run: nodeRun("process.exit(0)"),
          network: "unknown",
        },
      ],
    });
    const target = await emptyDir("unknown");
    const denied = await restorePackage(
      root,
      baseOptions({
        scopes: ["clean_build"],
        target,
        allowNetwork: ["registry"],
      }),
    );
    expect(scopeOf(denied, "clean_build").status).toBe("blocked");
    const allowed = await restorePackage(
      root,
      baseOptions({
        scopes: ["clean_build"],
        target,
        allowNetwork: ["unknown"],
      }),
    );
    expect(scopeOf(allowed, "clean_build").status).toBe("clean_build_verified");
  });
});

describe("timeouts and failures", () => {
  it("kills the whole process group when a step times out", async () => {
    const { root } = await makePackage({
      steps: [
        {
          id: "hang",
          scope: "clean_build",
          run: nodeRun(
            "const c = require('child_process').spawn('sleep', ['60'], { stdio: 'ignore' });" +
              "require('fs').writeFileSync('child.pid', String(c.pid));" +
              "setInterval(() => {}, 1000)",
          ),
        },
        { id: "after", scope: "clean_build", run: nodeRun("process.exit(0)") },
      ],
    });
    const target = await emptyDir("timeout");
    const started = Date.now();
    const report = await restorePackage(
      root,
      baseOptions({ scopes: ["clean_build"], target, stepTimeoutMs: 1500 }),
    );
    expect(Date.now() - started).toBeLessThan(15_000);
    const scope = scopeOf(report, "clean_build");
    expect(scope.status).toBe("failed");
    expect(scope.steps[0]).toMatchObject({ status: "failed", timed_out: true });
    expect(scope.steps[0]?.reason).toContain("timed out");
    expect(scope.steps[1]?.status).toBe("skipped");
    const pid = Number(await readFile(join(target, "child.pid"), "utf8"));
    await new Promise((r) => setTimeout(r, 300));
    expect(await isAlive(pid)).toBe(false);
  });

  it("stops a scope at the first failing step and marks the rest skipped", async () => {
    const { root } = await makePackage({
      steps: [
        { id: "ok", scope: "clean_build", run: nodeRun("console.log('fine')") },
        {
          id: "bad",
          scope: "clean_build",
          run: nodeRun("console.error('boom'); process.exit(7)"),
        },
        {
          id: "never",
          scope: "clean_build",
          run: nodeRun("require('fs').writeFileSync('never.txt','x')"),
        },
      ],
    });
    const target = await emptyDir("fail");
    const report = await restorePackage(
      root,
      baseOptions({ scopes: ["clean_build"], target }),
    );
    const scope = scopeOf(report, "clean_build");
    expect(scope.steps.map((s) => s.status)).toEqual([
      "passed",
      "failed",
      "skipped",
    ]);
    expect(scope.steps[1]).toMatchObject({
      exit_code: 7,
      stderr_tail: "boom\n",
    });
    expect(scope.steps[0]?.stdout_tail).toBe("fine\n");
    expect(scope.status).toBe("failed");
    expect(scope.detail).toContain("bad");
    expect(report.overall).toBe("partial");
    expect(await readdir(target)).toEqual([]);
  });

  it("keeps at most 16 KiB of each stream", async () => {
    const { root } = await makePackage({
      steps: [
        {
          id: "chatty",
          scope: "clean_build",
          run: nodeRun("process.stdout.write('a'.repeat(100000) + 'END')"),
        },
      ],
    });
    const target = await emptyDir("tail");
    const report = await restorePackage(
      root,
      baseOptions({ scopes: ["clean_build"], target }),
    );
    const tail = scopeOf(report, "clean_build").steps[0]?.stdout_tail ?? "";
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(16 * 1024);
    expect(tail.endsWith("END")).toBe(true);
  });
});

describe("behavior checks", () => {
  it("runs checks from the restored source with the recorded expectations", async () => {
    const { root } = await makePackage({
      steps: [
        {
          id: "clone",
          scope: "clean_build",
          run: nodeRun(
            "require('fs').mkdirSync('main'); require('fs').writeFileSync('main/flag.txt','1')",
          ),
        },
        {
          id: "behavior-present",
          scope: "behavior",
          cwd: "{{target}}/main",
          run: nodeRun(
            "process.exit(require('fs').existsSync('flag.txt') ? 0 : 1)",
          ),
        },
        {
          id: "behavior-expects-three",
          scope: "behavior",
          cwd: "{{target}}/main",
          run: nodeRun("process.exit(3)"),
        },
        {
          id: "behavior-slow",
          scope: "behavior",
          cwd: "{{target}}/main",
          run: nodeRun("setTimeout(() => {}, 30000)"),
        },
      ],
      behaviorChecks: [
        {
          id: "present",
          run: nodeRun(
            "process.exit(require('fs').existsSync('flag.txt') ? 0 : 1)",
          ),
          expect_exit: 0,
        },
        {
          id: "expects-three",
          run: nodeRun("process.exit(3)"),
          expect_exit: 3,
        },
        {
          id: "slow",
          run: nodeRun("setTimeout(() => {}, 30000)"),
          timeout_ms: 700,
        },
      ],
    });
    const target = await emptyDir("behavior");
    const report = await restorePackage(
      root,
      baseOptions({ scopes: ["clean_build", "behavior"], target }),
    );
    const behavior = scopeOf(report, "behavior");
    expect(behavior.steps.map((s) => [s.step_id, s.status])).toEqual([
      ["behavior-present", "passed"],
      ["behavior-expects-three", "passed"],
      ["behavior-slow", "failed"],
    ]);
    expect(behavior.steps[2]?.timed_out).toBe(true);
    expect(behavior.status).toBe("failed");
    expect(scopeOf(report, "clean_build").status).toBe("clean_build_verified");
    expect(report.overall).toBe("partial");
  });

  it("blocks behavior when clean_build did not complete", async () => {
    const { root } = await makePackage({
      steps: [
        { id: "clone", scope: "clean_build", run: nodeRun("process.exit(1)") },
        {
          id: "behavior-x",
          scope: "behavior",
          run: nodeRun("process.exit(0)"),
        },
      ],
    });
    const target = await emptyDir("prereq");
    const report = await restorePackage(
      root,
      baseOptions({ scopes: ["clean_build", "behavior"], target }),
    );
    expect(scopeOf(report, "clean_build").status).toBe("failed");
    expect(scopeOf(report, "behavior")).toMatchObject({
      status: "blocked",
      steps: [],
    });
  });

  it("blocks a scope the package declares nothing for", async () => {
    const { root } = await makePackage({ steps: [] });
    const target = await emptyDir("empty");
    const report = await restorePackage(
      root,
      baseOptions({ scopes: ["clean_build"], target }),
    );
    expect(scopeOf(report, "clean_build").status).toBe("blocked");
    expect(scopeOf(report, "clean_build").detail).toContain(
      "declares no clean_build",
    );
  });
});

describe.skipIf(!HAS_DATABASE)("database scope", () => {
  const stepSql = (sql: string): string[] => [
    "psql",
    "-X",
    "-q",
    "-v",
    "ON_ERROR_STOP=1",
    "--dbname",
    "{{database_url}}",
    "-c",
    sql,
  ];

  it("restores, evaluates invariants read-only and never leaks the password", async () => {
    const db = await createScratchDatabase();
    try {
      const { root } = await makePackage({
        steps: [
          {
            id: "seed",
            scope: "data_restore",
            run: stepSql(
              "create table t (a int); insert into t values (1), (2), (3)",
            ),
            network: "database",
            requires: ["psql"],
          },
          {
            id: "leak",
            scope: "data_restore",
            run: nodeRun(
              "console.log(process.env.PGPASSWORD); console.error('pw=' + process.env.PGPASSWORD)",
            ),
            network: "database",
          },
        ],
        invariants: [
          {
            id: "count",
            sql: "select count(*) from t",
            expected_at_capture: "3",
          },
        ],
      });
      const target = await emptyDir("db");
      const assets = await emptyDir("dbassets");
      const report = await restorePackage(
        root,
        baseOptions({
          scopes: ["data_restore"],
          target,
          assetsRoot: assets,
          databaseUrl: db.url,
        }),
      );
      const scope = scopeOf(report, "data_restore");
      expect(scope.status).toBe("data_restore_verified");
      expect(scope.invariants).toEqual([
        expect.objectContaining({
          id: "count",
          expected: "3",
          actual: "3",
          ok: true,
        }),
      ]);
      expect(scope.invariants[0]?.sql_sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(JSON.stringify(report)).not.toContain("select count");
      expect(JSON.stringify(report)).not.toContain(db.password);
      expect(scope.steps[1]?.stdout_tail).toBe("[REDACTED]\n");
      expect(scope.steps[0]?.argv.at(-3)).toBe(
        db.url.replace(`:${db.password}`, ""),
      );
      expect(report.guards.database_host).toBe("127.0.0.1");
      // TCP database: the step could not be isolated, and the report says so
      expect(scope.steps[0]?.network_isolated).toBe(false);
      expect(report.network_required.verdict).toBe("unknown");
    } finally {
      await db.drop();
    }
  });

  it("fails the scope when an invariant does not hold or cannot be evaluated", async () => {
    const db = await createScratchDatabase();
    try {
      const { root } = await makePackage({
        steps: [
          {
            id: "seed",
            scope: "data_restore",
            run: stepSql("create table t (a int); insert into t values (1)"),
            network: "database",
          },
        ],
        invariants: [
          {
            id: "wrong",
            sql: "select count(*) from t",
            expected_at_capture: "9",
          },
          { id: "write", sql: "delete from t", expected_at_capture: "0" },
          { id: "unknown", sql: "select 1", expected_at_capture: null },
        ],
      });
      const target = await emptyDir("dbfail");
      const report = await restorePackage(
        root,
        baseOptions({ scopes: ["data_restore"], target, databaseUrl: db.url }),
      );
      const scope = scopeOf(report, "data_restore");
      expect(scope.status).toBe("failed");
      expect(scope.invariants.map((i) => [i.id, i.ok])).toEqual([
        ["wrong", false],
        ["write", false],
        ["unknown", false],
      ]);
      expect(scope.invariants[0]).toMatchObject({ expected: "9", actual: "1" });
      expect(scope.invariants[1]?.detail).toContain("single SELECT");
      expect(scope.invariants[2]?.detail).toContain("no value");
    } finally {
      await db.drop();
    }
  });

  it("isolates database steps that reach the server through a Unix socket", async () => {
    // Peer authentication over the socket needs a role named after the OS user.
    const user = userInfo().username;
    const name = `fx_vfy_sock_${randomBytes(4).toString("hex")}`;
    let createdRole = false;
    try {
      await psqlAdmin(`CREATE ROLE "${user}" LOGIN`);
      createdRole = true;
    } catch {
      // the role may already exist
    }
    try {
      await psqlAdmin(`CREATE DATABASE ${name} OWNER "${user}"`);
    } catch {
      if (createdRole) await psqlAdmin(`DROP ROLE "${user}"`);
      return;
    }
    try {
      const { root } = await makePackage({
        steps: [
          {
            id: "seed",
            scope: "data_restore",
            run: stepSql("create table t (a int)"),
            network: "database",
          },
        ],
        invariants: [
          {
            id: "empty",
            sql: "select count(*) from t",
            expected_at_capture: "0",
          },
        ],
      });
      const target = await emptyDir("dbsock");
      const report = await restorePackage(
        root,
        baseOptions({
          scopes: ["data_restore"],
          target,
          databaseUrl: `postgres://${encodeURIComponent(user)}@/${name}?host=/var/run/postgresql`,
        }),
      );
      const scope = scopeOf(report, "data_restore");
      if (scope.status === "blocked") {
        // Socket unreachable from here: a block, never a pass.
        expect(scope.detail).toContain("inspected");
        return;
      }
      expect(scope.status).toBe("data_restore_verified");
      expect(scope.steps[0]?.network_isolated).toBe(
        report.network_isolation.available,
      );
      if (report.network_isolation.available)
        expect(report.network_required.verdict).toBe("no");
    } finally {
      await psqlAdmin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      if (createdRole) await psqlAdmin(`DROP ROLE "${user}"`);
    }
  });

  it("creates the assets root default inside the target", async () => {
    const db = await createScratchDatabase();
    try {
      await mkdir(join(await emptyDir("x"), "unused"), { recursive: true });
      const { root } = await makePackage({
        steps: [
          {
            id: "assets",
            scope: "data_restore",
            run: nodeRun(
              "require('fs').writeFileSync(process.argv[1] + '/f.txt', 'x')",
              "{{assets_root}}",
            ),
          },
        ],
      });
      const target = await emptyDir("defassets");
      const report = await restorePackage(
        root,
        baseOptions({ scopes: ["data_restore"], target, databaseUrl: db.url }),
      );
      expect(scopeOf(report, "data_restore").status).toBe(
        "data_restore_verified",
      );
      expect(await readdir(join(target, ".rea-assets"))).toEqual(["f.txt"]);
    } finally {
      await db.drop();
    }
  });
});
