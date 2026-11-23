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
//! - Every bind SOURCE from the tree (root, write prefixes, extraWrite,
//!   deny matches, git paths) is opened by us first, one component at a
//!   time from `/` with `O_PATH|O_NOFOLLOW` ([`open_no_symlinks`]); a
//!   symlink anywhere is refused (120). bwrap gets the fds via
//!   `--bind-fd`/`--ro-bind-fd`, so swapping a path for a symlink after our
//!   checks cannot redirect a mount (S10). The fds are inheritable only in
//!   the bwrap child; bwrap closes them before running the command.
//! - `--seccomp`: a BPF filter makes `socket(AF_UNIX, ..)` fail with EPERM
//!   (`socketpair` stays allowed), so filesystem sockets under the ro tree
//!   and abstract sockets (reachable with `--share-net`) cannot be
//!   connected (S9). `io_uring_setup` (which can create sockets without
//!   the socket syscall) and x32 syscalls get EPERM too; a foreign syscall
//!   ABI (e.g. i386 on x86_64) kills the process.
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
//! - the walk of root runs on every exec (cost grows with node_modules);
//! - mount DESTINATIONS are still resolved by bwrap by path; only sources
//!   are pinned by fd;
//! - needs a bwrap with `--bind-fd`/`--ro-bind-fd`/`--seccomp` (an older
//!   one fails the preflight: 120).
//!
//! Compiled on every platform so it stays unit-tested everywhere.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use crate::exec::absolute_prefix;
use crate::profile::{Anchor, Network, Profile};
use anyhow::{bail, Context, Result};
use std::ffi::CString;
use std::fs;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

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

/// `seccomp_fd` is the fd number of the filter program; `open` turns a
/// bind source into the fd number bwrap should mount (see [`BindFds`]).
pub fn build_bwrap_argv(
    p: &Profile,
    cwd: &Path,
    cmd: &[String],
    env: &[(String, String)],
    seccomp_fd: &str,
    open: &mut dyn FnMut(&Path) -> Result<String>,
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
    let mut bind = |flag: &str, path: &Path| -> Result<()> {
        let fd = open(path)?;
        argv.push(flag.into());
        argv.push(fd);
        argv.push(utf8(path)?.into());
        Ok(())
    };
    bind("--ro-bind-fd", p.root())?;
    for w in write_binds(p)? {
        bind("--bind-fd", &w)?;
    }
    for d in p.extra_write() {
        if d.is_dir() {
            bind("--bind-fd", d)?;
        }
    }
    for ro in &masks.read_only {
        bind("--ro-bind-fd", ro)?;
    }
    for f in &masks.hide_files {
        argv.push("--ro-bind".into());
        argv.push("/dev/null".into());
        argv.push(utf8(f)?.into());
    }
    for d in &masks.hide_dirs {
        argv.push("--tmpfs".into());
        argv.push(utf8(d)?.into());
    }
    argv.push("--seccomp".into());
    argv.push(seccomp_fd.into());
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
    let mut writable = write_binds(p)?;
    for d in p.extra_write().iter().filter(|d| d.is_dir()) {
        writable.push(fs::canonicalize(d).unwrap_or_else(|_| d.clone()));
    }
    for b in &bases {
        walk(p, b, &writable, &mut m, &mut budget)?;
    }
    // Absolute readDeny globs outside the walked trees: mask what exists.
    // Each literal prefix is walked once, only as deep as a glob below it can
    // match (`~/*/.env*` lists HOME's children, never all of HOME); `**`
    // means unbounded.
    let mut walks: Vec<(PathBuf, Option<usize>)> = Vec::new();
    for (anchor, glob) in p.read_deny_sources() {
        if anchor != Anchor::Abs {
            continue;
        }
        let Some((prefix, rest)) = absolute_prefix(p.root(), anchor, glob) else {
            continue;
        };
        if bases.iter().any(|b| prefix.starts_with(b)) || fs::symlink_metadata(&prefix).is_err() {
            continue;
        }
        let depth = glob_depth(&rest);
        match walks.iter_mut().find(|(w, _)| *w == prefix) {
            Some((_, d)) => *d = deeper(*d, depth),
            None => walks.push((prefix, depth)),
        }
    }
    for (prefix, depth) in walks {
        walk_read_only(p, &prefix, depth, &mut m, &mut budget)?;
    }
    m.hide_dirs.sort();
    m.hide_dirs.dedup();
    m.hide_files.sort();
    m.hide_files.dedup();
    m.read_only.sort();
    m.read_only.dedup();
    Ok(m)
}

/// Walk `dir` without following symlinks. A deny match is recorded and not
/// descended into (the mount covers its subtree).
fn walk(
    p: &Profile,
    dir: &Path,
    writable: &[PathBuf],
    m: &mut Masks,
    budget: &mut usize,
) -> Result<()> {
    for entry in fs::read_dir(dir).with_context(|| format!("reading {}", dir.display()))? {
        let path = entry?.path();
        *budget = budget.checked_sub(1).context("tree too large to sandbox")?;
        if classify(p, &path, writable, m)? {
            continue;
        }
        let meta = fs::symlink_metadata(&path)?;
        if meta.is_dir() {
            walk(p, &path, writable, m, budget)?;
        }
    }
    Ok(())
}

/// How many path segments below its literal prefix a glob can match;
/// `None` when it contains `**` (any depth).
fn glob_depth(rest: &str) -> Option<usize> {
    let segs: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    if segs.iter().any(|s| s.contains("**")) {
        None
    } else {
        Some(segs.len())
    }
}

fn deeper(a: Option<usize>, b: Option<usize>) -> Option<usize> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.max(y)),
        _ => None,
    }
}

/// Same as [`walk`] but only for readDeny (outside the writable trees),
/// descending at most `depth` levels below `start` (`None`: unbounded).
fn walk_read_only(
    p: &Profile,
    start: &Path,
    depth: Option<usize>,
    m: &mut Masks,
    budget: &mut usize,
) -> Result<()> {
    if hide_if_read_denied(p, start, m)? {
        return Ok(());
    }
    if depth == Some(0) || !fs::symlink_metadata(start)?.is_dir() {
        return Ok(());
    }
    let entries = match fs::read_dir(start) {
        Ok(e) => e,
        // A depth-limited walk spans home-wide globs (`~/*/.env*`); one
        // unlistable dir there (root-owned, 0711) must not make every exec
        // fail. Residual: a file inside a dir we cannot list but the command
        // can enter by name stays readable. Unbounded walks fail closed.
        Err(_) if depth.is_some() => return Ok(()),
        Err(e) => return Err(e).with_context(|| format!("reading {}", start.display())),
    };
    for entry in entries {
        let path = entry?.path();
        *budget = budget.checked_sub(1).context("tree too large to sandbox")?;
        walk_read_only(p, &path, depth.map(|d| d - 1), m, budget)?;
    }
    Ok(())
}

/// The worktree's `<root>/node_modules` link (and only that path) needs no
/// ro-bind (which would refuse a symlink) when its canonical target lies
/// outside every writable root: the target is already read-only, and the link
/// node itself is verified by the orchestrator before every tool run (R33).
/// Every other protected symlink, an unresolvable target, or a target inside
/// a writable root keeps the fail-closed mask.
fn symlink_mask_skippable(
    path: &Path,
    root: &Path,
    target: Option<&Path>,
    writable: &[PathBuf],
) -> bool {
    path == root.join("node_modules")
        && target.is_some_and(|t| !writable.iter().any(|w| t.starts_with(w)))
}

/// Record a mask for `path` if a rule hits it; true = handled.
fn classify(p: &Profile, path: &Path, writable: &[PathBuf], m: &mut Masks) -> Result<bool> {
    // Secrecy first: a hidden path is also not writable on the host.
    if hide_if_read_denied(p, path, m)? {
        return Ok(true);
    }
    let r = p
        .resolve(path)
        .with_context(|| format!("resolving {}", path.display()))?;
    let spellings: Vec<&Path> = r.spellings.iter().map(PathBuf::as_path).collect();
    if p.write_denial(&spellings).is_some() {
        let is_link = fs::symlink_metadata(path).is_ok_and(|md| md.file_type().is_symlink());
        if is_link {
            let target = fs::canonicalize(path).ok();
            if symlink_mask_skippable(path, p.root(), target.as_deref(), writable) {
                return Ok(true);
            }
        }
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

/// Open `path` (absolute, no `.`/`..`) walking from `/` one component at
/// a time without following symlinks; any symlink component is refused.
/// Linux: `O_PATH` fds (what `--bind-fd` wants). Elsewhere (unit tests):
/// `O_RDONLY|O_NONBLOCK`. Every fd is `O_CLOEXEC`.
pub fn open_no_symlinks(path: &Path) -> Result<OwnedFd> {
    #[cfg(target_os = "linux")]
    const BASE: libc::c_int = libc::O_PATH | libc::O_CLOEXEC;
    #[cfg(not(target_os = "linux"))]
    const BASE: libc::c_int = libc::O_RDONLY | libc::O_NONBLOCK | libc::O_CLOEXEC;
    let mut names = Vec::new();
    for (i, c) in path.components().enumerate() {
        match c {
            Component::RootDir if i == 0 => {}
            Component::Normal(n) => names.push(
                CString::new(n.as_encoded_bytes())
                    .with_context(|| format!("NUL in {}", path.display()))?,
            ),
            _ => bail!(
                "bind source must be absolute and normalized: {}",
                path.display()
            ),
        }
    }
    if !path.is_absolute() {
        bail!("bind source must be absolute: {}", path.display());
    }
    // SAFETY: valid C string; the fd is owned right away.
    let raw = unsafe { libc::open(c"/".as_ptr(), BASE | libc::O_DIRECTORY) };
    if raw < 0 {
        return Err(std::io::Error::last_os_error()).context("opening /");
    }
    // SAFETY: raw is a fresh, valid fd.
    let mut dir = unsafe { OwnedFd::from_raw_fd(raw) };
    for (i, name) in names.iter().enumerate() {
        let last = i + 1 == names.len();
        let flags = BASE | libc::O_NOFOLLOW | if last { 0 } else { libc::O_DIRECTORY };
        // SAFETY: dir is a valid fd and name a valid C string.
        let raw = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags) };
        if raw < 0 {
            let err = std::io::Error::last_os_error();
            if is_symlink_at(&dir, name) {
                bail!(
                    "bind source {} has a symlink component {:?}: refusing",
                    path.display(),
                    name
                );
            }
            return Err(err).with_context(|| format!("opening {}", path.display()));
        }
        // SAFETY: raw is a fresh, valid fd.
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        // Linux O_PATH|O_NOFOLLOW opens a final symlink itself: refuse it.
        if fd_is_symlink(&fd) {
            bail!("bind source {} is a symlink: refusing", path.display());
        }
        dir = fd;
    }
    Ok(dir)
}

fn is_symlink_at(dir: &OwnedFd, name: &CString) -> bool {
    // SAFETY: st is written by fstatat on success only.
    unsafe {
        let mut st: libc::stat = std::mem::zeroed();
        libc::fstatat(
            dir.as_raw_fd(),
            name.as_ptr(),
            &mut st,
            libc::AT_SYMLINK_NOFOLLOW,
        ) == 0
            && st.st_mode & libc::S_IFMT == libc::S_IFLNK
    }
}

fn fd_is_symlink(fd: &OwnedFd) -> bool {
    // SAFETY: st is written by fstat on success only.
    unsafe {
        let mut st: libc::stat = std::mem::zeroed();
        libc::fstat(fd.as_raw_fd(), &mut st) == 0 && st.st_mode & libc::S_IFMT == libc::S_IFLNK
    }
}

/// The fds one bwrap run reads: pinned bind sources and the seccomp
/// program. All are `O_CLOEXEC` here; [`BindFds::inherit_in`] clears that
/// only inside the forked bwrap child, so no other process gets them.
#[derive(Default)]
pub struct BindFds {
    fds: Vec<OwnedFd>,
}

impl BindFds {
    /// Pin `path` (see [`open_no_symlinks`]); returns the fd number.
    pub fn open(&mut self, path: &Path) -> Result<String> {
        let fd = open_no_symlinks(path)?;
        let n = fd.as_raw_fd();
        self.fds.push(fd);
        Ok(n.to_string())
    }

    /// A pipe holding the seccomp program for the host arch (bwrap reads it
    /// to EOF); returns the read end's fd number.
    pub fn seccomp_program(&mut self) -> Result<String> {
        let arch = Arch::host().context("seccomp: unsupported CPU architecture")?;
        let bytes = filter_bytes(&unix_socket_filter(arch));
        let mut ends = [0 as RawFd; 2];
        // SAFETY: ends has room for two fds.
        if unsafe { libc::pipe(ends.as_mut_ptr()) } != 0 {
            return Err(std::io::Error::last_os_error()).context("seccomp pipe");
        }
        // SAFETY: both fds are fresh and owned from here on.
        let (r, w) = unsafe { (OwnedFd::from_raw_fd(ends[0]), OwnedFd::from_raw_fd(ends[1])) };
        for fd in [&r, &w] {
            // SAFETY: plain fcntl on a valid fd.
            unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) };
        }
        let mut file = fs::File::from(w);
        std::io::Write::write_all(&mut file, &bytes).context("writing seccomp program")?;
        drop(file); // EOF for bwrap
        let n = r.as_raw_fd();
        self.fds.push(r);
        Ok(n.to_string())
    }

    /// Make exactly these fds inheritable in `c`'s child (after fork).
    pub fn inherit_in(&self, c: &mut Command) {
        use std::os::unix::process::CommandExt;
        let raw: Vec<RawFd> = self.fds.iter().map(AsRawFd::as_raw_fd).collect();
        // SAFETY: fcntl is async-signal-safe; `raw` is allocated already.
        unsafe {
            c.pre_exec(move || {
                for &fd in &raw {
                    if libc::fcntl(fd, libc::F_SETFD, 0) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
    }
}

// ---- seccomp (S9) -------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Arch {
    X86_64,
    Aarch64,
}

impl Arch {
    pub fn host() -> Option<Arch> {
        if cfg!(target_arch = "x86_64") {
            Some(Arch::X86_64)
        } else if cfg!(target_arch = "aarch64") {
            Some(Arch::Aarch64)
        } else {
            None
        }
    }
    /// AUDIT_ARCH_* as seen in `seccomp_data.arch`.
    fn audit(self) -> u32 {
        match self {
            Arch::X86_64 => 0xC000_003E,
            Arch::Aarch64 => 0xC000_00B7,
        }
    }
    fn nr_socket(self) -> u32 {
        match self {
            Arch::X86_64 => 41,
            Arch::Aarch64 => 198,
        }
    }
}

/// Same number on both arches (unified table since 5.1).
const NR_IO_URING_SETUP: u32 = 425;
const X32_SYSCALL_BIT: u32 = 0x4000_0000;
const AF_UNIX: u32 = 1;
const EPERM: u32 = 1;

const BPF_LD_W_ABS: u16 = 0x20;
const BPF_JEQ_K: u16 = 0x15;
const BPF_JGE_K: u16 = 0x35;
const BPF_RET_K: u16 = 0x06;
pub const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
pub const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
pub const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
/// `struct seccomp_data` offsets: nr, arch, args[0] (low word, LE).
const OFF_NR: u32 = 0;
const OFF_ARCH: u32 = 4;
const OFF_ARG0: u32 = 16;

/// One `struct sock_filter`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SockFilter {
    pub code: u16,
    pub jt: u8,
    pub jf: u8,
    pub k: u32,
}

const fn op(code: u16, jt: u8, jf: u8, k: u32) -> SockFilter {
    SockFilter { code, jt, jf, k }
}

/// Deny `socket(AF_UNIX, ..)`, `io_uring_setup` and x32 syscalls with
/// EPERM; kill on a foreign arch; allow everything else.
pub fn unix_socket_filter(arch: Arch) -> Vec<SockFilter> {
    vec![
        /* 0 */ op(BPF_LD_W_ABS, 0, 0, OFF_ARCH),
        /* 1 */ op(BPF_JEQ_K, 1, 0, arch.audit()),
        /* 2 */ op(BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS),
        /* 3 */ op(BPF_LD_W_ABS, 0, 0, OFF_NR),
        /* 4 */ op(BPF_JGE_K, 5, 0, X32_SYSCALL_BIT), // -> 10
        /* 5 */ op(BPF_JEQ_K, 4, 0, NR_IO_URING_SETUP), // -> 10
        /* 6 */ op(BPF_JEQ_K, 0, 2, arch.nr_socket()), // -> 7 / 9
        /* 7 */ op(BPF_LD_W_ABS, 0, 0, OFF_ARG0),
        /* 8 */ op(BPF_JEQ_K, 1, 0, AF_UNIX), // -> 10 / 9
        /* 9 */ op(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW),
        /* 10 */ op(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | EPERM),
    ]
}

/// Native-endian `struct sock_filter[]` bytes, as bwrap's `--seccomp` reads.
pub fn filter_bytes(prog: &[SockFilter]) -> Vec<u8> {
    let mut out = Vec::with_capacity(prog.len() * 8);
    for f in prog {
        out.extend_from_slice(&f.code.to_ne_bytes());
        out.push(f.jt);
        out.push(f.jf);
        out.extend_from_slice(&f.k.to_ne_bytes());
    }
    out
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

    #[test]
    fn glob_depth_counts_segments_and_star_star_is_unbounded() {
        assert_eq!(glob_depth(""), Some(0));
        assert_eq!(glob_depth(".env*"), Some(1));
        assert_eq!(glob_depth("*/*/.env*"), Some(3));
        assert_eq!(glob_depth("**"), None);
        assert_eq!(glob_depth("a/**/b"), None);
        assert_eq!(deeper(Some(1), Some(3)), Some(3));
        assert_eq!(deeper(Some(1), None), None);
    }

    #[test]
    fn home_wide_readdeny_walks_only_as_deep_as_the_glob() {
        let t = TempDir::new().unwrap();
        let base = fs::canonicalize(t.path()).unwrap();
        let root = base.join("root");
        let home = base.join("home");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(home.join("proj/sub/deeper")).unwrap();
        fs::write(home.join(".env"), "").unwrap();
        fs::write(home.join("proj/.env.local"), "").unwrap();
        fs::write(home.join("proj/sub/deeper/.env"), "").unwrap();
        // Many entries below the glob's depth: must never be walked.
        let wide = home.join("proj/sub/deeper/wide");
        fs::create_dir_all(&wide).unwrap();
        for i in 0..50 {
            fs::write(wide.join(format!("f{i}")), "").unwrap();
        }
        let h = s(&home);
        let p = Profile::from_spec(ProfileSpec {
            root: root.clone(),
            write: vec![],
            write_deny: vec![],
            read_deny: vec![format!("{h}/.env*"), format!("{h}/*/.env*")],
            network: Network::Deny,
            extra_write: vec![],
        })
        .unwrap();
        let m = collect_masks(&p).unwrap();
        assert!(m.hide_files.contains(&home.join(".env")), "{m:?}");
        assert!(
            m.hide_files.contains(&home.join("proj/.env.local")),
            "{m:?}"
        );
        assert!(
            !m.hide_files.contains(&home.join("proj/sub/deeper/.env")),
            "{m:?}"
        );
        // Walk budget: HOME's entries and proj's, never `wide`'s 50.
        let mut budget = 10;
        walk_read_only(&p, &home, Some(2), &mut Masks::default(), &mut budget).unwrap();
    }

    fn v(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|x| x.to_string()).collect()
    }

    /// argv with a fake opener: a bind source shows up as `fd:<path>`.
    fn argv(p: &Profile, cwd: &Path, cmd: &[String]) -> Result<Vec<String>> {
        build_bwrap_argv(p, cwd, cmd, &env(), "SECCOMP", &mut |src| {
            Ok(format!("fd:{}", src.display()))
        })
    }

    fn fd(p: &Path) -> String {
        format!("fd:{}", p.display())
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
    fn symlink_mask_skippable_only_for_root_node_modules_outside_writable_roots() {
        let root = Path::new("/r");
        let nm = Path::new("/r/node_modules");
        let w = vec![PathBuf::from("/r/src"), PathBuf::from("/scratch")];
        let out = Some(Path::new("/elsewhere/node_modules"));
        assert!(symlink_mask_skippable(nm, root, out, &w));
        assert!(!symlink_mask_skippable(
            nm,
            root,
            Some(Path::new("/r/src/inner")),
            &w
        ));
        assert!(!symlink_mask_skippable(
            nm,
            root,
            Some(Path::new("/scratch")),
            &w
        ));
        // dangling or unresolvable: keep the fail-closed mask
        assert!(!symlink_mask_skippable(nm, root, None, &w));
        // any other protected symlink keeps the mask, wherever it points
        assert!(!symlink_mask_skippable(
            Path::new("/r/vendor"),
            root,
            out,
            &w
        ));
        assert!(!symlink_mask_skippable(
            Path::new("/r/pkg/node_modules"),
            root,
            out,
            &w
        ));
    }

    #[test]
    fn protected_symlink_out_of_writable_roots_is_not_masked() {
        let (_t, root, _) = fixture(Network::Deny);
        let outside = TempDir::new().unwrap();
        let target = fs::canonicalize(outside.path()).unwrap();
        std::os::unix::fs::symlink(&target, root.join("node_modules")).unwrap();
        std::os::unix::fs::symlink(root.join("src"), root.join("tests/into-src")).unwrap();
        std::os::unix::fs::symlink(&target, root.join("vendor")).unwrap();
        let p = Profile::from_spec(ProfileSpec {
            root: root.clone(),
            write: vec!["src/**".into()],
            write_deny: vec![
                "tests/**".into(),
                "**/node_modules/**".into(),
                "node_modules".into(),
                "vendor".into(),
            ],
            read_deny: vec![],
            network: Network::Deny,
            extra_write: vec![],
        })
        .unwrap();
        let m = collect_masks(&p).unwrap();
        assert!(!m.read_only.contains(&root.join("node_modules")), "{m:?}");
        // other protected matches are still masked (tests/ covers the symlink into src)
        assert!(m.read_only.contains(&root.join("tests")), "{m:?}");
        // a protected symlink other than <root>/node_modules keeps the mask (fails closed later)
        assert!(m.read_only.contains(&root.join("vendor")), "{m:?}");
    }

    #[test]
    fn protected_symlink_into_a_writable_root_stays_masked() {
        let (_t, root, _) = fixture(Network::Deny);
        std::os::unix::fs::symlink(root.join("src"), root.join("node_modules")).unwrap();
        let p = Profile::from_spec(ProfileSpec {
            root: root.clone(),
            write: vec!["src/**".into()],
            write_deny: vec!["node_modules".into()],
            read_deny: vec![],
            network: Network::Deny,
            extra_write: vec![],
        })
        .unwrap();
        let m = collect_masks(&p).unwrap();
        assert!(m.read_only.contains(&root.join("node_modules")), "{m:?}");
    }

    #[test]
    fn argv_layout() {
        let (_t, root, p) = fixture(Network::Deny);
        let cmd = v(&["sh", "-c", "true"]);
        let argv = argv(&p, &root.join("src"), &cmd).unwrap();
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
        // Every tree bind is fd-pinned: no path-sourced --bind/--ro-bind of
        // the tree remains (only /dev/null and / itself).
        let ro_root = pos(&argv, &["--ro-bind-fd".into(), fd(&root), s(&root)]);
        let src = root.join("src");
        let rw_src = pos(&argv, &["--bind-fd".into(), fd(&src), s(&src)]);
        assert_eq!(
            argv.iter().filter(|a| *a == "--bind-fd").count(),
            1,
            "{argv:?}"
        );
        assert!(!argv.contains(&"--bind".to_string()));
        for (i, a) in argv.iter().enumerate() {
            if a == "--ro-bind" {
                assert!(
                    ["/", "/dev/null"].contains(&argv[i + 1].as_str()),
                    "{argv:?}"
                );
            }
        }
        assert!(!argv.contains(&s(&root.join("missing"))));
        let sep = argv.iter().position(|a| a == "--").unwrap();
        assert!(pos(&argv, &v(&["--seccomp", "SECCOMP"])) < sep);
        assert!(base < ro_root && ro_root < rw_src);
        // Deny matches re-bound read-only after the rw bind.
        for d in [
            root.join("tests"),
            root.join(".git"),
            root.join("src/sub/.git"),
            root.join("src/x.snap"),
        ] {
            assert!(
                pos(&argv, &["--ro-bind-fd".into(), fd(&d), s(&d)]) > rw_src,
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
        let argv = argv(&p, &root, &v(&["true"])).unwrap();
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
        let argv = argv(&p, &root, &v(&["true"])).unwrap();
        assert!(has_seq(&argv, &v(&["--unshare-all", "--share-net"])));
    }

    #[test]
    fn empty_command_is_an_error() {
        let (_t, root, p) = fixture(Network::Deny);
        assert!(argv(&p, &root, &[]).is_err());
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
        let argv = argv(&p, &root, &v(&["true"])).unwrap();
        let ro = pos(&argv, &["--ro-bind-fd".into(), fd(&root), s(&root)]);
        let rw = pos(&argv, &["--bind-fd".into(), fd(&root), s(&root)]);
        assert!(ro < rw);
    }

    #[test]
    fn real_opener_pins_every_tree_bind_by_fd() {
        let (_t, root, p) = fixture(Network::Deny);
        let mut fds = BindFds::default();
        let argv = build_bwrap_argv(&p, &root, &v(&["true"]), &env(), "9", &mut |src| {
            fds.open(src)
        })
        .unwrap();
        let i = pos(&argv, &["--ro-bind-fd".into()]);
        let n: RawFd = argv[i + 1].parse().unwrap();
        assert!(fds.fds.iter().any(|f| f.as_raw_fd() == n));
        assert_eq!(argv[i + 2], s(&root));
    }

    #[test]
    fn open_no_symlinks_refuses_symlink_components() {
        let t = TempDir::new().unwrap();
        let base = fs::canonicalize(t.path()).unwrap();
        fs::create_dir_all(base.join("real/inner")).unwrap();
        fs::write(base.join("real/file"), "").unwrap();
        std::os::unix::fs::symlink(base.join("real"), base.join("link")).unwrap();
        std::os::unix::fs::symlink(base.join("real/file"), base.join("flink")).unwrap();
        assert!(open_no_symlinks(&base.join("real/inner")).is_ok());
        assert!(open_no_symlinks(&base.join("real/file")).is_ok());
        assert!(open_no_symlinks(Path::new("/")).is_ok());
        let e = open_no_symlinks(&base.join("link/inner")).unwrap_err();
        assert!(format!("{e:#}").contains("symlink"), "{e:#}");
        let e = open_no_symlinks(&base.join("link")).unwrap_err();
        assert!(format!("{e:#}").contains("symlink"), "{e:#}");
        let e = open_no_symlinks(&base.join("flink")).unwrap_err();
        assert!(format!("{e:#}").contains("symlink"), "{e:#}");
        assert!(open_no_symlinks(&base.join("real/../real")).is_err());
        assert!(open_no_symlinks(Path::new("relative/x")).is_err());
        assert!(open_no_symlinks(&base.join("missing")).is_err());
    }

    #[test]
    fn bind_fds_are_cloexec_but_inherited_by_the_bwrap_child() {
        let t = TempDir::new().unwrap();
        let base = fs::canonicalize(t.path()).unwrap();
        let mut fds = BindFds::default();
        let n: RawFd = fds.open(&base).unwrap().parse().unwrap();
        let sc: RawFd = fds.seccomp_program().unwrap().parse().unwrap();
        for fd in [n, sc] {
            // SAFETY: plain fcntl.
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
            assert_eq!(flags & libc::FD_CLOEXEC, libc::FD_CLOEXEC);
        }
        let probe = |inherit: bool| {
            let mut c = Command::new("/bin/sh");
            c.args([
                "-c",
                &format!("test -e /dev/fd/{n} && test -e /dev/fd/{sc}"),
            ]);
            if inherit {
                fds.inherit_in(&mut c);
            }
            c.status().unwrap().success()
        };
        assert!(probe(true));
        assert!(!probe(false));
        // The seccomp pipe holds exactly the program, then EOF.
        let mut f = fs::File::from(fds.fds.pop().unwrap());
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut f, &mut buf).unwrap();
        assert_eq!(
            buf,
            filter_bytes(&unix_socket_filter(Arch::host().unwrap()))
        );
    }

    /// Minimal classic-BPF interpreter for the opcodes the filter uses.
    fn run_bpf(prog: &[SockFilter], nr: u32, arch: u32, arg0: u64) -> u32 {
        let mut data = [0u8; 64];
        data[0..4].copy_from_slice(&nr.to_le_bytes());
        data[4..8].copy_from_slice(&arch.to_le_bytes());
        data[16..24].copy_from_slice(&arg0.to_le_bytes());
        let (mut pc, mut acc) = (0usize, 0u32);
        loop {
            let f = prog[pc];
            pc += 1;
            match f.code {
                BPF_LD_W_ABS => {
                    let o = f.k as usize;
                    acc = u32::from_le_bytes(data[o..o + 4].try_into().unwrap());
                }
                BPF_JEQ_K | BPF_JGE_K => {
                    let hit = if f.code == BPF_JEQ_K {
                        acc == f.k
                    } else {
                        acc >= f.k
                    };
                    pc += usize::from(if hit { f.jt } else { f.jf });
                }
                BPF_RET_K => return f.k,
                c => panic!("unexpected opcode {c:#x}"),
            }
        }
    }

    #[test]
    fn seccomp_filter_denies_unix_sockets_only() {
        const AF_INET: u64 = 2;
        const AF_INET6: u64 = 10;
        let errno = SECCOMP_RET_ERRNO | EPERM;
        for arch in [Arch::X86_64, Arch::Aarch64] {
            let prog = unix_socket_filter(arch);
            // Every jump lands inside the program and it ends in a return.
            for (i, f) in prog.iter().enumerate() {
                if f.code == BPF_JEQ_K || f.code == BPF_JGE_K {
                    assert!(i + 1 + usize::from(f.jt.max(f.jf)) < prog.len());
                }
            }
            assert_eq!(prog.last().unwrap().code, BPF_RET_K);
            let (a, sock) = (arch.audit(), arch.nr_socket());
            let run = |nr, arg0| run_bpf(&prog, nr, a, arg0);
            assert_eq!(run(sock, u64::from(AF_UNIX)), errno, "{arch:?}");
            // High bits of the int argument are ignored by the kernel too.
            assert_eq!(run(sock, 0xffff_ffff_0000_0001), errno);
            assert_eq!(run(sock, AF_INET), SECCOMP_RET_ALLOW);
            assert_eq!(run(sock, AF_INET6), SECCOMP_RET_ALLOW);
            assert_eq!(run(NR_IO_URING_SETUP, 0), errno);
            assert_eq!(run(X32_SYSCALL_BIT | 41, u64::from(AF_UNIX)), errno);
            // socketpair and everything else: allowed, whatever arg0 is.
            let socketpair = if arch == Arch::X86_64 { 53 } else { 199 };
            assert_eq!(run(socketpair, u64::from(AF_UNIX)), SECCOMP_RET_ALLOW);
            assert_eq!(run(0, u64::from(AF_UNIX)), SECCOMP_RET_ALLOW);
            // Foreign ABI (i386 on x86_64, arm on aarch64, or the other arch).
            for bad in [0x4000_0003, 0x4000_0028, 0] {
                assert_eq!(run_bpf(&prog, sock, bad, 2), SECCOMP_RET_KILL_PROCESS);
            }
            let other = if arch == Arch::X86_64 {
                Arch::Aarch64
            } else {
                Arch::X86_64
            };
            assert_eq!(
                run_bpf(&prog, 0, other.audit(), 0),
                SECCOMP_RET_KILL_PROCESS
            );
        }
        // Serialized as 8-byte native-endian sock_filter entries.
        let prog = unix_socket_filter(Arch::X86_64);
        let bytes = filter_bytes(&prog);
        assert_eq!(bytes.len(), prog.len() * 8);
        assert_eq!(&bytes[4..8], &OFF_ARCH.to_ne_bytes());
    }
}
