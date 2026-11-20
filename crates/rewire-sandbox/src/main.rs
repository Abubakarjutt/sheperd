//! rewire-sandbox: the enforcement boundary for every agent file op.
//!
//! Exit codes: 0 allowed/succeeded, 3 policy denial, 120 any setup or
//! internal error (malformed profile, I/O failure, usage error, panic).
//! Nothing but a fully successful, allowed operation exits 0.

mod canonical;
mod profile;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use profile::{Decision, Op, Profile};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const EXIT_DENY: u8 = 3;
const EXIT_INTERNAL: u8 = 120;

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
    CheckPath {
        #[arg(long)]
        profile: PathBuf,
        #[arg(long, value_enum)]
        op: OpArg,
        path: PathBuf,
    },
    /// Print a file's content to stdout if reading it is allowed.
    FsRead {
        #[arg(long)]
        profile: PathBuf,
        path: PathBuf,
    },
    /// Atomically write stdin to a file if writing it is allowed.
    FsWrite {
        #[arg(long)]
        profile: PathBuf,
        path: PathBuf,
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
    Denied { canonical: PathBuf, rule: String },
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
            let code = if e.use_stderr() { EXIT_INTERNAL } else { 0 };
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
        Err(e) => {
            eprintln!("rewire-sandbox: error: {e:#}");
            ExitCode::from(EXIT_INTERNAL)
        }
    }
}

fn run(cmd: Command) -> Result<Outcome> {
    match cmd {
        Command::CheckPath { profile, op, path } => {
            let profile = Profile::load(&profile)?;
            let decision = profile
                .decide(op.into(), &path)
                .with_context(|| format!("canonicalizing {}", path.display()))?;
            Ok(to_outcome(decision))
        }
        Command::FsRead { profile, path } => {
            let profile = Profile::load(&profile)?;
            let (decision, canonical) = decide(&profile, Op::Read, &path)?;
            if let Decision::Deny { .. } = decision {
                return Ok(to_outcome(decision));
            }
            fs_read(&canonical)?;
            Ok(Outcome::Done)
        }
        Command::FsWrite { profile, path } => {
            let profile = Profile::load(&profile)?;
            let (decision, canonical) = decide(&profile, Op::Write, &path)?;
            if let Decision::Deny { .. } = decision {
                return Ok(to_outcome(decision));
            }
            fs_write(&profile, &canonical)
        }
    }
}

fn decide(profile: &Profile, op: Op, path: &Path) -> Result<(Decision, PathBuf)> {
    let canonical = profile
        .canonical(path)
        .with_context(|| format!("canonicalizing {}", path.display()))?;
    Ok((profile.decide_canonical(op, canonical.clone()), canonical))
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
fn fs_write(profile: &Profile, canonical: &Path) -> Result<Outcome> {
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
        let rule = profile.write_denial(dir).or_else(|| {
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
    let result = write_tmp_and_rename(&tmp, canonical, &content, existing.as_ref());
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result?;
    Ok(Outcome::Done)
}

fn write_tmp_and_rename(
    tmp: &Path,
    target: &Path,
    content: &[u8],
    existing: Option<&fs::Metadata>,
) -> Result<()> {
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
    drop(f);
    // rename(2) replaces the directory entry; it never follows a symlink at
    // the target, and a hard link at the target is replaced, not written through.
    fs::rename(tmp, target).with_context(|| format!("renaming into {}", target.display()))?;
    Ok(())
}
