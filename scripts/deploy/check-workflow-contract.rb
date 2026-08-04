#!/usr/bin/env ruby
# frozen_string_literal: true

require "yaml"

path = ARGV.fetch(0)
workflow = YAML.load_file(path, aliases: true)
trigger = workflow["on"] || workflow[true]
raise "workflow_dispatch is required" unless trigger.is_a?(Hash) && trigger.key?("workflow_dispatch")
dispatch = trigger.fetch("workflow_dispatch")
input = dispatch.fetch("inputs").fetch("commit_sha")
raise "commit_sha must remain optional" unless input["required"] == false
raise "commit_sha must remain a string" unless input["type"] == "string"

raise "permissions must be exactly contents: read" unless workflow["permissions"] == { "contents" => "read" }
concurrency = workflow.fetch("concurrency")
raise "deploys must not cancel in progress" unless concurrency["cancel-in-progress"] == false

deploy = workflow.fetch("jobs").fetch("deploy")
raise "production environment is required" unless deploy["environment"] == "production"
checkout = deploy.fetch("steps").find { |step| step["uses"].to_s.start_with?("actions/checkout@") }
raise "checkout action must be commit pinned" unless checkout && checkout["uses"].match?(/\Aactions\/checkout@[0-9a-f]{40}\z/)

ssh_config_step = deploy.fetch("steps").find { |step| step["name"] == "Configure restricted SSH client" }
ssh_config_run = ssh_config_step&.fetch("run", "")
deploy_key_lines = ssh_config_run.lines.filter { |line| line.include?("DEPLOY_KEY") }.map(&:strip)
allowed_deploy_key_lines = [
  'test -n "$DEPLOY_KEY"',
  'printf \'%s\\n\' "$DEPLOY_KEY" > "$HOME/.ssh/id_ed25519"'
]
raise "deploy secret must only be validated and written to the private key file" unless deploy_key_lines == allowed_deploy_key_lines

resolve_step = deploy.fetch("steps").find { |step| step["name"] == "Resolve and validate commit" }
raise "commit resolution step is required" unless resolve_step
raise "commit resolution must use the tested helper" unless resolve_step.fetch("run", "").include?("scripts/deploy/resolve-deploy-ref")
raise "commit_sha must feed the resolver" unless resolve_step.dig("env", "REQUESTED_SHA") == "${{ inputs.commit_sha }}"

ssh_step = deploy.fetch("steps").find { |step| step["name"] == "Deploy through forced command" }
ssh_run = ssh_step&.fetch("run", "")
raise "deploy must use the resolver output SHA" unless ssh_step&.dig("env", "TARGET_SHA") == "${{ steps.target.outputs.sha }}"
raise "deploy must use the restricted SSH principal" unless ssh_run.include?('openryoko-deploy@"$DEPLOY_HOST"')
raise "forced command payload must be exactly deploy plus the validated SHA" unless ssh_run.lines.map(&:strip).include?('"deploy $TARGET_SHA"')
raise "strict host key checking is required" unless ssh_run.match?(/StrictHostKeyChecking=yes(?:\s|\\|\z)/)
raise "host key checking must not be weakened" if ssh_run.match?(/StrictHostKeyChecking=(?:no|accept-new)/)

summary_step = deploy.fetch("steps").find { |step| step["name"] == "Record deployment summary" }
summary_run = summary_step&.fetch("run", "")
raise "summary must report the server-side result" unless summary_run.include?("server-side build, guarded restart, and systemd active check passed")
raise "summary must preserve the user-outcome disclaimer" unless summary_run.include?("Slack/Web user outcome still requires the release verification")

puts "deploy workflow semantic contract passed"
