//! `rewire-sandbox ns-reap -- cmd args…`: the trusted first process inside
//! the Linux sandbox's pid namespace (bwrap runs it in place of the command).
//!
//! Without it, a process the command leaves behind (`sleep 30 &`, a
//! detached daemon) is silently killed when bwrap's init exits and the pid
//! namespace is torn down, so the run reports success. macOS reports such a
//! process as an escape (120); this makes Linux do the same:
//!
//! 1. run the command in its own process group (a `kill(0, …)` from the
//!    command never reaches the reaper) and wait for it;
//! 2. list the namespace's `/proc` (bwrap mounts a fresh procfs for it):
//!    any live process other than pid 1 (bwrap's init) and the reaper is a
//!    descendant that outlived the command;
//! 3. if there is one: `kill(-1, SIGKILL)` (every process in the namespace
//!    except init and the reaper, atomically from the kernel's view, so a
//!    fork chain cannot outrun it), report `sandbox: escaped descendant
//!    <pid>` (pid as seen in the namespace) and exit 120;
//! 4. otherwise pass the command's exit code through (128+signal for a
//!    signal death).
//!
//! The scan cannot miss a live process: after the command is reaped, only
//! processes that are still alive (or zombies, which are dead and skipped)
//! appear in /proc, and the namespace holds nothing else. A command that
//! kills the reaper itself (`kill -9 -1`) ends the run with a signal exit,
//! never a success, and the namespace teardown still kills everything.

use anyhow::{bail, Context, Result};
use std::ffi::OsString;
use std::fs;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::Command;

pub enum Reaped {
    Exited(u8),
    Escaped(i32),
}

pub fn run(cmd: &[OsString]) -> Result<Reaped> {
    let Some((program, args)) = cmd.split_first() else {
        bail!("ns-reap: no command");
    };
    let status = Command::new(program)
        .args(args)
        .process_group(0)
        .status()
        .with_context(|| format!("ns-reap: starting {program:?}"))?;
    let code = match (status.code(), status.signal()) {
        (Some(c), _) => (c & 0xff) as u8,
        (None, Some(sig)) => (128 + sig).clamp(0, 255) as u8,
        (None, None) => bail!("ns-reap: command ended without status"),
    };
    let me = i32::try_from(std::process::id()).context("pid out of range")?;
    let left = live_pids("/proc", me)?;
    if let Some(&first) = left.first() {
        // SAFETY: plain syscall. -1: every process we may signal in this pid
        // namespace except its init and ourselves.
        unsafe {
            libc::kill(-1, libc::SIGKILL);
        }
        return Ok(Reaped::Escaped(first));
    }
    Ok(Reaped::Exited(code))
}

/// Live pids under `proc` other than 1 and `me` (zombies are dead and
/// skipped). A listing failure is an error, never "none left".
pub fn live_pids(proc: &str, me: i32) -> Result<Vec<i32>> {
    let mut out = Vec::new();
    for e in fs::read_dir(proc).with_context(|| format!("ns-reap: listing {proc}"))? {
        let e = e.with_context(|| format!("ns-reap: listing {proc}"))?;
        let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<i32>().ok()) else {
            continue;
        };
        if pid == 1 || pid == me {
            continue;
        }
        // Gone between listing and reading: it is not alive.
        let Ok(stat) = fs::read_to_string(e.path().join("stat")) else {
            continue;
        };
        if state_of(&stat) != Some('Z') {
            out.push(pid);
        }
    }
    out.sort_unstable();
    Ok(out)
}

/// The state field of `/proc/<pid>/stat`: the first non-space after the
/// LAST `)` (the command name may itself contain `)` and spaces).
fn state_of(stat: &str) -> Option<char> {
    let rest = &stat[stat.rfind(')')? + 1..];
    rest.trim_start().chars().next()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn state_is_read_after_the_last_paren() {
        assert_eq!(state_of("42 (sleep) S 1 42 42"), Some('S'));
        assert_eq!(state_of("43 (a) Z (b)) R 1 2"), Some('R'));
        assert_eq!(state_of("44 (x) Z 1"), Some('Z'));
        assert_eq!(state_of("garbage"), None);
    }

    #[test]
    fn live_pids_skips_init_self_zombies_and_non_pids() {
        let t = TempDir::new().unwrap();
        let p = t.path();
        for (pid, stat) in [
            ("1", "1 (bwrap) S 0"),
            ("2", "2 (rewire-sandbox) S 1"),
            ("7", "7 (sleep) S 1"),
            ("8", "8 (dead) Z 1"),
            ("9", "9 (sh) R 1"),
        ] {
            fs::create_dir(p.join(pid)).unwrap();
            fs::write(p.join(pid).join("stat"), stat).unwrap();
        }
        fs::create_dir(p.join("self")).unwrap();
        fs::create_dir(p.join("10")).unwrap(); // exited: no stat file
        assert_eq!(live_pids(p.to_str().unwrap(), 2).unwrap(), vec![7, 9]);
        assert!(live_pids("/nonexistent-proc-dir", 2).is_err());
    }
}
