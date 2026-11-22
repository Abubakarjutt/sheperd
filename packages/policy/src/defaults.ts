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

export const DEFAULT_POLICY: Policy = {
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
    "**/biome.json",
    "**/.eslintrc*",
    "**/eslint.config.*",
    "**/.prettierrc*",
    "**/tsconfig*.json",
    "**/vitest.config.*",
    "**/vite.config.*",
    "**/vitest.workspace.*",
    "**/jest.config.*",
    "**/.gitignore",
    "**/.gitattributes",
    "**/.eslintignore",
    "**/.prettierignore",
    "**/biome.jsonc",
    "**/.npmrc",
    "**/.yarnrc",
    "**/.yarnrc.yml",
    "**/pnpm-workspace.yaml",
    "**/babel.config.*",
    "**/.babelrc",
    "**/.babelrc.*",
    "**/.swcrc",
    "**/__mocks__/**",
    "**/node_modules/**",
    "**/package-lock.json",
    "**/pnpm-lock.yaml",
    "**/yarn.lock",
    "**/.gitleaks.toml",
    "**/.gitleaksignore",
    "**/.semgrepignore",
    "**/npm-shrinkwrap.json",
    "**/.pnpmfile.cjs",
    "**/.pnpmfile.mjs",
    "**/.pnpmfile.js",
    "**/.yarn/**",
    "**/.tool-versions",
    "**/mise.toml",
    "**/.mise.toml",
    "**/mise.local.toml",
    "**/.mise.local.toml",
    "**/.config/mise.toml",
    "**/.config/mise/**",
    "**/.mise/**",
    "**/.nvmrc",
    "**/.node-version",
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
  ],
  gates: ["frozen-tests", "tsc", "lint", "tests", "semgrep", "gitleaks", "audit"],
  reviewerMinConfidence: 0.5,
  maxFixRounds: 6,
  noProgressRounds: 2,
  gateTimeoutMs: 300000,
  commandRules: [],
};
