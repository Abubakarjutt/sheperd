//! rewire-sandbox: the enforcement boundary for every agent file op.
//!
//! Exit codes: 0 allowed/succeeded, 3 policy denial, 120 any setup or
//! internal error (malformed profile, I/O failure, usage error, panic).
//! Nothing but a fully successful, allowed operation exits 0.
//! `exec` additionally passes through the child's exit code, and uses 124
//! (timeout) and 127 (command not found) — see `exec.rs`.

mod canonical;
mod exec;
mod exec_linux;
mod exec_macos;
#[cfg(target_os = "macos")]
mod exec_track;
mod profile;
mod reap;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use profile::{Decision, Op, Profile, Resolved};
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const EXIT_DENY: u8 = 3;
const EXIT_INTERNAL: u8 = 120;
/// Built-in rule: the target resolved differently just before the rename.
const RULE_PATH_CHANGED: &str = "<path-changed>";
const SUBCOMMANDS: [&str; 5] = ["check-path", "fs-read", "fs-write", "exec", "ns-reap"];

#[derive(Parser)]
#[command(
    name = "rewire-sandbox",
    version,
    about = "rewire sandbox enforcement boundary"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Decide whether an operation on a path is allowed (exit 0) or denied (exit 3).
    #[command(disable_help_flag = true)]
    CheckPath {
        #[arg(long)]
        profile: PathBuf,
        #[arg(long, value_enum)]
        op: OpArg,
        #[arg(allow_hyphen_values = true)]
        path: PathBuf,
    },
    /// Print a file's content to stdout if reading it is allowed.
    #[command(disable_help_flag = true)]
    FsRead {
        #[arg(long)]
        profile: PathBuf,
        #[arg(allow_hyphen_values = true)]
        path: PathBuf,
    },
    /// Atomically write stdin to a file if writing it is allowed.
    #[command(disable_help_flag = true)]
    FsWrite {
        #[arg(long)]
        profile: PathBuf,
        #[arg(allow_hyphen_values = true)]
        path: PathBuf,
    },
    /// Run a command under the OS sandbox: `exec --profile P -- cmd args…`.
    #[command(disable_help_flag = true)]
    Exec {
        #[arg(long)]
        profile: PathBuf,
        #[arg(long)]
        timeout_ms: Option<u64>,
        #[arg(long)]
        cwd: Option<PathBuf>,
        #[arg(last = true, required = true, num_args = 1..)]
        cmd: Vec<OsString>,
    },
    /// Internal (Linux): first process inside the sandbox's pid namespace;
    /// runs the command and reports any process it leaves behind (`reap.rs`).
    #[command(disable_help_flag = true, hide = true)]
    NsReap {
        #[arg(last = true, required = true, num_args = 1..)]
        cmd: Vec<OsString>,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum OpArg {
    Read,
    Write,
}

impl From<OpArg> for Op {
    fn from(o: OpArg) -> Op {
        match o {
            OpArg::Read => Op::Read,
            OpArg::Write => Op::Write,
        }
    }
}

/// Outcome of a successfully evaluated command.
enum Outcome {
    Done,
    Denied {
        canonical: PathBuf,
        rule: String,
    },
    /// `exec`: exit with this code (the child's, or 124 on timeout).
    Exit(u8),
    /// `exec`: the command could not be resolved.
    NotFound(String),
    /// `exec`: a descendant outlived the command (killed; exit 120).
    Escaped(i32),
    /// `exec`: terminated by a signal after the full sweep (exit 120).
    Terminated {
        signal: i32,
        escaped: Option<i32>,
    },
}

fn main() -> ExitCode {
    // A panic must never look like success (default panic exit is 101).
    std::panic::set_hook(Box::new(|info| {
        eprintln!("rewire-sandbox: internal error: {info}");
        std::process::exit(EXIT_INTERNAL.into());
    }));

    let cli = match Cli::try_parse() {
        Ok(c) => c,
        Err(e) => {
            // Only bare top-level `--help`/`--version` may exit 0: anything
            // naming a subcommand must reach a decision or exit 120.
            let informational = matches!(
                e.kind(),
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
            );
            let names_subcommand = std::env::args()
                .skip(1)
                .any(|a| SUBCOMMANDS.contains(&a.as_str()));
            let code = if informational && !names_subcommand {
                0
            } else {
                EXIT_INTERNAL
            };
            let _ = e.print();
            return ExitCode::from(code);
        }
    };

    match run(cli.command) {
        Ok(Outcome::Done) => ExitCode::SUCCESS,
        Ok(Outcome::Denied { canonical, rule }) => {
            let line = serde_json::json!({ "denied": canonical, "rule": rule });
            eprintln!("{line}");
            ExitCode::from(EXIT_DENY)
        }
        Ok(Outcome::Exit(code)) => ExitCode::from(code),
        Ok(Outcome::NotFound(cmd)) => {
            eprintln!("command not found: {cmd}");
            ExitCode::from(exec::EXIT_NOT_FOUND)
        }
        Ok(Outcome::Escaped(pid)) => {
            eprintln!("sandbox: escaped descendant {pid}");
            ExitCode::from(EXIT_INTERNAL)
        }
        Ok(Outcome::Terminated { signal, escaped }) => {
            eprintln!("sandbox: terminated by signal {signal}");
            if let Some(pid) = escaped {
                eprintln!("sandbox: escaped descendant {pid}");
            }
            ExitCode::from(EXIT_INTERNAL)
        }
        Err(e) => {
            eprintln!("rewire-sandbox: error: {e:#}");
            ExitCode::from(EXIT_INTERNAL)
        }
    }
}

fn run(cmd: Command) -> Result<Outcome> {
    match cmd {
        Command::NsReap { cmd } => Ok(match reap::run(&cmd)? {
            reap::Reaped::Exited(c) => Outcome::Exit(c),
            reap::Reaped::Escaped(pid) => Outcome::Escaped(pid),
        }),
        Command::CheckPath { profile, op, path } => {
            let profile = Profile::load(&profile)?;
            let decision = profile
                .decide(op.into(), &path)
                .with_context(|| format!("canonicalizing {}", path.display()))?;
            Ok(to_outcome(decision))
        }
        Command::FsRead { profile, path } => {
            let profile = Profile::load(&profile)?;
            let (decision, resolved) = decide(&profile, Op::Read, &path)?;
            if let Decision::Deny { .. } = decision {
                return Ok(to_outcome(decision));
            }
            fs_read(&resolved.canonical)?;
            Ok(Outcome::Done)
        }
        Command::FsWrite { profile, path } => {
            let profile = Profile::load(&profile)?;
            let (decision, resolved) = decide(&profile, Op::Write, &path)?;
            if let Decision::Deny { .. } = decision {
                return Ok(to_outcome(decision));
            }
            fs_write(&profile, &path, &resolved)
        }
        Command::Exec {
            profile,
            timeout_ms,
            cwd,
            cmd,
        } => Ok(
            match exec::run(exec::ExecArgs {
                profile,
                timeout_ms,
                cwd,
                cmd,
            })? {
                exec::ExecOutcome::Exited(c) => Outcome::Exit(c),
                exec::ExecOutcome::Denied { canonical, rule } => {
                    Outcome::Denied { canonical, rule }
                }
                exec::ExecOutcome::NotFound(c) => Outcome::NotFound(c),
                exec::ExecOutcome::Escaped(pid) => Outcome::Escaped(pid),
                exec::ExecOutcome::Terminated { signal, escaped } => {
                    Outcome::Terminated { signal, escaped }
                }
            },
        ),
    }
}

fn decide(profile: &Profile, op: Op, path: &Path) -> Result<(Decision, Resolved)> {
    let resolved = profile
        .resolve(path)
        .with_context(|| format!("canonicalizing {}", path.display()))?;
    Ok((profile.decide_resolved(op, &resolved), resolved))
}

fn to_outcome(d: Decision) -> Outcome {
    match d {
        Decision::Allow => Outcome::Done,
        Decision::Deny { canonical, rule } => Outcome::Denied { canonical, rule },
    }
}

/// Read the canonical (already-decided) path, never the caller's spelling.
fn fs_read(canonical: &Path) -> Result<()> {
    let data = fs::read(canonical).with_context(|| format!("reading {}", canonical.display()))?;
    let mut out = io::stdout().lock();
    out.write_all(&data).context("writing stdout")?;
    out.flush().context("flushing stdout")?;
    Ok(())
}

/// Atomic write to an allowed canonical path: create missing parents (each
/// re-checked against the deny rules), write a temp file in the target
/// directory, fsync, then rename over the target.
///
/// TOCTOU: a concurrent process could swap a directory for a symlink between
/// the decision and the write. Accepted for v0.1; the OS sandbox around
/// `exec` (Task 4) is the backstop.
fn fs_write(profile: &Profile, path: &Path, resolved: &Resolved) -> Result<Outcome> {
    let canonical = resolved.canonical.as_path();
    let parent = canonical
        .parent()
        .with_context(|| format!("no parent directory for {}", canonical.display()))?;
    let name = canonical
        .file_name()
        .with_context(|| format!("no file name in {}", canonical.display()))?;

    // Missing ancestors, outermost first. Each must be inside root or an
    // extraWrite dir (a missing extraWrite dir's own parents are not) and
    // must not hit a deny rule.
    let mut missing: Vec<&Path> = parent
        .ancestors()
        .take_while(|a| fs::symlink_metadata(a).is_err())
        .collect();
    missing.reverse();
    for dir in &missing {
        let rule = profile.write_denial(&[dir]).or_else(|| {
            (!profile.in_write_space(dir)).then(|| profile::RULE_OUTSIDE_ROOT.to_owned())
        });
        if let Some(rule) = rule {
            return Ok(Outcome::Denied {
                canonical: dir.to_path_buf(),
                rule,
            });
        }
    }
    if !missing.is_empty() {
        fs::create_dir_all(parent)
            .with_context(|| format!("creating parents of {}", canonical.display()))?;
    }

    let existing = match fs::symlink_metadata(canonical) {
        Ok(m) => Some(m),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(e).context(format!("stat {}", canonical.display())),
    };
    if let Some(m) = &existing {
        if !m.is_file() {
            bail!(
                "refusing to write over non-regular file {}",
                canonical.display()
            );
        }
    }

    let mut content = Vec::new();
    io::stdin()
        .read_to_end(&mut content)
        .context("reading stdin")?;

    let tmp = parent.join(format!(
        ".{}.rewire-tmp-{}-{}",
        name.to_string_lossy(),
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let result = write_tmp(&tmp, &content, existing.as_ref())
        .and_then(|()| recheck(profile, path, resolved))
        .and_then(|outcome| match outcome {
            Outcome::Done => fs::rename(&tmp, canonical)
                .with_context(|| format!("renaming into {}", canonical.display()))
                .map(|()| Outcome::Done),
            denied => Ok(denied),
        });
    if !matches!(result, Ok(Outcome::Done)) {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Belt and braces, right before the rename: re-resolve the caller's path
/// now that parents exist. If the canonical target moved (e.g. a created
/// directory aliased an existing one) or the decision flipped, deny.
fn recheck(profile: &Profile, path: &Path, before: &Resolved) -> Result<Outcome> {
    let (decision, now) = decide(profile, Op::Write, path)?;
    if let Decision::Deny { .. } = decision {
        return Ok(to_outcome(decision));
    }
    if now.canonical != before.canonical {
        return Ok(Outcome::Denied {
            canonical: now.canonical,
            rule: RULE_PATH_CHANGED.to_owned(),
        });
    }
    Ok(Outcome::Done)
}

fn write_tmp(tmp: &Path, content: &[u8], existing: Option<&fs::Metadata>) -> Result<()> {
    // create_new = O_EXCL: never follows or reuses a pre-planted file/symlink.
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(tmp)
        .with_context(|| format!("creating temp file {}", tmp.display()))?;
    f.write_all(content).context("writing temp file")?;
    if let Some(m) = existing {
        f.set_permissions(m.permissions())
            .context("copying permissions")?;
    }
    f.sync_all().context("syncing temp file")?;
    // The caller renames it over the target: rename(2) replaces the
    // directory entry, never follows a symlink at the target, and replaces
    // (rather than writes through) a hard link.
    Ok(())
}
