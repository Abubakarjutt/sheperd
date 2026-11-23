//! Sandbox profile: parsing, validation, and the allow/deny decision.
//!
//! Gitdir protection (see `canonical::git_protected_paths`) adapted from
//! openai/codex default_read_only_subpaths_for_writable_root — Apache-2.0.
//!
//! Every decision considers two spellings of the target: the *canonical*
//! path (symlinks resolved) and the *lexical* path (the caller's spelling
//! with `.`/`..` resolved textually). Deny rules fire if EITHER matches;
//! allow rules only ever look at the canonical path.
//!
//! Decision order (deny beats allow):
//! - read:  `readDeny` match → deny; otherwise allow (reads are not confined
//!   to `root`).
//! - write: git metadata (root's gitdir, or any `.git` component under root
//!   or an extraWrite dir) → deny `<gitdir>`; `writeDeny` match → deny;
//!   canonical inside an `extraWrite` dir → allow; canonical outside `root`
//!   → deny `<outside-root>`; `write` match → allow; else `<no-write-rule>`.
//! - A path that is not valid UTF-8 is denied (`<non-utf8>`) for both ops.
//!
//! Glob semantics: relative globs match the path relative to root; absolute
//! globs match the absolute path. `*` never crosses `/`. `X/**` also matches
//! `X`. Deny globs additionally:
//! - are compared after [`fold`] (NFD + full Unicode case folding + stripping
//!   combining marks) on both sides, a superset of APFS's name equivalence
//!   (`teſts` ≡ `tests`, `Keys` ≡ `keys`, `straße` ≡ `strasse`);
//! - have their literal prefix canonicalized (`tests/**` with `tests -> real`
//!   also denies `real/...`);
//! - when relative and starting with `**/`, also apply outside `root`.

use crate::canonical::{
    canonicalize_maybe_missing, canonicalize_traced, git_protected_paths, normalize_lexically,
};
use anyhow::{bail, Context, Result};
use globset::{GlobBuilder, GlobMatcher};
use serde::Deserialize;
use std::path::{Path, PathBuf};

pub const RULE_GITDIR: &str = "<gitdir>";
pub const RULE_OUTSIDE_ROOT: &str = "<outside-root>";
pub const RULE_NO_WRITE_RULE: &str = "<no-write-rule>";
pub const RULE_NON_UTF8: &str = "<non-utf8>";

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

/// Both spellings of a target path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub canonical: PathBuf,
    pub lexical: PathBuf,
    /// Every spelling deny rules are checked against: the canonical path,
    /// the lexical path (caller's spelling, `.`/`..` collapsed textually),
    /// and the walk trace from [`canonicalize_traced`]: for every name the
    /// real walk looks up, the real directory reached so far + that name +
    /// the remaining components. Textual `..` collapsing alone would HIDE
    /// symlink names the kernel walks through (`R/s/../a/data` with
    /// `s -> tests/b` really traverses `R/tests/a/data`); the trace puts
    /// every intermediate real-walk name into some spelling, including root
    /// reached through a symlinked ancestor and `..` inside link targets.
    pub spellings: Vec<PathBuf>,
}

/// Fold a name for deny-side comparison: NFD, full Unicode case folding,
/// NFD again, then drop combining marks. Two names APFS considers equal
/// always fold equal; some distinct names also fold equal (`.GİT` ≡ `.git`,
/// `café` ≡ `cafe`) — over-denial is the fail-closed direction.
pub fn fold(s: &str) -> String {
    use caseless::Caseless;
    use unicode_normalization::char::is_combining_mark;
    use unicode_normalization::UnicodeNormalization;
    s.chars()
        .filter(|c| !is_default_ignorable(*c))
        .nfd()
        .default_case_fold()
        .nfd()
        .filter(|c| !is_combining_mark(*c) && !is_default_ignorable(*c))
        .collect()
}

/// Code points HFS+ ignores in names (Git's `is_hfs_dotgit` list), plus a
/// few more invisible ones for safety. Stripped so `.git<U+200C>` ≡ `.git`.
fn is_default_ignorable(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{206A}'..='\u{206F}'
            | '\u{FEFF}'
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Anchor {
    /// Matched against the path relative to root.
    Rel,
    /// Matched against the absolute path.
    Abs,
}

/// One glob rule as written in the profile, compiled to one or more matchers.
#[derive(Debug)]
struct Rule {
    /// The glob exactly as written in the profile (reported on denial).
    name: String,
    /// The globs compiled for this rule, unfolded and before the `X/**` ⇒
    /// `X` expansion (the OS sandbox layer translates these itself).
    sources: Vec<(Anchor, String)>,
    matchers: Vec<(Anchor, GlobMatcher)>,
}

/// One spelling of a candidate path, prepared for matching.
struct Candidate {
    abs: String,
    rel: Option<String>,
}

impl Rule {
    /// Compile an allow rule: exact, case-sensitive, canonical paths only.
    fn allow(pattern: &str) -> Result<Rule> {
        Self::build(
            pattern,
            false,
            vec![(anchor_of(pattern), pattern.to_owned())],
        )
    }

    /// Compile a deny rule: folded, canonicalized literal prefix, `**/`
    /// relative rules also applied to absolute paths.
    fn deny(pattern: &str, root: &Path) -> Result<Rule> {
        let anchor = anchor_of(pattern);
        let mut sources = vec![(anchor, pattern.to_owned())];
        if anchor == Anchor::Rel && pattern.starts_with("**/") {
            sources.push((Anchor::Abs, pattern.to_owned()));
        }
        if let Some(src) = canonicalize_glob_prefix(pattern, root)? {
            if !sources.contains(&src) {
                sources.push(src);
            }
        }
        Self::build(pattern, true, sources)
    }

    fn build(pattern: &str, folded: bool, mut sources: Vec<(Anchor, String)>) -> Result<Rule> {
        if pattern.is_empty() {
            bail!("empty glob in profile");
        }
        if pattern.starts_with('~') {
            // `~` expansion is the caller's job; an unexpanded `~/` glob
            // would silently protect nothing.
            bail!("unexpanded `~` in glob {pattern:?}");
        }
        let original = sources.clone();
        // `dir/**` must also cover `dir` itself.
        for (a, s) in original.clone() {
            if let Some(dir) = s.strip_suffix("/**") {
                if !dir.is_empty() {
                    sources.push((a, dir.to_owned()));
                }
            }
        }
        let matchers = sources
            .iter()
            .map(|(a, s)| {
                let s = if folded { fold(s) } else { s.clone() };
                GlobBuilder::new(&s)
                    .literal_separator(true)
                    .build()
                    .map(|g| (*a, g.compile_matcher()))
                    .with_context(|| format!("invalid glob {pattern:?}"))
            })
            .collect::<Result<_>>()?;
        Ok(Rule {
            name: pattern.to_owned(),
            sources: original,
            matchers,
        })
    }

    fn matches(&self, c: &Candidate) -> bool {
        self.matchers.iter().any(|(a, m)| match a {
            Anchor::Abs => m.is_match(&c.abs),
            Anchor::Rel => c.rel.as_ref().is_some_and(|r| m.is_match(r)),
        })
    }
}

fn anchor_of(pattern: &str) -> Anchor {
    if pattern.starts_with('/') {
        Anchor::Abs
    } else {
        Anchor::Rel
    }
}

/// Canonicalize the literal (glob-free) directory prefix of a glob, so
/// `/var/x/**` also matches `/private/var/x/...` and, with `root/tests` a
/// symlink to `root/real`, `tests/**` also matches `real/...`. Returns the
/// extra source to compile, or `None` if canonicalizing changes nothing.
fn canonicalize_glob_prefix(pattern: &str, root: &Path) -> Result<Option<(Anchor, String)>> {
    let segments: Vec<&str> = pattern.split('/').collect();
    let first_glob = segments
        .iter()
        .position(|s| s.contains(['*', '?', '[', ']', '{', '}', '\\']))
        .unwrap_or(segments.len());
    let prefix = segments[..first_glob].join("/");
    let rest = &segments[first_glob..];
    let literal = match anchor_of(pattern) {
        Anchor::Abs if prefix.is_empty() => PathBuf::from("/"),
        Anchor::Abs => PathBuf::from(&prefix),
        Anchor::Rel if prefix.is_empty() => return Ok(None),
        Anchor::Rel => root.join(&prefix),
    };
    let canon = canonicalize_maybe_missing(&literal)
        .with_context(|| format!("canonicalizing glob prefix {prefix:?}"))?;
    if canon == normalize_lexically(&literal) {
        return Ok(None);
    }
    let (anchor, base) = match canon.strip_prefix(root) {
        Ok(rel) => (Anchor::Rel, rel.to_path_buf()),
        Err(_) => (Anchor::Abs, canon.clone()),
    };
    let base = base
        .to_str()
        .with_context(|| format!("non-UTF-8 canonical glob prefix for {pattern:?}"))?;
    let mut out = globset::escape(base);
    for seg in rest {
        if !out.is_empty() && !out.ends_with('/') {
            out.push('/');
        }
        out.push_str(seg);
    }
    Ok(Some((anchor, out)))
}

/// A validated, compiled profile. All paths held here are canonical.
#[derive(Debug)]
pub struct Profile {
    root: PathBuf,
    write: Vec<Rule>,
    write_deny: Vec<Rule>,
    read_deny: Vec<Rule>,
    extra_write: Vec<PathBuf>,
    /// Folded absolute spellings of root's git metadata paths.
    git_protected: Vec<String>,
    /// The same paths, canonical and unfolded (for the OS sandbox layer).
    git_paths: Vec<PathBuf>,
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
        let deny = |globs: &[String]| -> Result<Vec<Rule>> {
            globs.iter().map(|g| Rule::deny(g, &root)).collect()
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
        let git_paths = git_protected_paths(&root).context("resolving git metadata")?;
        let git_protected = git_paths
            .iter()
            .map(|p| {
                p.to_str()
                    .map(fold)
                    .with_context(|| format!("non-UTF-8 git path {}", p.display()))
            })
            .collect::<Result<_>>()?;
        Ok(Profile {
            write: spec
                .write
                .iter()
                .map(|g| Rule::allow(g))
                .collect::<Result<_>>()?,
            write_deny: deny(&spec.write_deny)?,
            read_deny: deny(&spec.read_deny)?,
            extra_write,
            git_protected,
            git_paths,
            network: spec.network,
            root,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn network(&self) -> Network {
        self.network
    }

    /// Canonical `extraWrite` directories.
    pub fn extra_write(&self) -> &[PathBuf] {
        &self.extra_write
    }

    /// Canonical git metadata paths of root (`.git`, gitdir, commondir).
    pub fn git_paths(&self) -> &[PathBuf] {
        &self.git_paths
    }

    /// Glob sources of the `write` allow rules.
    pub fn write_sources(&self) -> Vec<(Anchor, &str)> {
        sources_of(&self.write)
    }

    /// Glob sources of the `writeDeny` rules (incl. canonicalized prefixes).
    pub fn write_deny_sources(&self) -> Vec<(Anchor, &str)> {
        sources_of(&self.write_deny)
    }

    /// Glob sources of the `readDeny` rules (incl. canonicalized prefixes).
    pub fn read_deny_sources(&self) -> Vec<(Anchor, &str)> {
        sources_of(&self.read_deny)
    }

    /// The `readDeny` rule matching any spelling of a path, if any
    /// (non-UTF-8 counts as a match).
    pub fn read_denial(&self, spellings: &[&Path]) -> Option<String> {
        match self.deny_match(&self.read_deny, spellings) {
            Ok(m) => m.map(str::to_owned),
            Err(rule) => Some(rule.to_owned()),
        }
    }

    /// Both spellings of `path` (relative paths are taken relative to root).
    pub fn resolve(&self, path: &Path) -> std::io::Result<Resolved> {
        let joined = self.root.join(path);
        let (canonical, trace) = canonicalize_traced(&joined)?;
        let lexical = normalize_lexically(&joined);
        let mut spellings = vec![canonical.clone(), lexical.clone()];
        for t in trace {
            if !spellings.contains(&t) {
                spellings.push(t);
            }
        }
        Ok(Resolved {
            canonical,
            lexical,
            spellings,
        })
    }

    /// Decide whether `op` on `path` is permitted. I/O errors while
    /// canonicalizing are returned as errors (callers fail closed).
    pub fn decide(&self, op: Op, path: &Path) -> std::io::Result<Decision> {
        Ok(self.decide_resolved(op, &self.resolve(path)?))
    }

    pub fn decide_resolved(&self, op: Op, r: &Resolved) -> Decision {
        let deny = |rule: &str| Decision::Deny {
            canonical: r.canonical.clone(),
            rule: rule.to_owned(),
        };
        let spellings: Vec<&Path> = r.spellings.iter().map(PathBuf::as_path).collect();
        match op {
            Op::Read => match self.deny_match(&self.read_deny, &spellings) {
                Ok(Some(rule)) => deny(rule),
                Ok(None) => Decision::Allow,
                Err(rule) => deny(rule),
            },
            Op::Write => {
                if let Some(rule) = self.write_denial(&spellings) {
                    return deny(&rule);
                }
                if self.extra_write.iter().any(|d| r.canonical.starts_with(d)) {
                    return Decision::Allow;
                }
                let Ok(rel) = r.canonical.strip_prefix(&self.root) else {
                    return deny(RULE_OUTSIDE_ROOT);
                };
                // Checked UTF-8 in write_denial.
                let raw = Candidate {
                    abs: r.canonical.to_string_lossy().into_owned(),
                    rel: Some(rel.to_string_lossy().into_owned()),
                };
                if self.write.iter().any(|rule| rule.matches(&raw)) {
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

    /// The deny-only half of the write decision: non-UTF-8, git metadata,
    /// and `writeDeny`, over every given spelling. Also used for every
    /// parent directory `fs-write` creates.
    pub fn write_denial(&self, spellings: &[&Path]) -> Option<String> {
        let cands = match self.candidates(spellings) {
            Ok(c) => c,
            Err(rule) => return Some(rule.to_owned()),
        };
        if spellings.iter().any(|p| self.has_git_component(p))
            || cands.iter().any(|c| {
                self.git_protected
                    .iter()
                    .any(|g| Path::new(&c.abs).starts_with(g))
            })
        {
            return Some(RULE_GITDIR.to_owned());
        }
        first_match(&self.write_deny, &cands).map(str::to_owned)
    }

    /// A `.git` component (folded) anywhere below root or an extraWrite dir.
    fn has_git_component(&self, path: &Path) -> bool {
        std::iter::once(&self.root)
            .chain(&self.extra_write)
            .filter_map(|base| path.strip_prefix(base).ok())
            .any(|rel| {
                rel.components()
                    .any(|c| c.as_os_str().to_str().is_none_or(|s| fold(s) == ".git"))
            })
    }

    fn deny_match<'a>(
        &self,
        rules: &'a [Rule],
        spellings: &[&Path],
    ) -> std::result::Result<Option<&'a str>, &'static str> {
        Ok(first_match(rules, &self.candidates(spellings)?))
    }

    /// Fold spellings for deny matching; any non-UTF-8 spelling is a denial.
    fn candidates(&self, spellings: &[&Path]) -> std::result::Result<Vec<Candidate>, &'static str> {
        spellings
            .iter()
            .map(|p| {
                let f = |p: &Path| -> std::result::Result<String, &'static str> {
                    let s = p.to_str().ok_or(RULE_NON_UTF8)?;
                    Ok(fold(s))
                };
                Ok(Candidate {
                    abs: f(p)?,
                    rel: match p.strip_prefix(&self.root) {
                        Ok(rel) => Some(f(rel)?),
                        Err(_) => None,
                    },
                })
            })
            .collect()
    }
}

fn sources_of(rules: &[Rule]) -> Vec<(Anchor, &str)> {
    rules
        .iter()
        .flat_map(|r| r.sources.iter().map(|(a, s)| (*a, s.as_str())))
        .collect()
}

fn first_match<'a>(rules: &'a [Rule], cands: &[Candidate]) -> Option<&'a str> {
    rules
        .iter()
        .find(|r| cands.iter().any(|c| r.matches(c)))
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
        for v in [".GIT/config", ".G\u{130}T/config", "src/.Git/HEAD"] {
            let d = p.decide(Op::Write, Path::new(v)).unwrap();
            assert_eq!(rule_of(d), Some(RULE_GITDIR.into()), "{v}");
        }
    }

    #[test]
    fn fold_strips_default_ignorables() {
        assert_eq!(fold(".git\u{200c}"), ".git");
        assert_eq!(fold(".g\u{feff}i\u{202e}t"), ".git");
        assert_eq!(fold("te\u{ad}s\u{2060}ts"), "tests");
    }

    #[test]
    fn hybrid_spellings_relate_aliased_root() {
        let t = setup();
        std::os::unix::fs::symlink(&t.base, t.base.join("alias")).unwrap();
        let p = Profile::from_spec(spec(&t.root)).unwrap();
        let r = p.resolve(&t.base.join("alias/root/src/a.ts")).unwrap();
        assert!(r.spellings.contains(&t.root.join("src/a.ts")));
        assert!(r.spellings.contains(&t.base.join("alias/root/src/a.ts")));
    }

    #[test]
    fn fold_matches_apfs_equivalences() {
        assert_eq!(fold("te\u{17f}ts"), "tests");
        assert_eq!(fold("\u{212a}EYS"), "keys");
        assert_eq!(fold("Stra\u{df}e"), "strasse");
        assert_eq!(fold("caf\u{e9}"), fold("cafe\u{301}"));
        assert_eq!(fold(".G\u{130}T"), ".git");
        assert_eq!(fold("src/**/*.ts"), "src/**/*.ts");
    }

    #[test]
    fn unicode_alias_of_deny_glob_is_denied() {
        let t = setup();
        let mut s = spec(&t.root);
        s.write = vec!["**".into()];
        let p = Profile::from_spec(s).unwrap();
        let d = p.decide(Op::Write, Path::new("te\u{17f}ts/x.ts")).unwrap();
        assert_eq!(rule_of(d), Some("tests/**".into()));
    }

    #[test]
    fn lexical_spelling_is_checked_against_deny() {
        let t = setup();
        fs::remove_dir(t.root.join("tests")).unwrap();
        fs::create_dir(t.root.join("real")).unwrap();
        std::os::unix::fs::symlink("real", t.root.join("tests")).unwrap();
        let mut s = spec(&t.root);
        s.write = vec!["**".into()];
        let p = Profile::from_spec(s).unwrap();
        for v in ["tests/a.ts", "real/a.ts", "src/../tests/a.ts"] {
            let d = p.decide(Op::Write, Path::new(v)).unwrap();
            assert_eq!(rule_of(d), Some("tests/**".into()), "{v}");
        }
    }

    #[test]
    fn non_utf8_path_is_denied() {
        use std::os::unix::ffi::OsStrExt;
        let t = setup();
        let p = Profile::from_spec(spec(&t.root)).unwrap();
        let bad = Path::new(std::ffi::OsStr::from_bytes(b"src/\xff.ts"));
        assert_eq!(
            rule_of(p.decide(Op::Write, bad).unwrap()),
            Some(RULE_NON_UTF8.into())
        );
        assert_eq!(
            rule_of(p.decide(Op::Read, bad).unwrap()),
            Some(RULE_NON_UTF8.into())
        );
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

        let mut s = spec(&t.root);
        s.read_deny = vec!["~/.ssh/**".into()];
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
