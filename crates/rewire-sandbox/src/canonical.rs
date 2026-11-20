//! Canonicalization of paths that may not exist yet, and git-dir discovery.
//!
//! Gitdir pointer logic adapted from openai/codex
//! default_read_only_subpaths_for_writable_root — Apache-2.0.

use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

/// Maximum number of symlinks followed while resolving one path (matches
/// Linux's MAXSYMLINKS). Exceeding it is an error, never a silent stop.
const MAX_SYMLINK_HOPS: u32 = 40;

/// Canonicalize an absolute path whose tail may not exist.
///
/// Components are resolved one at a time: every prefix that exists is
/// canonicalized by the OS (resolving symlinks), and a missing component is
/// appended lexically. Because the prefix is always canonical, a later `..`
/// pops a *real* directory, never the textual name of a symlink. A dangling
/// symlink is resolved to the place a write through it would land.
///
/// Errors (fail closed): relative input, too many symlinks, or any I/O error
/// other than "not found" (e.g. a component under a regular file).
pub fn canonicalize_maybe_missing(path: &Path) -> io::Result<PathBuf> {
    let mut hops = 0;
    resolve(path, &mut hops)
}

fn resolve(path: &Path, hops: &mut u32) -> io::Result<PathBuf> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("path must be absolute: {}", path.display()),
        ));
    }
    let mut cur = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::Prefix(_) | Component::RootDir => cur.push(comp.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                cur.pop();
            }
            Component::Normal(name) => cur = step(&cur, name, hops)?,
        }
    }
    Ok(cur)
}

/// Resolve `cur/name` where `cur` is already canonical (or a lexical tail
/// below a missing component).
fn step(cur: &Path, name: &OsStr, hops: &mut u32) -> io::Result<PathBuf> {
    let next = cur.join(name);
    let meta = match fs::symlink_metadata(&next) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(next),
        Err(e) => return Err(e),
    };
    if !meta.file_type().is_symlink() {
        // `cur` is canonical and `name` is a real entry: no resolution needed,
        // but let the OS confirm (also normalizes case on case-insensitive FS).
        return fs::canonicalize(&next);
    }
    *hops += 1;
    if *hops > MAX_SYMLINK_HOPS {
        return Err(io::Error::other(format!(
            "too many levels of symbolic links: {}",
            next.display()
        )));
    }
    let target = fs::read_link(&next)?;
    // Relative targets are relative to the directory containing the link.
    resolve(&cur.join(target), hops)
}

/// Resolve `.` and `..` textually, without touching the filesystem. This is
/// the path as the caller *spelled* it; deny rules are checked against it as
/// well as against the canonical path, so a symlinked deny prefix cannot be
/// dodged by either spelling.
pub fn normalize_lexically(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            c => out.push(c.as_os_str()),
        }
    }
    out
}

/// Directories that must never be writable because they hold git metadata
/// for `root` (hooks, config, refs: writing there is code execution).
///
/// - `root/.git` itself (directory or worktree pointer file).
/// - If `root/.git` is a pointer file (`gitdir: <path>`), its target, plus
///   the target's `commondir` when present (the main repository's `.git`).
///
/// A pointer file that cannot be parsed is an error (fail closed).
pub fn git_protected_paths(root: &Path) -> io::Result<Vec<PathBuf>> {
    let dot_git = root.join(".git");
    let meta = match fs::symlink_metadata(&dot_git) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(vec![dot_git]),
        Err(e) => return Err(e),
    };
    let mut out = vec![dot_git.clone()];
    let resolved = canonicalize_maybe_missing(&dot_git)?;
    if resolved != dot_git {
        // `.git` is a symlink: protect what it points at as well.
        out.push(resolved.clone());
    }
    let is_file = if meta.file_type().is_symlink() {
        resolved.is_file()
    } else {
        meta.is_file()
    };
    if !is_file {
        return Ok(out);
    }
    let contents = fs::read_to_string(&resolved)?;
    let gitdir = parse_gitdir_pointer(&contents).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("malformed gitdir pointer file: {}", dot_git.display()),
        )
    })?;
    let gitdir = canonicalize_maybe_missing(&root.join(gitdir))?;
    match fs::read_to_string(gitdir.join("commondir")) {
        Ok(common) => {
            let common = common.trim_end_matches(['\n', '\r']);
            if !common.is_empty() {
                out.push(canonicalize_maybe_missing(&gitdir.join(common))?);
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    out.push(gitdir);
    Ok(out)
}

/// Parse the `gitdir: <path>` line of a worktree/submodule `.git` file.
fn parse_gitdir_pointer(contents: &str) -> Option<&str> {
    contents.lines().find_map(|line| {
        let rest = line.strip_prefix("gitdir:")?.trim();
        (!rest.is_empty()).then_some(rest)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use tempfile::TempDir;

    fn base() -> (TempDir, PathBuf) {
        let t = TempDir::new().unwrap();
        let b = fs::canonicalize(t.path()).unwrap();
        (t, b)
    }

    #[test]
    fn rejects_relative() {
        assert!(canonicalize_maybe_missing(Path::new("a/b")).is_err());
    }

    #[test]
    fn missing_tail_is_appended_lexically() {
        let (_t, b) = base();
        let got = canonicalize_maybe_missing(&b.join("x/y/z.txt")).unwrap();
        assert_eq!(got, b.join("x/y/z.txt"));
    }

    #[test]
    fn non_canonical_base_is_canonicalized() {
        let t = TempDir::new().unwrap();
        let got = canonicalize_maybe_missing(&t.path().join("new")).unwrap();
        assert_eq!(got, fs::canonicalize(t.path()).unwrap().join("new"));
    }

    #[test]
    fn dotdot_after_symlink_pops_real_parent() {
        let (_t, b) = base();
        fs::create_dir_all(b.join("real/inner")).unwrap();
        fs::create_dir_all(b.join("dir")).unwrap();
        symlink(b.join("real/inner"), b.join("dir/link")).unwrap();
        // Lexically dir/link/.. == dir; physically it is real/.
        let got = canonicalize_maybe_missing(&b.join("dir/link/../f")).unwrap();
        assert_eq!(got, b.join("real/f"));
    }

    #[test]
    fn dotdot_through_missing_then_symlink_is_resolved() {
        let (_t, b) = base();
        fs::create_dir_all(b.join("target")).unwrap();
        symlink(b.join("target"), b.join("link")).unwrap();
        let got = canonicalize_maybe_missing(&b.join("missing/../link/f")).unwrap();
        assert_eq!(got, b.join("target/f"));
    }

    #[test]
    fn dangling_symlink_resolves_to_its_target() {
        let (_t, b) = base();
        symlink("elsewhere/new.txt", b.join("dangling")).unwrap();
        let got = canonicalize_maybe_missing(&b.join("dangling")).unwrap();
        assert_eq!(got, b.join("elsewhere/new.txt"));
    }

    #[test]
    fn symlink_loop_is_an_error() {
        let (_t, b) = base();
        symlink(b.join("a"), b.join("b")).unwrap();
        symlink(b.join("b"), b.join("a")).unwrap();
        assert!(canonicalize_maybe_missing(&b.join("a/x")).is_err());
    }

    #[test]
    fn component_under_regular_file_is_an_error() {
        let (_t, b) = base();
        fs::write(b.join("file"), "x").unwrap();
        assert!(canonicalize_maybe_missing(&b.join("file/x")).is_err());
    }

    #[test]
    fn lexical_normalization() {
        assert_eq!(
            normalize_lexically(Path::new("/r/./a/../b/../../x")),
            PathBuf::from("/x")
        );
        assert_eq!(normalize_lexically(Path::new("/../..")), PathBuf::from("/"));
    }

    #[test]
    fn parse_gitdir_variants() {
        assert_eq!(parse_gitdir_pointer("gitdir: /a/b\n"), Some("/a/b"));
        assert_eq!(parse_gitdir_pointer("gitdir:../x"), Some("../x"));
        assert_eq!(parse_gitdir_pointer("gitdir:   \n"), None);
        assert_eq!(parse_gitdir_pointer("nonsense"), None);
    }

    #[test]
    fn git_dir_directory_is_protected() {
        let (_t, b) = base();
        fs::create_dir_all(b.join(".git")).unwrap();
        assert_eq!(git_protected_paths(&b).unwrap(), vec![b.join(".git")]);
    }

    #[test]
    fn missing_git_still_protects_dot_git() {
        let (_t, b) = base();
        assert_eq!(git_protected_paths(&b).unwrap(), vec![b.join(".git")]);
    }

    #[test]
    fn pointer_file_adds_gitdir_and_commondir() {
        let (_t, b) = base();
        let root = b.join("wt");
        let gitdir = b.join("main/.git/worktrees/wt");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&gitdir).unwrap();
        fs::write(gitdir.join("commondir"), "../..\n").unwrap();
        fs::write(root.join(".git"), "gitdir: ../main/.git/worktrees/wt\n").unwrap();
        let got = git_protected_paths(&root).unwrap();
        assert!(got.contains(&root.join(".git")));
        assert!(got.contains(&gitdir));
        assert!(got.contains(&b.join("main/.git")));
    }

    #[test]
    fn malformed_pointer_file_is_an_error() {
        let (_t, b) = base();
        fs::write(b.join(".git"), "garbage").unwrap();
        assert!(git_protected_paths(&b).is_err());
    }
}
