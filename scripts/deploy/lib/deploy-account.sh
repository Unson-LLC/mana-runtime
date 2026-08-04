#!/usr/bin/env bash

ensure_deploy_account() {
  local account_name="$1"
  local account_home="$2"
  local account_shell="${3:-/bin/bash}"
  local shadow_entry=""
  local password_field=""

  [[ -x "$account_shell" ]] \
    || { echo "$account_shell is required for sshd forced-command execution" >&2; return 1; }

  id "$account_name" >/dev/null 2>&1 \
    || useradd --system --create-home --home-dir "$account_home" --shell "$account_shell" "$account_name"

  # Existing installations may have either a nologin shell or a usable
  # password. sshd needs a real shell to dispatch authorized_keys commands,
  # while password login must remain impossible.
  usermod --shell "$account_shell" --lock "$account_name"
  shadow_entry="$(getent shadow "$account_name")" \
    || { echo "cannot verify password lock for $account_name" >&2; return 1; }
  password_field="${shadow_entry#*:}"
  password_field="${password_field%%:*}"
  [[ "$password_field" == \!* || "$password_field" == \** ]] \
    || { echo "password is not locked for $account_name" >&2; return 1; }
}

seed_release_pointer_if_missing() {
  local pointer_runtime_home="$1"
  local pointer_source_repo="$2"
  local current_link="$pointer_runtime_home/current"

  if [[ ! -e "$current_link" && ! -L "$current_link" ]]; then
    local next_link="${current_link}.next.$$"
    ln -s "$pointer_source_repo" "$next_link"
    mv -f "$next_link" "$current_link"
  fi
}
