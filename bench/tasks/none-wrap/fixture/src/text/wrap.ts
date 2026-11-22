/**
 * Greedy word wrap: breaks `text` into lines of at most `width` characters, splitting on
 * whitespace. A word longer than `width` gets a line to itself.
 */
export function wrap(text: string, width: number): string[] {
  if (!Number.isInteger(width) || width < 1) {
    throw new RangeError(`width must be a positive integer, got ${width}`);
  }
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line === "") {
      line = word;
    } else if (line.length + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line += ` ${word}`;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}
