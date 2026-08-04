#!/usr/bin/env bash
# One-time, root-only installer for the restricted GitHub Actions deploy principal.
set -euo pipefail

usage() {
  echo "usage: sudo $0 --authorized-key-file PATH" >&2
}

key_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --authorized-key-file)
      key_file="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "installer must run as root" >&2; exit 1; }
[[ -n "$key_file" && -f "$key_file" ]] || { usage; exit 2; }
readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly runtime_home="/home/ryoko"
readonly source_repo="$runtime_home/src/OpenRyoko"
readonly deploy_user="openryoko-deploy"
readonly service="openryoko.service"
readonly wrapper="$runtime_home/bin/ryoko"

[[ -f "$source_repo/packages/jimmy/dist/bin/jimmy.js" ]] \
  || { echo "current runtime entrypoint is missing" >&2; exit 1; }
systemctl cat "$service" >/dev/null \
  || { echo "$service is not installed" >&2; exit 1; }

rendered_config="$(mktemp -d)"
trap 'rm -rf "$rendered_config" "${dropin_tmp:-}" "${wrapper_tmp:-}"' EXIT
"$script_dir/render-pilot-deploy-config" --authorized-key-file "$key_file" --output-dir "$rendered_config"

[[ -x /bin/bash ]] || { echo "/bin/bash is required for sshd forced-command execution" >&2; exit 1; }
# sshd invokes authorized_keys forced commands through the account shell with
# `-c`. Keep the password locked and the key restricted below, but use a shell
# that can actually dispatch the forced command. usermod also repairs installs
# made by an earlier version that selected nologin.
id "$deploy_user" >/dev/null 2>&1 \
  || useradd --system --create-home --home-dir "/home/$deploy_user" --shell /bin/bash "$deploy_user"
usermod --shell /bin/bash "$deploy_user"
install -o root -g root -m 0755 "$script_dir/openryoko-pilot-deploy" /usr/local/sbin/openryoko-pilot-deploy
install -o root -g root -m 0755 "$script_dir/openryoko-deploy-command" /usr/local/sbin/openryoko-deploy-command
install -o root -g root -m 0755 "$source_repo/scripts/development-runner/guard-restart.sh" /usr/local/libexec/openryoko-guard-restart

deploy_home="/home/$deploy_user"
install -d -o "$deploy_user" -g "$deploy_user" -m 0700 "$deploy_home/.ssh"
install -m 0600 "$rendered_config/authorized_keys" "$deploy_home/.ssh/authorized_keys"
chown "$deploy_user:$deploy_user" "$deploy_home/.ssh/authorized_keys"

sudoers_file="/etc/sudoers.d/openryoko-pilot-deploy"
install -o root -g root -m 0440 "$rendered_config/openryoko-pilot-deploy.sudoers" "$sudoers_file"
visudo -cf "$sudoers_file"

# Pin systemd to the stable release-pointer wrapper. The drop-in is installed
# without restarting the service; activation remains an explicit guarded step.
dropin_dir="/etc/systemd/system/${service}.d"
install -d -o root -g root -m 0755 "$dropin_dir"
dropin_tmp="$(mktemp "$dropin_dir/10-release-pointer.conf.tmp.XXXXXX")"
install -m 0644 "$rendered_config/10-release-pointer.conf" "$dropin_tmp"
chown root:root "$dropin_tmp"
mv -f "$dropin_tmp" "$dropin_dir/10-release-pointer.conf"
systemctl daemon-reload

# Move the runtime entrypoint to a release pointer without changing the active code.
ln -sfn "$source_repo" "$runtime_home/current.next"
mv -Tf "$runtime_home/current.next" "$runtime_home/current"
if [[ -f "$wrapper" && ! -f "${wrapper}.pre-release-pointer" ]]; then
  cp -a "$wrapper" "${wrapper}.pre-release-pointer"
fi
wrapper_tmp="$(mktemp "${wrapper}.tmp.XXXXXX")"
install -m 0755 "$rendered_config/ryoko" "$wrapper_tmp"
chown ryoko:ryoko "$wrapper_tmp"
mv -f "$wrapper_tmp" "$wrapper"

exec_start="$(systemctl show --property ExecStart --value "$service")"
[[ "$exec_start" == *"$wrapper start"* ]] \
  || { echo "$service does not use the release-pointer wrapper" >&2; exit 1; }
rm -rf "$rendered_config"
trap - EXIT

echo "Restricted deploy principal installed. Verify with: sudo -u ryoko $wrapper status"
