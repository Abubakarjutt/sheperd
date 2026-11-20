//! macOS Seatbelt (SBPL) policy for `exec`.
//!
//! Structure informed by openai/codex `seatbelt_base_policy.sbpl`
//! (Apache-2.0): start from `(deny default)`, allow the minimum needed for
//! `sh`/`node` to run, allow reads system-wide minus `readDeny`, allow
//! writes only where the profile does, then place every write denial AFTER
//! the allows (later rules win in SBPL).
//!
//! Probed on Darwin 27 (see task-4 report):
//! - `(regex #"(?i)…")` is rejected ("unexpected ^ operator"), so deny
//!   regexes spell ASCII letters as `[tT]` classes. Seatbelt on APFS also
//!   matched case/Unicode variants of existing and missing paths itself;
//!   the classes are belt and braces. Non-ASCII folding (`teſts`) relies on
//!   that filesystem-aware matching plus the deny dir existing.
//! - `(remote tcp "registry.npmjs.org:443")` is rejected ("host must be * or
//!   localhost"), so `network: "registry"` is approximated as ANY host on
//!   tcp/443 plus DNS. NETWORK EXCEPTION: report this in evidence.
//! - Renaming a parent of a denied dir moves the dir out from under a path
//!   rule, so every deny prefix and all its ancestors get a `(literal …)`
//!   write denial (blocks rename/unlink of the dir node itself; creating
//!   children is still allowed by the allows).
//!
//! Compiled on every platform so it stays unit-tested everywhere.

use crate::exec::absolute_prefix;
use crate::profile::{Anchor, Network, Profile};
use anyhow::{bail, Context, Result};
use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// The allows every sandboxed command gets, each with its reason.
const BASE_POLICY: &str = r#"(version 1)
(deny default)
; Run the command and anything it spawns (sh -c, node, npm scripts).
(allow process-exec)
(allow process-fork)
; Signals only within this sandbox (job control, kill of own children).
(allow signal (target same-sandbox))
; Read-only kernel info (hw.ncpu, kern.osversion) used by libc and node.
(allow sysctl-read)
; Reads are system-wide; readDeny is carved out below.
(allow file-read*)
"#;

/// Character devices every program writes to. `/dev/fd/N` are fds the
/// process already holds (incl. /dev/stdout, /dev/stderr).
const DEVICE_WRITES: &str = r#"(allow file-write* (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/fd/[0-9]+$"))
"#;

pub fn build_sbpl(p: &Profile) -> Result<String> {
    let root = p.root();
    let mut out = String::from(BASE_POLICY);

    // readDeny: carve out of the system-wide read allow.
    let mut read_deny = Vec::new();
    for (anchor, glob) in p.read_deny_sources() {
        read_deny.push(regex_filter(&source_regex(root, anchor, glob, true)?)?);
    }
    emit(&mut out, "deny file-read*", &read_deny);

    out.push_str(DEVICE_WRITES);

    // Writes inside root, narrowed by the `write` globs.
    let root_lit = sbpl_string(root)?;
    let mut writes = Vec::new();
    for (anchor, glob) in p.write_sources() {
        let re = regex_filter(&source_regex(root, anchor, glob, false)?)?;
        writes.push(format!("(require-all (subpath {root_lit}) {re})"));
    }
    emit(&mut out, "allow file-write*", &writes);

    let mut extra = Vec::new();
    for d in p.extra_write() {
        extra.push(format!("(subpath {})", sbpl_string(d)?));
    }
    emit(&mut out, "allow file-write*", &extra);

    // Every write denial, after all write allows.
    out.push_str("; Denials below override the allows above.\n");
    let mut deny = Vec::new();
    // writeDeny, and readDeny too: writing/renaming/linking a secret is
    // how it would be laundered to a readable name.
    for (anchor, glob) in p
        .write_deny_sources()
        .into_iter()
        .chain(p.read_deny_sources())
    {
        deny.push(regex_filter(&source_regex(root, anchor, glob, true)?)?);
    }
    // Git metadata, same as the path layer's `<gitdir>`.
    for g in p.git_paths() {
        deny.push(format!("(subpath {})", sbpl_string(g)?));
        deny.push(regex_filter(&format!(
            "^{}(/.*)?$",
            escape_re(utf8(g)?, true)
        ))?);
    }
    for base in std::iter::once(root).chain(p.extra_write().iter().map(PathBuf::as_path)) {
        let re = format!(
            "^{}/(.*/)?{}(/.*)?$",
            escape_re(utf8(base)?, true),
            escape_re(".git", true)
        );
        deny.push(regex_filter(&re)?);
    }
    // The dir nodes of every deny prefix and their ancestors (anti-rename).
    for a in deny_anchors(p)? {
        deny.push(format!("(literal {})", sbpl_string(&a)?));
        deny.push(regex_filter(&format!("^{}$", escape_re(utf8(&a)?, true)))?);
    }
    emit(&mut out, "deny file-write*", &deny);

    match p.network() {
        Network::Deny => out.push_str("(deny network*)\n"),
        Network::Registry => out.push_str(
            "; network \"registry\": Seatbelt only accepts `*`/localhost hosts, so this\n\
             ; allows ANY host on tcp/443 (not just registry.npmjs.org) plus DNS.\n\
             (allow network-outbound (remote tcp \"*:443\"))\n\
             (allow network-outbound (remote udp \"*:53\") (remote tcp \"*:53\"))\n\
             ; getaddrinfo goes through mDNSResponder's unix socket.\n\
             (allow network-outbound (literal \"/private/var/run/mDNSResponder\"))\n",
        ),
    }
    Ok(out)
}

/// Emit `(<head> f1 f2 …)` — never with zero filters, which would mean
/// "everything" (an unfiltered `(allow file-write*)` allows all writes).
fn emit(out: &mut String, head: &str, filters: &[String]) {
    if filters.is_empty() {
        return;
    }
    let _ = write!(out, "({head}");
    for f in filters {
        let _ = write!(out, "\n  {f}");
    }
    out.push_str(")\n");
}

/// Every literal deny prefix (canonical and as written) and all ancestors.
fn deny_anchors(p: &Profile) -> Result<BTreeSet<PathBuf>> {
    let mut bases = Vec::new();
    for (anchor, glob) in p
        .write_deny_sources()
        .into_iter()
        .chain(p.read_deny_sources())
    {
        if let Some((dir, _)) = absolute_prefix(p.root(), anchor, glob) {
            bases.push(dir);
        }
    }
    bases.extend(p.git_paths().iter().cloned());
    let mut out = BTreeSet::new();
    for b in bases {
        let canonical = crate::canonical::canonicalize_maybe_missing(&b)
            .with_context(|| format!("canonicalizing {}", b.display()))?;
        for path in [crate::canonical::normalize_lexically(&b), canonical] {
            out.extend(path.ancestors().map(Path::to_path_buf));
        }
    }
    Ok(out)
}

/// Anchored regex for one glob source. Relative sources sit under root.
pub fn source_regex(root: &Path, anchor: Anchor, glob: &str, ci: bool) -> Result<String> {
    let body = glob_to_regex(glob, ci)?;
    Ok(match anchor {
        Anchor::Rel => format!("^{}/{body}$", escape_re(utf8(root)?, ci)),
        Anchor::Abs => format!("^{body}$"),
    })
}

/// Translate a glob (globset syntax, `*` never crossing `/`) to a regex
/// body: `**/` → `(.*/)?`, trailing `/**` → `(/.*)?` (also matches the dir
/// itself), bare `**` → `.*`, `*` → `[^/]*`, `?` → `[^/]`, `{a,b}` →
/// `(a|b)`, `[..]` → class. With `ci`, ASCII letters match either case.
/// Anything ambiguous (nested braces, escapes inside classes) is an error.
pub fn glob_to_regex(glob: &str, ci: bool) -> Result<String> {
    let chars: Vec<char> = glob.chars().collect();
    let n = chars.len();
    let mut out = String::new();
    let mut in_brace = false;
    let mut i = 0;
    while i < n {
        let c = chars[i];
        match c {
            '*' if chars.get(i + 1) == Some(&'*') => {
                let seg_start = i == 0 || chars[i - 1] == '/';
                let seg_end = i + 2 == n || chars[i + 2] == '/';
                if seg_start && seg_end && !in_brace {
                    if i + 2 == n {
                        if out.ends_with('/') {
                            out.pop();
                            out.push_str("(/.*)?");
                        } else {
                            out.push_str(".*");
                        }
                        i += 2;
                    } else {
                        out.push_str("(.*/)?");
                        i += 3;
                    }
                } else {
                    out.push_str("[^/]*");
                    i += 2;
                }
            }
            '*' => {
                out.push_str("[^/]*");
                i += 1;
            }
            '?' => {
                out.push_str("[^/]");
                i += 1;
            }
            '[' => {
                let (class, next) = class_to_regex(&chars, i, ci)
                    .with_context(|| format!("unsupported character class in glob {glob:?}"))?;
                out.push_str(&class);
                i = next;
            }
            '{' => {
                if in_brace {
                    bail!("nested braces unsupported in glob {glob:?}");
                }
                in_brace = true;
                out.push('(');
                i += 1;
            }
            ',' if in_brace => {
                out.push('|');
                i += 1;
            }
            '}' if in_brace => {
                in_brace = false;
                out.push(')');
                i += 1;
            }
            '\\' => {
                let lit = chars
                    .get(i + 1)
                    .with_context(|| format!("dangling escape in glob {glob:?}"))?;
                out.push_str(&escape_re(&lit.to_string(), ci));
                i += 2;
            }
            _ => {
                out.push_str(&escape_re(&c.to_string(), ci));
                i += 1;
            }
        }
    }
    if in_brace {
        bail!("unclosed brace in glob {glob:?}");
    }
    Ok(out)
}

/// Translate `[...]` starting at `chars[start]`; returns the class and the
/// index after `]`. Negated classes never match `/` (like globset).
fn class_to_regex(chars: &[char], start: usize, ci: bool) -> Result<(String, usize)> {
    let mut i = start + 1;
    let negated = matches!(chars.get(i), Some('!' | '^'));
    if negated {
        i += 1;
    }
    let mut members: Vec<char> = Vec::new();
    let first = i;
    loop {
        let c = *chars.get(i).context("unclosed [")?;
        if c == ']' && i > first {
            break;
        }
        if matches!(c, '\\' | '[' | '"') {
            bail!("{c:?} inside a character class");
        }
        members.push(c);
        i += 1;
    }
    let swap = |x: char| {
        if x.is_ascii_lowercase() {
            x.to_ascii_uppercase()
        } else {
            x.to_ascii_lowercase()
        }
    };
    let mut body = String::new();
    let mut dash = false;
    let mut j = 0;
    while j < members.len() {
        let c = members[j];
        if j + 2 < members.len() && members[j + 1] == '-' {
            let (lo, hi) = (c, members[j + 2]);
            let _ = write!(body, "{lo}-{hi}");
            if ci && lo.is_ascii_alphabetic() && hi.is_ascii_alphabetic() {
                let _ = write!(body, "{}-{}", swap(lo), swap(hi));
            }
            j += 3;
            continue;
        }
        if c == '-' {
            dash = true;
        } else {
            body.push(c);
            if ci && c.is_ascii_alphabetic() {
                body.push(swap(c));
            }
        }
        j += 1;
    }
    if dash {
        // A literal '-' goes last so it is never read as a range.
        body.push('-');
    }
    if body.is_empty() {
        bail!("empty character class");
    }
    let class = if negated {
        format!("[^/{body}]")
    } else {
        format!("[{body}]")
    };
    Ok((class, i + 1))
}

/// Escape regex metacharacters; with `ci`, ASCII letters become `[xX]`.
pub fn escape_re(s: &str, ci: bool) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for c in s.chars() {
        if ci && c.is_ascii_alphabetic() {
            let _ = write!(
                out,
                "[{}{}]",
                c.to_ascii_lowercase(),
                c.to_ascii_uppercase()
            );
        } else if ".^$|()[]{}*+?\\".contains(c) {
            out.push('\\');
            out.push(c);
        } else {
            out.push(c);
        }
    }
    out
}

/// `(regex #"…")`. The raw literal cannot contain `"`; refuse instead.
fn regex_filter(re: &str) -> Result<String> {
    if re.contains('"') || re.chars().any(char::is_control) {
        bail!("cannot express {re:?} as an SBPL regex");
    }
    Ok(format!("(regex #\"{re}\")"))
}

/// A path as an SBPL string literal. Paths needing escapes are refused.
fn sbpl_string(p: &Path) -> Result<String> {
    let s = utf8(p)?;
    if s.contains(['"', '\\']) || s.chars().any(char::is_control) {
        bail!("cannot express path {s:?} in an SBPL policy");
    }
    Ok(format!("\"{s}\""))
}

fn utf8(p: &Path) -> Result<&str> {
    p.to_str()
        .with_context(|| format!("non-UTF-8 path {}", p.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::ProfileSpec;
    use std::fs;
    use tempfile::TempDir;

    fn profile(write: &[&str], write_deny: &[&str], read_deny: &[&str]) -> (TempDir, Profile) {
        let t = TempDir::new().unwrap();
        let root = fs::canonicalize(t.path()).unwrap();
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect();
        let p = Profile::from_spec(ProfileSpec {
            root,
            write: s(write),
            write_deny: s(write_deny),
            read_deny: s(read_deny),
            network: Network::Deny,
            extra_write: vec![],
        })
        .unwrap();
        (t, p)
    }

    #[test]
    fn sbpl_denies_after_allows() {
        let (_t, p) = profile(&["src/**"], &["tests/**"], &["secret/**"]);
        let sbpl = build_sbpl(&p).unwrap();
        assert!(sbpl.contains("(deny default)"));
        let allow_root = sbpl.rfind("(allow file-write*").unwrap();
        let deny = sbpl.find("(deny file-write*").unwrap();
        assert!(deny > allow_root, "{sbpl}");
        let deny_tests = sbpl.find(&escape_re("/tests", true)).unwrap();
        assert!(deny_tests > allow_root);
        let read_allow = sbpl.find("(allow file-read*)").unwrap();
        let read_deny = sbpl.find("(deny file-read*").unwrap();
        assert!(read_deny > read_allow);
        assert!(sbpl.contains("(deny network*)"));
    }

    #[test]
    fn no_rules_never_emits_unfiltered_allow() {
        let (_t, p) = profile(&[], &[], &[]);
        let sbpl = build_sbpl(&p).unwrap();
        for line in sbpl.lines() {
            let l = line.trim_end();
            assert_ne!(l, "(allow file-write*)", "{sbpl}");
            assert_ne!(l, "(deny file-read*)", "{sbpl}");
        }
        assert!(!sbpl.contains("(allow file-write*\n)"));
    }

    #[test]
    fn registry_network_allows_443_and_dns_only() {
        let t = TempDir::new().unwrap();
        let p = Profile::from_spec(ProfileSpec {
            root: fs::canonicalize(t.path()).unwrap(),
            write: vec![],
            write_deny: vec![],
            read_deny: vec![],
            network: Network::Registry,
            extra_write: vec![],
        })
        .unwrap();
        let sbpl = build_sbpl(&p).unwrap();
        assert!(sbpl.contains(r#"(remote tcp "*:443")"#));
        assert!(sbpl.contains(r#"(remote udp "*:53")"#));
        assert!(!sbpl.contains("(deny network*)"));
        assert!(!sbpl.contains("(allow network*"));
    }

    #[test]
    fn git_and_ancestors_are_denied() {
        let (_t, p) = profile(&["**"], &["src/sub/tests/**"], &[]);
        let sbpl = build_sbpl(&p).unwrap();
        let root = p.root().to_str().unwrap();
        assert!(sbpl.contains(&format!("(subpath \"{root}/.git\")")));
        for a in ["/src/sub", "/src", ""] {
            assert!(sbpl.contains(&format!("(literal \"{root}{a}\")")), "{a}");
        }
        assert!(sbpl.contains(&format!("{}(/.*)?$", escape_re("/.git", true))));
    }

    #[test]
    fn glob_translation() {
        let g = |s| glob_to_regex(s, false).unwrap();
        assert_eq!(g("src/**"), "src(/.*)?");
        assert_eq!(g("**"), ".*");
        assert_eq!(g("**/.env*"), "(.*/)?\\.env[^/]*");
        assert_eq!(g("src/**/*.snap"), "src/(.*/)?[^/]*\\.snap");
        assert_eq!(g("a?.ts"), "a[^/]\\.ts");
        assert_eq!(g("a**b"), "a[^/]*b");
        assert_eq!(g("{a,b}.ts"), "(a|b)\\.ts");
        assert_eq!(g("[!x]"), "[^/x]");
        assert_eq!(g("[a-c]"), "[a-c]");
        assert_eq!(g("a+b(c)"), "a\\+b\\(c\\)");
        assert_eq!(g("\\*"), "\\*");
        assert_eq!(glob_to_regex("Te[s]t", true).unwrap(), "[tT][eE][sS][tT]");
        assert_eq!(glob_to_regex("[a-c]", true).unwrap(), "[a-cA-C]");
        assert!(glob_to_regex("{a,{b}}", false).is_err());
        assert!(glob_to_regex("{a", false).is_err());
        assert!(glob_to_regex("[a", false).is_err());
        assert!(glob_to_regex("a\\", false).is_err());
    }

    #[test]
    fn source_regex_anchors_relative_globs_under_root() {
        let re = source_regex(Path::new("/r.x"), Anchor::Rel, "tests/**", true).unwrap();
        assert_eq!(re, "^/[rR]\\.[xX]/[tT][eE][sS][tT][sS](/.*)?$");
        let re = source_regex(Path::new("/r"), Anchor::Abs, "**/.env", false).unwrap();
        assert_eq!(re, "^(.*/)?\\.env$");
    }

    #[test]
    fn paths_needing_escapes_are_refused() {
        let t = TempDir::new().unwrap();
        let root = fs::canonicalize(t.path()).unwrap().join("we\"ird");
        fs::create_dir(&root).unwrap();
        let p = Profile::from_spec(ProfileSpec {
            root,
            write: vec!["**".into()],
            write_deny: vec![],
            read_deny: vec![],
            network: Network::Deny,
            extra_write: vec![],
        })
        .unwrap();
        assert!(build_sbpl(&p).is_err());
    }
}
