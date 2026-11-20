//! Linux bubblewrap argv for `exec` (Ruling R7).
//!
//! Layout, in mount order (later mounts cover earlier ones):
//! - `--unshare-all` (`--share-net` only for `network: "registry"`),
//!   `--die-with-parent`, `--new-session`, `--clearenv` + `--setenv` for the
//!   scrubbed allowlist (see `exec::scrubbed_env`).
//! - `--ro-bind / /`, private `/dev`, `/proc`, `/tmp`.
//! - `--tmpfs` over `/run`, `/var/run` and `$XDG_RUNTIME_DIR` (real dirs
//!   only): host unix sockets (docker.sock, ssh-agent, dbus) are hidden.
//! - `--ro-bind root root` (root may live under the private /tmp).
//! - `--bind` (rw) only the literal prefixes of the `write` globs inside
//!   root, and existing `extraWrite` dirs.
//! - `--ro-bind` every existing writeDeny match and git path found by
//!   walking root (and extraWrite) once, and root's gitdir/commondir.
//! - readDeny masked: `--tmpfs` over dirs, `/dev/null` over files.
//!
//! Bind mounts follow the dentry, so renaming a parent of a ro/masked
//! mount does not unprotect it.
//!
//! KNOWN LINUX LIMITATIONS (bind mounts on a case-sensitive FS):
//! - write narrowing is per literal prefix: `src/**/*.ts` binds all of
//!   `src` rw (writeDeny inside it still applies to existing matches);
//! - a writeDeny/readDeny match or nested `.git` CREATED after the sandbox
//!   starts (or renamed into a matching name) is not protected; existing
//!   matches and pre-created deny-glob literal dirs are;
//! - no case-variant protection (`TESTS` is a different dir on ext4);
//! - `**/x` readDeny is masked only inside root/extraWrite;
//! - `network: "registry"` shares the host network unrestricted;
//! - the walk of root runs on every exec (cost grows with node_modules).
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

/// Directories holding host IPC sockets, hidden behind a tmpfs.
fn runtime_dirs() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = vec!["/run".into(), "/var/run".into()];
    if let Some(x) = std::env::var_os("XDG_RUNTIME_DIR") {
        v.push(PathBuf::from(x));
    }
    let mut out: Vec<PathBuf> = Vec::new();
    for d in v {
        // Only real directories (a symlinked /var/run -> /run is covered).
        let real_dir = fs::symlink_metadata(&d).is_ok_and(|m| m.is_dir());
        if real_dir && d.is_absolute() && !out.iter().any(|o| d.starts_with(o)) {
            out.push(d);
        }
    }
    out
}

/// Canonical rw bind targets: the literal prefixes of `write` globs that
/// exist inside root (a prefix-less glob such as `**` binds root itself),
/// as a minimal set (no target below another).
fn write_binds(p: &Profile) -> Result<Vec<PathBuf>> {
    let root = p.root();
    let mut all = Vec::new();
    for (anchor, glob) in p.write_sources() {
        let dir = match absolute_prefix(root, anchor, glob) {
            Some((d, _)) => d,
            None => root.to_path_buf(),
        };
        let c = crate::canonical::canonicalize_maybe_missing(&dir)
            .with_context(|| format!("canonicalizing {}", dir.display()))?;
        if c.starts_with(root) && fs::symlink_metadata(&c).is_ok() {
            all.push(c);
        }
    }
    all.sort();
    let mut out: Vec<PathBuf> = Vec::new();
    for c in all {
        if !out.iter().any(|o| c.starts_with(o)) {
            out.push(c);
        }
    }
    Ok(out)
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn build_bwrap_argv(
    p: &Profile,
    cwd: &Path,
    cmd: &[String],
    env: &[(String, String)],
) -> Result<Vec<String>> {
    if cmd.is_empty() {
        bail!("no command");
    }
    let masks = collect_masks(p)?;
    let mut argv: Vec<String> = vec!["--unshare-all".into()];
    if p.network() == Network::Registry {
        argv.push("--share-net".into());
    }
    // The pid namespace from --unshare-all dies with bwrap, taking every
    // descendant with it; --new-session blocks TIOCSTI into our terminal.
    for a in ["--die-with-parent", "--new-session", "--clearenv"] {
        argv.push(a.into());
    }
    for (k, v) in env {
        argv.extend(["--setenv".into(), k.clone(), v.clone()]);
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
    for d in runtime_dirs() {
        argv.push("--tmpfs".into());
        argv.push(utf8(&d)?.into());
    }
    let mut bind = |flag: &str, src: &Path, dst: &Path| -> Result<()> {
        argv.push(flag.into());
        argv.push(utf8(src)?.into());
        argv.push(utf8(dst)?.into());
        Ok(())
    };
    bind("--ro-bind", p.root(), p.root())?;
    for w in write_binds(p)? {
        bind("--bind", &w, &w)?;
    }
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

    fn env() -> Vec<(String, String)> {
        vec![("PATH".into(), "/usr/bin:/bin".into())]
    }

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
            write: vec!["src/**".into(), "missing/**".into(), "src/sub/*.ts".into()],
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

    fn v(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|x| x.to_string()).collect()
    }

    fn has_seq(argv: &[String], seq: &[String]) -> bool {
        argv.windows(seq.len()).any(|w| w == seq)
    }

    fn pos(argv: &[String], seq: &[String]) -> usize {
        argv.windows(seq.len())
            .position(|w| w == seq)
            .unwrap_or_else(|| panic!("{seq:?} not in {argv:?}"))
    }

    #[test]
    fn argv_layout() {
        let (_t, root, p) = fixture(Network::Deny);
        let cmd = v(&["sh", "-c", "true"]);
        let argv = build_bwrap_argv(&p, &root.join("src"), &cmd, &env()).unwrap();
        assert_eq!(argv[0], "--unshare-all");
        assert!(!argv.contains(&"--share-net".to_string()));
        assert!(argv.contains(&"--die-with-parent".to_string()));
        assert!(argv.contains(&"--new-session".to_string()));
        assert!(has_seq(
            &argv,
            &v(&["--clearenv", "--setenv", "PATH", "/usr/bin:/bin"])
        ));
        let base = pos(
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
                "/tmp",
            ]),
        );
        // Root read-only; only the existing write prefix `src` read-write
        // (`missing` is not bound, `src/sub` is covered by `src`).
        let ro_root = pos(&argv, &["--ro-bind".into(), s(&root), s(&root)]);
        let src = root.join("src");
        let rw_src = pos(&argv, &["--bind".into(), s(&src), s(&src)]);
        assert_eq!(
            argv.iter().filter(|a| *a == "--bind").count(),
            1,
            "{argv:?}"
        );
        assert!(!argv.contains(&s(&root.join("missing"))));
        assert!(base < ro_root && ro_root < rw_src);
        // Deny matches re-bound read-only after the rw bind.
        for d in [
            root.join("tests"),
            root.join(".git"),
            root.join("src/sub/.git"),
            root.join("src/x.snap"),
        ] {
            assert!(
                pos(&argv, &["--ro-bind".into(), s(&d), s(&d)]) > rw_src,
                "{d:?}"
            );
        }
        assert!(pos(&argv, &["--tmpfs".into(), s(&root.join("secret"))]) > rw_src);
        assert!(has_seq(
            &argv,
            &[
                "--ro-bind".into(),
                "/dev/null".into(),
                s(&root.join("src/.env"))
            ]
        ));
        assert!(!argv.contains(&s(&root.join("src/a.ts"))));
        let sep = argv.iter().position(|a| a == "--").unwrap();
        assert_eq!(&argv[sep + 1..], &cmd[..]);
        assert!(has_seq(&argv, &["--chdir".into(), s(&root.join("src"))]));
    }

    #[test]
    fn runtime_socket_dirs_are_masked() {
        let (_t, root, p) = fixture(Network::Deny);
        let argv = build_bwrap_argv(&p, &root, &v(&["true"]), &env()).unwrap();
        for d in runtime_dirs() {
            assert!(has_seq(&argv, &["--tmpfs".into(), s(&d)]), "{d:?}");
        }
        // Only real directories, never a symlink like /var/run -> /run.
        for d in runtime_dirs() {
            assert!(fs::symlink_metadata(&d).unwrap().is_dir());
        }
    }

    #[test]
    fn registry_shares_network() {
        let (_t, root, p) = fixture(Network::Registry);
        let argv = build_bwrap_argv(&p, &root, &v(&["true"]), &env()).unwrap();
        assert!(has_seq(&argv, &v(&["--unshare-all", "--share-net"])));
    }

    #[test]
    fn empty_command_is_an_error() {
        let (_t, root, p) = fixture(Network::Deny);
        assert!(build_bwrap_argv(&p, &root, &[], &env()).is_err());
    }

    #[test]
    fn write_everything_binds_root_rw_after_ro() {
        let t = TempDir::new().unwrap();
        let root = fs::canonicalize(t.path()).unwrap();
        let p = Profile::from_spec(ProfileSpec {
            root: root.clone(),
            write: vec!["**".into()],
            write_deny: vec![],
            read_deny: vec![],
            network: Network::Deny,
            extra_write: vec![],
        })
        .unwrap();
        let argv = build_bwrap_argv(&p, &root, &v(&["true"]), &env()).unwrap();
        let ro = pos(&argv, &["--ro-bind".into(), s(&root), s(&root)]);
        let rw = pos(&argv, &["--bind".into(), s(&root), s(&root)]);
        assert!(ro < rw);
    }
}
