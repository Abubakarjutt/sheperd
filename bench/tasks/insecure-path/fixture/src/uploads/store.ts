import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Stores an upload under a server-generated name (never a client-supplied path). */
export async function saveUpload(root: string, id: string, data: Buffer): Promise<string> {
  if (data.byteLength > MAX_UPLOAD_BYTES) throw new RangeError("upload too large");
  if (!/^[a-f0-9]{8,64}$/.test(id)) throw new TypeError("bad upload id");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, id), data);
  return id;
}

export async function listUploads(root: string): Promise<string[]> {
  const names = await readdir(root);
  return names.sort();
}
