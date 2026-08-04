#!/usr/bin/env ruby
# frozen_string_literal: true

require "yaml"

path = ARGV.fetch(0)
workflow = YAML.load_file(path, aliases: true)
trigger = workflow["on"] || workflow[true]
raise "workflow_dispatch is required" unless trigger.is_a?(Hash) && trigger.key?("workflow_dispatch")

raise "permissions must be exactly contents: read" unless workflow["permissions"] == { "contents" => "read" }
concurrency = workflow.fetch("concurrency")
raise "deploys must not cancel in progress" unless concurrency["cancel-in-progress"] == false

deploy = workflow.fetch("jobs").fetch("deploy")
raise "production environment is required" unless deploy["environment"] == "production"
checkout = deploy.fetch("steps").find { |step| step["uses"].to_s.start_with?("actions/checkout@") }
raise "checkout action must be commit pinned" unless checkout && checkout["uses"].match?(/\Aactions\/checkout@[0-9a-f]{40}\z/)

ssh_step = deploy.fetch("steps").find { |step| step["name"] == "Deploy through forced command" }
ssh_run = ssh_step&.fetch("run", "")
raise "strict host key checking is required" unless ssh_run.match?(/StrictHostKeyChecking=yes(?:\s|\\|\z)/)
raise "host key checking must not be weakened" if ssh_run.match?(/StrictHostKeyChecking=(?:no|accept-new)/)

puts "deploy workflow semantic contract passed"
