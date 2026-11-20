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
  testGlobs: ["**/*.test.ts", "**/*.spec.ts", "**/__tests__/**", "test/**", "tests/**"],
  protectedGlobs: [
    ".github/**",
    ".rewire/**",
    ".git/**",
    "**/biome.json",
    "**/.eslintrc*",
    "**/eslint.config.*",
    "**/.prettierrc*",
    "**/tsconfig*.json",
    "**/package-lock.json",
    "**/pnpm-lock.yaml",
    "**/yarn.lock",
  ],
  // `~` is kept unexpanded here; the sandbox layer expands it.
  credentialDenyGlobs: [
    "~/.ssh/**",
    "~/.aws/**",
    "~/.config/gh/**",
    "~/.netrc",
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
