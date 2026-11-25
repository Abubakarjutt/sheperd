/** Colors and glyphs shared by every TUI component. */
export const theme = {
  user: "cyan",
  assistant: undefined,
  tool: "gray",
  error: "red",
  busy: "yellow",
  dim: "gray",
  glyph: { user: ">", tool: "●", toolError: "✗" },
} as const;
