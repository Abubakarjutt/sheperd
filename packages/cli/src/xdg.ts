import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type XdgDirs = { home: string; xdgConfig: string; cacheDir: string };

const absolute = (v: string | undefined): string | undefined =>
  v !== undefined && v !== "" && isAbsolute(v) ? v : undefined;

/**
 * HOME, `$XDG_CONFIG_HOME` and `$XDG_CACHE_HOME`, resolved as `@rewire/skills` does: only an
 * absolute value is used (the XDG spec says to ignore relative ones), otherwise the default under
 * HOME. A relative value never reaches the trust file or the skill-set cache, so neither can land
 * inside the working tree.
 */
export function xdgDirs(env: NodeJS.ProcessEnv, fallbackHome: () => string = homedir): XdgDirs {
  const home = absolute(env.HOME) ?? fallbackHome();
  return {
    home,
    xdgConfig: absolute(env.XDG_CONFIG_HOME) ?? join(home, ".config"),
    cacheDir: absolute(env.XDG_CACHE_HOME) ?? join(home, ".cache"),
  };
}
