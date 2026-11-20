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
/// be killed. macOS: we track descendants and fail with 120. Linux: the pid
/// namespace dies with the command, so it cannot survive (exit passes through).
fn assert_detached_killed(cmd: &[&str]) {
    let f = Fixture::new();
    let a = f.exec(&[], cmd).assert();
    if cfg!(target_os = "macos") {
        assert_eq!(code(&a), INTERNAL, "{}", stderr(&a));
        assert!(
            stderr(&a).contains("sandbox: escaped descendant "),
            "{}",
            stderr(&a)
        );
    }
    std::thread::sleep(Duration::from_millis(2000));
    assert!(
        !f.root.join("src/late").exists(),
        "detached descendant survived"
    );
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
