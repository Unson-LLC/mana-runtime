#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
deploy_dir="$repo_root/scripts/deploy"
workflow="$repo_root/.github/workflows/deploy-lightsail.yml"
runbook="$repo_root/docs/operations/lightsail-deploy-workflow.md"
workflow_checker="$deploy_dir/check-workflow-contract.rb"
resolver="$deploy_dir/resolve-deploy-ref"
renderer="$deploy_dir/render-pilot-deploy-config"
account_library="$deploy_dir/lib/deploy-account.sh"

for script in \
  "$deploy_dir/openryoko-pilot-deploy" \
  "$deploy_dir/openryoko-deploy-command" \
  "$deploy_dir/install-pilot-deployer.sh" \
  "$resolver" \
  "$renderer"; do
  bash -n "$script"
done
bash -n "$account_library"

grep -Fq 'repositoryの`Write`権限が必要' "$runbook"
grep -Fq 'Environment secretの値を閲覧する権限やLightsail shell accessは不要' "$runbook"
grep -Fq 'mana-runtime repository administratorへ`Write`権限を依頼する' "$runbook"
grep -Fq 'rollback対象SHAから古いinstallerを実行しない' "$runbook"
echo "operator access guidance fixture passed"

if SSH_ORIGINAL_COMMAND="uname -a" bash "$deploy_dir/openryoko-deploy-command" >/dev/null 2>&1; then
  echo "forced command accepted an arbitrary SSH command" >&2
  exit 1
fi

if SSH_ORIGINAL_COMMAND="deploy deadbeef" bash "$deploy_dir/openryoko-deploy-command" >/dev/null 2>&1; then
  echo "forced command accepted a short SHA" >&2
  exit 1
fi

valid_sha="0123456789abcdef0123456789abcdef01234567"
valid_digest="89abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567"
if SSH_ORIGINAL_COMMAND="deploy $valid_sha" bash "$deploy_dir/openryoko-deploy-command" >/dev/null 2>&1; then
  echo "forced command accepted a deploy request without a control-plane digest" >&2
  exit 1
fi
source_output="$(OPENRYOKO_DEPLOY_SOURCE_ONLY=1 bash -c 'source "$1"; control_plane_digest "$2" "$3"' _ \
  "$deploy_dir/openryoko-deploy-command" \
  "$deploy_dir/openryoko-pilot-deploy" \
  "$deploy_dir/openryoko-deploy-command")"
expected_source_output="$({
  sha256sum "$deploy_dir/openryoko-pilot-deploy" | cut -d' ' -f1
  sha256sum "$deploy_dir/openryoko-deploy-command" | cut -d' ' -f1
} | sha256sum | cut -d' ' -f1)"
[[ "$source_output" == "$expected_source_output" ]] \
  || { echo "control-plane digest is not deterministic" >&2; exit 1; }
grep -Fq 'exec sudo -n /usr/local/sbin/openryoko-pilot-deploy "$target_sha" "$expected_digest"' \
  "$deploy_dir/openryoko-deploy-command" \
  || { echo "forced command does not preserve the validated SHA and digest as separate argv" >&2; exit 1; }
if grep -Fq '/usr/sbin/nologin' "$deploy_dir/install-pilot-deployer.sh"; then
  echo "installer configures a shell that prevents sshd forced-command execution" >&2
  exit 1
fi
account_fixture_root="$(mktemp -d)"
pointer_fixture="$account_fixture_root/pointer"
mkdir -p "$pointer_fixture/runtime" "$pointer_fixture/source" "$pointer_fixture/release"
source "$account_library"
seed_release_pointer_if_missing "$pointer_fixture/runtime" "$pointer_fixture/source"
[[ "$(readlink "$pointer_fixture/runtime/current")" == "$pointer_fixture/source" ]] \
  || { echo "installer did not seed a missing current pointer" >&2; exit 1; }
ln -sfn "$pointer_fixture/release" "$pointer_fixture/runtime/current"
seed_release_pointer_if_missing "$pointer_fixture/runtime" "$pointer_fixture/source"
[[ "$(readlink "$pointer_fixture/runtime/current")" == "$pointer_fixture/release" ]] \
  || { echo "installer reinstall overwrote the active release pointer" >&2; exit 1; }
ln -sfn "$pointer_fixture/missing-release" "$pointer_fixture/runtime/current"
seed_release_pointer_if_missing "$pointer_fixture/runtime" "$pointer_fixture/source"
[[ "$(readlink "$pointer_fixture/runtime/current")" == "$pointer_fixture/missing-release" ]] \
  || { echo "installer reinstall overwrote a dangling recovery pointer" >&2; exit 1; }
echo "sshd account-shell forced-command fixture passed"

account_fixture_bin="$account_fixture_root/bin"
mkdir -p "$account_fixture_bin"
cat > "$account_fixture_bin/id" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
cat > "$account_fixture_bin/useradd" <<'STUB'
#!/usr/bin/env bash
echo "useradd must not run for an existing account" >&2
exit 97
STUB
cat > "$account_fixture_bin/usermod" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$ACCOUNT_FIXTURE_ROOT/usermod.args"
STUB
cat > "$account_fixture_bin/getent" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' 'openryoko-deploy:!locked:20000:0:99999:7:::'
STUB
chmod +x "$account_fixture_bin"/*
(
  export ACCOUNT_FIXTURE_ROOT="$account_fixture_root"
  PATH="$account_fixture_bin:/bin:/usr/bin"
  # shellcheck source=lib/deploy-account.sh
  source "$account_library"
  ensure_deploy_account openryoko-deploy /home/openryoko-deploy /bin/bash
)
grep -Fqx -- '--shell /bin/bash --lock openryoko-deploy' "$account_fixture_root/usermod.args"

# The real installer declares these names readonly before sourcing the helper.
# Reproduce that shell scope so helper locals cannot accidentally collide with
# installer globals (a plain helper-only fixture does not detect this).
(
  export ACCOUNT_FIXTURE_ROOT="$account_fixture_root"
  PATH="$account_fixture_bin:/bin:/usr/bin"
  readonly deploy_user="openryoko-deploy"
  readonly runtime_home="$pointer_fixture/runtime"
  readonly source_repo="$pointer_fixture/source"
  source "$account_library"
  ensure_deploy_account "$deploy_user" "/home/$deploy_user" /bin/bash
  rm -f "$runtime_home/current"
  seed_release_pointer_if_missing "$runtime_home" "$source_repo"
  [[ "$(readlink "$runtime_home/current")" == "$source_repo" ]]
)
echo "installer readonly-scope fixture passed"

cat > "$account_fixture_bin/getent" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' 'openryoko-deploy:$6$unexpected-password:20000:0:99999:7:::'
STUB
if (
  export ACCOUNT_FIXTURE_ROOT="$account_fixture_root"
  PATH="$account_fixture_bin:/bin:/usr/bin"
  source "$account_library"
  ensure_deploy_account openryoko-deploy /home/openryoko-deploy /bin/bash
) >/dev/null 2>&1; then
  echo "account helper accepted an unlocked password field" >&2
  exit 1
fi
echo "existing deploy-account lock fixture passed"

ruby "$workflow_checker" "$workflow" >/dev/null
echo "deploy workflow semantic contract passed"

resolver_root="$(mktemp -d)"
remote_repo="$resolver_root/origin.git"
working_repo="$resolver_root/work"
git init --bare -q "$remote_repo"
git init -q "$working_repo"
git -C "$working_repo" config user.email fixture@example.invalid
git -C "$working_repo" config user.name fixture
printf 'main\n' > "$working_repo/state.txt"
git -C "$working_repo" add state.txt
git -C "$working_repo" commit -qm main
ancestor_sha="$(git -C "$working_repo" rev-parse HEAD)"
printf 'current\n' >> "$working_repo/state.txt"
git -C "$working_repo" commit -qam current
main_sha="$(git -C "$working_repo" rev-parse HEAD)"
git -C "$working_repo" branch -M main
git -C "$working_repo" remote add origin "$remote_repo"
git -C "$working_repo" push -q -u origin main
resolver_output="$resolver_root/github-output"
(cd "$working_repo" && GITHUB_OUTPUT="$resolver_output" "$resolver" "") >/dev/null
grep -Fqx "sha=$main_sha" "$resolver_output" \
  || { echo "resolver did not emit origin/main" >&2; exit 1; }
(cd "$working_repo" && "$resolver" "$main_sha") >/dev/null
resolver_ancestor_output="$resolver_root/github-output-ancestor"
(cd "$working_repo" && GITHUB_OUTPUT="$resolver_ancestor_output" "$resolver" "$ancestor_sha") >/dev/null
grep -Fqx "sha=$ancestor_sha" "$resolver_ancestor_output" \
  || { echo "resolver did not emit a past origin/main ancestor" >&2; exit 1; }
short_sha_error="$resolver_root/short-sha-error"
if (cd "$working_repo" && "$resolver" "${main_sha:0:12}") >/dev/null 2>"$short_sha_error"; then
  echo "resolver accepted a short SHA" >&2
  exit 1
fi
grep -Fqx 'commit_sha must be a full 40-character Git SHA.' "$short_sha_error" \
  || { echo "resolver did not emit the operator-facing full-SHA error" >&2; exit 1; }
git -C "$working_repo" checkout -qb side
printf 'side\n' >> "$working_repo/state.txt"
git -C "$working_repo" commit -qam side
side_sha="$(git -C "$working_repo" rev-parse HEAD)"
side_sha_error="$resolver_root/side-sha-error"
if (cd "$working_repo" && "$resolver" "$side_sha") >/dev/null 2>"$side_sha_error"; then
  echo "resolver accepted a commit outside origin/main" >&2
  exit 1
fi
grep -Fqx 'The requested commit is not reachable from origin/main.' "$side_sha_error" \
  || { echo "resolver did not emit the operator-facing ancestry error" >&2; exit 1; }
echo "commit resolution fixtures passed"

render_root="$(mktemp -d)"
printf '%s\n' 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureKey deploy-test' > "$render_root/key.pub"
"$renderer" --authorized-key-file "$render_root/key.pub" --output-dir "$render_root/rendered"
grep -Fqx 'restrict,command="/usr/local/sbin/openryoko-deploy-command" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureKey deploy-test' "$render_root/rendered/authorized_keys"
grep -Fqx 'openryoko-deploy ALL=(root) NOPASSWD: /usr/local/sbin/openryoko-pilot-deploy *' "$render_root/rendered/openryoko-pilot-deploy.sudoers"
grep -Fqx 'ExecStart=/home/ryoko/bin/ryoko start' "$render_root/rendered/10-release-pointer.conf"
grep -Fq '/home/ryoko/current/packages/jimmy/dist/bin/jimmy.js' "$render_root/rendered/ryoko"
if stat -c '%a' "$render_root/rendered/authorized_keys" >/dev/null 2>&1; then
  authorized_keys_mode="$(stat -c '%a' "$render_root/rendered/authorized_keys")"
else
  authorized_keys_mode="$(stat -f '%Lp' "$render_root/rendered/authorized_keys")"
fi
[[ "$authorized_keys_mode" == "600" ]] \
  || { echo "authorized_keys mode is not 600: $authorized_keys_mode" >&2; exit 1; }
echo "installer artifact fixtures passed"

grep -Fq 'Control-plane digest:' "$deploy_dir/install-pilot-deployer.sh"
grep -Fq 'openryoko deploy: control plane digest' "$deploy_dir/openryoko-pilot-deploy"
grep -Fq 'openryoko deploy: main pid' "$deploy_dir/openryoko-pilot-deploy"
grep -Fq 'openryoko deploy: entrypoint' "$deploy_dir/openryoko-pilot-deploy"
echo "deployment evidence output fixtures passed"

workflow_fixture_root="$(mktemp -d)"
cp "$workflow" "$workflow_fixture_root/expanded-permissions.yml"
ruby -e 'p=ARGV.fetch(0); s=File.read(p).sub("  contents: read", "  contents: read\n  issues: write"); File.write(p, s)' "$workflow_fixture_root/expanded-permissions.yml"
if ruby "$workflow_checker" "$workflow_fixture_root/expanded-permissions.yml" >/dev/null 2>&1; then
  echo "workflow checker accepted expanded repository permissions" >&2
  exit 1
fi
cp "$workflow" "$workflow_fixture_root/disabled-host-check.yml"
ruby -e 'p=ARGV.fetch(0); s=File.read(p).sub("StrictHostKeyChecking=yes", "StrictHostKeyChecking=no # StrictHostKeyChecking=yes"); File.write(p, s)' "$workflow_fixture_root/disabled-host-check.yml"
if ruby "$workflow_checker" "$workflow_fixture_root/disabled-host-check.yml" >/dev/null 2>&1; then
  echo "workflow checker accepted disabled host key checking" >&2
  exit 1
fi
cp "$workflow" "$workflow_fixture_root/leaked-deploy-key.yml"
ruby -e 'p=ARGV.fetch(0); s=File.read(p); needle=%q{          test -n "$DEPLOY_KEY"}; s=s.sub(needle, needle + "\n" + %q{          echo "$DEPLOY_KEY"}); File.write(p, s)' "$workflow_fixture_root/leaked-deploy-key.yml"
if ruby "$workflow_checker" "$workflow_fixture_root/leaked-deploy-key.yml" >/dev/null 2>&1; then
  echo "workflow checker accepted deploy-key output" >&2
  exit 1
fi
cp "$workflow" "$workflow_fixture_root/raw-input-sha.yml"
ruby -e 'p=ARGV.fetch(0); s=File.read(p).gsub(%q{TARGET_SHA: ${{ needs.prepare.outputs.target_sha }}}, %q{TARGET_SHA: ${{ inputs.commit_sha }}}); File.write(p, s)' "$workflow_fixture_root/raw-input-sha.yml"
if ruby "$workflow_checker" "$workflow_fixture_root/raw-input-sha.yml" >/dev/null 2>&1; then
  echo "workflow checker accepted an unvalidated input SHA for deployment" >&2
  exit 1
fi
cp "$workflow" "$workflow_fixture_root/late-checkout.yml"
ruby -e 'p=ARGV.fetch(0); s=File.read(p).sub(%q{      - name: Configure restricted SSH client}, %q{      - name: Late checkout\n        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\n      - name: Configure restricted SSH client}); File.write(p, s)' "$workflow_fixture_root/late-checkout.yml"
if ruby "$workflow_checker" "$workflow_fixture_root/late-checkout.yml" >/dev/null 2>&1; then
  echo "workflow checker accepted a moving checkout after production approval" >&2
  exit 1
fi
cp "$workflow" "$workflow_fixture_root/unrestricted-principal.yml"
ruby -e 'p=ARGV.fetch(0); s=File.read(p).sub(%q{openryoko-deploy@"$DEPLOY_HOST"}, %q{ubuntu@"$DEPLOY_HOST"}); File.write(p, s)' "$workflow_fixture_root/unrestricted-principal.yml"
if ruby "$workflow_checker" "$workflow_fixture_root/unrestricted-principal.yml" >/dev/null 2>&1; then
  echo "workflow checker accepted an unrestricted SSH principal" >&2
  exit 1
fi
cp "$workflow" "$workflow_fixture_root/non-deploy-payload.yml"
ruby -e 'p=ARGV.fetch(0); s=File.read(p).sub(%q{"deploy $TARGET_SHA $CONTROL_PLANE_DIGEST"}, %q{"status"}); File.write(p, s)' "$workflow_fixture_root/non-deploy-payload.yml"
if ruby "$workflow_checker" "$workflow_fixture_root/non-deploy-payload.yml" >/dev/null 2>&1; then
  echo "workflow checker accepted a non-deploy forced-command payload" >&2
  exit 1
fi

rollback_root="$(mktemp -d)"
trap 'rm -rf "$rollback_root" "$workflow_fixture_root" "$resolver_root" "$render_root" "$account_fixture_root" "${build_fixture_root:-}" "${failure_root:-}"' EXIT

build_fixture_root="$(mktemp -d)"
mkdir -p "$build_fixture_root/bin"
cat > "$build_fixture_root/bin/tsc" <<'STUB'
#!/usr/bin/env bash
exit 42
STUB
chmod +x "$build_fixture_root/bin/tsc"
jimmy_build_command="$(node -p "require('./packages/jimmy/package.json').scripts.build")"
set +e
(
  cd "$build_fixture_root"
  PATH="$build_fixture_root/bin:/bin:/usr/bin" /bin/sh -c "$jimmy_build_command"
)
jimmy_build_status=$?
set -e
[[ $jimmy_build_status -eq 42 ]] \
  || { echo "Jimmy package build masked the TypeScript compiler failure" >&2; exit 1; }
echo "Jimmy build failure propagation fixture passed"

mkdir -p "$rollback_root/previous" "$rollback_root/failed"
ln -s "$rollback_root/failed" "$rollback_root/current"
: > "$rollback_root/systemctl.log"
set +e
(
  systemctl() { printf '%s\n' "$*" >> "$rollback_root/systemctl.log"; }
  mv() { command rm -f "$3"; command mv "$2" "$3"; }
  export OPENRYOKO_DEPLOY_SOURCE_ONLY=1
  # shellcheck source=openryoko-pilot-deploy
  source "$deploy_dir/openryoko-pilot-deploy"
  rollback_activation 23 "$rollback_root/current" "$rollback_root/previous" test.service
)
rollback_status=$?
set -e
[[ $rollback_status -eq 23 ]] \
  || { echo "rollback did not preserve the activation failure status" >&2; exit 1; }
[[ "$(readlink "$rollback_root/current")" == "$rollback_root/previous" ]] \
  || { echo "rollback did not restore the previous release pointer" >&2; exit 1; }
[[ "$(grep -Fxc 'restart test.service' "$rollback_root/systemctl.log")" -eq 1 ]] \
  || { echo "rollback did not restart the restored service exactly once" >&2; exit 1; }
grep -Fq 'rollback 1' "$deploy_dir/openryoko-pilot-deploy" \
  || { echo "activation consistency failures do not explicitly rollback" >&2; exit 1; }

failure_root="$(mktemp -d)"
failure_sha="89abcdef0123456789abcdef0123456789abcdef"
fixture_bin="$failure_root/bin"
mkdir -p "$fixture_bin" "$failure_root/source/.git" "$failure_root/releases" "$failure_root/previous"
cat > "$failure_root/pnpm" <<'PNPM'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${FIXTURE_EXPECT_RELEASE_CWD:-0}" == "1" ]]; then
  expected_release_dir="$(< "$FIXTURE_ROOT/release-dir")"
  printf '%s\n' "$PWD" >> "$FIXTURE_ROOT/pnpm-pwd.log"
  [[ "$PWD" == "$expected_release_dir" && -r "$PWD/package.json" ]] || {
    echo "package manager did not start in the readable release worktree: pwd=$PWD release=$expected_release_dir" >&2
    exit 43
  }
fi
release_dir=""
if [[ "${1:-}" == "--dir" ]]; then release_dir="$2"; shift 2; fi
if [[ "${1:-}" == "build" ]]; then
  [[ "${FIXTURE_MODE:-}" != "build-fail" ]] || exit 42
  mkdir -p "$release_dir/packages/jimmy/dist/bin"
  : > "$release_dir/packages/jimmy/dist/bin/jimmy.js"
fi
PNPM
chmod +x "$failure_root/pnpm"
cat > "$fixture_bin/stub-command" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
name="$(basename "$0")"
case "$name" in
  git)
    if [[ " $* " == *" merge-base "* && "${FIXTURE_MODE:-}" == "main-reject" ]]; then exit 1; fi
    if [[ " $* " == *" worktree add "* ]]; then
      release_dir="${@: -2:1}"
      mkdir -p "$release_dir"
      printf '%s\n' "$release_dir" > "$FIXTURE_ROOT/release-dir"
      printf '%s\n' '{"packageManager":"pnpm@10.6.4"}' > "$release_dir/package.json"
    fi
    if [[ " $* " == *" worktree remove "* ]]; then rm -rf "${@: -1}"; fi
    if [[ " $* " == *" rev-parse HEAD "* ]]; then printf '%s\n' "$FIXTURE_SHA"; fi
    if [[ " $* " == *" worktree prune "* && "${FIXTURE_MODE:-}" == "prune-fail" ]]; then exit 1; fi
    ;;
  flock)
    [[ "${FIXTURE_MODE:-}" != "lock-conflict" ]] || exit 1
    ;;
  install)
    mkdir -p "${@: -1}"
    ;;
  mv)
    destination="${@: -1}"
    source="${@: -2:1}"
    rm -f "$destination"
    /bin/mv "$source" "$destination"
    ;;
  systemctl)
    printf '%s\n' "$*" >> "$FIXTURE_SYSTEMCTL_LOG"
    if [[ "${1:-}" == "is-active" && "${FIXTURE_MODE:-}" == "active-fail" ]]; then exit 1; fi
    if [[ "${1:-}" == "show" && " $* " == *" --property MainPID "* ]]; then printf '123\n'; fi
    if [[ "${1:-}" == "show" && " $* " == *" --property ExecStart "* ]]; then
      printf '%s\n' "$FIXTURE_ROOT/systemd-entrypoint"
    fi
    ;;
  realpath)
    if [[ "${FIXTURE_MODE:-}" == "entrypoint-mismatch" && "${1:-}" == *"/current/packages/jimmy/dist/bin/jimmy.js" ]]; then
      printf '%s\n' "$FIXTURE_ROOT/mismatched/jimmy.js"
    else
      /bin/realpath "$@"
    fi
    ;;
  sleep) ;;
esac
STUB
chmod +x "$fixture_bin/stub-command"
for command_name in git flock install mv systemctl realpath sleep; do
  ln -s stub-command "$fixture_bin/$command_name"
done
fixture_path="$fixture_bin:$(dirname "$(command -v sha256sum)"):/bin:/usr/bin"

run_failure_case() {
  local mode="$1"
  local guard_status="$2"
  local requested_digest="${3:-$expected_source_output}"
  rm -rf "$failure_root/releases"/*
  rm -f "$failure_root/current"
  ln -s "$failure_root/previous" "$failure_root/current"
  : > "$failure_root/systemctl.log"
  cat > "$failure_root/guard" <<GUARD
#!/usr/bin/env bash
exit $guard_status
GUARD
  chmod +x "$failure_root/guard"
  set +e
  PATH="$fixture_path" \
  FIXTURE_MODE="$mode" \
  FIXTURE_ROOT="$failure_root" \
  FIXTURE_SHA="$failure_sha" \
  FIXTURE_SYSTEMCTL_LOG="$failure_root/systemctl.log" \
  OPENRYOKO_DEPLOY_TESTING=1 \
  OPENRYOKO_TEST_RUNTIME_HOME="$failure_root" \
  OPENRYOKO_TEST_SOURCE_REPO="$failure_root/source" \
  OPENRYOKO_TEST_RELEASES_DIR="$failure_root/releases" \
  OPENRYOKO_TEST_CURRENT_LINK="$failure_root/current" \
  OPENRYOKO_TEST_RESTART_GUARD="$failure_root/guard" \
  OPENRYOKO_TEST_LOCK_FILE="$failure_root/deploy.lock" \
  OPENRYOKO_TEST_PNPM_BIN="$failure_root/pnpm" \
  OPENRYOKO_TEST_DEPLOY_SCRIPT_PATH="$deploy_dir/openryoko-pilot-deploy" \
  OPENRYOKO_TEST_DEPLOY_COMMAND_PATH="$deploy_dir/openryoko-deploy-command" \
  OPENRYOKO_TEST_ACTIVE_CHECK_ATTEMPTS=1 \
  OPENRYOKO_TEST_PROCESS_COMMAND="${OPENRYOKO_TEST_PROCESS_COMMAND_OVERRIDE:-$failure_root/current/packages/jimmy/dist/bin/jimmy.js}" \
    bash "$deploy_dir/openryoko-pilot-deploy" "$failure_sha" "$requested_digest" >"$failure_root/deploy-$mode.log" 2>&1
  local status=$?
  set -e
  [[ $status -ne 0 ]] || { echo "failure fixture unexpectedly passed: $mode" >&2; exit 1; }
  [[ "$(realpath "$failure_root/current")" == "$(realpath "$failure_root/previous")" ]] \
    || {
      cat "$failure_root/deploy-$mode.log" >&2
      cat "$failure_root/systemctl.log" >&2
      echo "failure fixture changed the active pointer: $mode" >&2
      exit 1
    }
}

assert_rollback_restart() {
  local mode="$1"
  [[ "$(grep -Fxc 'restart openryoko.service' "$failure_root/systemctl.log")" -eq 2 ]] \
    || {
      cat "$failure_root/systemctl.log" >&2
      echo "activation failure did not restart both attempted and restored releases: $mode" >&2
      exit 1
    }
}

run_failure_case control-plane-mismatch 0 "$(printf '0%.0s' {1..64})"
[[ ! -s "$failure_root/systemctl.log" ]] \
  || { echo "control-plane mismatch restarted the service" >&2; exit 1; }
run_failure_case main-reject 0
run_failure_case lock-conflict 0
run_failure_case build-fail 0
[[ -z "$(find "$failure_root/releases" -mindepth 1 -maxdepth 1 -print -quit)" ]] \
  || { echo "build failure left an incomplete release" >&2; exit 1; }
[[ ! -s "$failure_root/systemctl.log" ]] \
  || { echo "build failure restarted the service" >&2; exit 1; }
run_failure_case guard-timeout 1
[[ ! -s "$failure_root/systemctl.log" ]] \
  || { echo "guard timeout restarted the service" >&2; exit 1; }
run_failure_case active-fail 0
assert_rollback_restart active-fail
run_failure_case entrypoint-mismatch 0
assert_rollback_restart entrypoint-mismatch
OPENRYOKO_TEST_PROCESS_COMMAND_OVERRIDE="$failure_root/other/jimmy.js" run_failure_case mainpid-mismatch 0
assert_rollback_restart mainpid-mismatch
mainpid_mismatch_log="$failure_root/deploy-mainpid-mismatch.log"
expected_release_dir="$(< "$failure_root/release-dir")"
expected_release_realpath="$(realpath "$expected_release_dir")"
grep -Fqx "openryoko deploy: expected process entrypoint: $failure_root/current/packages/jimmy/dist/bin/jimmy.js" "$mainpid_mismatch_log" \
  || { echo "cmdline mismatch did not report the expected entrypoint" >&2; exit 1; }
grep -Fqx "openryoko deploy: observed process command: $failure_root/other/jimmy.js" "$mainpid_mismatch_log" \
  || { echo "cmdline mismatch did not report the observed process command" >&2; exit 1; }
grep -Fqx 'openryoko deploy: observed MainPID: 123' "$mainpid_mismatch_log" \
  || { echo "cmdline mismatch did not report MainPID" >&2; exit 1; }
grep -Fqx "openryoko deploy: observed systemd ExecStart: $failure_root/systemd-entrypoint" "$mainpid_mismatch_log" \
  || { echo "cmdline mismatch did not report ExecStart" >&2; exit 1; }
grep -Fqx "openryoko deploy: observed current release realpath: $expected_release_realpath" "$mainpid_mismatch_log" \
  || { echo "cmdline mismatch did not report the current release realpath" >&2; exit 1; }
grep -Fqx "openryoko deploy: expected release directory: $expected_release_dir" "$mainpid_mismatch_log" \
  || { echo "cmdline mismatch did not report the expected release directory" >&2; exit 1; }

rm -rf "$failure_root/releases"/*
rm -f "$failure_root/current"
ln -s "$failure_root/previous" "$failure_root/current"
: > "$failure_root/systemctl.log"
: > "$failure_root/pnpm-pwd.log"
cat > "$failure_root/guard" <<'GUARD'
#!/usr/bin/env bash
exit 0
GUARD
chmod +x "$failure_root/guard"
PATH="$fixture_path" \
FIXTURE_MODE=prune-fail \
FIXTURE_EXPECT_RELEASE_CWD=1 \
FIXTURE_ROOT="$failure_root" \
FIXTURE_SHA="$failure_sha" \
FIXTURE_SYSTEMCTL_LOG="$failure_root/systemctl.log" \
OPENRYOKO_DEPLOY_TESTING=1 \
OPENRYOKO_TEST_RUNTIME_HOME="$failure_root" \
OPENRYOKO_TEST_SOURCE_REPO="$failure_root/source" \
OPENRYOKO_TEST_RELEASES_DIR="$failure_root/releases" \
OPENRYOKO_TEST_CURRENT_LINK="$failure_root/current" \
OPENRYOKO_TEST_RESTART_GUARD="$failure_root/guard" \
OPENRYOKO_TEST_LOCK_FILE="$failure_root/deploy.lock" \
OPENRYOKO_TEST_PNPM_BIN="$failure_root/pnpm" \
OPENRYOKO_TEST_DEPLOY_SCRIPT_PATH="$deploy_dir/openryoko-pilot-deploy" \
OPENRYOKO_TEST_DEPLOY_COMMAND_PATH="$deploy_dir/openryoko-deploy-command" \
OPENRYOKO_TEST_ACTIVE_CHECK_ATTEMPTS=1 \
OPENRYOKO_TEST_PROCESS_COMMAND="$failure_root/current/packages/jimmy/dist/bin/jimmy.js" \
  bash "$deploy_dir/openryoko-pilot-deploy" "$failure_sha" "$expected_source_output" >"$failure_root/deploy-prune-fail.log" 2>&1 \
  || {
    cat "$failure_root/deploy-prune-fail.log" >&2
    echo "post-activation prune failure reversed deploy success" >&2
    exit 1
  }
grep -Fq 'warning: worktree metadata pruning failed after successful activation' "$failure_root/deploy-prune-fail.log" \
  || {
    cat "$failure_root/deploy-prune-fail.log" >&2
    echo "post-activation prune failure did not emit a warning" >&2
    exit 1
  }
[[ "$(wc -l < "$failure_root/pnpm-pwd.log" | tr -d ' ')" == "2" ]] \
  || { echo "package manager did not start in the release worktree for install and build" >&2; exit 1; }

echo "deploy script, workflow contract, and rollback validation passed"
