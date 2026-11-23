import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const r = spawnSync("cargo", ["build", "-p", "rewire-sandbox"], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error("cargo build -p rewire-sandbox failed; the client tests need the real binary");
  }
}
