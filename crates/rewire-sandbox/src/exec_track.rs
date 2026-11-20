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
//! Remaining limitation: a process detaching faster than one poll interval
//! is still found by the sweep, but only after the command exits (it runs
//! until then, sandboxed).

use anyhow::{Context, Result};
use std::collections::HashMap;
use std::ffi::{c_char, c_int, CString};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

extern "C" {
    /// libsystem_sandbox (re-exported by libSystem). Returns 0 if `op` on
    /// the filter argument is allowed for `pid`, non-zero if denied; with a
    /// null `op`, non-zero iff `pid` is sandboxed.
    fn sandbox_check(pid: libc::pid_t, op: *const c_char, ty: c_int, ...) -> c_int;
}
const SANDBOX_FILTER_NONE: c_int = 0;
const SANDBOX_FILTER_PATH: c_int = 1;

/// The per-run tag files (removed on drop).
pub struct RunTag {
    dir: PathBuf,
    pub denied: PathBuf,
    allowed: PathBuf,
}

impl RunTag {
    pub fn create(token: &str) -> Result<RunTag> {
        let base = fs::canonicalize(std::env::temp_dir()).context("canonicalizing temp dir")?;
        let dir = base.join(format!("rewire-sandbox-tag-{token}"));
        fs::create_dir(&dir).with_context(|| format!("creating {}", dir.display()))?;
        let tag = RunTag {
            denied: dir.join("a"),
            allowed: dir.join("b"),
            dir,
        };
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

/// `pid` runs inside the sandbox tagged by (`denied`, `allowed`).
fn in_tagged_sandbox(pid: i32, denied: &CString, allowed: &CString) -> bool {
    let op = c"file-read-data";
    // SAFETY: valid NUL-terminated strings; the path filter takes one char*.
    unsafe {
        sandbox_check(pid, std::ptr::null(), SANDBOX_FILTER_NONE) != 0
            && sandbox_check(pid, op.as_ptr(), SANDBOX_FILTER_PATH, denied.as_ptr()) != 0
            && sandbox_check(pid, op.as_ptr(), SANDBOX_FILTER_PATH, allowed.as_ptr()) == 0
    }
}

pub struct Tracker {
    root: i32,
    /// Start time of the command, so a recycled root pid is never walked.
    root_start: Option<u64>,
    denied: CString,
    allowed: CString,
    /// pid → start time (µs since epoch).
    seen: HashMap<i32, u64>,
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
            denied: cpath(&tag.denied),
            allowed: cpath(&tag.allowed),
            seen: HashMap::new(),
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
    /// excluding the command itself.
    pub fn survivors(&self) -> Vec<i32> {
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
        for pid in all_pids() {
            if pid == me || pid == self.root || out.contains(&pid) {
                continue;
            }
            let Some(i) = info(pid) else { continue };
            if i.uid != uid || i.zombie {
                continue;
            }
            if in_tagged_sandbox(pid, &self.denied, &self.allowed) {
                out.push(pid);
            }
        }
        out.sort_unstable();
        out
    }

    /// SIGKILL every surviving descendant, and its process group when that
    /// group is led by a descendant (never a group we do not own).
    pub fn kill_all(&self) {
        let survivors = self.survivors();
        // SAFETY: getpgrp cannot fail.
        let own_group = unsafe { libc::getpgrp() };
        for &pid in &survivors {
            let pgid = info(pid).map(|i| i.pgid).unwrap_or(0);
            // SAFETY: plain syscalls; ESRCH is fine.
            unsafe {
                libc::kill(pid, libc::SIGKILL);
                let leader_is_ours = pgid == self.root || survivors.contains(&pgid);
                if pgid > 1 && pgid != own_group && leader_is_ours {
                    libc::kill(-pgid, libc::SIGKILL);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tag() -> RunTag {
        RunTag::create(&format!(
            "test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ))
        .unwrap()
    }

    #[test]
    fn tracks_a_child_and_sees_it_die() {
        let t0 = tag();
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
        assert!(!t.survivors().contains(&pid));
    }

    #[test]
    fn sandbox_tag_identifies_only_this_runs_sandbox() {
        let t0 = tag();
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
        let t = Tracker::new(1, &t0);
        let s = t.survivors();
        assert!(s.contains(&(ours.id() as i32)), "{s:?}");
        assert!(!s.contains(&(theirs.id() as i32)));
        assert!(!s.contains(&(plain.id() as i32)));
        for c in [&mut ours, &mut theirs, &mut plain] {
            c.kill().unwrap();
            c.wait().unwrap();
        }
    }
}
