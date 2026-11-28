export type CommandRule = {
  pattern: (string | string[])[];
  decision: "allow" | "forbidden";
  justification?: string;
  match?: string[];
  notMatch?: string[];
};

/**
 * Web access for the chat, spec and implementer web tools (tighten-only, see `mergeTightenOnly`).
 * Domains are lowercase host names without a trailing dot; each matches itself and its
 * subdomains. `allowDomains` absent means no allow list; present (even empty) means only those.
 */
export type WebPolicy = {
  enabled: boolean;
  denyDomains: string[];
  allowDomains?: string[];
};

export type Policy = {
  testGlobs: string[];
  protectedGlobs: string[];
  credentialDenyGlobs: string[];
  gates: string[];
  reviewerMinConfidence: number;
  maxFixRounds: number;
  noProgressRounds: number;
  gateTimeoutMs: number;
  commandRules: CommandRule[];
  web: WebPolicy;
};

/**
 * The single source of truth for config files that decide what the verification gates run and
 * how they judge (runner, lint, compiler, scanner, package-manager and version-manager config).
 * `protectedGlobs` includes every entry; the gates derive their config-drift matcher and git
 * pathspecs from it (`@rewire/gates` shared.ts). Plain globs only: no `{a,b}` braces, and
 * every entry starts with `**` so it matches at any depth.
 */
export const CONFIG_FILE_GLOBS: readonly string[] = [
  "**/vitest.config.*",
  "**/vite.config.*",
  "**/vitest.workspace.*",
  "**/jest.config.*",
  "**/tsconfig*.json",
  "**/biome.json",
  "**/biome.jsonc",
  "**/.eslintrc*",
  "**/eslint.config.*",
  "**/.gitignore",
  "**/.eslintignore",
  "**/.prettierrc*",
  "**/.prettierignore",
  "**/.npmrc",
  "**/.yarnrc",
  "**/.yarnrc.yml",
  "**/pnpm-workspace.yaml",
  "**/babel.config.*",
  "**/.babelrc",
  "**/.babelrc.*",
  "**/.swcrc",
  "**/.gitleaks.toml",
  "**/.gitleaksignore",
  "**/.semgrepignore",
  "**/npm-shrinkwrap.json",
  "**/.pnpmfile.cjs",
  "**/.pnpmfile.mjs",
  "**/.pnpmfile.js",
  "**/__mocks__/**",
  "**/.yarn/**",
  // version managers (node/pm version selection)
  "**/.tool-versions",
  "**/.nvmrc",
  "**/.node-version",
  "**/mise.toml",
  "**/.mise.toml",
  "**/mise.local.toml",
  "**/.mise.local.toml",
  "**/mise.*.toml",
  "**/.mise.*.toml",
  "**/.config/mise.toml",
  "**/.config/mise.*.toml",
  "**/.config/mise/**",
  "**/.mise/**",
  "**/mise/config.toml",
  "**/mise/config.*.toml",
  "**/mise/conf.d/**",
];

function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

/** Deep-frozen: callers that need a mutable policy take a `structuredClone` (row 5). */
export const DEFAULT_POLICY: Policy = deepFreeze({
  testGlobs: [
    "**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
    "**/__tests__/**",
    "test/**",
    "tests/**",
  ],
  protectedGlobs: [
    ".github/**",
    ".rewire/**",
    ".git/**",
    "**/.gitattributes",
    "**/node_modules/**",
    "**/package-lock.json",
    "**/pnpm-lock.yaml",
    "**/yarn.lock",
    ...CONFIG_FILE_GLOBS,
  ],
  // `~` is kept unexpanded here; the sandbox layer expands it.
  credentialDenyGlobs: [
    "~/.ssh/**",
    "~/.aws/**",
    "~/.config/gh/**",
    "~/.netrc",
    "~/.npmrc",
    "**/.env*",
    "~/Library/Keychains/**",
    // I10: other credential stores an agent could read and send to a provider.
    "~/.git-credentials",
    "~/.docker/config.json",
    "~/.kube/**",
    "~/.config/gcloud/**",
    "~/.azure/**",
    "~/.gnupg/**",
    "~/.pypirc",
    "~/.config/rewire/**",
    // I3: files that commonly hold API keys and tokens. Shell start-up files and histories
    // (`export ANTHROPIC_API_KEY=...`), Claude Code's own config, and other tool credentials.
    // This is a deny-list, not an allow-list: secrets elsewhere in HOME stay readable (see
    // KNOWN_LIMITATIONS).
    // `*` also matches the bare name and covers backups (`~/.zshrc.bak-20260721`).
    "~/.zshrc*",
    "~/.zprofile*",
    "~/.zshenv*",
    "~/.zlogin*",
    "~/.bashrc*",
    "~/.bash_profile*",
    "~/.bash_login*",
    "~/.profile*",
    "~/.zsh_history*",
    "~/.bash_history*",
    // macOS Terminal's per-session zsh history (the same data as ~/.zsh_history).
    "~/.zsh_sessions/**",
    "~/.config/fish/**",
    // Other agent and model CLIs' credentials and MCP configs (tokens in `env`).
    "~/.codex/**",
    "~/.gemini/**",
    "~/.mcp.json*",
    "~/.cursor/mcp.json",
    "~/.config/openai/**",
    "~/.ollama/id_*",
    "~/.claude.json*",
    "~/.claude/**",
    "~/.cargo/credentials*",
    "~/.pgpass",
    "~/.terraform.d/**",
    // `.env` files outside the worktree, up to three directories below HOME (`**/.env*` above
    // covers the worktree). Depth-limited: on Linux an absolute deny glob is walked on every
    // exec, and `~/**` would walk all of HOME. The run's own repo is added per profile.
    "~/.env*",
    "~/*/.env*",
    "~/*/*/.env*",
    "~/*/*/*/.env*",
    // Private-key PEMs by name only: a blanket `**/*.pem` also denies CA bundles such as
    // /etc/ssl/cert.pem, and semgrep (and any TLS client) then fails in every gate.
    "**/*key*.pem",
    "**/*.key",
    "**/id_rsa*",
    "**/id_ed25519*",
  ],
  gates: ["frozen-tests", "tsc", "lint", "tests", "semgrep", "gitleaks", "audit"],
  reviewerMinConfidence: 0.5,
  maxFixRounds: 6,
  noProgressRounds: 2,
  gateTimeoutMs: 300000,
  commandRules: [],
  web: { enabled: true, denyDomains: [] },
});
