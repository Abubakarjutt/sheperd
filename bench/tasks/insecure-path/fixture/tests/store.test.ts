import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { listUploads, saveUpload } from "../src/uploads/store.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "uploads-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("upload store", () => {
  test("saves and lists", async () => {
    await saveUpload(root, "abcdef012345", Buffer.from("hi"));
    expect(await listUploads(root)).toEqual(["abcdef012345"]);
    expect((await readFile(join(root, "abcdef012345"))).toString()).toBe("hi");
  });

  test("rejects bad ids", async () => {
    await expect(saveUpload(root, "../x", Buffer.from("x"))).rejects.toThrow(TypeError);
  });
});
