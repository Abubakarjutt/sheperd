export type CommandRule = {
  pattern: (string | string[])[];
  decision: "allow" | "forbidden";
  justification?: string;
  match?: string[];
  notMatch?: string[];
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
});
