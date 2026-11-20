//! `rewire-sandbox exec`: run a command under the OS sandbox built from a
//! profile (macOS Seatbelt via `sandbox-exec`, Linux bubblewrap).
//!
//! Order of checks, each failing closed before the command can run:
//! 1. profile loads (120), 2. `--cwd` is inside root (3, deny JSON),
//! 3. the command resolves via PATH (127, `command not found: <cmd>`),
//! 4. missing deny-glob literal dirs inside root are created (120),
//! 5. the sandbox is built and preflighted with a no-op (120),
//! 6. the command runs in its own process group with a scrubbed
//!    environment; its exit code, stdout and stderr pass through (stdio is
//!    inherited, nothing is buffered). A signal death maps to 128+signal.
//!    `--timeout-ms` → SIGKILL the group and every tracked descendant, 124.
//!
//! Descendants (macOS): a child can leave the process group (`setsid`,
//! `detached: true`) and outlive us. While the command runs we poll its
//! process tree every [`POLL_INTERVAL`] and remember every descendant (pid +
//! start time); after it exits we also sweep for any process inside this
//! run's Seatbelt sandbox (per-run tag rule, see `exec_track`). Any
//! descendant still alive is SIGKILLed (with its own group) and exec fails
//! with 120 `sandbox: escaped descendant <pid>`. KNOWN LIMITATION: a
//! process that detaches faster than one poll interval is only found by the
//! post-exit sweep, so it runs (sandboxed) until the command exits. Linux
//! needs none of this: the command runs in its own pid namespace, which the
//! kernel tears down when bwrap exits.

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
use std::time::{Duration, Instant};

pub const EXIT_TIMEOUT: u8 = 124;
pub const EXIT_NOT_FOUND: u8 = 127;

/// Descendant-tracking poll interval.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// Fixed, trusted bwrap locations; PATH is never consulted for it.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const BWRAP_CANDIDATES: [&str; 2] = ["/usr/bin/bwrap", "/usr/local/bin/bwrap"];

/// Setting this makes exec behave as if bwrap were missing. It can only
/// make exec refuse to run (fail closed), so honoring it is safe.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const DISABLE_BWRAP_VAR: &str = "REWIRE_SANDBOX_DISABLE_BWRAP";

/// Environment passed through to the sandboxed command; everything else is
/// dropped. `LC_*` is matched as a prefix. `TMPDIR` passes only when it is
/// inside an `extraWrite` dir (otherwise it would point at an unwritable
/// dir). Secrets are additionally rejected by [`is_secret_var`] even if a
/// future edit widens this list.
const ENV_ALLOW: [&str; 12] = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "TERM",
    "TZ",
    "NODE_ENV",
    "CI",
    "NO_COLOR",
    "FORCE_COLOR",
];

pub enum ExecOutcome {
    /// The sandboxed command ran; exit with this code.
    Exited(u8),
    /// `--cwd` (canonical) is outside root.
    Denied { canonical: PathBuf, rule: String },
    /// The command could not be resolved; the string is the name as given.
    NotFound(String),
    /// A descendant outlived the command (it has been killed).
    Escaped(i32),
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
    let path_var = std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into());
    let Some(program) = resolve_command(name, &cwd, &path_var) else {
        return Ok(ExecOutcome::NotFound(name.to_string_lossy().into_owned()));
    };
    create_deny_dirs(&profile)?;
    let tag = RunTag::create(&run_token())?;
    let env = scrubbed_env(std::env::vars_os(), &profile);
    let mut command = sandboxed(&profile, &cwd, &program, rest, &env, &tag)?;
    command.current_dir(&cwd).env_clear().envs(env);
    spawn_and_wait(command, args.timeout_ms.map(Duration::from_millis), &tag)
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
/// containing `/` are taken relative to the child's cwd. Only absolute PATH
/// entries are searched: empty and relative entries (implicit `.`, which
/// would let files in the writable tree shadow real tools) are skipped.
pub fn resolve_command(name: &OsStr, cwd: &Path, path_var: &OsStr) -> Option<PathBuf> {
    if name.is_empty() {
        return None;
    }
    if name.as_encoded_bytes().contains(&b'/') {
        let p = cwd.join(name);
        return is_executable(&p).then_some(p);
    }
    std::env::split_paths(path_var)
        .filter(|d| d.is_absolute())
        .map(|d| d.join(name))
        .find(|p| is_executable(p))
}

fn is_executable(p: &Path) -> bool {
    fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// First trusted bwrap candidate that exists and is not inside a tree the
/// sandboxed command (or an agent) can write.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn find_bwrap(p: &Profile, candidates: &[&str]) -> Option<PathBuf> {
    if std::env::var_os(DISABLE_BWRAP_VAR).is_some() {
        return None;
    }
    candidates
        .iter()
        .map(PathBuf::from)
        .filter(|c| is_executable(c))
        .find(|c| match fs::canonicalize(c) {
            Ok(real) => !p.in_write_space(&real) && !p.in_write_space(c),
            Err(_) => false,
        })
}

/// Keep only allowlisted, non-secret variables.
pub fn scrubbed_env(
    vars: impl Iterator<Item = (OsString, OsString)>,
    p: &Profile,
) -> Vec<(OsString, OsString)> {
    vars.filter(|(k, v)| {
        let Some(k) = k.to_str() else {
            return false;
        };
        if is_secret_var(k) {
            return false;
        }
        if k == "TMPDIR" {
            return crate::canonical::canonicalize_maybe_missing(Path::new(v))
                .is_ok_and(|t| p.extra_write().iter().any(|d| t.starts_with(d)));
        }
        ENV_ALLOW.contains(&k) || k.starts_with("LC_")
    })
    .collect()
}

/// Never passed, whatever the allowlist says.
fn is_secret_var(k: &str) -> bool {
    let u = k.to_ascii_uppercase();
    matches!(u.as_str(), "SSH_AUTH_SOCK" | "DBUS_SESSION_BUS_ADDRESS")
        || ["TOKEN", "KEY", "SECRET", "PASSWORD", "CREDENTIAL"]
            .iter()
            .any(|w| u.contains(w))
        || ["AWS_", "GH_", "GITHUB_"]
            .iter()
            .any(|pre| u.starts_with(pre))
}

/// Unique per run: pid + nanos + a stack address.
fn run_token() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let local = 0u8;
    format!(
        "{}-{nanos}-{:x}",
        std::process::id(),
        &local as *const u8 as usize
    )
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

/// For every writeDeny/readDeny glob with a literal directory prefix inside
/// root (`tests/**`, `src/sub/tests/**`, `config/*/key`), create that
/// directory if missing. Files created there later then sit under an
/// existing, denied directory, and (macOS) the anti-rename denials on the
/// prefix nodes don't block creating it. Never creates anything outside root.
fn create_deny_dirs(p: &Profile) -> Result<()> {
    for (anchor, glob) in p
        .write_deny_sources()
        .into_iter()
        .chain(p.read_deny_sources())
    {
        let Some((dir, rest)) = absolute_prefix(p.root(), anchor, glob) else {
            continue;
        };
        if rest.is_empty() {
            continue; // fully literal: it names a file or dir, not a parent
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
fn sandboxed(
    p: &Profile,
    _cwd: &Path,
    program: &Path,
    args: &[OsString],
    env: &[(OsString, OsString)],
    tag: &RunTag,
) -> Result<Command> {
    use crate::exec_macos::{build_sbpl, tag_rule, SANDBOX_EXEC};
    let sbpl = build_sbpl(p)? + &tag_rule(&tag.denied)?;
    // Preflight: sandbox-exec's own failures (bad policy, sandbox_init
    // refused) exit non-zero without running anything, indistinguishable
    // from the child's exit code. Prove the policy applies first.
    let ok = Command::new(SANDBOX_EXEC)
        .arg("-p")
        .arg(&sbpl)
        .arg("--")
        .arg("/usr/bin/true")
        .env_clear()
        .envs(env.iter().cloned())
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
fn sandboxed(
    p: &Profile,
    cwd: &Path,
    program: &Path,
    args: &[OsString],
    env: &[(OsString, OsString)],
    _tag: &RunTag,
) -> Result<Command> {
    use crate::exec_linux::build_bwrap_argv;
    let bwrap = find_bwrap(p, &BWRAP_CANDIDATES).with_context(|| {
        format!(
            "no trusted bwrap ({}): cannot sandbox, refusing to run",
            BWRAP_CANDIDATES.join(", ")
        )
    })?;
    let to_string = |o: &OsStr| {
        o.to_str()
            .map(str::to_owned)
            .with_context(|| format!("non-UTF-8 argument {o:?}"))
    };
    let mut cmd = vec![to_string(program.as_os_str())?];
    for a in args {
        cmd.push(to_string(a)?);
    }
    let mut env_s = Vec::new();
    for (k, v) in env {
        env_s.push((to_string(k)?, to_string(v)?));
    }
    // Preflight with a no-op: bwrap's setup failures exit 1, which would
    // otherwise look like the child's own exit code.
    let noop: Vec<String> = vec!["/bin/sh".into(), "-c".into(), ":".into()];
    let probe = build_bwrap_argv(p, cwd, &noop, &env_s)?;
    let ok = Command::new(&bwrap)
        .args(&probe)
        .env_clear()
        .envs(env.iter().cloned())
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
    c.args(build_bwrap_argv(p, cwd, &cmd, &env_s)?);
    Ok(c)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn sandboxed(
    _: &Profile,
    _: &Path,
    _: &Path,
    _: &[OsString],
    _: &[(OsString, OsString)],
    _: &RunTag,
) -> Result<Command> {
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

fn spawn_and_wait(
    mut command: Command,
    timeout: Option<Duration>,
    tag: &RunTag,
) -> Result<ExecOutcome> {
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
    let mut tracker = Tracker::new(pgid, tag);

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait());
    });
    let deadline = timeout.map(|d| Instant::now() + d);
    let status = loop {
        tracker.poll();
        let wait = match deadline {
            Some(d) => {
                let left = d.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    kill_group();
                    tracker.kill_all();
                    let _ = rx.recv();
                    kill_group();
                    tracker.kill_all();
                    CHILD_PGID.store(0, Ordering::SeqCst);
                    return Ok(ExecOutcome::Exited(EXIT_TIMEOUT));
                }
                left.min(tracker.interval())
            }
            None => tracker.interval(),
        };
        match rx.recv_timeout(wait) {
            Ok(s) => break s,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => bail!("lost the child waiter"),
        }
    }
    .context("waiting for sandboxed command")?;
    // Leftover background processes must not outlive the command.
    let escaped = tracker.survivors();
    kill_group();
    tracker.kill_all();
    CHILD_PGID.store(0, Ordering::SeqCst);
    if let Some(&pid) = escaped.first() {
        return Ok(ExecOutcome::Escaped(pid));
    }
    Ok(ExecOutcome::Exited(
        match (status.code(), status.signal()) {
            (Some(c), _) => (c & 0xff) as u8,
            (None, Some(sig)) => (128 + sig).clamp(0, 255) as u8,
            (None, None) => bail!("child ended without status"),
        },
    ))
}

#[cfg(target_os = "macos")]
use crate::exec_track::{RunTag, Tracker};

/// Linux: the pid namespace already confines every descendant.
#[cfg(not(target_os = "macos"))]
struct RunTag;

#[cfg(not(target_os = "macos"))]
impl RunTag {
    fn create(_token: &str) -> Result<RunTag> {
        Ok(RunTag)
    }
}

#[cfg(not(target_os = "macos"))]
struct Tracker;

#[cfg(not(target_os = "macos"))]
impl Tracker {
    fn new(_root: i32, _tag: &RunTag) -> Tracker {
        Tracker
    }
    fn poll(&mut self) {}
    fn interval(&self) -> Duration {
        Duration::from_secs(3600)
    }
    fn survivors(&self) -> Vec<i32> {
        Vec::new()
    }
    fn kill_all(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::{Network, ProfileSpec};
    use tempfile::TempDir;

    fn profile_with_extra(extra: Vec<PathBuf>) -> (TempDir, Profile) {
        let t = TempDir::new().unwrap();
        let root = fs::canonicalize(t.path()).unwrap().join("root");
        fs::create_dir_all(&root).unwrap();
        let p = Profile::from_spec(ProfileSpec {
            root,
            write: vec!["**".into()],
            write_deny: vec![],
            read_deny: vec![],
            network: Network::Deny,
            extra_write: extra,
        })
        .unwrap();
        (t, p)
    }

    #[test]
    fn literal_prefix_splits_at_first_glob_segment() {
        assert_eq!(literal_prefix("tests/**"), ("tests".into(), "**"));
        assert_eq!(literal_prefix("a/b/*.ts"), ("a/b".into(), "*.ts"));
        assert_eq!(literal_prefix("**/.env*"), ("".into(), "**/.env*"));
        assert_eq!(literal_prefix("/x/y"), ("/x/y".into(), ""));
        assert_eq!(literal_prefix("src/a{b,c}/d"), ("src".into(), "a{b,c}/d"));
    }

    #[test]
    fn resolve_command_uses_absolute_path_entries_only() {
        let t = TempDir::new().unwrap();
        let base = fs::canonicalize(t.path()).unwrap();
        fs::create_dir(base.join("bin")).unwrap();
        let tool = base.join("bin/tool");
        fs::write(&tool, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&tool, fs::Permissions::from_mode(0o755)).unwrap();
        let r = |name: &str, path: &str| resolve_command(OsStr::new(name), &base, OsStr::new(path));
        assert_eq!(
            r("tool", base.join("bin").to_str().unwrap()),
            Some(tool.clone())
        );
        // Relative and empty entries are never searched (no implicit `.`).
        assert_eq!(r("tool", "bin"), None);
        assert_eq!(r("tool", ""), None);
        assert_eq!(r("tool", ":bin:"), None);
        // Explicit paths are relative to the child's cwd.
        assert_eq!(r("bin/tool", ""), Some(base.join("bin/tool")));
        assert!(r("sh", "/bin:/usr/bin").is_some());
        assert_eq!(r("no-such-cmd-xyz", "/bin:/usr/bin"), None);
        assert_eq!(r("", "/bin"), None);
        // A directory is not a command.
        assert_eq!(r("/usr/bin", "/bin"), None);
    }

    #[test]
    fn bwrap_candidates_inside_write_space_are_refused() {
        let t = TempDir::new().unwrap();
        let extra = fs::canonicalize(t.path()).unwrap();
        let (_t, p) = profile_with_extra(vec![extra.clone()]);
        let mk = |p: &Path| {
            fs::write(p, "#!/bin/sh\n").unwrap();
            fs::set_permissions(p, fs::Permissions::from_mode(0o755)).unwrap();
        };
        let in_root = p.root().join("bwrap");
        let in_extra = extra.join("bwrap");
        mk(&in_root);
        mk(&in_extra);
        let s = |x: &Path| x.to_str().unwrap().to_owned();
        assert_eq!(find_bwrap(&p, &[&s(&in_root), &s(&in_extra)]), None);
        assert_eq!(find_bwrap(&p, &["/nonexistent/bwrap"]), None);
        // A trusted executable outside the write space is accepted.
        assert_eq!(
            find_bwrap(&p, &[&s(&in_root), "/bin/sh"]),
            Some("/bin/sh".into())
        );
    }

    #[test]
    fn env_is_allowlisted_and_secrets_dropped() {
        let t = TempDir::new().unwrap();
        let scratch = fs::canonicalize(t.path()).unwrap();
        let (_t, p) = profile_with_extra(vec![scratch.clone()]);
        let vars = [
            ("PATH", "/bin"),
            ("HOME", "/h"),
            ("LANG", "C"),
            ("LC_CTYPE", "C"),
            ("TERM", "xterm"),
            ("SSH_AUTH_SOCK", "/s"),
            ("DBUS_SESSION_BUS_ADDRESS", "x"),
            ("GH_TOKEN", "x"),
            ("GITHUB_ACTIONS", "x"),
            ("AWS_REGION", "x"),
            ("NPM_TOKEN", "x"),
            ("MY_KEY", "x"),
            ("DB_SECRET", "x"),
            ("OTHER", "x"),
            ("TMPDIR", "/somewhere/else"),
        ]
        .map(|(k, v)| (OsString::from(k), OsString::from(v)));
        let out = scrubbed_env(vars.into_iter(), &p);
        let names: Vec<&str> = out.iter().map(|(k, _)| k.to_str().unwrap()).collect();
        assert_eq!(names, ["PATH", "HOME", "LANG", "LC_CTYPE", "TERM"]);
        let tmp = [(OsString::from("TMPDIR"), scratch.join("t").into_os_string())];
        assert_eq!(scrubbed_env(tmp.into_iter(), &p).len(), 1);
        assert!(is_secret_var("lc_api_key"));
    }
}
