/** Colors and glyphs shared by every TUI component. */
export const theme = {
  user: "cyan",
  assistant: undefined,
  tool: "gray",
  error: "red",
  busy: "yellow",
  dim: "gray",
  /** Markdown accent: h1/h2 headings and inline code. */
  accent: "blueBright",
  /** The input box border while idle (empty or busy); it turns `accent` while typing. */
  border: "gray",
  glyph: { user: ">", tool: "●", toolError: "✗", welcome: "✻" },
  /**
   * Syntax colours for highlight.js scopes (the part after `hljs-`, first word). A scope that is
   * not listed (attr, variable, params, ...) renders in the default colour. `gray` is the dim one.
   */
  syntax: {
    keyword: "magenta",
    literal: "magenta",
    string: "green",
    regexp: "green",
    number: "yellow",
    comment: "gray",
    doctag: "gray",
    meta: "gray",
    title: "blue",
    function: "blue",
    section: "blue",
    type: "cyan",
    built_in: "cyan",
    addition: "green",
    deletion: "red",
  } as Readonly<Record<string, string>>,
} as const;
