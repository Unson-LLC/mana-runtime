#!/usr/bin/env bash

ensure_deploy_account() {
  local deploy_user="$1"
  local deploy_home="$2"
  local deploy_shell="${3:-/bin/bash}"
  local shadow_entry=""
  local password_field=""

  [[ -x "$deploy_shell" ]] \
    || { echo "$deploy_shell is required for sshd forced-command execution" >&2; return 1; }

  id "$deploy_user" >/dev/null 2>&1 \
    || useradd --system --create-home --home-dir "$deploy_home" --shell "$deploy_shell" "$deploy_user"

  # Existing installations may have either a nologin shell or a usable
  # password. sshd needs a real shell to dispatch authorized_keys commands,
  # while password login must remain impossible.
  usermod --shell "$deploy_shell" --lock "$deploy_user"
  shadow_entry="$(getent shadow "$deploy_user")" \
    || { echo "cannot verify password lock for $deploy_user" >&2; return 1; }
  password_field="${shadow_entry#*:}"
  password_field="${password_field%%:*}"
  [[ "$password_field" == \!* || "$password_field" == \** ]] \
    || { echo "password is not locked for $deploy_user" >&2; return 1; }
}
