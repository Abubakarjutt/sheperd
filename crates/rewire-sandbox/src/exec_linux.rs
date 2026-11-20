//! Linux bubblewrap argv for `exec`.
//!
//! Layout: the whole filesystem read-only, private /dev, /proc and /tmp,
//! `root` and existing `extraWrite` dirs bound read-write, then every
//! existing writeDeny/git match re-bound read-only on top, then readDeny
//! masked (`--tmpfs` over dirs, `/dev/null` over files). Matches are found
//! by walking `root` (and each extraWrite dir) once at exec time; together
//! with `exec` creating missing `<dir>/**` deny dirs first, that covers
//! files created later under denied directories.
//!
//! Known limits vs. macOS (documented in the task-4 report):
//! - writes inside root that match no `write` glob are NOT blocked here
//!   (only the path layer narrows them); writeDeny/git/readDeny are.
//! - a `.git` (or deny match) that does not exist at exec time cannot be
//!   bind-mounted, so a newly created nested `.git` is not protected.
//! - `**/x` readDeny is masked only inside root/extraWrite, not system-wide.
//!
//! Compiled on every platform so it stays unit-tested everywhere.

use crate::exec::absolute_prefix;
use crate::profile::{Anchor, Network, Profile};
use anyhow::{bail, Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

/// Refuse to walk trees bigger than this rather than silently stop.
const MAX_WALK_ENTRIES: usize = 2_000_000;

#[derive(Debug, Default, PartialEq, Eq)]
struct Masks {
    read_only: Vec<PathBuf>,
    hide_dirs: Vec<PathBuf>,
    hide_files: Vec<PathBuf>,
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn build_bwrap_argv(p: &Profile, cwd: &Path, cmd: &[String]) -> Result<Vec<String>> {
    if cmd.is_empty() {
        bail!("no command");
    }
    let masks = collect_masks(p)?;
    let mut argv: Vec<String> = vec![
        "--die-with-parent".into(),
        "--new-session".into(),
        // Own pid namespace: when bwrap dies, everything inside dies too,
        // so a timeout kill cannot leave grandchildren behind.
        "--unshare-pid".into(),
    ];
    if p.network() != Network::Registry {
        argv.push("--unshare-net".into());
    }
    for a in [
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/tmp",
    ] {
        argv.push(a.into());
    }
    let mut bind = |flag: &str, src: &Path, dst: &Path| -> Result<()> {
        argv.push(flag.into());
        argv.push(utf8(src)?.into());
        argv.push(utf8(dst)?.into());
        Ok(())
    };
    bind("--bind", p.root(), p.root())?;
    for d in p.extra_write() {
        if d.is_dir() {
            bind("--bind", d, d)?;
        }
    }
    for ro in &masks.read_only {
        bind("--ro-bind", ro, ro)?;
    }
    for f in &masks.hide_files {
        bind("--ro-bind", Path::new("/dev/null"), f)?;
    }
    for d in &masks.hide_dirs {
        argv.push("--tmpfs".into());
        argv.push(utf8(d)?.into());
    }
    argv.push("--chdir".into());
    argv.push(utf8(cwd)?.into());
    argv.push("--".into());
    argv.extend(cmd.iter().cloned());
    Ok(argv)
}

fn collect_masks(p: &Profile) -> Result<Masks> {
    let mut m = Masks::default();
    let mut budget = MAX_WALK_ENTRIES;
    // Git metadata that exists (possibly outside root, e.g. a worktree's
    // gitdir) is read-only regardless of the walk.
    for g in p.git_paths() {
        if fs::symlink_metadata(g).is_ok() {
            m.read_only.push(g.clone());
        }
    }
    let mut bases = vec![p.root().to_path_buf()];
    bases.extend(p.extra_write().iter().filter(|d| d.is_dir()).cloned());
    for b in &bases {
        walk(p, b, &mut m, &mut budget)?;
    }
    // Absolute readDeny globs outside the walked trees: mask what exists.
    for (anchor, glob) in p.read_deny_sources() {
        if anchor != Anchor::Abs {
            continue;
        }
        let Some((prefix, _)) = absolute_prefix(p.root(), anchor, glob) else {
            continue;
        };
        if bases.iter().any(|b| prefix.starts_with(b)) || fs::symlink_metadata(&prefix).is_err() {
            continue;
        }
        walk_read_only(p, &prefix, &mut m, &mut budget)?;
    }
    m.read_only.sort();
    m.read_only.dedup();
    Ok(m)
}

/// Walk `dir` without following symlinks. A deny match is recorded and not
/// descended into (the mount covers its subtree).
fn walk(p: &Profile, dir: &Path, m: &mut Masks, budget: &mut usize) -> Result<()> {
    for entry in fs::read_dir(dir).with_context(|| format!("reading {}", dir.display()))? {
        let path = entry?.path();
        *budget = budget.checked_sub(1).context("tree too large to sandbox")?;
        if classify(p, &path, m)? {
            continue;
        }
        let meta = fs::symlink_metadata(&path)?;
        if meta.is_dir() {
            walk(p, &path, m, budget)?;
        }
    }
    Ok(())
}

/// Same as [`walk`] but only for readDeny (outside the writable trees).
fn walk_read_only(p: &Profile, start: &Path, m: &mut Masks, budget: &mut usize) -> Result<()> {
    if hide_if_read_denied(p, start, m)? {
        return Ok(());
    }
    if !fs::symlink_metadata(start)?.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(start).with_context(|| format!("reading {}", start.display()))? {
        let path = entry?.path();
        *budget = budget.checked_sub(1).context("tree too large to sandbox")?;
        walk_read_only(p, &path, m, budget)?;
    }
    Ok(())
}

/// Record a mask for `path` if a rule hits it; true = handled.
fn classify(p: &Profile, path: &Path, m: &mut Masks) -> Result<bool> {
    // Secrecy first: a hidden path is also not writable on the host.
    if hide_if_read_denied(p, path, m)? {
        return Ok(true);
    }
    let r = p
        .resolve(path)
        .with_context(|| format!("resolving {}", path.display()))?;
    let spellings: Vec<&Path> = r.spellings.iter().map(PathBuf::as_path).collect();
    if p.write_denial(&spellings).is_some() {
        m.read_only.push(path.to_path_buf());
        return Ok(true);
    }
    Ok(false)
}

fn hide_if_read_denied(p: &Profile, path: &Path, m: &mut Masks) -> Result<bool> {
    let r = p
        .resolve(path)
        .with_context(|| format!("resolving {}", path.display()))?;
    let spellings: Vec<&Path> = r.spellings.iter().map(PathBuf::as_path).collect();
    if p.read_denial(&spellings).is_none() {
        return Ok(false);
    }
    if fs::metadata(path).is_ok_and(|md| md.is_dir()) {
        m.hide_dirs.push(path.to_path_buf());
    } else {
        m.hide_files.push(path.to_path_buf());
    }
    Ok(true)
}

fn utf8(p: &Path) -> Result<&str> {
    p.to_str()
        .with_context(|| format!("non-UTF-8 path {}", p.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::ProfileSpec;
    use tempfile::TempDir;

    fn fixture(network: Network) -> (TempDir, PathBuf, Profile) {
        let t = TempDir::new().unwrap();
        let root = fs::canonicalize(t.path()).unwrap();
        fs::create_dir_all(root.join("src/sub/.git")).unwrap();
        fs::create_dir_all(root.join("tests")).unwrap();
        fs::create_dir_all(root.join("secret")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join("src/a.ts"), "").unwrap();
        fs::write(root.join("src/.env"), "").unwrap();
        fs::write(root.join("src/x.snap"), "").unwrap();
        let p = Profile::from_spec(ProfileSpec {
            root: root.clone(),
            write: vec!["src/**".into()],
            write_deny: vec!["tests/**".into(), "**/*.snap".into()],
            read_deny: vec!["secret/**".into(), "**/.env*".into()],
            network,
            extra_write: vec![],
        })
        .unwrap();
        (t, root, p)
    }

    fn s(p: &Path) -> String {
        p.to_str().unwrap().to_owned()
    }

    fn has_seq(argv: &[String], seq: &[String]) -> bool {
        argv.windows(seq.len()).any(|w| w == seq)
    }

    #[test]
    fn argv_layout() {
        let (_t, root, p) = fixture(Network::Deny);
        let cmd = vec!["sh".to_string(), "-c".into(), "true".into()];
        let argv = build_bwrap_argv(&p, &root.join("src"), &cmd).unwrap();
        let v = |xs: &[&str]| xs.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert!(has_seq(
            &argv,
            &v(&[
                "--ro-bind",
                "/",
                "/",
                "--dev",
                "/dev",
                "--proc",
                "/proc",
                "--tmpfs",
                "/tmp"
            ])
        ));
        let rw = vec!["--bind".to_string(), s(&root), s(&root)];
        assert!(has_seq(&argv, &rw));
        for d in [
            root.join("tests"),
            root.join(".git"),
            root.join("src/sub/.git"),
            root.join("src/x.snap"),
        ] {
            assert!(
                has_seq(&argv, &["--ro-bind".into(), s(&d), s(&d)]),
                "{d:?} {argv:?}"
            );
        }
        assert!(has_seq(&argv, &["--tmpfs".into(), s(&root.join("secret"))]));
        assert!(has_seq(
            &argv,
            &[
                "--ro-bind".into(),
                "/dev/null".into(),
                s(&root.join("src/.env"))
            ]
        ));
        assert!(!argv.contains(&s(&root.join("src/a.ts"))));
        assert!(argv.contains(&"--unshare-net".to_string()));
        assert!(argv.contains(&"--die-with-parent".to_string()));
        assert!(argv.contains(&"--new-session".to_string()));
        // Root bind precedes the ro re-binds, which precede the command.
        let rw_at = argv.iter().position(|a| a == "--bind").unwrap();
        let ro_tests = argv
            .iter()
            .position(|a| *a == s(&root.join("tests")))
            .unwrap();
        assert!(ro_tests > rw_at);
        let sep = argv.iter().position(|a| a == "--").unwrap();
        assert_eq!(&argv[sep + 1..], &cmd[..]);
        assert!(has_seq(&argv, &["--chdir".into(), s(&root.join("src"))]));
    }

    #[test]
    fn registry_keeps_network() {
        let (_t, root, p) = fixture(Network::Registry);
        let argv = build_bwrap_argv(&p, &root, &["true".into()]).unwrap();
        assert!(!argv.contains(&"--unshare-net".to_string()));
    }

    #[test]
    fn empty_command_is_an_error() {
        let (_t, root, p) = fixture(Network::Deny);
        assert!(build_bwrap_argv(&p, &root, &[]).is_err());
    }
}
