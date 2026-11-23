import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { makeThumbnail } from "../src/media/thumbnail.js";

async function installFakeConvert(code = 0) {
  const dir = await mkdtemp(join(tmpdir(), "fake-convert-"));
  const log = join(dir, "calls.log");
  const script = `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(${code});
`;
  const p = join(dir, "convert");
  await writeFile(p, script);
  await chmod(p, 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved ?? ""}`;
  return {
    calls: async (): Promise<string[][]> =>
      (await readFile(log, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[]),
    restore: () => {
      process.env.PATH = saved;
    },
  };
}

let restore = () => {};
afterEach(() => restore());

describe("makeThumbnail", () => {
  test("runs convert with the input, the width and the output", async () => {
    const fake = await installFakeConvert();
    restore = fake.restore;
    await makeThumbnail("in.png", "out.png", { width: 200 });
    const calls = await fake.calls();
    expect(calls).toHaveLength(1);
    const argv = calls[0] as string[];
    expect(argv).toContain("in.png");
    expect(argv.at(-1)).toBe("out.png");
    expect(argv.join(" ")).toMatch(/200/);
  });

  test("hostile file names reach convert as single arguments, never through a shell", async () => {
    const fake = await installFakeConvert();
    restore = fake.restore;
    const input = "evil; touch pwned #.png";
    const output = "$(touch pwned2).png";
    await makeThumbnail(input, output, { width: 64 });
    const argv = (await fake.calls())[0] as string[];
    expect(argv).toContain(input);
    expect(argv).toContain(output);
  });

  test("a name that starts with a dash cannot be read as an option", async () => {
    const fake = await installFakeConvert();
    restore = fake.restore;
    await makeThumbnail("-write", "out.png", { width: 64 });
    const argv = (await fake.calls())[0] as string[];
    const i = argv.findIndex((a) => a.endsWith("-write"));
    expect(i).toBeGreaterThanOrEqual(0);
    // either neutralised ("./-write") or never an option-looking argument on its own
    expect(argv[i]).not.toBe("-write");
  });

  test("width outside 16..2048 or non-integer is a RangeError before anything runs", async () => {
    const fake = await installFakeConvert();
    restore = fake.restore;
    for (const width of [15, 2049, 0, -1, 10.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(makeThumbnail("in.png", "out.png", { width })).rejects.toBeInstanceOf(RangeError);
    }
    expect(await fake.calls()).toHaveLength(0);
  });

  test("boundaries are allowed", async () => {
    const fake = await installFakeConvert();
    restore = fake.restore;
    await makeThumbnail("in.png", "out.png", { width: 16 });
    await makeThumbnail("in.png", "out.png", { width: 2048 });
    expect(await fake.calls()).toHaveLength(2);
  });

  test("a failing convert rejects", async () => {
    const fake = await installFakeConvert(1);
    restore = fake.restore;
    await expect(makeThumbnail("in.png", "out.png", { width: 100 })).rejects.toThrow();
  });
});
