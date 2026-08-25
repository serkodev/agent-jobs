import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BatchTasksError } from "../src/errors.js";
import {
  canonicalizeId,
  loadRecords,
  resolveJsonPointer,
  safeIdFilename,
} from "../src/input.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function temporaryFile(name: string, content: string | Uint8Array): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "batch-input-test-"));
  roots.push(root);
  const path = join(root, name);
  await writeFile(path, content);
  return path;
}

describe("input loaders", () => {
  it("preserves JSON integers larger than the JavaScript safe range", async () => {
    const path = await temporaryFile(
      "rows.json",
      '[{"id":9223372036854775807,"title":"huge"}]',
    );
    const records = await loadRecords(path);
    expect(records).toEqual([{ id: 9223372036854775807n, title: "huge" }]);
    expect(typeof records[0]?.id).toBe("bigint");
  });

  it("keeps ordinary JSON integer tokens distinct from float/exponent tokens", async () => {
    const path = await temporaryFile(
      "rows.json",
      '[{"id":0},{"id":-42},{"id":1.0},{"id":1e0}]',
    );
    const records = await loadRecords(path);
    expect(records.map((record) => record.id)).toEqual([0n, -42n, 1, 1]);
    expect(canonicalizeId(records[0]!.id)).toBe("0");
    expect(canonicalizeId(records[1]!.id)).toBe("-42");
    expect(() => canonicalizeId(records[2]!.id)).toThrowError(
      expect.objectContaining({ code: "invalid_id" }),
    );
    expect(() => canonicalizeId(records[3]!.id)).toThrowError(
      expect.objectContaining({ code: "invalid_id" }),
    );
  });

  it("loads JSONL in order, skips blanks, and retains bigint", async () => {
    const path = await temporaryFile(
      "rows.ndjson",
      '{"id":"a","title":"A"}\n\n  \n{"id":9007199254740992,"title":"B"}\n',
    );
    expect(await loadRecords(path)).toEqual([
      { id: "a", title: "A" },
      { id: 9007199254740992n, title: "B" },
    ]);
  });

  it.each([
    '[{"id":"bad","score":NaN}]',
    '[{"id":"bad","score":Infinity}]',
    '[{"id":"bad","score":1e400}]',
  ])("rejects non-strict or non-finite JSON numbers", async (content) => {
    const path = await temporaryFile("rows.json", content);
    await expect(loadRecords(path)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("parses quoted, multiline CSV while retaining string values", async () => {
    const path = await temporaryFile(
      "rows.csv",
      '\ufeffid,title,optional\r\n001,"One, first",\r\n002,"Two\nlines",yes\r\n',
    );
    expect(await loadRecords(path)).toEqual([
      { id: "001", title: "One, first", optional: "" },
      { id: "002", title: "Two\nlines", optional: "yes" },
    ]);
  });

  it("preserves a literal CSV __proto__ header without prototype pollution", async () => {
    const path = await temporaryFile(
      "rows.csv",
      "id,__proto__\none,literal\n",
    );
    const [record] = await loadRecords(path);
    expect(Object.hasOwn(record!, "__proto__")).toBe(true);
    expect(record!.__proto__).toBe("literal");
    expect(record!.injected).toBeUndefined();
    expect(Object.getPrototypeOf(record!)).toBeNull();
  });

  it.each(["id,id\none,two\n", ",title\none,two\n", ""])(
    "rejects invalid CSV headers",
    async (content) => {
      const path = await temporaryFile("rows.csv", content);
      await expect(loadRecords(path)).rejects.toMatchObject({ code: "invalid_input" });
    },
  );

  it.each(["yaml", "yml"])(
    "loads YAML with exact bigint and timestamp-looking strings (%s)",
    async (extension) => {
      const path = await temporaryFile(
        `rows.${extension}`,
        "- id: 9223372036854775807\n  date: 2026-08-21\n- id: safe\n  date: 2026-08-22T10:00:00Z\n",
      );
      expect(await loadRecords(path)).toEqual([
        { id: 9223372036854775807n, date: "2026-08-21" },
        { id: "safe", date: "2026-08-22T10:00:00Z" },
      ]);
    },
  );

  it("preserves a literal YAML __proto__ field without prototype pollution", async () => {
    const path = await temporaryFile(
      "rows.yaml",
      "- id: safe\n  __proto__:\n    injected: true\n  title: Example\n",
    );
    const [record] = await loadRecords(path);
    expect(record).toBeDefined();
    expect(Object.hasOwn(record!, "__proto__")).toBe(true);
    expect(record!.__proto__).toEqual({ injected: true });
    expect(record!.injected).toBeUndefined();
    expect(Object.getPrototypeOf(record!)).toBeNull();
  });

  it("keeps YAML integers distinct from integral floats for ID handling", async () => {
    const path = await temporaryFile(
      "rows.yaml",
      "- id: 1\n- id: 1.0\n",
    );
    const records = await loadRecords(path);
    expect(records.map((record) => record.id)).toEqual([1n, 1]);
    expect(canonicalizeId(records[0]!.id)).toBe("1");
    expect(() => canonicalizeId(records[1]!.id)).toThrowError(
      expect.objectContaining({ code: "invalid_id" }),
    );
  });

  it.each([
    '[{"id":9007199254740991.1}]',
    '[{"id":1.0000000000000001}]',
    '[{"id":9.007199254740993e15}]',
    '[{"id":1e-400}]',
  ])("rejects a decimal/exponent ID literal that Number would change", async (content) => {
    const path = await temporaryFile("rows.json", content);
    await expect(loadRecords(path)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it.each(["json", "yaml"])("selects nested records using JSON Pointer (%s)", async (format) => {
    const content =
      format === "json"
        ? '{"payload":{"records":[{"id":"nested"}]}}'
        : "payload:\n  records:\n    - id: nested\n";
    const path = await temporaryFile(`nested.${format}`, content);
    expect(await loadRecords(path, "/payload/records")).toEqual([{ id: "nested" }]);
  });

  it("rejects RECORDS_PATH for streaming and tabular inputs", async () => {
    const jsonl = await temporaryFile("rows.jsonl", '{"id":"one"}\n');
    await expect(loadRecords(jsonl, "/rows")).rejects.toMatchObject({
      code: "records_path_not_supported",
    });
    const csv = await temporaryFile("rows.csv", "id\none\n");
    await expect(loadRecords(csv, "/rows")).rejects.toMatchObject({
      code: "records_path_not_supported",
    });
  });

  it("rejects malformed UTF-8 rather than substituting replacement characters", async () => {
    const path = await temporaryFile("rows.json", new Uint8Array([0x5b, 0xff, 0x5d]));
    await expect(loadRecords(path)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects unknown input types, scalar rows, and absent paths", async () => {
    const unknown = await temporaryFile("rows.toml", "rows = []");
    await expect(loadRecords(unknown)).rejects.toMatchObject({
      code: "unsupported_input_format",
    });
    const scalars = await temporaryFile("rows.json", '[{"id":"ok"},42]');
    await expect(loadRecords(scalars)).rejects.toMatchObject({ code: "invalid_records" });
    await expect(loadRecords(join(tmpdir(), "definitely-not-a-batch-input.json"))).rejects.toMatchObject({
      code: "input_not_found",
    });
  });
});

describe("JSON Pointer", () => {
  it("decodes escaped tokens and indexes arrays", () => {
    const document = { "a/b": { "~key": [{ value: 1 }, { value: 2 }] } };
    expect(resolveJsonPointer(document, "/a~1b/~0key/1/value")).toBe(2);
    expect(resolveJsonPointer(document, "")).toBe(document);
  });

  it.each(["payload/records", "/missing", "/rows/9", "/rows/not-index"])(
    "rejects an unavailable pointer %s",
    (pointer) => {
      expect(() => resolveJsonPointer({ rows: [] }, pointer)).toThrowError(BatchTasksError);
    },
  );

  it("rejects invalid tilde escapes", () => {
    expect(() => resolveJsonPointer({ "bad~2key": [] }, "/bad~2key")).toThrowError(
      expect.objectContaining({ code: "invalid_records_path" }),
    );
  });
});

describe("row IDs", () => {
  it.each([
    [0n, "0"],
    [-42n, "-42"],
    [9223372036854775807n, "9223372036854775807"],
    ["  preserve spaces  ", "  preserve spaces  "],
    ["unicode-台灣", "unicode-台灣"],
  ])("canonicalizes %s exactly", (raw, expected) => {
    expect(canonicalizeId(raw)).toBe(expected);
  });

  it.each([null, true, false, 0, 1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "", "   "])(
    "rejects ambiguous ID %s",
    (raw) => {
      expect(() => canonicalizeId(raw)).toThrowError(
        expect.objectContaining({ code: "invalid_id" }),
      );
    },
  );

  it("uses direct safe filenames and deterministic encodings for unsafe IDs", () => {
    expect(safeIdFilename("alpha-01_foo.bar")).toBe("alpha-01_foo.bar");
    const unsafe = "../hello/world\n";
    const encoded = safeIdFilename(unsafe);
    expect(encoded).toBe(safeIdFilename(unsafe));
    expect(encoded).not.toBe(safeIdFilename("../hello/world"));
    expect(encoded).not.toMatch(/[\\/]/);
    expect(["", ".", ".."]).not.toContain(encoded);
  });
});
