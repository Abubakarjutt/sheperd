//! macOS descendant tracking for `exec` (see the module docs of `exec`).
//!
//! Two independent nets:
//! 1. Tree polling: every poll, walk `proc_listchildpids` from the command
//!    and from every descendant seen so far (orphans re-parent to launchd,
//!    so already-known pids are walked too). Each pid is remembered with its
//!    start time so a recycled pid is never mistaken for a descendant.
//! 2. Sandbox-tag sweep: each run's SBPL denies reading one per-run tag
//!    file `a` but not its sibling `b`. A Seatbelt sandbox is inherited by
//!    every descendant and can never be dropped, so after the command ends
//!    any process of our uid for which `sandbox_check` says "a denied, b
//!    allowed" is in THIS run's sandbox, whatever it did to its parentage,
//!    session, group or environment. (Probed on Darwin 27: other sandboxes,
//!    even deny-default ones, treat `a` and `b` alike; the process env is
//!    not readable via KERN_PROCARGS2 there, so an env token cannot work.)
//!
//! Tag placement (N1): the tag dir lives in a system temp dir that is NOT
//! in the profile's write space (never the caller's `TMPDIR`, which may sit
//! inside `extraWrite`), and the SBPL also denies writes to it and its
//! parent entry, so the command cannot move it or swap in a decoy.
//!
//! Fail closed (N2): `sandbox_check` is reached through [`CheckFn`]; every
//! answer other than 0/1 is "unknown", and before the command runs a
//! self-test proves the checker sees a probe inside this run's sandbox and
//! does not see us. An unknown answer during a sweep, for a process that is
//! still alive, aborts with an internal error.
//!
//! Killing (N3): [`Tracker::kill_until_quiet`] repeats sweep + SIGKILL
//! back to back until sweeps stay empty for [`QUIET_TIME`], so a pid-hopping
//! chain (fork, parent exits, child `setsid`s, repeat; probed: a new link
//! every ~70-250µs) cannot outrun a single snapshot. Cached sweeps skip
//! already-cleared pids without a syscall, so one sweep is shorter than one
//! fork. Bounded by [`KILL_BUDGET`]; still finding processes at the bound
//! is an error (120).
//!
//! Remaining limitation: a process detaching faster than one poll interval
//! is found by the sweep only after the command exits (it runs until then,
//! sandboxed).

use anyhow::{bail, Context, Result};
use std::collections::{BTreeSet, HashMap};
use std::ffi::{c_char, c_int, CStr, CString};
use std::fs;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::profile::Profile;

extern "C" {
    /// libsystem_sandbox (re-exported by libSystem). Returns 0 if `op` on
    /// the filter argument is allowed for `pid`, 1 if denied; with a null
    /// `op`, 1 iff `pid` is sandboxed. Anything else is an error.
    fn sandbox_check(pid: libc::pid_t, op: *const c_char, ty: c_int, ...) -> c_int;
}
const SANDBOX_FILTER_NONE: c_int = 0;
const SANDBOX_FILTER_PATH: c_int = 1;

/// `sandbox_check(pid, op, path)`: `op == None` asks "is pid sandboxed".
pub type CheckFn = fn(i32, Option<&CStr>, Option<&CStr>) -> c_int;

fn real_check(pid: i32, op: Option<&CStr>, path: Option<&CStr>) -> c_int {
    // SAFETY: valid NUL-terminated strings (or null op); the path filter
    // takes one char*.
    unsafe {
        match (op, path) {
            (Some(op), Some(path)) => {
                sandbox_check(pid, op.as_ptr(), SANDBOX_FILTER_PATH, path.as_ptr())
            }
            _ => sandbox_check(pid, std::ptr::null(), SANDBOX_FILTER_NONE),
        }
    }
}

/// Upper bound on sweep + kill rounds after the command ends.
pub const KILL_BUDGET: Duration = Duration::from_secs(2);
/// Descendants count as gone after this many consecutive empty sweeps
/// spanning at least [`QUIET_TIME`] (many hop lifetimes), plus one
/// validated sweep.
const QUIET_SWEEPS: u32 = 64;
const QUIET_TIME: Duration = Duration::from_millis(30);

/// Candidate homes for the tag dir, in order. The per-user temp dir
/// (mode 0700, not influenced by `TMPDIR`) comes first.
fn tag_bases() -> Vec<PathBuf> {
    let mut v = Vec::new();
    let mut buf = vec![0u8; 1024];
    // SAFETY: confstr writes at most buf.len() bytes, NUL-terminated.
    let n = unsafe {
        libc::confstr(
            libc::_CS_DARWIN_USER_TEMP_DIR,
            buf.as_mut_ptr().cast(),
            buf.len(),
        )
    };
    if n > 0 && n <= buf.len() {
        if let Ok(c) = CStr::from_bytes_until_nul(&buf) {
            v.push(PathBuf::from(c.to_string_lossy().into_owned()));
        }
    }
    v.push("/private/tmp".into());
    v.push("/private/var/tmp".into());
    v
}

/// The per-run tag files (removed on drop).
pub struct RunTag {
    pub dir: PathBuf,
    pub denied: PathBuf,
    allowed: PathBuf,
}

impl RunTag {
    /// Create the tag dir in the first candidate base outside `p`'s write
    /// space; refuse (error) when every candidate is writable by the command.
    pub fn create(token: &str, p: &Profile) -> Result<RunTag> {
        Self::create_in(token, p, &tag_bases())
    }

    fn create_in(token: &str, p: &Profile, bases: &[PathBuf]) -> Result<RunTag> {
        let base = bases
            .iter()
            .filter_map(|b| fs::canonicalize(b).ok())
            .find(|b| b.is_dir() && !p.in_write_space(b))
            .context("no temp dir outside the sandbox write space for the run tag")?;
        let dir = base.join(format!("rewire-sandbox-tag-{token}"));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&dir)
            .with_context(|| format!("creating {}", dir.display()))?;
        let tag = RunTag {
            denied: dir.join("a"),
            allowed: dir.join("b"),
            dir,
        };
        // Must still be exactly where we put it (no symlink in the way).
        let real = fs::canonicalize(&tag.dir).context("canonicalizing tag dir")?;
        if real != tag.dir || p.in_write_space(&real) {
            bail!("run tag dir {} is not where expected", tag.dir.display());
        }
        fs::write(&tag.denied, "").context("creating sandbox tag")?;
        fs::write(&tag.allowed, "").context("creating sandbox tag")?;
        Ok(tag)
    }
}

impl Drop for RunTag {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn cpath(p: &Path) -> CString {
    CString::new(p.as_os_str().as_encoded_bytes()).unwrap_or_default()
}

/// Answers "is pid inside this run's sandbox" through a [`CheckFn`].
pub struct Probe {
    check: CheckFn,
    denied: CString,
    allowed: CString,
}

/// Map a raw answer: 0 → false, 1 → true, anything else → unknown.
fn verdict(rc: c_int) -> Option<bool> {
    match rc {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}

impl Probe {
    pub fn new(tag: &RunTag) -> Probe {
        Self::with_check(tag, real_check)
    }

    fn with_check(tag: &RunTag, check: CheckFn) -> Probe {
        Probe {
            check,
            denied: cpath(&tag.denied),
            allowed: cpath(&tag.allowed),
        }
    }

    /// `Some(true)`: in this run's sandbox (tag `a` denied, `b` allowed).
    /// `None`: the checker gave an answer outside 0/1.
    pub fn tagged(&self, pid: i32) -> Option<bool> {
        let op = c"file-read-data";
        if !verdict((self.check)(pid, None, None))? {
            return Some(false);
        }
        let a = verdict((self.check)(pid, Some(op), Some(&self.denied)))?;
        let b = verdict((self.check)(pid, Some(op), Some(&self.allowed)))?;
        Some(a && !b)
    }

    /// Prove the checker works before relying on it: `inside` (a process
    /// known to run in this run's sandbox) must be detected and `outside`
    /// (us) must not. Any other result means detection would fail open.
    pub fn self_test(&self, inside: i32, outside: i32) -> Result<()> {
        match (self.tagged(inside), self.tagged(outside)) {
            (Some(true), Some(false)) => Ok(()),
            (i, o) => bail!(
                "sandbox_check self-test failed (probe in sandbox: {i:?}, \
                 self: {o:?}): cannot track descendants, refusing to run"
            ),
        }
    }
}

pub struct Tracker {
    root: i32,
    /// Start time of the command, so a recycled root pid is never walked.
    root_start: Option<u64>,
    probe: Probe,
    /// pid → start time (µs since epoch).
    seen: HashMap<i32, u64>,
    /// Sweep cache: pid → start time of processes found NOT to be ours.
    cleared: HashMap<i32, u64>,
}

struct Info {
    start: u64,
    pgid: i32,
    zombie: bool,
    uid: u32,
}

fn info(pid: i32) -> Option<Info> {
    // SAFETY: proc_pidinfo writes at most `size` bytes into `bi`.
    unsafe {
        let mut bi: libc::proc_bsdinfo = std::mem::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        let n = libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut bi as *mut libc::proc_bsdinfo).cast(),
            size,
        );
        if n != size {
            return None;
        }
        Some(Info {
            start: bi.pbi_start_tvsec * 1_000_000 + bi.pbi_start_tvusec,
            pgid: bi.pbi_pgid as i32,
            zombie: bi.pbi_status == libc::SZOMB,
            uid: bi.pbi_uid,
        })
    }
}

fn children(pid: i32) -> Vec<i32> {
    let mut buf = vec![0i32; 1024];
    loop {
        let bytes = (buf.len() * std::mem::size_of::<i32>()) as libc::c_int;
        // SAFETY: the buffer holds `bytes` bytes.
        let n = unsafe { libc::proc_listchildpids(pid, buf.as_mut_ptr().cast(), bytes) };
        if n <= 0 {
            return Vec::new();
        }
        let n = n as usize;
        if n < buf.len() {
            buf.truncate(n);
            return buf.into_iter().filter(|&p| p > 0).collect();
        }
        buf.resize(buf.len() * 2, 0);
    }
}

fn all_pids() -> Vec<i32> {
    let mut buf = vec![0i32; 8192];
    loop {
        let bytes = (buf.len() * std::mem::size_of::<i32>()) as libc::c_int;
        // SAFETY: the buffer holds `bytes` bytes.
        let n = unsafe { libc::proc_listallpids(buf.as_mut_ptr().cast(), bytes) };
        if n <= 0 {
            return Vec::new();
        }
        let n = n as usize;
        if n < buf.len() {
            buf.truncate(n);
            return buf.into_iter().filter(|&p| p > 0).collect();
        }
        buf.resize(buf.len() * 2, 0);
    }
}

impl Tracker {
    pub fn new(root: i32, tag: &RunTag) -> Tracker {
        Tracker {
            root,
            root_start: info(root).map(|i| i.start),
            probe: Probe::new(tag),
            seen: HashMap::new(),
            cleared: HashMap::new(),
        }
    }

    pub fn interval(&self) -> Duration {
        crate::exec::POLL_INTERVAL
    }

    /// Record every current descendant of the command.
    pub fn poll(&mut self) {
        let mut stack: Vec<i32> = vec![self.root];
        stack.extend(self.seen.keys().copied());
        let mut visited = std::collections::HashSet::new();
        while let Some(pid) = stack.pop() {
            if !visited.insert(pid) {
                continue;
            }
            // A remembered pid only counts while it is the same process.
            if pid == self.root {
                if info(pid).map(|i| i.start) != self.root_start {
                    continue;
                }
            } else {
                match (self.seen.get(&pid), info(pid)) {
                    (Some(&start), Some(i)) if i.start == start => {}
                    (Some(_), _) => continue,
                    (None, _) => {}
                }
            }
            for c in children(pid) {
                if let Some(i) = info(c) {
                    self.seen.entry(c).or_insert(i.start);
                    stack.push(c);
                }
            }
        }
    }

    /// Descendants still alive (tracked, or inside this run's sandbox),
    /// excluding the command itself. Processes already cleared (same pid
    /// and start time) are not re-checked; with `use_cache` a cleared pid
    /// is skipped without validating its start time. Errors when the
    /// checker gives an unknown answer for a process that is still alive.
    pub fn survivors(&mut self, use_cache: bool) -> Result<Vec<i32>> {
        let mut out: Vec<i32> = self
            .seen
            .iter()
            .filter(|(&pid, &start)| {
                pid != self.root && info(pid).is_some_and(|i| i.start == start && !i.zombie)
            })
            .map(|(&pid, _)| pid)
            .collect();
        // SAFETY: getuid/getpid cannot fail.
        let (uid, me) = unsafe { (libc::getuid(), libc::getpid()) };
        let mut pids = all_pids();
        // Newest first: a hopping chain's current link is the newest pid.
        pids.sort_unstable_by(|a, b| b.cmp(a));
        for pid in pids {
            if pid == me || pid == self.root || out.contains(&pid) {
                continue;
            }
            // Fast path: a cached sweep skips known pids without even a
            // pidinfo call (~1µs each), so a whole sweep costs tens of µs,
            // well under one fork. The final, validated sweep re-checks
            // start times, so a recycled pid is still caught.
            if use_cache && self.cleared.contains_key(&pid) {
                continue;
            }
            let Some(i) = info(pid) else { continue };
            if i.uid != uid || i.zombie {
                continue;
            }
            if self.cleared.get(&pid) == Some(&i.start) {
                continue;
            }
            match self.probe.tagged(pid) {
                Some(true) => out.push(pid),
                Some(false) => {
                    self.cleared.insert(pid, i.start);
                }
                None => {
                    // An unknown answer is fine only if the process is gone.
                    if info(pid).is_some_and(|j| j.start == i.start && !j.zombie) {
                        bail!("sandbox_check gave an unknown answer for live pid {pid}");
                    }
                }
            }
        }
        out.sort_unstable();
        out.dedup();
        Ok(out)
    }

    /// SIGKILL `pids`, and each one's process group when that group is led
    /// by the command or by one of `pids` (never a group we do not own).
    fn kill(&self, pids: &[i32]) {
        // SAFETY: getpgrp cannot fail.
        let own_group = unsafe { libc::getpgrp() };
        for &pid in pids {
            let pgid = info(pid).map(|i| i.pgid).unwrap_or(0);
            // SAFETY: plain syscalls; ESRCH is fine.
            unsafe {
                libc::kill(pid, libc::SIGKILL);
                let leader_is_ours = pgid == self.root || pids.contains(&pgid);
                if pgid > 1 && pgid != own_group && leader_is_ours {
                    libc::kill(-pgid, libc::SIGKILL);
                }
            }
        }
    }

    /// Sweep and SIGKILL until [`QUIET_SWEEPS`] consecutive sweeps (the
    /// last one uncached) find nothing. Returns every pid found. Errors if
    /// processes are still being found after [`KILL_BUDGET`].
    pub fn kill_until_quiet(&mut self) -> Result<Vec<i32>> {
        self.kill_until_quiet_within(KILL_BUDGET)
    }

    fn kill_until_quiet_within(&mut self, budget: Duration) -> Result<Vec<i32>> {
        let deadline = Instant::now() + budget;
        let mut found = BTreeSet::new();
        let mut empty = 0;
        let mut last_find = Instant::now();
        loop {
            // Back-to-back cached sweeps (tens of µs each, shorter than a
            // fork) until quiet, then one validated sweep to confirm.
            let validate = empty >= QUIET_SWEEPS && last_find.elapsed() >= QUIET_TIME;
            let s = self.survivors(!validate)?;
            if s.is_empty() {
                if validate {
                    return Ok(found.into_iter().collect());
                }
                empty += 1;
            } else {
                self.kill(&s);
                found.extend(s);
                empty = 0;
                last_find = Instant::now();
            }
            if Instant::now() >= deadline {
                let seen: Vec<String> = found.iter().map(i32::to_string).collect();
                bail!(
                    "sandbox: escaped descendants still appearing after {}ms of kill \
                     sweeps (seen: {})",
                    budget.as_millis(),
                    seen.join(", ")
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::{Network, ProfileSpec};
    use std::os::unix::process::ExitStatusExt;
    use tempfile::TempDir;

    fn profile(extra: Vec<PathBuf>) -> (TempDir, Profile) {
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

    fn token() -> String {
        format!(
            "test-{}-{:?}-{}",
            std::process::id(),
            std::thread::current().id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    }

    fn tag() -> (TempDir, RunTag) {
        let (t, p) = profile(vec![]);
        let tag = RunTag::create(&token(), &p).unwrap();
        (t, tag)
    }

    #[test]
    fn tag_dir_is_never_inside_the_write_space() {
        let t = TempDir::new().unwrap();
        let a = fs::canonicalize(t.path()).unwrap().join("a");
        let b = fs::canonicalize(t.path()).unwrap().join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        // `a` is writable by the command: skipped, `b` is used.
        let (_t, p) = profile(vec![a.clone()]);
        let tag = RunTag::create_in(&token(), &p, &[a.clone(), b.clone()]).unwrap();
        assert!(tag.dir.starts_with(&b), "{:?}", tag.dir);
        drop(tag);
        // Every candidate writable: refuse.
        assert!(RunTag::create_in(&token(), &p, std::slice::from_ref(&a)).is_err());
        // The real candidates ignore TMPDIR and land outside the space.
        let tag = RunTag::create(&token(), &p).unwrap();
        assert!(!p.in_write_space(&tag.dir));
    }

    const INSIDE: i32 = 4242;
    const OUTSIDE: i32 = 4243;

    fn fake_working(pid: i32, op: Option<&CStr>, path: Option<&CStr>) -> c_int {
        let path = path.map(|p| p.to_string_lossy().into_owned());
        match (pid, op, path) {
            (INSIDE, None, _) => 1,
            (INSIDE, Some(_), Some(p)) if p.ends_with("/a") => 1,
            _ => 0,
        }
    }
    fn fake_minus_one(_: i32, _: Option<&CStr>, _: Option<&CStr>) -> c_int {
        -1
    }
    fn fake_zero(_: i32, _: Option<&CStr>, _: Option<&CStr>) -> c_int {
        0
    }
    fn fake_one(_: i32, _: Option<&CStr>, _: Option<&CStr>) -> c_int {
        1
    }
    fn fake_two(_: i32, _: Option<&CStr>, _: Option<&CStr>) -> c_int {
        2
    }
    /// Sees the probe but answers every path query "denied".
    fn fake_everything_denied(pid: i32, op: Option<&CStr>, _: Option<&CStr>) -> c_int {
        i32::from(pid == INSIDE || op.is_some())
    }

    #[test]
    fn self_test_rejects_every_failing_checker() {
        let (_t, t0) = tag();
        assert!(Probe::with_check(&t0, fake_working)
            .self_test(INSIDE, OUTSIDE)
            .is_ok());
        for bad in [
            fake_minus_one as CheckFn,
            fake_zero,
            fake_one,
            fake_two,
            fake_everything_denied,
        ] {
            assert!(Probe::with_check(&t0, bad)
                .self_test(INSIDE, OUTSIDE)
                .is_err());
        }
        // Unknown answers are surfaced as unknown, not as "not ours".
        assert_eq!(Probe::with_check(&t0, fake_minus_one).tagged(INSIDE), None);
        assert_eq!(Probe::with_check(&t0, fake_two).tagged(OUTSIDE), None);
    }

    #[test]
    fn real_checker_passes_self_test_against_a_sandboxed_probe() {
        let (_t, t0) = tag();
        let pol = format!(
            "(version 1)(allow default)(deny file-read* (literal \"{}\"))",
            t0.denied.display()
        );
        let mut c = std::process::Command::new(crate::exec_macos::SANDBOX_EXEC)
            .args(["-p", &pol, "--", "/bin/sleep", "5"])
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        // SAFETY: getpid cannot fail.
        let me = unsafe { libc::getpid() };
        let r = Probe::new(&t0).self_test(c.id() as i32, me);
        c.kill().unwrap();
        c.wait().unwrap();
        r.unwrap();
    }

    #[test]
    fn tracks_a_child_and_sees_it_die() {
        let (_t, t0) = tag();
        let mut child = std::process::Command::new("sleep")
            .arg("5")
            .spawn()
            .unwrap();
        // SAFETY: getpid cannot fail.
        let me = unsafe { libc::getpid() };
        let mut t = Tracker::new(me, &t0);
        t.poll();
        let pid = child.id() as i32;
        assert!(t.seen.contains_key(&pid));
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(!t.survivors(false).unwrap().contains(&pid));
    }

    #[test]
    fn sandbox_tag_identifies_only_this_runs_sandbox() {
        let (_t, t0) = tag();
        let policy = |deny: &Path| {
            format!(
                "(version 1)(deny default)(allow process-exec)(allow process-fork)\
                 (allow sysctl-read)(allow file-read*)(deny file-read* (literal \"{}\"))",
                deny.display()
            )
        };
        let spawn = |pol: String| {
            std::process::Command::new(crate::exec_macos::SANDBOX_EXEC)
                .args(["-p", &pol, "--", "/bin/sleep", "5"])
                .spawn()
                .unwrap()
        };
        let mut ours = spawn(policy(&t0.denied));
        let mut theirs = spawn(policy(&t0.allowed));
        let mut plain = std::process::Command::new("sleep")
            .arg("5")
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        // Root 1: no tree relation; only the sandbox tag can find them.
        let mut t = Tracker::new(1, &t0);
        let s = t.survivors(false).unwrap();
        assert!(s.contains(&(ours.id() as i32)), "{s:?}");
        assert!(!s.contains(&(theirs.id() as i32)));
        assert!(!s.contains(&(plain.id() as i32)));
        // The kill loop finds and kills ours, and only ours.
        let killed = t.kill_until_quiet().unwrap();
        assert!(killed.contains(&(ours.id() as i32)));
        assert!(ours.wait().unwrap().signal() == Some(libc::SIGKILL));
        assert!(theirs.try_wait().unwrap().is_none());
        assert!(plain.try_wait().unwrap().is_none());
        for c in [&mut theirs, &mut plain] {
            c.kill().unwrap();
            c.wait().unwrap();
        }
    }
}
