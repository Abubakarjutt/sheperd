//! Black-box tests for the rewire-sandbox CLI: path decisions and fs ops.

use assert_cmd::Command;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

const DENY: i32 = 3;
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

    /// Build a fixture; `tweak` may edit the profile JSON before it is written.
    fn with(tweak: impl FnOnce(&mut Value)) -> Self {
        let tmp = TempDir::new().unwrap();
        let base = fs::canonicalize(tmp.path()).unwrap();
        let root = base.join("root");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("tests")).unwrap();
        let mut profile_json = json!({
            "root": root,
            "write": ["src/**"],
            "writeDeny": ["tests/**"],
            "readDeny": ["**/.env*"],
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

    fn cmd(&self, sub: &str) -> Command {
        let mut c = Command::cargo_bin("rewire-sandbox").unwrap();
        c.current_dir(&self.root)
            .arg(sub)
            .arg("--profile")
            .arg(&self.profile);
        c
    }

    fn check(&self, op: &str, path: impl AsRef<Path>) -> assert_cmd::assert::Assert {
        self.cmd("check-path")
            .arg("--op")
            .arg(op)
            .arg(path.as_ref())
            .assert()
    }
}

/// Parse the single JSON line that a denial writes to stderr.
fn denial(assert: &assert_cmd::assert::Assert) -> Value {
    let stderr = String::from_utf8(assert.get_output().stderr.clone()).unwrap();
    let lines: Vec<&str> = stderr.lines().collect();
    assert_eq!(
        lines.len(),
        1,
        "expected exactly one stderr line, got {stderr:?}"
    );
    serde_json::from_str(lines[0]).unwrap()
}

#[test]
fn allows_write_in_src() {
    let f = Fixture::new();
    f.check("write", "src/a.ts").code(0);
}

#[test]
fn denies_write_in_tests() {
    let f = Fixture::new();
    let a = f.check("write", "tests/a.test.ts").code(DENY);
    let d = denial(&a);
    assert_eq!(d["rule"], "tests/**");
    assert_eq!(
        d["denied"],
        f.root.join("tests/a.test.ts").to_str().unwrap()
    );
}

#[test]
fn denies_write_to_tests_dir_itself() {
    let f = Fixture::new();
    let a = f.check("write", "tests").code(DENY);
    assert_eq!(denial(&a)["rule"], "tests/**");
}

#[test]
fn denies_symlink_into_tests() {
    let f = Fixture::new();
    std::os::unix::fs::symlink("../tests", f.root.join("src/link")).unwrap();
    let a = f.check("write", "src/link/x.ts").code(DENY);
    let d = denial(&a);
    assert!(d["denied"].as_str().unwrap().ends_with("tests/x.ts"), "{d}");
    assert_eq!(d["rule"], "tests/**");
}

#[test]
fn denies_dangling_symlink_pointing_outside() {
    let f = Fixture::new();
    let target = f.base.join("outside/new.txt");
    std::os::unix::fs::symlink(&target, f.root.join("src/evil.ts")).unwrap();
    let a = f.check("write", "src/evil.ts").code(DENY);
    let d = denial(&a);
    assert_eq!(d["denied"], target.to_str().unwrap());
    assert_eq!(d["rule"], "<outside-root>");
}

#[test]
fn denies_dotdot_escape() {
    let f = Fixture::new();
    let a = f.check("write", "src/../../outside.txt").code(DENY);
    let d = denial(&a);
    assert_eq!(d["rule"], "<outside-root>");
    assert_eq!(d["denied"], f.base.join("outside.txt").to_str().unwrap());
}

#[test]
fn denies_write_outside_write_globs() {
    let f = Fixture::new();
    f.check("write", "README.md").code(DENY);
}

#[test]
fn denies_gitdir_from_pointer_file() {
    let f = Fixture::new();
    let gitdir = f.base.join(".git/worktrees/w");
    fs::create_dir_all(&gitdir).unwrap();
    fs::write(
        f.root.join(".git"),
        format!("gitdir: {}\n", gitdir.display()),
    )
    .unwrap();
    let a = f.check("write", gitdir.join("HEAD")).code(DENY);
    assert_eq!(denial(&a)["rule"], "<gitdir>");
    // The pointer file itself is protected too.
    let a = f.check("write", ".git").code(DENY);
    assert_eq!(denial(&a)["rule"], "<gitdir>");
}

#[test]
fn denies_gitdir_even_when_in_extra_write() {
    let f = Fixture::with(|p| {
        let root = PathBuf::from(p["root"].as_str().unwrap());
        p["extraWrite"] = json!([root.parent().unwrap()]);
    });
    let gitdir = f.base.join(".git/worktrees/w");
    fs::create_dir_all(&gitdir).unwrap();
    fs::write(f.root.join(".git"), "gitdir: ../.git/worktrees/w\n").unwrap();
    let a = f.check("write", gitdir.join("config")).code(DENY);
    assert_eq!(denial(&a)["rule"], "<gitdir>");
}

#[test]
fn allows_write_in_extra_write_dir() {
    let f = Fixture::new();
    let extra = f.base.join("scratch");
    fs::create_dir_all(&extra).unwrap();
    let f2 = Fixture::with(|p| p["extraWrite"] = json!([extra]));
    f2.check("write", extra.join("a.log")).code(0);
    // Unrelated fixture still denies it.
    f.check("write", extra.join("a.log")).code(DENY);
}

#[test]
fn fs_write_into_missing_extra_write_does_not_create_outside_parents() {
    let probe = Fixture::new();
    let extra = probe.base.join("a/b/scratch");
    let f = Fixture::with(|p| p["extraWrite"] = json!([extra]));
    let a = f
        .cmd("fs-write")
        .arg(extra.join("x.log"))
        .write_stdin("x")
        .assert()
        .code(DENY);
    assert_eq!(denial(&a)["rule"], "<outside-root>");
    assert!(!probe.base.join("a").exists());
    // Once the extraWrite dir exists, writes (and subdirs) inside it work.
    fs::create_dir_all(&extra).unwrap();
    f.cmd("fs-write")
        .arg(extra.join("sub/x.log"))
        .write_stdin("ok")
        .assert()
        .code(0);
    assert_eq!(fs::read_to_string(extra.join("sub/x.log")).unwrap(), "ok");
}

#[test]
fn denies_env_read() {
    let f = Fixture::new();
    fs::write(f.root.join(".env.local"), "SECRET=1").unwrap();
    let a = f.cmd("fs-read").arg(".env.local").assert().code(DENY);
    assert!(a.get_output().stdout.is_empty());
    assert_eq!(denial(&a)["rule"], "**/.env*");
}

#[test]
fn denies_env_read_in_subdir_and_outside_root() {
    let f = Fixture::new();
    f.check("read", "src/deep/.env").code(DENY);
    f.check("read", f.base.join(".env")).code(DENY);
}

#[test]
fn allows_read_outside_root() {
    let f = Fixture::new();
    fs::write(f.base.join("notes.txt"), "hello").unwrap();
    f.cmd("fs-read")
        .arg(f.base.join("notes.txt"))
        .assert()
        .code(0)
        .stdout("hello");
}

#[test]
fn denies_absolute_read_deny_glob_through_symlinked_prefix() {
    // readDeny given via a non-canonical (symlinked) prefix still applies.
    let f0 = Fixture::new();
    let secrets = f0.base.join("secrets");
    fs::create_dir_all(&secrets).unwrap();
    fs::write(secrets.join("id_rsa"), "k").unwrap();
    std::os::unix::fs::symlink(&secrets, f0.base.join("alias")).unwrap();
    let alias_glob = format!("{}/**", f0.base.join("alias").display());
    let f = Fixture::with(|p| p["readDeny"] = json!([alias_glob]));
    let a = f.check("read", secrets.join("id_rsa")).code(DENY);
    assert_eq!(denial(&a)["rule"], alias_glob);
}

#[test]
fn fs_write_is_atomic_and_creates_parents() {
    let f = Fixture::new();
    let content = "export const a = 1;\n";
    f.cmd("fs-write")
        .arg("src/new/dir/a.ts")
        .write_stdin(content)
        .assert()
        .code(0);
    let target = f.root.join("src/new/dir/a.ts");
    assert_eq!(fs::read_to_string(&target).unwrap(), content);
    // No temp files left behind.
    let names: Vec<_> = fs::read_dir(target.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names, vec![std::ffi::OsString::from("a.ts")]);
    // Overwrite replaces content.
    f.cmd("fs-write")
        .arg("src/new/dir/a.ts")
        .write_stdin("v2")
        .assert()
        .code(0);
    assert_eq!(fs::read_to_string(&target).unwrap(), "v2");
}

#[test]
fn fs_write_denied_creates_nothing() {
    let f = Fixture::new();
    f.cmd("fs-write")
        .arg("tests/sub/a.test.ts")
        .write_stdin("x")
        .assert()
        .code(DENY);
    assert!(!f.root.join("tests/sub").exists());
}

#[test]
fn fs_write_through_symlink_into_tests_is_denied() {
    let f = Fixture::new();
    fs::write(f.root.join("tests/a.test.ts"), "orig").unwrap();
    std::os::unix::fs::symlink("../tests/a.test.ts", f.root.join("src/a.ts")).unwrap();
    f.cmd("fs-write")
        .arg("src/a.ts")
        .write_stdin("pwned")
        .assert()
        .code(DENY);
    assert_eq!(
        fs::read_to_string(f.root.join("tests/a.test.ts")).unwrap(),
        "orig"
    );
}

#[test]
fn fs_write_onto_directory_is_internal_error() {
    let f = Fixture::new();
    fs::create_dir_all(f.root.join("src/d")).unwrap();
    f.cmd("fs-write")
        .arg("src/d")
        .write_stdin("x")
        .assert()
        .code(INTERNAL);
}

#[test]
fn fs_read_missing_file_is_internal_error() {
    let f = Fixture::new();
    f.cmd("fs-read").arg("src/nope.ts").assert().code(INTERNAL);
}

#[test]
fn malformed_profile_exits_120() {
    let f = Fixture::new();
    fs::write(&f.profile, "{").unwrap();
    f.check("write", "src/a.ts").code(INTERNAL);
}

#[test]
fn unknown_profile_field_exits_120() {
    let f = Fixture::with(|p| p["writeDenny"] = json!(["src/**"]));
    f.check("write", "src/a.ts").code(INTERNAL);
}

#[test]
fn missing_profile_field_exits_120() {
    let f = Fixture::with(|p| {
        p.as_object_mut().unwrap().remove("writeDeny");
    });
    f.check("write", "src/a.ts").code(INTERNAL);
}

#[test]
fn relative_root_exits_120() {
    let f = Fixture::with(|p| p["root"] = json!("root"));
    f.check("write", "src/a.ts").code(INTERNAL);
}

#[test]
fn bad_network_value_exits_120() {
    let f = Fixture::with(|p| p["network"] = json!("allow"));
    f.check("write", "src/a.ts").code(INTERNAL);
}

#[test]
fn missing_profile_file_exits_120() {
    let f = Fixture::new();
    fs::remove_file(&f.profile).unwrap();
    f.check("read", "src/a.ts").code(INTERNAL);
}

#[test]
fn usage_error_exits_120() {
    let f = Fixture::new();
    f.cmd("check-path")
        .arg("--op")
        .arg("delete")
        .arg("x")
        .assert()
        .code(INTERNAL);
}

// ---- fix round 1 regressions ----

fn write_all_fixture() -> Fixture {
    Fixture::with(|p| p["write"] = json!(["**"]))
}

#[test]
fn unicode_long_s_alias_of_tests_is_denied() {
    let f = write_all_fixture();
    fs::remove_dir(f.root.join("tests")).unwrap();
    let a = f.check("write", "te\u{17f}ts/x.test.ts").code(DENY);
    assert_eq!(denial(&a)["rule"], "tests/**");
    f.cmd("fs-write")
        .arg("te\u{17f}ts/x.test.ts")
        .write_stdin("pwned")
        .assert()
        .code(DENY);
    assert!(!f.root.join("tests").exists());
}

#[test]
fn existing_unicode_alias_dir_still_denies_plain_spelling() {
    let f = write_all_fixture();
    fs::remove_dir(f.root.join("tests")).unwrap();
    fs::create_dir(f.root.join("te\u{17f}ts")).unwrap();
    let a = f.check("write", "tests/x.test.ts").code(DENY);
    assert_eq!(denial(&a)["rule"], "tests/**");
}

#[test]
fn kelvin_sign_alias_is_denied() {
    let f = Fixture::with(|p| {
        p["write"] = json!(["**"]);
        p["writeDeny"] = json!(["keys/**"]);
    });
    let a = f.check("write", "\u{212a}eys/a").code(DENY);
    assert_eq!(denial(&a)["rule"], "keys/**");
}

#[test]
fn sharp_s_and_nfd_aliases_are_denied() {
    let f = Fixture::with(|p| {
        p["write"] = json!(["**"]);
        p["writeDeny"] = json!(["strasse/**", "caf\u{e9}/**"]);
    });
    f.check("write", "stra\u{df}e/a").code(DENY);
    f.check("write", "cafe\u{301}/a").code(DENY);
}

#[test]
fn dotted_capital_i_git_variant_is_denied() {
    let f = write_all_fixture();
    let a = f.check("write", ".G\u{130}T/hooks/pre-commit").code(DENY);
    assert_eq!(denial(&a)["rule"], "<gitdir>");
}

#[test]
fn help_flag_on_subcommand_is_a_path_not_success() {
    let f = Fixture::new();
    for flag in ["--help", "-h", "-V", "--version"] {
        let a = f
            .cmd("check-path")
            .arg("--op")
            .arg("write")
            .arg(flag)
            .assert()
            .code(DENY);
        assert_eq!(denial(&a)["rule"], "<no-write-rule>", "{flag}");
    }
    f.cmd("fs-write")
        .arg("--help")
        .write_stdin("x")
        .assert()
        .code(DENY);
    assert!(!f.root.join("--help").exists());
}

#[test]
fn help_without_required_args_exits_120() {
    let mut c = Command::cargo_bin("rewire-sandbox").unwrap();
    c.args(["check-path", "--help"]).assert().code(INTERNAL);
    let mut c = Command::cargo_bin("rewire-sandbox").unwrap();
    c.args(["fs-write", "-h"]).assert().code(INTERNAL);
}

#[test]
fn symlinked_deny_prefix_denies_lexical_and_canonical_spellings() {
    let f = write_all_fixture();
    fs::remove_dir(f.root.join("tests")).unwrap();
    fs::create_dir(f.root.join("real")).unwrap();
    std::os::unix::fs::symlink("real", f.root.join("tests")).unwrap();
    let a = f.check("write", "tests/a.test.ts").code(DENY);
    assert_eq!(denial(&a)["rule"], "tests/**");
    let a = f.check("write", "real/a.test.ts").code(DENY);
    assert_eq!(denial(&a)["rule"], "tests/**");
    f.cmd("fs-write")
        .arg("tests/a.test.ts")
        .write_stdin("x")
        .assert()
        .code(DENY);
    assert!(!f.root.join("real/a.test.ts").exists());
}

#[test]
fn nested_dot_git_anywhere_is_denied() {
    let f = write_all_fixture();
    for p in ["src/.git/hooks/pre-commit", "src/a/.GIT/config", "src/.git"] {
        let a = f.check("write", p).code(DENY);
        assert_eq!(denial(&a)["rule"], "<gitdir>", "{p}");
    }
    f.cmd("fs-write")
        .arg("src/.git/hooks/pre-commit")
        .write_stdin("x")
        .assert()
        .code(DENY);
    assert!(!f.root.join("src/.git").exists());
    // Reading is fine; `.gitignore` is not `.git`.
    f.check("read", "src/.git/config").code(0);
    f.check("write", "src/.gitignore").code(0);
}

#[test]
fn nested_dot_git_in_extra_write_is_denied() {
    let probe = Fixture::new();
    let extra = probe.base.join("scratch");
    fs::create_dir_all(&extra).unwrap();
    let f = Fixture::with(|p| p["extraWrite"] = json!([extra]));
    let a = f.check("write", extra.join("repo/.git/HEAD")).code(DENY);
    assert_eq!(denial(&a)["rule"], "<gitdir>");
}
