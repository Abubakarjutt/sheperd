import { SECRET } from "@rewire/core";

/**
 * Why `text` (a search query or a URL about to be sent) must not leave this process, or
 * undefined. It is refused when it, or its percent-decoded form, contains anything `SECRET`
 * matches, so a page cannot talk a model into sending a key out in a query string.
 */
export function checkOutgoing(text: string): string | undefined {
  const forms = [text];
  try {
    forms.push(decodeURIComponent(text.replaceAll("+", " ")));
  } catch {
    // Malformed percent-encoding: the raw form is still checked.
  }
  // `search` ignores the global flag and lastIndex, so the shared regex is safe to use here.
  if (forms.some((f) => f.search(SECRET) >= 0)) {
    return "refused: it contains what looks like a secret (an API key or token), which is never sent";
  }
  return undefined;
}
