import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { BatchTasksError } from "../src/errors.js";
import {
  atomicMove,
  atomicWriteJson,
  atomicWriteText,
  parseStrictJson,
  readJson,
  safeUnlink,
  stringifyStrictJson,
  withLock,
} from "../src/storage.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "batch-storage-test-"));
  roots.push(root);
  return root;
}

describe("strict bigint-safe JSON", () => {
  it("roundtrips unsafe integers as unquoted numeric literals", () => {
    const text = stringifyStrictJson({ exact: 9223372036854775807n });
    expect(text).toBe('{"exact":9223372036854775807}');
    expect(parseStrictJson(text)).toEqual({ exact: 9223372036854775807n });
  });

  it("supports deterministic recursive key sorting and pretty output", () => {
    expect(
      stringifyStrictJson(
        { z: 1, a: { z: 2, a: 3 }, rows: [{ z: true, a: false }] },
        { pretty: true, sortKeys: true },
      ),
    ).toBe(
      '{\n  "a": {\n    "a": 3,\n    "z": 2\n  },\n  "rows": [\n    {\n      "a": false,\n      "z": true\n    }\n  ],\n  "z": 1\n}',
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, undefined, () => true, new Date()])(
    "rejects non-strict value %s",
    (value) => {
      expect(() => stringifyStrictJson({ value })).toThrow();
    },
  );

  it("rejects cycles and non-finite parsed numbers", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => stringifyStrictJson(cyclic)).toThrow(/cyclic/i);
    expect(() => parseStrictJson("1e400")).toThrow(/finite/i);
  });
});

describe("JSON file storage", () => {
  it("reads and writes exact, sorted, newline-terminated JSON", async () => {
    const root = await temporaryRoot();
    const path = join(root, "nested", "result.json");
    await atomicWriteJson(path, { z: 1, id: 9223372036854775807n });
    expect(await readFile(path, "utf8")).toBe(
      '{\n  "id": 9223372036854775807,\n  "z": 1\n}\n',
    );
    expect(await readJson(path)).toEqual({ id: 9223372036854775807n, z: 1 });
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  it("maps missing, malformed, non-finite, and invalid UTF-8 JSON to stable errors", async () => {
    const root = await temporaryRoot();
    await expect(readJson(join(root, "missing.json"))).rejects.toMatchObject({
      code: "storage_not_found",
    });

    const malformed = join(root, "malformed.json");
    await writeFile(malformed, "{\n  nope\n}", "utf8");
    await expect(readJson(malformed)).rejects.toMatchObject({
      code: "invalid_json",
      details: expect.objectContaining({ path: malformed }),
    });

    const nonfinite = join(root, "nonfinite.json");
    await writeFile(nonfinite, "1e400", "utf8");
    await expect(readJson(nonfinite)).rejects.toMatchObject({ code: "invalid_json" });

    const invalidUtf8 = join(root, "invalid-utf8.json");
    await writeFile(invalidUtf8, new Uint8Array([0x5b, 0xff, 0x5d]));
    await expect(readJson(invalidUtf8)).rejects.toMatchObject({ code: "storage_error" });
  });

  it("rejects non-serializable JSON without creating the target", async () => {
    const root = await temporaryRoot();
    const path = join(root, "bad.json");
    await expect(atomicWriteJson(path, { value: Number.NaN })).rejects.toMatchObject({
      code: "json_not_serializable",
    });
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replaces normally but never clobbers with noClobber", async () => {
    const root = await temporaryRoot();
    const path = join(root, "result.txt");
    await atomicWriteText(path, "first\n");
    await atomicWriteText(path, "second\n");
    expect(await readFile(path, "utf8")).toBe("second\n");
    await expect(
      atomicWriteText(path, "third\n", { noClobber: true }),
    ).rejects.toMatchObject({ code: "target_exists" });
    expect(await readFile(path, "utf8")).toBe("second\n");
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("publishes exactly one winner in a concurrent no-clobber race", async () => {
    const root = await temporaryRoot();
    const path = join(root, "winner.json");
    const attempts = await Promise.allSettled([
      atomicWriteJson(path, { winner: "a" }, { noClobber: true }),
      atomicWriteJson(path, { winner: "b" }, { noClobber: true }),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "target_exists" }),
    });
    expect(await readJson(path)).toEqual(
      expect.objectContaining({ winner: expect.stringMatching(/^[ab]$/) }),
    );
  });
});

describe("move, unlink, and locking", () => {
  it("moves without clobbering and preserves a source on conflict", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source.json");
    const destination = join(root, "archive", "destination.json");
    await writeFile(source, "source", "utf8");
    await atomicMove(source, destination);
    expect(await readFile(destination, "utf8")).toBe("source");
    await expect(readFile(source)).rejects.toMatchObject({ code: "ENOENT" });

    const conflictSource = join(root, "conflict-source.json");
    await writeFile(conflictSource, "new", "utf8");
    await expect(atomicMove(conflictSource, destination)).rejects.toMatchObject({
      code: "target_exists",
    });
    expect(await readFile(conflictSource, "utf8")).toBe("new");
    expect(await readFile(destination, "utf8")).toBe("source");
  });

  it("rejects absent and symlink move sources", async () => {
    const root = await temporaryRoot();
    await expect(atomicMove(join(root, "missing"), join(root, "target"))).rejects.toMatchObject({
      code: "storage_not_found",
    });
    const actual = join(root, "actual");
    const linked = join(root, "linked");
    await writeFile(actual, "contents", "utf8");
    await symlink(actual, linked);
    await expect(atomicMove(linked, join(root, "moved"))).rejects.toMatchObject({
      code: "storage_error",
    });
    expect(await readFile(actual, "utf8")).toBe("contents");
  });

  it("unlinks one file idempotently", async () => {
    const root = await temporaryRoot();
    const path = join(root, "one.txt");
    await writeFile(path, "one", "utf8");
    expect(await safeUnlink(path)).toBe(true);
    expect(await safeUnlink(path)).toBe(false);
  });

  it("serializes concurrent operations on the same cross-process lock", async () => {
    const root = await temporaryRoot();
    const path = join(root, "state.lock");
    let active = 0;
    let maximumActive = 0;
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let announceFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      announceFirst = resolve;
    });

    const first = withLock(path, async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      announceFirst();
      await holdFirst;
      active -= 1;
      return "first";
    });
    await firstEntered;
    const second = withLock(path, async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      active -= 1;
      return "second";
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(maximumActive).toBe(1);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(maximumActive).toBe(1);
    expect((await lstat(path)).isFile()).toBe(true);
  });

  it("fails with bounded owner diagnostics when a live lock remains held", async () => {
    const root = await temporaryRoot();
    const path = join(root, "timed.lock");
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const first = withLock(path, async () => {
      enteredFirst();
      await holdFirst;
    });
    await firstEntered;

    const error = await withLock(path, () => "unexpected", {
      timeoutMs: 50,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BatchTasksError);
    expect(error).toMatchObject({
      code: "lock_timeout",
      details: {
        path: `${path}.lock`,
        timeout_ms: 50,
        owner: expect.objectContaining({ pid: process.pid }),
      },
    });

    releaseFirst();
    await first;
  });

  it("never steals a pre-existing dead recovery claim", async () => {
    const root = await temporaryRoot();
    const path = join(root, "claimed.lock");
    const primaryLock = `${path}.lock`;
    const recoveryClaim = `${primaryLock}.recover`;
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const first = withLock(path, async () => {
      enteredFirst();
      await holdFirst;
    });
    await firstEntered;

    const deadClaimOwner = {
      pid: 2_147_483_647,
      hostname: hostname(),
      token: "preseeded-dead-recovery-claim",
      created_at: Date.now() - 60_000,
    };
    await atomicWriteJson(recoveryClaim, deadClaimOwner, { noClobber: true });

    let waiterEntries = 0;
    const errors = await Promise.all(
      Array.from({ length: 12 }, () =>
        withLock(
          path,
          () => {
            waiterEntries += 1;
          },
          { timeoutMs: 75 },
        ).catch((caught: unknown) => caught),
      ),
    );
    expect(waiterEntries).toBe(0);
    expect(errors).toHaveLength(12);
    for (const error of errors) {
      expect(error).toBeInstanceOf(BatchTasksError);
      expect(error).toMatchObject({
        code: "lock_timeout",
        details: {
          recovery_claim_path: recoveryClaim,
          recovery_claim_owner: deadClaimOwner,
        },
      });
    }
    expect((await lstat(primaryLock)).isFile()).toBe(true);
    expect(await readJson(recoveryClaim)).toEqual(deadClaimOwner);

    releaseFirst();
    await first;
    await expect(lstat(primaryLock)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readJson(recoveryClaim)).toEqual(deadClaimOwner);
  });

  it("rejects a symlink as a lock anchor", async () => {
    const root = await temporaryRoot();
    const actual = join(root, "actual.lock");
    const linked = join(root, "linked.lock");
    await writeFile(actual, "", "utf8");
    await symlink(actual, linked);
    await expect(withLock(linked, () => undefined)).rejects.toMatchObject({
      code: "lock_error",
    });
  });

  it("preserves operation errors raised inside a lock", async () => {
    const root = await temporaryRoot();
    const expected = new BatchTasksError("inner", "inner failure");
    await expect(
      withLock(join(root, "state.lock"), () => {
        throw expected;
      }),
    ).rejects.toBe(expected);

    const ordinary = new Error("ordinary operation failure");
    await expect(
      withLock(join(root, "ordinary.lock"), () => {
        throw ordinary;
      }),
    ).rejects.toBe(ordinary);
  });

  it("handles simultaneous creation of a new lock anchor", async () => {
    const root = await temporaryRoot();
    const path = join(root, "new.lock");
    await expect(
      Promise.all([
        withLock(path, async () => "one"),
        withLock(path, async () => "two"),
      ]),
    ).resolves.toEqual(["one", "two"]);
  });

  it(
    "does not steal a live cross-process lock while its event loop is blocked",
    async () => {
      const root = await temporaryRoot();
      const path = join(root, "blocked.lock");
      const first = spawnLockProcess(path, "block", 12_000);
      const firstEntered = waitForChildTimestamp(first, "ENTER:");
      const firstLeaving = waitForChildTimestamp(first, "LEAVE:");
      await firstEntered;

      const second = spawnLockProcess(path, "normal", 0);
      const secondEntered = waitForChildTimestamp(second, "ENTER:");
      const [leaveTimestamp, enterTimestamp] = await Promise.all([
        firstLeaving,
        secondEntered,
      ]);
      expect(enterTimestamp).toBeGreaterThanOrEqual(leaveTimestamp);
      await Promise.all([expectChildSuccess(first), expectChildSuccess(second)]);
    },
    25_000,
  );

  it("recovers a lock whose owning process crashed", async () => {
    const root = await temporaryRoot();
    const path = join(root, "crashed.lock");
    const crashed = spawnLockProcess(path, "crash", 0);
    await waitForChildTimestamp(crashed, "ENTER:");
    await expectChildSuccess(crashed);

    const started = Date.now();
    await expect(withLock(path, () => "recovered")).resolves.toBe("recovered");
    expect(Date.now() - started).toBeLessThan(2_000);
    await expect(lstat(`${path}.lock.recover`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

function spawnLockProcess(
  lockPath: string,
  mode: "block" | "normal" | "crash",
  blockMs: number,
): ChildProcess {
  const storageUrl = pathToFileURL(join(process.cwd(), "src", "storage.ts")).href;
  const script = `
import { withLock } from ${JSON.stringify(storageUrl)};
const lockPath = process.env.BATCH_TEST_LOCK_PATH;
const mode = process.env.BATCH_TEST_LOCK_MODE;
const blockMs = Number(process.env.BATCH_TEST_LOCK_BLOCK_MS ?? "0");
const writeLine = (line) => new Promise((resolve, reject) => {
  process.stdout.write(line + "\\n", (error) => error ? reject(error) : resolve());
});
try {
  await withLock(lockPath, async () => {
    await writeLine("ENTER:" + Date.now());
    if (mode === "crash") process.exit(0);
    const until = Date.now() + blockMs;
    while (Date.now() < until) {}
    await writeLine("LEAVE:" + Date.now());
  });
} catch (error) {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
}
`;
  return spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BATCH_TEST_LOCK_PATH: lockPath,
        BATCH_TEST_LOCK_MODE: mode,
        BATCH_TEST_LOCK_BLOCK_MS: String(blockMs),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function waitForChildTimestamp(child: ChildProcess, prefix: string): Promise<number> {
  return new Promise((resolveTimestamp, rejectTimestamp) => {
    let output = "";
    const onData = (chunk: Buffer | string): void => {
      output += chunk.toString();
      for (const line of output.split(/\r?\n/)) {
        if (line.startsWith(prefix)) {
          cleanup();
          resolveTimestamp(Number(line.slice(prefix.length)));
          return;
        }
      }
    };
    const onExit = (): void => {
      cleanup();
      rejectTimestamp(new Error(`Child exited before writing ${prefix}`));
    };
    const cleanup = (): void => {
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
}

async function expectChildSuccess(child: ChildProcess): Promise<void> {
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveExit({ code: child.exitCode, signal: child.signalCode });
      } else {
        child.once("exit", (code, signal) => resolveExit({ code, signal }));
      }
    },
  );
  expect(result, stderr).toEqual({ code: 0, signal: null });
}
