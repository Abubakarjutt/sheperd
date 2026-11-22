import { graphemes } from "./segments.js";

export function padEnd(text: string, width: number, fill = " "): string {
  const missing = width - graphemes(text).length;
  return missing > 0 ? text + fill.repeat(missing) : text;
}
