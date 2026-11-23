import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { UploadNotFoundError, UploadPathError } from "../src/uploads/errors.js";
import { readUpload } from "../src/uploads/store.js";

let base: string;
let root: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "uploads-"));
  root = join(base, "uploads");
  await mkdir(join(root, "reports"), { recursive: true });
  await writeFile(join(root, "a.txt"), "alpha");
  await writeFile(join(root, "reports", "q1.txt"), "quarter");
  await writeFile(join(base, "secret.txt"), "TOP SECRET");
  // a sibling directory that shares the root's name as a prefix
  await mkdir(join(base, "uploads-private"));
  await writeFile(join(base, "uploads-private", "key.txt"), "PRIVATE");
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const refused = async (name: string): Promise<unknown> => readUpload(root, name).catch((e) => e);

describe("readUpload", () => {
  test("reads a file and a nested file", async () => {
    expect((await readUpload(root, "a.txt")).toString()).toBe("alpha");
    expect((await readUpload(root, "reports/q1.txt")).toString()).toBe("quarter");
  });

  test("a missing file is UploadNotFoundError", async () => {
    expect(await refused("nope.txt")).toBeInstanceOf(UploadNotFoundError);
  });

  test("parent traversal is refused", async () => {
    for (const name of ["../secret.txt", "reports/../../secret.txt", "..", "../uploads/a.txt/../../secret.txt"]) {
      expect(await refused(name)).toBeInstanceOf(UploadPathError);
    }
  });

  test("a sibling directory with the root name as prefix is refused", async () => {
    expect(await refused("../uploads-private/key.txt")).toBeInstanceOf(UploadPathError);
  });

  test("absolute paths are refused", async () => {
    expect(await refused(join(base, "secret.txt"))).toBeInstanceOf(UploadPathError);
  });

  test("a symlink pointing outside the root is refused", async () => {
    await symlink(join(base, "secret.txt"), join(root, "link.txt"));
    expect(await refused("link.txt")).toBeInstanceOf(UploadPathError);
  });

  test("a NUL byte is not a way through", async () => {
    const err = await refused("a.txt\0../../secret.txt");
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toContain("TOP SECRET");
  });
});
