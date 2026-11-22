import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type ImageInfo = { width: number; height: number };

/** Dimensions of an image via ImageMagick's `identify`. The path is passed as one argv entry. */
export async function probeImage(path: string): Promise<ImageInfo> {
  const { stdout } = await run("identify", ["-format", "%w %h", path], { timeout: 10_000 });
  const [w, h] = stdout.trim().split(" ").map(Number);
  if (!Number.isInteger(w) || !Number.isInteger(h)) {
    throw new Error(`unexpected identify output: ${stdout.slice(0, 40)}`);
  }
  return { width: w as number, height: h as number };
}
