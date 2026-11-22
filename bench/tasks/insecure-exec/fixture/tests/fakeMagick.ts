import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Puts a fake `identify`/`convert` first on PATH. Each call appends its argv, as one JSON line,
 * to the returned log file, then prints `stdout` and exits with `code`.
 */
export async function installFakeMagick(opts: { stdout?: string; code?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "fake-magick-"));
  const log = join(dir, "calls.log");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([require("node:path").basename(process.argv[1]), ...process.argv.slice(2)]) + "\\n");
process.stdout.write(${JSON.stringify(opts.stdout ?? "")});
process.exit(${opts.code ?? 0});
`;
  for (const name of ["identify", "convert"]) {
    const p = join(dir, name);
    await writeFile(p, script);
    await chmod(p, 0o755);
  }
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved ?? ""}`;
  return {
    calls: async (): Promise<string[][]> => {
      const text = await readFile(log, "utf8").catch(() => "");
      return text
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[]);
    },
    restore: () => {
      process.env.PATH = saved;
    },
  };
}
