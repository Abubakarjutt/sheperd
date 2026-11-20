//! Sandbox profile: parsing, validation, and the allow/deny decision.
//!
//! Gitdir protection (see `canonical::git_protected_paths`) adapted from
//! openai/codex default_read_only_subpaths_for_writable_root — Apache-2.0.
//!
//! Decision order (deny beats allow):
//! - read:  `readDeny` match → deny; otherwise allow (reads are not confined
//!   to `root`).
//! - write: git metadata → deny `<gitdir>`; `writeDeny` match → deny;
//!   inside an `extraWrite` dir → allow; outside `root` → deny
//!   `<outside-root>`; `write` match → allow; otherwise deny `<no-write-rule>`.
//!
//! Glob semantics: relative globs match the path relative to the canonical
//! root; absolute globs match the canonical absolute path (their literal
//! prefix is canonicalized too). `*` never crosses `/`. A glob ending in
//! `/**` also matches the directory itself. Deny globs are case-insensitive
//! (fail closed on case-insensitive filesystems) and relative deny globs that
//! start with `**/` also apply to paths outside `root`.

use crate::canonical::{canonicalize_maybe_missing, git_protected_paths};
use anyhow::{bail, Context, Result};
use globset::{GlobBuilder, GlobMatcher};
use serde::Deserialize;
use std::path::{Path, PathBuf};

pub const RULE_GITDIR: &str = "<gitdir>";
pub const RULE_OUTSIDE_ROOT: &str = "<outside-root>";
pub const RULE_NO_WRITE_RULE: &str = "<no-write-rule>";

/// On-disk profile JSON, shared verbatim with the TS packages.
/// Every field is required and unknown fields are rejected, so a typo can
/// never silently drop a deny rule.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileSpec {
    pub root: PathBuf,
    pub write: Vec<String>,
    pub write_deny: Vec<String>,
    pub read_deny: Vec<String>,
    pub network: Network,
    pub extra_write: Vec<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Network {
    Deny,
    Registry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Read,
    Write,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Deny { canonical: PathBuf, rule: String },
}

/// One glob rule as written in the profile, compiled to one or more matchers.
#[derive(Debug)]
struct Rule {
    /// The glob exactly as written in the profile (reported on denial).
    name: String,
    absolute: bool,
    /// Relative rule that also applies to absolute paths outside root.
    anywhere: bool,
    matchers: Vec<GlobMatcher>,
}

impl Rule {
    fn compile(pattern: &str, case_insensitive: bool) -> Result<Rule> {
        if pattern.is_empty() {
            bail!("empty glob in profile");
        }
        let absolute = pattern.starts_with('/');
        let mut sources = vec![pattern.to_owned()];
        if absolute {
            let canon = canonicalize_glob_prefix(pattern)?;
            if canon != pattern {
                sources.push(canon);
            }
        }
        // `dir/**` must also cover `dir` itself.
        for s in sources.clone() {
            if let Some(dir) = s.strip_suffix("/**") {
                if !dir.is_empty() {
                    sources.push(dir.to_owned());
                }
            }
        }
        let matchers = sources
            .iter()
            .map(|s| {
                GlobBuilder::new(s)
                    .literal_separator(true)
                    .case_insensitive(case_insensitive)
                    .build()
                    .map(|g| g.compile_matcher())
                    .with_context(|| format!("invalid glob {pattern:?}"))
            })
            .collect::<Result<_>>()?;
        Ok(Rule {
            name: pattern.to_owned(),
            absolute,
            anywhere: !absolute && pattern.starts_with("**/"),
            matchers,
        })
    }

    /// `rel` is the path relative to root, if the path is inside root.
    fn matches(&self, canonical: &Path, rel: Option<&Path>) -> bool {
        let candidate = if self.absolute || (self.anywhere && rel.is_none()) {
            canonical
        } else {
            match rel {
                Some(r) => r,
                None => return false,
            }
        };
        self.matchers.iter().any(|m| m.is_match(candidate))
    }
}

/// Canonicalize the literal (glob-free) directory prefix of an absolute glob,
/// so `/var/x/**` also matches the canonical `/private/var/x/...`.
fn canonicalize_glob_prefix(pattern: &str) -> Result<String> {
    let segments: Vec<&str> = pattern.split('/').collect();
    let first_glob = segments
        .iter()
        .position(|s| s.contains(['*', '?', '[', ']', '{', '}', '\\']))
        .unwrap_or(segments.len());
    let prefix = segments[..first_glob].join("/");
    let rest = &segments[first_glob..];
    let prefix = if prefix.is_empty() {
        "/".to_owned()
    } else {
        prefix
    };
    let canon = canonicalize_maybe_missing(Path::new(&prefix))
        .with_context(|| format!("canonicalizing glob prefix {prefix:?}"))?;
    let canon = canon
        .to_str()
        .with_context(|| format!("non-UTF-8 canonical glob prefix for {pattern:?}"))?;
    let mut out = globset::escape(canon);
    for seg in rest {
        if !out.ends_with('/') {
            out.push('/');
        }
        out.push_str(seg);
    }
    Ok(out)
}

/// A validated, compiled profile. All paths held here are canonical.
#[derive(Debug)]
pub struct Profile {
    root: PathBuf,
    write: Vec<Rule>,
    write_deny: Vec<Rule>,
    read_deny: Vec<Rule>,
    extra_write: Vec<PathBuf>,
    git_protected: Vec<PathBuf>,
    #[allow(dead_code)] // consumed by `exec` (Task 4)
    network: Network,
}

impl Profile {
    pub fn load(path: &Path) -> Result<Profile> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("reading profile {}", path.display()))?;
        let spec: ProfileSpec = serde_json::from_str(&text)
            .with_context(|| format!("parsing profile {}", path.display()))?;
        Profile::from_spec(spec)
    }

    pub fn from_spec(spec: ProfileSpec) -> Result<Profile> {
        if !spec.root.is_absolute() {
            bail!("profile root must be absolute: {}", spec.root.display());
        }
        let root = std::fs::canonicalize(&spec.root)
            .with_context(|| format!("canonicalizing root {}", spec.root.display()))?;
        if !root.is_dir() {
            bail!("profile root is not a directory: {}", root.display());
        }
        let compile = |globs: &[String], ci: bool| -> Result<Vec<Rule>> {
            globs.iter().map(|g| Rule::compile(g, ci)).collect()
        };
        let extra_write = spec
            .extra_write
            .iter()
            .map(|p| {
                if !p.is_absolute() {
                    bail!("extraWrite entries must be absolute: {}", p.display());
                }
                canonicalize_maybe_missing(p)
                    .with_context(|| format!("canonicalizing extraWrite {}", p.display()))
            })
            .collect::<Result<_>>()?;
        let git_protected = git_protected_paths(&root).context("resolving git metadata")?;
        Ok(Profile {
            write: compile(&spec.write, false)?,
            write_deny: compile(&spec.write_deny, true)?,
            read_deny: compile(&spec.read_deny, true)?,
            extra_write,
            git_protected,
            network: spec.network,
            root,
        })
    }

    /// Canonicalize `path` (relative paths are taken relative to `root`).
    pub fn canonical(&self, path: &Path) -> std::io::Result<PathBuf> {
        canonicalize_maybe_missing(&self.root.join(path))
    }

    /// Decide whether `op` on `path` is permitted. I/O errors while
    /// canonicalizing are returned as errors (callers fail closed).
    pub fn decide(&self, op: Op, path: &Path) -> std::io::Result<Decision> {
        let canonical = self.canonical(path)?;
        Ok(self.decide_canonical(op, canonical))
    }

    /// Decide for an already-canonical absolute path.
    pub fn decide_canonical(&self, op: Op, canonical: PathBuf) -> Decision {
        let deny = |rule: &str| Decision::Deny {
            canonical: canonical.clone(),
            rule: rule.to_owned(),
        };
        let rel = canonical.strip_prefix(&self.root).ok();
        match op {
            Op::Read => match first_match(&self.read_deny, &canonical, rel) {
                Some(rule) => deny(rule),
                None => Decision::Allow,
            },
            Op::Write => {
                if let Some(rule) = self.write_denial(&canonical) {
                    return deny(&rule);
                }
                if self.extra_write.iter().any(|d| canonical.starts_with(d)) {
                    return Decision::Allow;
                }
                let Some(rel) = rel else {
                    return deny(RULE_OUTSIDE_ROOT);
                };
                if first_match(&self.write, &canonical, Some(rel)).is_some() {
                    Decision::Allow
                } else {
                    deny(RULE_NO_WRITE_RULE)
                }
            }
        }
    }

    /// Inside `root` or an `extraWrite` dir (ignores globs and deny rules).
    pub fn in_write_space(&self, canonical: &Path) -> bool {
        canonical.starts_with(&self.root)
            || self.extra_write.iter().any(|d| canonical.starts_with(d))
    }

    /// The deny-only half of the write decision: git metadata and
    /// `writeDeny`. Used for the final path and for every parent directory
    /// `fs-write` creates.
    pub fn write_denial(&self, canonical: &Path) -> Option<String> {
        if self
            .git_protected
            .iter()
            .any(|g| starts_with_ignore_ascii_case(canonical, g))
        {
            return Some(RULE_GITDIR.to_owned());
        }
        let rel = canonical.strip_prefix(&self.root).ok();
        first_match(&self.write_deny, canonical, rel).map(str::to_owned)
    }
}

/// Component-wise `starts_with`, ignoring ASCII case. Used on the deny side
/// so `.GIT/...` cannot dodge `.git` protection on a case-insensitive FS
/// when the directory does not exist yet (realpath only fixes existing names).
fn starts_with_ignore_ascii_case(path: &Path, prefix: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let mut p = path.components();
    prefix.components().all(|pc| {
        p.next().is_some_and(|c| {
            c.as_os_str()
                .as_bytes()
                .eq_ignore_ascii_case(pc.as_os_str().as_bytes())
        })
    })
}

fn first_match<'a>(rules: &'a [Rule], canonical: &Path, rel: Option<&Path>) -> Option<&'a str> {
    rules
        .iter()
        .find(|r| r.matches(canonical, rel))
        .map(|r| r.name.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    struct T {
        _t: TempDir,
        base: PathBuf,
        root: PathBuf,
    }

    fn setup() -> T {
        let t = TempDir::new().unwrap();
        let base = fs::canonicalize(t.path()).unwrap();
        let root = base.join("root");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("tests")).unwrap();
        T { _t: t, base, root }
    }

    fn spec(root: &Path) -> ProfileSpec {
        ProfileSpec {
            root: root.to_owned(),
            write: vec!["src/**".into()],
            write_deny: vec!["tests/**".into(), "src/**/*.snap".into()],
            read_deny: vec!["**/.env*".into()],
            network: Network::Deny,
            extra_write: vec![],
        }
    }

    fn rule_of(d: Decision) -> Option<String> {
        match d {
            Decision::Allow => None,
            Decision::Deny { rule, .. } => Some(rule),
        }
    }

    #[test]
    fn write_allow_and_deny_rules() {
        let t = setup();
        let p = Profile::from_spec(spec(&t.root)).unwrap();
        let w = |s: &str| rule_of(p.decide(Op::Write, Path::new(s)).unwrap());
        assert_eq!(w("src/a.ts"), None);
        assert_eq!(w("src/deep/er/a.ts"), None);
        assert_eq!(w("tests/a.ts"), Some("tests/**".into()));
        assert_eq!(w("tests"), Some("tests/**".into()));
        assert_eq!(w("src/x/a.snap"), Some("src/**/*.snap".into()));
        assert_eq!(w("README.md"), Some(RULE_NO_WRITE_RULE.into()));
        assert_eq!(w(""), Some(RULE_NO_WRITE_RULE.into()));
        assert_eq!(w("../x"), Some(RULE_OUTSIDE_ROOT.into()));
        assert_eq!(w("/etc/passwd"), Some(RULE_OUTSIDE_ROOT.into()));
    }

    #[test]
    fn star_does_not_cross_separator() {
        let t = setup();
        let mut s = spec(&t.root);
        s.write = vec!["src/*".into()];
        let p = Profile::from_spec(s).unwrap();
        assert_eq!(
            p.decide(Op::Write, Path::new("src/a.ts")).unwrap(),
            Decision::Allow
        );
        assert!(p.decide(Op::Write, Path::new("src/d/a.ts")).unwrap() != Decision::Allow);
    }

    #[test]
    fn deny_is_case_insensitive() {
        let t = setup();
        let p = Profile::from_spec(spec(&t.root)).unwrap();
        // Missing dir with odd case: canonicalization cannot fix it, globs must.
        let mut s = spec(&t.root);
        s.write = vec!["**".into()];
        let p2 = Profile::from_spec(s).unwrap();
        assert!(rule_of(p2.decide(Op::Write, Path::new("TESTS/a.ts")).unwrap()).is_some());
        assert!(rule_of(p.decide(Op::Read, Path::new("src/.ENV")).unwrap()).is_some());
    }

    #[test]
    fn env_read_deny_root_subdir_and_outside() {
        let t = setup();
        let p = Profile::from_spec(spec(&t.root)).unwrap();
        let r = |s: &Path| rule_of(p.decide(Op::Read, s).unwrap());
        assert_eq!(r(Path::new(".env")), Some("**/.env*".into()));
        assert_eq!(r(Path::new("src/a/.env.local")), Some("**/.env*".into()));
        assert_eq!(r(&t.base.join(".env")), Some("**/.env*".into()));
        assert_eq!(r(Path::new("src/env.ts")), None);
        assert_eq!(r(Path::new("/etc/hosts")), None);
    }

    #[test]
    fn extra_write_allows_but_write_deny_still_wins() {
        let t = setup();
        let extra = t.base.join("scratch");
        let mut s = spec(&t.root);
        s.extra_write = vec![extra.clone()];
        s.write_deny.push(format!("{}/locked/**", extra.display()));
        let p = Profile::from_spec(s).unwrap();
        assert_eq!(
            p.decide(Op::Write, &extra.join("a")).unwrap(),
            Decision::Allow
        );
        assert!(p.decide(Op::Write, &extra.join("locked/a")).unwrap() != Decision::Allow);
        assert!(p.decide(Op::Write, &t.base.join("scratchy")).unwrap() != Decision::Allow);
    }

    #[test]
    fn missing_dot_git_case_variant_is_write_denied() {
        let t = setup();
        let mut s = spec(&t.root);
        s.write = vec!["**".into()];
        let p = Profile::from_spec(s).unwrap();
        let d = p.decide(Op::Write, Path::new(".GIT/config")).unwrap();
        assert_eq!(rule_of(d), Some(RULE_GITDIR.into()));
        assert!(starts_with_ignore_ascii_case(
            Path::new("/a/B/c"),
            Path::new("/A/b")
        ));
        assert!(!starts_with_ignore_ascii_case(
            Path::new("/a/bc"),
            Path::new("/a/b")
        ));
    }

    #[test]
    fn dot_git_dir_is_write_denied() {
        let t = setup();
        fs::create_dir_all(t.root.join(".git/hooks")).unwrap();
        let mut s = spec(&t.root);
        s.write = vec!["**".into()];
        let p = Profile::from_spec(s).unwrap();
        let d = p
            .decide(Op::Write, Path::new(".git/hooks/pre-commit"))
            .unwrap();
        assert_eq!(rule_of(d), Some(RULE_GITDIR.into()));
        assert_eq!(
            p.decide(Op::Read, Path::new(".git/config")).unwrap(),
            Decision::Allow
        );
    }

    #[test]
    fn absolute_glob_prefix_is_canonicalized() {
        let t = setup();
        std::os::unix::fs::symlink(&t.root, t.base.join("alias")).unwrap();
        let mut s = spec(&t.root);
        s.read_deny = vec![format!("{}/src/**", t.base.join("alias").display())];
        let p = Profile::from_spec(s).unwrap();
        assert!(p.decide(Op::Read, Path::new("src/a.ts")).unwrap() != Decision::Allow);
        assert_eq!(
            p.decide(Op::Read, Path::new("tests/a.ts")).unwrap(),
            Decision::Allow
        );
    }

    #[test]
    fn invalid_specs_are_rejected() {
        let t = setup();
        let mut s = spec(&t.root);
        s.root = PathBuf::from("root");
        assert!(Profile::from_spec(s).is_err());

        let mut s = spec(&t.root);
        s.root = t.base.join("missing");
        assert!(Profile::from_spec(s).is_err());

        let mut s = spec(&t.root);
        s.extra_write = vec![PathBuf::from("rel")];
        assert!(Profile::from_spec(s).is_err());

        let mut s = spec(&t.root);
        s.write_deny = vec!["[".into()];
        assert!(Profile::from_spec(s).is_err());

        let mut s = spec(&t.root);
        s.write_deny = vec!["".into()];
        assert!(Profile::from_spec(s).is_err());
    }

    #[test]
    fn json_is_strict() {
        let ok = r#"{"root":"/","write":[],"writeDeny":[],"readDeny":[],"network":"registry","extraWrite":[]}"#;
        let s: ProfileSpec = serde_json::from_str(ok).unwrap();
        assert_eq!(s.network, Network::Registry);
        let unknown = ok.replace("\"extraWrite\"", "\"extra_write\"");
        assert!(serde_json::from_str::<ProfileSpec>(&unknown).is_err());
        let missing = r#"{"root":"/","write":[],"writeDeny":[],"network":"deny","extraWrite":[]}"#;
        assert!(serde_json::from_str::<ProfileSpec>(missing).is_err());
    }
}
