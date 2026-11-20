//! `rewire-sandbox exec`: run a command under the OS sandbox built from a
//! profile (macOS Seatbelt via `sandbox-exec`, Linux bubblewrap).
//!
//! Order of checks, each failing closed before the command can run:
//! 1. profile loads (120), 2. `--cwd` is inside root (3, deny JSON),
//! 3. the command resolves via PATH (127, `command not found: <cmd>`),
//! 4. missing `<dir>/**` writeDeny dirs inside root are created (120),
//! 5. the sandbox is built and preflighted with a no-op (120),
//! 6. the command runs in its own process group; its exit code, stdout and
//!    stderr pass through (stdio is inherited, nothing is buffered). A
//!    signal death maps to 128+signal. `--timeout-ms` → SIGKILL the group,
//!    exit 124.

use crate::profile::{self, Anchor, Profile};
use anyhow::{bail, Context, Result};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::mpsc;
use std::time::Duration;

pub const EXIT_TIMEOUT: u8 = 124;
pub const EXIT_NOT_FOUND: u8 = 127;

pub enum ExecOutcome {
    /// The sandboxed command ran; exit with this code.
    Exited(u8),
    /// `--cwd` (canonical) is outside root.
    Denied { canonical: PathBuf, rule: String },
    /// The command could not be resolved; the string is the name as given.
    NotFound(String),
}

pub struct ExecArgs {
    pub profile: PathBuf,
    pub timeout_ms: Option<u64>,
    pub cwd: Option<PathBuf>,
    pub cmd: Vec<OsString>,
}

pub fn run(args: ExecArgs) -> Result<ExecOutcome> {
    let profile = Profile::load(&args.profile)?;
    let cwd = match resolve_cwd(&profile, args.cwd.as_deref())? {
        Ok(c) => c,
        Err(denied) => return Ok(denied),
    };
    let (name, rest) = args.cmd.split_first().context("exec: no command given")?;
    let Some(program) = resolve_command(name, &cwd) else {
        return Ok(ExecOutcome::NotFound(name.to_string_lossy().into_owned()));
    };
    create_deny_dirs(&profile)?;
    let mut command = sandboxed(&profile, &cwd, &program, rest)?;
    command.current_dir(&cwd);
    let status = spawn_and_wait(command, args.timeout_ms.map(Duration::from_millis))?;
    Ok(ExecOutcome::Exited(status))
}

/// Canonical working directory: default root; relative is relative to root.
/// `Ok(Err(..))` is a policy denial.
fn resolve_cwd(profile: &Profile, cwd: Option<&Path>) -> Result<Result<PathBuf, ExecOutcome>> {
    let root = profile.root();
    let Some(cwd) = cwd else {
        return Ok(Ok(root.to_path_buf()));
    };
    let resolved = profile
        .resolve(cwd)
        .with_context(|| format!("canonicalizing --cwd {}", cwd.display()))?;
    let canonical = resolved.canonical;
    if !canonical.starts_with(root) {
        return Ok(Err(ExecOutcome::Denied {
            canonical,
            rule: profile::RULE_OUTSIDE_ROOT.to_owned(),
        }));
    }
    if !canonical.is_dir() {
        bail!("--cwd is not a directory: {}", canonical.display());
    }
    Ok(Ok(canonical))
}

/// Resolve a command like `execvp` would, so "not found" is reported by us
/// (127) rather than guessed from the sandbox launcher's exit code. Names
/// containing `/` are taken relative to the child's cwd; empty PATH entries
/// are skipped (no implicit `.`).
pub fn resolve_command(name: &OsStr, cwd: &Path) -> Option<PathBuf> {
    if name.is_empty() {
        return None;
    }
    if name.as_encoded_bytes().contains(&b'/') {
        let p = cwd.join(name);
        return is_executable(&p).then_some(p);
    }
    let path = std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into());
    std::env::split_paths(&path)
        .filter(|d| !d.as_os_str().is_empty())
        .map(|d| cwd.join(d).join(name))
        .find(|p| is_executable(p))
}

fn is_executable(p: &Path) -> bool {
    fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// Split a glob into its literal (glob-free) leading segments and the rest.
pub fn literal_prefix(glob: &str) -> (String, &str) {
    let mut prefix = Vec::new();
    let mut rest = "";
    let mut remaining = glob;
    loop {
        let (seg, tail) = match remaining.split_once('/') {
            Some((s, t)) => (s, Some(t)),
            None => (remaining, None),
        };
        if seg.contains(['*', '?', '[', ']', '{', '}', '\\']) {
            rest = remaining;
            break;
        }
        prefix.push(seg);
        match tail {
            Some(t) => remaining = t,
            None => break,
        }
    }
    (prefix.join("/"), rest)
}

/// Absolute form of a glob source's literal prefix, or `None` when the
/// prefix is empty and the source floats (a relative-anchored `**/x` that
/// is also applied absolutely).
pub fn absolute_prefix(root: &Path, anchor: Anchor, glob: &str) -> Option<(PathBuf, String)> {
    let (prefix, rest) = literal_prefix(glob);
    let base = match anchor {
        Anchor::Rel if prefix.is_empty() => root.to_path_buf(),
        Anchor::Rel => root.join(&prefix),
        Anchor::Abs if glob.starts_with('/') => {
            PathBuf::from(if prefix.is_empty() { "/" } else { &prefix })
        }
        Anchor::Abs => return None,
    };
    Some((base, rest.to_owned()))
}

/// For every writeDeny glob `<dir>/**` with a literal `<dir>` inside root,
/// create `<dir>` if missing, so files created there later sit under an
/// existing, denied directory. Never creates anything outside root.
fn create_deny_dirs(p: &Profile) -> Result<()> {
    for (anchor, glob) in p.write_deny_sources() {
        let Some((dir, rest)) = absolute_prefix(p.root(), anchor, glob) else {
            continue;
        };
        if rest != "**" {
            continue;
        }
        let canonical = crate::canonical::canonicalize_maybe_missing(&dir)
            .with_context(|| format!("canonicalizing deny dir {}", dir.display()))?;
        if canonical == p.root() || !canonical.starts_with(p.root()) {
            continue;
        }
        if fs::symlink_metadata(&canonical).is_err() {
            fs::create_dir_all(&canonical)
                .with_context(|| format!("creating deny dir {}", canonical.display()))?;
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn sandboxed(p: &Profile, _cwd: &Path, program: &Path, args: &[OsString]) -> Result<Command> {
    use crate::exec_macos::{build_sbpl, SANDBOX_EXEC};
    let sbpl = build_sbpl(p)?;
    // Preflight: sandbox-exec's own failures (bad policy, sandbox_init
    // refused) exit non-zero without running anything, indistinguishable
    // from the child's exit code. Prove the policy applies first.
    let ok = Command::new(SANDBOX_EXEC)
        .arg("-p")
        .arg(&sbpl)
        .arg("--")
        .arg("/usr/bin/true")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .status()
        .with_context(|| format!("running {SANDBOX_EXEC}"))?
        .success();
    if !ok {
        bail!("sandbox-exec could not apply the sandbox profile");
    }
    let mut c = Command::new(SANDBOX_EXEC);
    c.arg("-p").arg(sbpl).arg("--").arg(program).args(args);
    Ok(c)
}

#[cfg(target_os = "linux")]
fn sandboxed(p: &Profile, cwd: &Path, program: &Path, args: &[OsString]) -> Result<Command> {
    use crate::exec_linux::build_bwrap_argv;
    let bwrap = resolve_command(OsStr::new("bwrap"), cwd)
        .context("bwrap not found on PATH: cannot sandbox, refusing to run")?;
    let to_string = |o: &OsStr| {
        o.to_str()
            .map(str::to_owned)
            .with_context(|| format!("non-UTF-8 argument {o:?}"))
    };
    let mut cmd = vec![to_string(program.as_os_str())?];
    for a in args {
        cmd.push(to_string(a)?);
    }
    // Preflight with a no-op: bwrap's setup failures exit 1, which would
    // otherwise look like the child's own exit code.
    let probe = build_bwrap_argv(p, cwd, &["/bin/sh".into(), "-c".into(), ":".into()])?;
    let ok = Command::new(&bwrap)
        .args(&probe)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .status()
        .with_context(|| format!("running {}", bwrap.display()))?
        .success();
    if !ok {
        bail!("bwrap could not apply the sandbox");
    }
    let mut c = Command::new(bwrap);
    c.args(build_bwrap_argv(p, cwd, &cmd)?);
    Ok(c)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn sandboxed(_: &Profile, _: &Path, _: &Path, _: &[OsString]) -> Result<Command> {
    bail!("exec is not supported on this platform: no OS sandbox")
}

/// Process group of the running child, for the signal handler (0 = none).
static CHILD_PGID: AtomicI32 = AtomicI32::new(0);

extern "C" fn on_fatal_signal(sig: libc::c_int) {
    let pg = CHILD_PGID.load(Ordering::SeqCst);
    // SAFETY: kill and _exit are async-signal-safe.
    unsafe {
        if pg > 0 {
            libc::kill(-pg, libc::SIGKILL);
        }
        libc::_exit(128 + sig);
    }
}

fn spawn_and_wait(mut command: Command, timeout: Option<Duration>) -> Result<u8> {
    // If we are told to die, take the sandboxed group with us.
    for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        // SAFETY: installing a handler that only calls async-signal-safe fns.
        unsafe {
            libc::signal(sig, on_fatal_signal as *const () as libc::sighandler_t);
        }
    }
    let mut child = command
        .process_group(0)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .context("spawning sandboxed command")?;
    let pgid = i32::try_from(child.id()).context("child pid out of range")?;
    CHILD_PGID.store(pgid, Ordering::SeqCst);
    let kill_group = || {
        // SAFETY: plain syscall; ESRCH (group already gone) is fine.
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
    };

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait());
    });
    let status = match timeout {
        Some(d) => match rx.recv_timeout(d) {
            Ok(s) => s,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                kill_group();
                let _ = rx.recv();
                CHILD_PGID.store(0, Ordering::SeqCst);
                return Ok(EXIT_TIMEOUT);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => bail!("lost the child waiter"),
        },
        None => rx.recv().context("lost the child waiter")?,
    }
    .context("waiting for sandboxed command")?;
    // Leftover background processes must not outlive the command.
    kill_group();
    CHILD_PGID.store(0, Ordering::SeqCst);
    Ok(match (status.code(), status.signal()) {
        (Some(c), _) => (c & 0xff) as u8,
        (None, Some(sig)) => (128 + sig).clamp(0, 255) as u8,
        (None, None) => bail!("child ended without status"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literal_prefix_splits_at_first_glob_segment() {
        assert_eq!(literal_prefix("tests/**"), ("tests".into(), "**"));
        assert_eq!(literal_prefix("a/b/*.ts"), ("a/b".into(), "*.ts"));
        assert_eq!(literal_prefix("**/.env*"), ("".into(), "**/.env*"));
        assert_eq!(literal_prefix("/x/y"), ("/x/y".into(), ""));
        assert_eq!(literal_prefix("src/a{b,c}/d"), ("src".into(), "a{b,c}/d"));
    }

    #[test]
    fn resolve_command_uses_path_and_rejects_missing() {
        let cwd = Path::new("/");
        assert!(resolve_command(OsStr::new("sh"), cwd).is_some());
        assert!(resolve_command(OsStr::new("/bin/sh"), cwd).is_some());
        assert!(resolve_command(OsStr::new("no-such-cmd-xyz"), cwd).is_none());
        assert!(resolve_command(OsStr::new(""), cwd).is_none());
        // A directory is not a command.
        assert!(resolve_command(OsStr::new("/usr/bin"), cwd).is_none());
    }
}
