//! Black-box tests for `rewire-sandbox exec`: the OS sandbox must stop what
//! the path checks cannot see (shell redirects, symlinks, renames, network).
//!
//! On Linux these need `bwrap` installed; macOS uses /usr/bin/sandbox-exec.
#![cfg(any(target_os = "macos", target_os = "linux"))]

use assert_cmd::Command;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tempfile::TempDir;

const DENY: i32 = 3;
const TIMEOUT: i32 = 124;
const NOT_FOUND: i32 = 127;
const INTERNAL: i32 = 120;

/// Serialises tests that briefly hold inheritable fds with the test that
/// counts the fds a command inherits.
static FD_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct Fixture {
    _tmp: TempDir,
    /// Canonical temp dir (macOS: /private/var/...).
    base: PathBuf,
    root: PathBuf,
    profile: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        Self::with(|_| {})
    }

    fn with(tweak: impl FnOnce(&mut Value)) -> Self {
        let tmp = TempDir::new().unwrap();
        let base = fs::canonicalize(tmp.path()).unwrap();
        let root = base.join("root");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("tests")).unwrap();
        fs::create_dir_all(root.join("secret")).unwrap();
        fs::write(root.join("secret/key"), "topsecret").unwrap();
        fs::write(root.join("tests/existing.test.ts"), "original").unwrap();
        // `write: **` so every denial below comes from a deny rule, not
        // from a path merely lacking a write rule.
        let mut profile_json = json!({
            "root": root,
            "write": ["**"],
            "writeDeny": ["tests/**"],
            "readDeny": ["secret/**"],
            "network": "deny",
            "extraWrite": [],
        });
        tweak(&mut profile_json);
        let profile = base.join("profile.json");
        fs::write(&profile, profile_json.to_string()).unwrap();
        Fixture {
            _tmp: tmp,
            base,
            root,
            profile,
        }
    }

    fn exec(&self, extra: &[&str], cmd: &[&str]) -> Command {
        let mut c = Command::cargo_bin("rewire-sandbox").unwrap();
        c.current_dir(&self.root)
            .arg("exec")
            .arg("--profile")
            .arg(&self.profile)
            .args(extra)
            .arg("--")
            .args(cmd);
        c
    }

    fn sh(&self, script: &str) -> assert_cmd::assert::Assert {
        self.exec(&[], &["sh", "-c", script]).assert()
    }
}

fn code(a: &assert_cmd::assert::Assert) -> i32 {
    a.get_output().status.code().expect("exited by signal")
}

fn stderr(a: &assert_cmd::assert::Assert) -> String {
    String::from_utf8_lossy(&a.get_output().stderr).into_owned()
}

#[test]
fn exec_can_write_allowed_path() {
    let f = Fixture::new();
    let a = f.sh("echo hi > src/a.txt");
    assert_eq!(code(&a), 0, "{}", stderr(&a));
    assert_eq!(
        fs::read_to_string(f.root.join("src/a.txt")).unwrap(),
        "hi\n"
    );
}

#[test]
fn exec_passes_through_exit_code_and_output() {
    let f = Fixture::new();
    let a = f.sh("echo out; echo err >&2; exit 42");
    assert_eq!(code(&a), 42);
    assert_eq!(a.get_output().stdout, b"out\n");
    assert!(stderr(&a).contains("err"));
}

#[test]
fn exec_default_cwd_is_root() {
    let f = Fixture::new();
    let a = f.exec(&[], &["pwd", "-P"]).assert();
    assert_eq!(code(&a), 0, "{}", stderr(&a));
    let out = String::from_utf8(a.get_output().stdout.clone()).unwrap();
    assert_eq!(out.trim_end(), f.root.to_str().unwrap());
}

#[test]
fn exec_cannot_write_test_dir_via_shell() {
    let f = Fixture::new();
    let a = f.sh("echo x > tests/a.test.ts");
    assert_ne!(code(&a), 0);
    assert!(!f.root.join("tests/a.test.ts").exists());
    let a = f.sh("echo x > tests/existing.test.ts");
    assert_ne!(code(&a), 0);
    let a = f.sh("rm tests/existing.test.ts");
    assert_ne!(code(&a), 0);
    assert_eq!(
        fs::read_to_string(f.root.join("tests/existing.test.ts")).unwrap(),
        "original"
    );
}

/// Case-insensitive matching is a property of macOS's APFS + Seatbelt;
/// on case-sensitive Linux `TESTS` is simply a different directory.
#[cfg(target_os = "macos")]
#[test]
fn exec_cannot_write_case_variant_of_denied_dir() {
    let f = Fixture::new();
    let a = f.sh("mkdir -p TESTS; echo x > TESTS/a.test.ts");
    assert_ne!(code(&a), 0);
    assert!(!f.root.join("tests/a.test.ts").exists());
    assert!(!f.root.join("TESTS/a.test.ts").exists());
}

#[test]
fn exec_creates_missing_deny_dir_and_denies_it() {
    let f = Fixture::with(|p| p["writeDeny"] = json!(["spec/**"]));
    assert!(!f.root.join("spec").exists());
    let a = f.sh("mkdir -p Spec; echo x > Spec/a.ts; echo y > spec/b.ts");
    assert_ne!(code(&a), 0);
    assert!(f.root.join("spec").is_dir(), "deny dir must be created");
    assert!(!f.root.join("spec/a.ts").exists());
    assert!(!f.root.join("spec/b.ts").exists());
}

#[test]
fn exec_never_creates_deny_dirs_outside_root() {
    let f = Fixture::with(|p| {
        let root = PathBuf::from(p["root"].as_str().unwrap());
        let outside = root.parent().unwrap().join("elsewhere");
        p["writeDeny"] = json!([format!("{}/**", outside.display())]);
    });
    let a = f.sh("true");
    assert_eq!(code(&a), 0, "{}", stderr(&a));
    assert!(!f.base.join("elsewhere").exists());
}

#[test]
fn exec_cannot_create_symlink_inside_denied_dir() {
    let f = Fixture::new();
    let a = f.sh("ln -s ../src/x tests/link.test.ts");
    assert_ne!(code(&a), 0);
    assert!(fs::symlink_metadata(f.root.join("tests/link.test.ts")).is_err());
}

#[test]
fn exec_cannot_escape_deny_by_renaming_a_parent() {
    let f = Fixture::with(|p| p["writeDeny"] = json!(["src/sub/tests/**"]));
    fs::create_dir_all(f.root.join("src/sub/tests")).unwrap();
    let a = f.sh("mv src/sub src/sub2 && echo x > src/sub2/tests/evil.ts");
    assert_ne!(code(&a), 0);
    // Linux: the rename may succeed, but the ro bind mount moves with the
    // dentry, so the write still fails. macOS: the rename itself is denied.
    assert!(!f.root.join("src/sub/tests/evil.ts").exists());
    assert!(!f.root.join("src/sub2/tests/evil.ts").exists());
    #[cfg(target_os = "macos")]
    {
        assert!(f.root.join("src/sub/tests").is_dir());
        assert!(!f.root.join("src/sub2").exists());
    }
    #[cfg(target_os = "linux")]
    if f.root.join("src/sub2").exists() {
        fs::rename(f.root.join("src/sub2"), f.root.join("src/sub")).unwrap();
    }
    // Ancestors stay usable for ordinary writes.
    let a = f.sh("echo ok > src/sub/fine.ts && mkdir src/sub/d");
    assert_eq!(code(&a), 0, "{}", stderr(&a));
}

/// Linux binds cannot protect a `.git` created after the sandbox starts.
#[cfg(target_os = "macos")]
#[test]
fn exec_cannot_write_nested_git_hooks() {
    let f = Fixture::new();
    let a = f.sh("mkdir -p src/.git/hooks && echo x > src/.git/hooks/x");
    assert_ne!(code(&a), 0);
    assert!(!f.root.join("src/.git/hooks/x").exists());
    let a = f.sh("mkdir -p src/.GIT/hooks && echo x > src/.GIT/hooks/y");
    assert_ne!(code(&a), 0);
    assert!(!f.root.join("src/.git/hooks/y").exists());
}

#[test]
fn exec_cannot_write_root_git_dir() {
    let f = Fixture::new();
    fs::create_dir_all(f.root.join(".git/hooks")).unwrap();
    let a = f.sh("echo x > .git/hooks/pre-commit");
    assert_ne!(code(&a), 0);
    assert!(!f.root.join(".git/hooks/pre-commit").exists());
}

#[test]
fn exec_cannot_write_outside_write_rules() {
    let f = Fixture::with(|p| p["write"] = json!(["src/**"]));
    for target in [
        f.root.join("README.md"),
        f.base.join("outside.txt"),
        std::env::temp_dir().join(format!("rewire-exec-{}", std::process::id())),
    ] {
        let a = f.sh(&format!("echo x > '{}'", target.display()));
        // Linux: /tmp is a private tmpfs, so a write there "succeeds" but
        // never reaches the host. Everywhere else it must fail.
        let private_tmp = cfg!(target_os = "linux") && target.starts_with("/tmp");
        if !private_tmp {
            assert_ne!(code(&a), 0, "{}", target.display());
        }
        assert!(!target.exists(), "{}", target.display());
    }
}

#[test]
fn exec_extra_write_is_writable() {
    let tmp = TempDir::new().unwrap();
    let scratch = fs::canonicalize(tmp.path()).unwrap().join("scratch");
    fs::create_dir_all(&scratch).unwrap();
    let s = scratch.clone();
    let f = Fixture::with(move |p| p["extraWrite"] = json!([s]));
    let a = f.sh(&format!("echo x > '{}/out'", scratch.display()));
    assert_eq!(code(&a), 0, "{}", stderr(&a));
    assert!(scratch.join("out").exists());
}

#[test]
fn exec_cannot_read_denied_file() {
    let f = Fixture::new();
    let a = f.exec(&[], &["cat", "secret/key"]).assert();
    assert_ne!(code(&a), 0);
    assert!(!String::from_utf8_lossy(&a.get_output().stdout).contains("topsecret"));
    let a = f.sh("cat SECRET/key; cp secret/key src/copy");
    assert!(!String::from_utf8_lossy(&a.get_output().stdout).contains("topsecret"));
    assert!(!f.root.join("src/copy").exists());
}

#[test]
fn exec_has_no_network() {
    let f = Fixture::new();
    let a = f
        .exec(
            &[],
            &[
                "node",
                "-e",
                "fetch('https://example.com').then(()=>process.exit(0),()=>process.exit(7))",
            ],
        )
        .assert();
    assert_eq!(code(&a), 7, "{}", stderr(&a));
}

#[test]
fn exec_timeout_kills_and_exits_124() {
    let f = Fixture::new();
    let start = Instant::now();
    // The background grandchild must die with the group, not just `sh`.
    let a = f
        .exec(
            &["--timeout-ms", "200"],
            &["sh", "-c", "(sleep 1; echo late > src/late) & sleep 10"],
        )
        .assert();
    assert_eq!(code(&a), TIMEOUT);
    assert!(start.elapsed() < Duration::from_secs(5));
    std::thread::sleep(Duration::from_millis(1500));
    assert!(!f.root.join("src/late").exists(), "process group survived");
}

#[test]
fn exec_tilde_pattern_is_internal_error() {
    let f = Fixture::with(|p| p["readDeny"] = json!(["~/.ssh/**"]));
    let a = f.sh("echo ran > src/marker");
    assert_eq!(code(&a), INTERNAL);
    assert!(!f.root.join("src/marker").exists());
}

#[test]
fn exec_cwd_outside_root_is_denied() {
    let f = Fixture::new();
    let a = f
        .exec(
            &["--cwd", f.base.to_str().unwrap()],
            &["sh", "-c", "touch m"],
        )
        .assert();
    assert_eq!(code(&a), DENY);
    let line: Value = serde_json::from_str(stderr(&a).trim_end()).unwrap();
    assert_eq!(line["denied"], json!(f.base));
    assert_eq!(line["rule"], json!("<outside-root>"));
    assert!(!f.base.join("m").exists());
}

#[test]
fn exec_cwd_inside_root_is_used() {
    let f = Fixture::new();
    let a = f
        .exec(&["--cwd", "src"], &["sh", "-c", "echo x > here"])
        .assert();
    assert_eq!(code(&a), 0, "{}", stderr(&a));
    assert!(f.root.join("src/here").exists());
}

#[test]
fn exec_command_not_found_exits_127() {
    let f = Fixture::new();
    let a = f.exec(&[], &["rewire-no-such-cmd-xyz", "a"]).assert();
    assert_eq!(code(&a), NOT_FOUND);
    assert_eq!(stderr(&a), "command not found: rewire-no-such-cmd-xyz\n");
}

#[test]
fn exec_requires_a_command() {
    let f = Fixture::new();
    let a = f.exec(&[], &[]).assert();
    assert_eq!(code(&a), INTERNAL);
}

#[test]
fn exec_bad_profile_is_internal_error_without_running() {
    let f = Fixture::new();
    fs::write(&f.profile, "{").unwrap();
    let a = f.sh("echo ran > src/marker");
    assert_eq!(code(&a), INTERNAL);
    assert!(!f.root.join("src/marker").exists());
}

/// bwrap is only taken from fixed trusted paths, never PATH; the
/// fail-closed `REWIRE_SANDBOX_DISABLE_BWRAP` switch simulates it missing.
#[cfg(target_os = "linux")]
#[test]
fn exec_missing_bwrap_exits_120_without_running() {
    let f = Fixture::new();
    let a = f
        .exec(&[], &["sh", "-c", "touch src/marker"])
        .env("REWIRE_SANDBOX_DISABLE_BWRAP", "1")
        .assert();
    assert_eq!(code(&a), INTERNAL);
    assert!(!f.root.join("src/marker").exists());
}

/// Rename a parent of a deny match out from under the glob, write, and
/// rename back: the protected file must be untouched.
fn assert_rename_escape_blocked(write_deny: &str, setup_dir: &str, script: &str, file: &str) {
    let wd = write_deny.to_owned();
    let f = Fixture::with(move |p| p["writeDeny"] = json!([wd]));
    fs::create_dir_all(f.root.join(setup_dir)).unwrap();
    fs::write(f.root.join(file), "original").unwrap();
    let a = f.sh(script);
    assert_ne!(code(&a), 0, "{write_deny}: {}", stderr(&a));
    assert_eq!(
        fs::read_to_string(f.root.join(file)).unwrap_or_default(),
        "original",
        "{write_deny}"
    );
}

#[test]
fn exec_rename_escape_partial_star_segment() {
    assert_rename_escape_blocked(
        "packages/*-api/tests/**",
        "packages/foo-api/tests",
        "mv packages/foo-api packages/foo && echo PWN > packages/foo/tests/a.test.ts; \
         mv packages/foo packages/foo-api; cat packages/foo-api/tests/a.test.ts | grep -q PWN",
        "packages/foo-api/tests/a.test.ts",
    );
}

#[test]
fn exec_rename_escape_brace_segment() {
    assert_rename_escape_blocked(
        "src/{a,b}/tests/**",
        "src/a/tests",
        "mv src/a src/c && echo PWN > src/c/tests/a.test.ts; mv src/c src/a; \
         grep -q PWN src/a/tests/a.test.ts",
        "src/a/tests/a.test.ts",
    );
}

#[test]
fn exec_rename_escape_top_level_brace() {
    assert_rename_escape_blocked(
        "{src,lib}/__tests__/**",
        "lib/__tests__",
        "mv lib lib2 && echo PWN > lib2/__tests__/a.test.ts; mv lib2 lib; \
         grep -q PWN lib/__tests__/a.test.ts",
        "lib/__tests__/a.test.ts",
    );
}

#[test]
fn exec_rename_escape_class_segment() {
    assert_rename_escape_blocked(
        "l[i]b/__tests__/**",
        "lib/__tests__",
        "mv lib lib2 && echo PWN > lib2/__tests__/a.test.ts; mv lib2 lib; \
         grep -q PWN lib/__tests__/a.test.ts",
        "lib/__tests__/a.test.ts",
    );
}

fn assert_read_rename_escape_blocked(read_deny: &str, script: &str) {
    let rd = read_deny.to_owned();
    let f = Fixture::with(move |p| p["readDeny"] = json!([rd]));
    fs::create_dir_all(f.root.join("config/prod")).unwrap();
    fs::write(f.root.join("config/prod/key"), "SECRET").unwrap();
    let a = f.sh(script);
    let out = String::from_utf8_lossy(&a.get_output().stdout).into_owned();
    assert!(!out.contains("SECRET"), "{read_deny}: leaked");
}

#[test]
fn exec_read_rename_escape_brace() {
    assert_read_rename_escape_blocked("{config,secrets}/prod/**", "mv config c2; cat c2/prod/key");
}

#[test]
fn exec_read_rename_escape_partial_star() {
    assert_read_rename_escape_blocked("conf*/prod/**", "mv config xx; cat xx/prod/key");
}

#[test]
fn exec_read_rename_escape_inner_dir() {
    assert_read_rename_escape_blocked(
        "config/prod/**",
        "mv config/prod config/p2; cat config/p2/key",
    );
}

/// A descendant that detaches (new session) and outlives the command must
/// be killed and reported (120). macOS: descendant tracking. Linux: the
/// in-namespace reaper (`reap.rs`); the pid namespace dies with bwrap too.
fn assert_detached_killed(cmd: &[&str]) {
    let f = Fixture::new();
    let a = f.exec(&[], cmd).assert();
    assert_eq!(code(&a), INTERNAL, "{}", stderr(&a));
    assert!(
        stderr(&a).contains("sandbox: escaped descendant "),
        "{}",
        stderr(&a)
    );
    std::thread::sleep(Duration::from_millis(2000));
    assert!(
        !f.root.join("src/late").exists(),
        "detached descendant survived"
    );
}

/// `cmd &` leaves a process behind: reported as an escape on every
/// platform, never a silent success, and the run does not wait for it.
#[test]
fn exec_background_process_is_reported() {
    let f = Fixture::new();
    let start = Instant::now();
    let a = f.sh("sleep 30 & echo started");
    assert_eq!(code(&a), INTERNAL, "{}", stderr(&a));
    assert!(
        stderr(&a).contains("sandbox: escaped descendant "),
        "{}",
        stderr(&a)
    );
    assert!(String::from_utf8_lossy(&a.get_output().stdout).contains("started"));
    assert!(
        start.elapsed() < Duration::from_secs(20),
        "waited for the background job"
    );
}

/// A child still finishing when the command returns (a test runner's worker
/// shutting down) is not an escape: leftovers get a short settle grace to
/// exit on their own. Anything alive after it is still reported (above).
#[test]
fn exec_child_exiting_just_after_the_command_is_not_an_escape() {
    let f = Fixture::new();
    for _ in 0..5 {
        let a = f.sh("(sleep 0.1; :) & exit 0");
        assert_eq!(code(&a), 0, "{}", stderr(&a));
    }
}

/// Exit codes still pass through when nothing is left behind, a signal
/// death is 128+signal, and a command killing its own process group does
/// not take the Linux reaper down with it.
#[test]
fn exec_exit_and_signal_codes_pass_through() {
    let f = Fixture::new();
    assert_eq!(code(&f.sh("sleep 0.2 & wait; exit 7")), 7);
    let a = f.sh("kill -9 0");
    assert_eq!(code(&a), 137, "{}", stderr(&a));
    assert!(!stderr(&a).contains("escaped"), "{}", stderr(&a));
}

#[test]
fn exec_detached_node_child_is_killed() {
    assert_detached_killed(&[
        "node",
        "-e",
        "require('child_process').spawn('sh',['-c','sleep 1; echo x > src/late'],\
         {detached:true,stdio:'ignore'}).unref()",
    ]);
}

#[test]
fn exec_setsid_fork_is_killed() {
    assert_detached_killed(&[
        "perl",
        "-MPOSIX",
        "-e",
        "if (!fork) { POSIX::setsid(); sleep 1; open(F, '>src/late'); print F 'x'; exit }",
    ]);
}

#[test]
fn exec_scrubs_environment() {
    let f = Fixture::new();
    let a = f
        .exec(&[], &["env"])
        .env("SSH_AUTH_SOCK", "/tmp/agent.sock")
        .env("DBUS_SESSION_BUS_ADDRESS", "unix:path=/x")
        .env("GH_TOKEN", "ghp_x")
        .env("GITHUB_TOKEN", "x")
        .env("AWS_ACCESS_KEY_ID", "x")
        .env("NPM_TOKEN", "x")
        .env("MY_API_KEY", "x")
        .env("DB_SECRET", "x")
        .env("RANDOM_OTHER", "x")
        .env("LANG", "C")
        .env("LC_ALL", "C")
        .assert();
    assert_eq!(code(&a), 0, "{}", stderr(&a));
    let out = String::from_utf8_lossy(&a.get_output().stdout).into_owned();
    let names: Vec<&str> = out.lines().filter_map(|l| l.split('=').next()).collect();
    for bad in [
        "SSH_AUTH_SOCK",
        "DBUS_SESSION_BUS_ADDRESS",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "AWS_ACCESS_KEY_ID",
        "NPM_TOKEN",
        "MY_API_KEY",
        "DB_SECRET",
        "RANDOM_OTHER",
    ] {
        assert!(!names.contains(&bad), "{bad} leaked: {out}");
    }
    for good in ["PATH", "LANG", "LC_ALL"] {
        assert!(names.contains(&good), "{good} missing: {out}");
    }
}

/// Host unix sockets (ssh-agent, docker.sock, dbus) must not be reachable.
fn assert_unix_socket_denied(network: &'static str) {
    let f = Fixture::with(move |p| p["network"] = json!(network));
    let sock = f.base.join("s.sock");
    let _listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
    let script = format!(
        "require('net').connect('{}').on('connect',()=>process.exit(0)).on('error',()=>process.exit(7))",
        sock.display()
    );
    let a = f.exec(&[], &["node", "-e", &script]).assert();
    assert_eq!(code(&a), 7, "{network}: {}", stderr(&a));
}

#[test]
fn exec_cannot_connect_host_unix_socket() {
    assert_unix_socket_denied("deny");
    assert_unix_socket_denied("registry");
}

/// N1: the tag dir must not be reachable through a caller-chosen TMPDIR
/// inside extraWrite. The command tries to move every tag dir it can see
/// and plant a decoy (symlink to a dir with fresh `a`/`b`), then leaves a
/// fast double-forked survivor. The tag must be untouched, so the survivor
/// is found (120) and killed.
#[cfg(target_os = "macos")]
#[test]
fn exec_tag_dir_tamper_cannot_hide_a_survivor() {
    let f = Fixture::with(|p| {
        let scratch = p["root"].as_str().unwrap().replace("/root", "/scratch");
        p["extraWrite"] = json!([scratch]);
    });
    let scratch = f.base.join("scratch");
    fs::create_dir_all(&scratch).unwrap();
    let script = r#"
for d in "$TMPDIR"/rewire-sandbox-tag-* /private/tmp/rewire-sandbox-tag-* /private/var/tmp/rewire-sandbox-tag-* "$(getconf DARWIN_USER_TEMP_DIR)"rewire-sandbox-tag-*; do
  [ -d "$d" ] || continue
  mv "$d" "$d.moved" 2>/dev/null || continue
  mkdir -p "$TMPDIR/decoy" && : > "$TMPDIR/decoy/a" && : > "$TMPDIR/decoy/b"
  ln -s "$TMPDIR/decoy" "$d"
done
perl -e 'exit if fork; exit if fork; sleep 1; open(F, ">src/late"); print F "x"'
"#;
    let a = f
        .exec(&[], &["sh", "-c", script])
        .env("TMPDIR", &scratch)
        .assert();
    assert_eq!(code(&a), INTERNAL, "{}", stderr(&a));
    assert!(
        stderr(&a).contains("sandbox: escaped descendant "),
        "{}",
        stderr(&a)
    );
    std::thread::sleep(Duration::from_millis(2000));
    assert!(!f.root.join("src/late").exists(), "survivor ran");
}

/// N3: a pid-hopping chain (fork, parent exits, child setsid()s, repeat as
/// fast as the kernel allows) is always reported (120, escaped descendant)
/// and usually killed; see the R8 note in the loop. The chain appends a
/// heartbeat every 20 ms. Written in C because perl forks too slowly to race
/// the sweep.
#[cfg(target_os = "macos")]
#[test]
fn exec_pid_hopping_chain_is_killed() {
    const HOP_C: &str = r#"
#include <fcntl.h>
#include <sys/time.h>
#include <unistd.h>
static double now(void) { struct timeval t; gettimeofday(&t, 0); return t.tv_sec + t.tv_usec / 1e6; }
int main(int argc, char **argv) {
  if (argc < 2 || fork()) _exit(0);
  close(0); close(1); close(2); /* let the test's output pipes close */
  int fd = open(argv[1], O_WRONLY | O_APPEND | O_CREAT, 0644);
  double end = now() + 8, next = 0;
  for (;;) {
    double t = now();
    if (t > end) _exit(0);
    if (t >= next) { write(fd, "x", 1); next = t + 0.02; }
    pid_t p = fork();
    if (p < 0) _exit(1);
    if (p > 0) _exit(0);
    setsid(); /* new session + group per link: group kills cannot help */
  }
}
"#;
    let f = Fixture::new();
    let src = f.base.join("hop.c");
    let bin = f.base.join("hop");
    fs::write(&src, HOP_C).unwrap();
    let cc = std::process::Command::new("cc")
        .args(["-O2", "-o"])
        .arg(&bin)
        .arg(&src)
        .status()
        .expect("cc is needed to build the hop chain");
    assert!(cc.success());
    let mut survived = 0;
    for i in 0..10 {
        let hb = f.root.join(format!("src/hb{i}"));
        let a = f
            .exec(&[], &[bin.to_str().unwrap(), hb.to_str().unwrap()])
            .assert();
        assert_eq!(code(&a), INTERNAL, "{}", stderr(&a));
        assert!(
            stderr(&a).contains("sandbox: escaped descendant "),
            "{}",
            stderr(&a)
        );
        // The guarantee is the two assertions above: every run fails closed
        // with the escape reported. Killing the chain is best-effort on
        // macOS (R8, documented): a link that forks and exits faster than a
        // sweep's list-then-check is gone before it is checked and its child
        // was not listed, so a sweep can come back empty while the chain
        // lives (seen on CI and locally under load, about 1 run in 10).
        // Guard against the sweep regressing to never killing it.
        let size = || fs::metadata(&hb).map(|m| m.len()).unwrap_or(0);
        let before = size();
        std::thread::sleep(Duration::from_millis(300));
        if size() != before {
            survived += 1;
            eprintln!("run {i}: hopping chain outlived the sweep (R8)");
        }
    }
    assert!(survived <= 5, "the chain survived {survived} of 10 runs");
}

/// S10: the pinned bind-source fds (Linux) and every internal fd must not
/// reach the command: an O_PATH fd to a denied dir would allow openat()
/// writes through the original rw mount. Only stdio (plus what `ls` opens
/// for the listing itself) may be open.
#[test]
fn exec_command_inherits_no_extra_fds() {
    let _g = FD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new();
    let dir = if cfg!(target_os = "linux") {
        "/proc/self/fd"
    } else {
        "/dev/fd"
    };
    let parse = |out: &[u8]| -> Vec<u32> {
        String::from_utf8_lossy(out)
            .lines()
            .filter_map(|l| l.trim().parse().ok())
            .collect()
    };
    // Baseline: the same `ls` run directly with only stdio open (macOS ls
    // opens two dirs of its own, Linux ls one).
    let base = std::process::Command::new("ls")
        .arg(dir)
        .current_dir(&f.root)
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    let expected = parse(&base.stdout);
    let a = f.exec(&[], &["ls", dir]).assert();
    assert_eq!(code(&a), 0, "{}", stderr(&a));
    let fds = parse(&a.get_output().stdout);
    assert_eq!(fds, expected, "extra fds reached the command");
}

/// N1 (cross-run): a concurrent run A whose extraWrite is the per-user temp
/// dir T must not be able to swap run B's tag dir (in T) for a symlink to a
/// decoy. Either A's swap is denied, or B notices and fails closed; B must
/// exit 120 and its fast double-forked survivor must be dead.
#[cfg(target_os = "macos")]
#[test]
fn exec_concurrent_run_cannot_swap_another_runs_tag() {
    let out = std::process::Command::new("getconf")
        .arg("DARWIN_USER_TEMP_DIR")
        .output()
        .unwrap();
    let t = fs::canonicalize(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    let b = Fixture::new();
    let a = Fixture::with(|p| p["extraWrite"] = json!([t]));
    let bin = assert_cmd::cargo::cargo_bin("rewire-sandbox");
    let run_b = std::process::Command::new(&bin)
        .current_dir(&b.root)
        .arg("exec")
        .arg("--profile")
        .arg(&b.profile)
        .args(["--", "sh", "-c"])
        .arg("sleep 1.5; perl -e 'exit if fork; exit if fork; sleep 1; open(F, \">src/late\"); print F 1'")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let bpid = run_b.id();
    let decoy = t.join(format!("rewire-test-decoy-{bpid}"));
    fs::create_dir_all(&decoy).unwrap();
    fs::write(decoy.join("a"), "").unwrap();
    fs::write(decoy.join("b"), "").unwrap();
    let script = format!(
        r#"for i in $(seq 40); do
  for d in "{t}"/rewire-sandbox-tag-{bpid}-*; do
    [ -d "$d" ] && [ ! -L "$d" ] || continue
    mv "$d" "$d.moved" && ln -s "{decoy}" "$d" && echo SWAPPED
  done
  sleep 0.05
done"#,
        t = t.display(),
        decoy = decoy.display()
    );
    let ra = a.exec(&[], &["sh", "-c", &script]).assert();
    let swapped = String::from_utf8_lossy(&ra.get_output().stdout).contains("SWAPPED");
    let out_b = run_b.wait_with_output().unwrap();
    let err_b = String::from_utf8_lossy(&out_b.stderr).into_owned();
    std::thread::sleep(Duration::from_millis(2000));
    // Clean up whatever the swap left behind.
    let _ = fs::remove_dir_all(&decoy);
    for e in fs::read_dir(&t).unwrap().flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if n.starts_with(&format!("rewire-sandbox-tag-{bpid}-")) {
            let _ = fs::remove_file(e.path());
            let _ = fs::remove_dir_all(e.path());
        }
    }
    assert_eq!(
        out_b.status.code(),
        Some(INTERNAL),
        "swapped={swapped} {err_b}"
    );
    assert!(
        !b.root.join("src/late").exists(),
        "survivor ran (swapped={swapped})"
    );
}

/// T4-F1: a termination signal to the binary (the TS client's output cap
/// or watchdog) must still sweep: a setsid-detached descendant must not
/// outlive it. Exit 120 with `sandbox: terminated by signal 15`, well
/// within the client's 3 s grace.
#[cfg(target_os = "macos")]
#[test]
fn exec_sigterm_sweeps_detached_descendants() {
    let f = Fixture::new();
    let bin = assert_cmd::cargo::cargo_bin("rewire-sandbox");
    let script = "perl -MPOSIX -e 'my $p = fork; if (!$p) { POSIX::setsid(); \
                  open(STDOUT, \">/dev/null\"); open(STDERR, \">/dev/null\"); \
                  exec \"/bin/sleep\", \"37\" } open(F, \">src/pid\"); print F $p; close F'; \
                  sleep 30";
    let child = std::process::Command::new(&bin)
        .current_dir(&f.root)
        .arg("exec")
        .arg("--profile")
        .arg(&f.profile)
        .args(["--", "sh", "-c", script])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let pid_file = f.root.join("src/pid");
    let t0 = Instant::now();
    let detached: i32 = loop {
        if let Ok(s) = fs::read_to_string(&pid_file) {
            if let Ok(p) = s.trim().parse() {
                break p;
            }
        }
        assert!(t0.elapsed() < Duration::from_secs(10), "no pid file");
        std::thread::sleep(Duration::from_millis(20));
    };
    // Let the tracker see it detached first, as in the real scenario.
    std::thread::sleep(Duration::from_millis(200));
    // SAFETY: plain kill on our own child / its detached descendant.
    let alive = |pid: i32| unsafe { libc::kill(pid, 0) == 0 };
    assert!(alive(detached));
    let sent = Instant::now();
    // SAFETY: plain kill on our own child.
    unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
    let out = child.wait_with_output().unwrap();
    let took = sent.elapsed();
    let err = String::from_utf8_lossy(&out.stderr).into_owned();
    std::thread::sleep(Duration::from_millis(200));
    let survived = alive(detached);
    if survived {
        // SAFETY: clean up the escapee.
        unsafe { libc::kill(detached, libc::SIGKILL) };
    }
    assert!(!survived, "detached descendant survived SIGTERM: {err}");
    assert_eq!(out.status.code(), Some(INTERNAL), "{err}");
    assert!(err.contains("sandbox: terminated by signal 15"), "{err}");
    assert!(took < Duration::from_secs(3), "took {took:?}");
}

/// T4-F1: a signal racing the timeout shutdown still ends with nothing
/// left alive; the result is either the signal (120) or the timeout (124).
#[cfg(target_os = "macos")]
#[test]
fn exec_sigterm_during_timeout_still_sweeps() {
    let f = Fixture::new();
    let bin = assert_cmd::cargo::cargo_bin("rewire-sandbox");
    let script = "perl -MPOSIX -e 'my $p = fork; if (!$p) { POSIX::setsid(); \
                  open(STDOUT, \">/dev/null\"); open(STDERR, \">/dev/null\"); \
                  exec \"/bin/sleep\", \"38\" } open(F, \">src/pid\"); print F $p; close F'; \
                  sleep 30";
    for delay_ms in [290u64, 300, 310, 330] {
        let _ = fs::remove_file(f.root.join("src/pid"));
        let child = std::process::Command::new(&bin)
            .current_dir(&f.root)
            .args(["exec", "--timeout-ms", "300", "--profile"])
            .arg(&f.profile)
            .args(["--", "sh", "-c", script])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(delay_ms));
        // SAFETY: plain kill on our own child.
        unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
        let out = child.wait_with_output().unwrap();
        let err = String::from_utf8_lossy(&out.stderr).into_owned();
        let code = out.status.code();
        assert!(
            (code == Some(INTERNAL) && err.contains("terminated by signal 15"))
                || code == Some(TIMEOUT),
            "{delay_ms}ms: {code:?} {err}"
        );
        if let Ok(s) = fs::read_to_string(f.root.join("src/pid")) {
            let pid: i32 = s.trim().parse().unwrap();
            std::thread::sleep(Duration::from_millis(100));
            // SAFETY: probe, then clean up an escapee if any.
            let alive = unsafe { libc::kill(pid, 0) == 0 };
            if alive {
                unsafe { libc::kill(pid, libc::SIGKILL) };
            }
            assert!(!alive, "{delay_ms}ms: descendant survived");
        }
    }
}

/// macOS only (I1 is a Seatbelt finding; on Linux bwrap's `--new-session`
/// and private `/dev` cover it, asserted in exec_linux's argv tests).
#[cfg(target_os = "macos")]
/// Run `script` under the sandbox with a fresh pty as the sandbox binary's
/// controlling terminal (as when a user runs rewire in a terminal). `input`
/// is typed into the terminal first. Returns (stdout plus a trailer line
/// with the exit code and stderr, everything the terminal displayed).
fn exec_on_pty(f: &Fixture, script: &str, input: &[u8]) -> (String, String) {
    use std::io::{Read, Write};
    use std::os::fd::FromRawFd;
    use std::os::unix::process::CommandExt;
    let (mut master, mut slave) = (0, 0);
    {
        // openpty fds are inheritable until CLOEXEC is set; hold the lock so
        // a concurrently spawned test command never sees them.
        let _g = FD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // SAFETY: openpty fills two fds; null name/termios/winsize are allowed.
        let rc = unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        assert_eq!(rc, 0, "openpty");
        for fd in [master, slave] {
            // SAFETY: plain fcntl on fds we own. The slave still reaches the
            // pre_exec hook below (CLOEXEC only acts at exec).
            unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
        }
    }
    // SAFETY: ttyname returns a static NUL-terminated buffer or null.
    let name = unsafe { std::ffi::CStr::from_ptr(libc::ttyname(slave)) }
        .to_string_lossy()
        .into_owned();
    let script = script.replace("{TTY}", &name);
    // SAFETY: we own `master`.
    let mut term = unsafe { fs::File::from_raw_fd(master) };
    term.write_all(input).unwrap();
    let _ = Write::flush(&mut term);
    let mut c = std::process::Command::new(assert_cmd::cargo::cargo_bin("rewire-sandbox"));
    c.current_dir(&f.root)
        .args(["exec", "--timeout-ms", "15000", "--profile"])
        .arg(&f.profile)
        .args(["--", "/bin/sh", "-c", &script])
        .stdin(std::process::Stdio::null());
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        c.pre_exec(move || {
            if libc::setsid() < 0 || libc::ioctl(slave, libc::TIOCSCTTY as _, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = c
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    // SAFETY: closing our copy of the slave; the child holds its own.
    unsafe { libc::close(slave) };
    // Drain the terminal while the command runs: an exiting session leader
    // waits for its terminal's output to drain.
    let reader = std::thread::spawn(move || {
        let mut shown = Vec::new();
        let mut buf = [0u8; 4096];
        // Ends with EOF/EIO once no process holds the slave side.
        while let Ok(n) = term.read(&mut buf) {
            if n == 0 {
                break;
            }
            shown.extend_from_slice(&buf[..n]);
        }
        shown
    });
    let out = child.wait_with_output().unwrap();
    let shown = reader.join().unwrap();
    (
        format!(
            "{}\n[exit {:?}] [stderr {}]",
            String::from_utf8_lossy(&out.stdout),
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        ),
        String::from_utf8_lossy(&shown).into_owned(),
    )
}

#[cfg(target_os = "macos")]
#[test]
fn exec_cannot_write_or_read_the_users_terminal() {
    let f = Fixture::new();
    let (stdout, shown) = exec_on_pty(
        &f,
        "printf 'TTY-MARK\\033]0;pwned\\007' > /dev/tty && echo W-OK; \
         head -c 6 < /dev/tty && echo R-OK; \
         printf 'NAMED-MARK' > {TTY} && echo N-OK; \
         head -c 6 < {TTY} && echo NR-OK; echo done",
        b"typed\n",
    );
    assert!(stdout.contains("done"), "command did not run: {stdout:?}");
    assert!(!shown.contains("TTY-MARK"), "terminal showed: {shown:?}");
    assert!(
        !stdout.lines().any(|l| l == "W-OK"),
        "write to /dev/tty succeeded: {stdout:?}"
    );
    assert!(
        !stdout.lines().any(|l| l == "R-OK"),
        "read from /dev/tty succeeded: {stdout:?}"
    );
    // The same terminal opened by its device name, not as the ctty.
    assert!(!shown.contains("NAMED-MARK"), "terminal showed: {shown:?}");
    assert!(
        !stdout.lines().any(|l| l == "N-OK"),
        "write to the tty by name succeeded: {stdout:?}"
    );
    assert!(
        !stdout.lines().any(|l| l == "NR-OK"),
        "read from the tty by name succeeded: {stdout:?}"
    );
}

/// macOS only: on Linux bwrap's `--new-session` detaches the command (its
/// session leader is bwrap's child inside the pid namespace).
#[cfg(target_os = "macos")]
#[test]
fn exec_command_leads_its_own_session() {
    let f = Fixture::new();
    let a = f
        .exec(
            &[],
            &[
                "python3",
                "-c",
                "import os; print(os.getsid(0) == os.getpid())",
            ],
        )
        .assert();
    assert_eq!(code(&a), 0, "{}", stderr(&a));
    assert_eq!(
        String::from_utf8_lossy(&a.get_output().stdout).trim(),
        "True"
    );
}
