export async function assertMeetingMinutesDeployAllowed({ baseUrl, token, fetchImpl = fetch, timeoutMs = 10_000,
  allowMissingGate = false }) {
  if (!baseUrl || !token) throw new Error("meeting_minutes_deploy_gate_config_missing");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(new URL("/admin/meeting-minutes/deploy-gate", baseUrl), {
      headers: { authorization: `Bearer ${token}` }, signal: controller.signal,
    });
  } catch {
    throw new Error("meeting_minutes_deploy_gate_unreachable");
  } finally {
    clearTimeout(timeout);
  }
  if (response.status === 404 && allowMissingGate) return;
  if (response.status === 503 && allowMissingGate) {
    const legacy = await response.clone().json().catch(() => null);
    if (legacy?.boundary === "brainbase_proxy" && legacy?.error === "TENANT_CONTEXT_MISSING") return;
    if (legacy?.error === "runtime_bootstrap_mode_active") return;
  }
  if (!response.ok) throw new Error(`meeting_minutes_deploy_gate_http_${response.status}`);
  const gate = await response.json();
  if (gate?.allowed !== true) {
    const count = Array.isArray(gate?.activeRuns) ? gate.activeRuns.length : "unknown";
    throw new Error(`meeting_minutes_deploy_blocked_active_runs:${count}`);
  }
}

export async function setMeetingMinutesIntakePaused({ baseUrl, token, paused, fetchImpl = fetch, timeoutMs = 10_000 }) {
  if (!baseUrl || !token || typeof paused !== "boolean") throw new Error("meeting_minutes_intake_control_config_missing");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(new URL("/admin/meeting-minutes/intake", baseUrl), {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ paused }), signal: controller.signal,
    });
  } catch { throw new Error("meeting_minutes_intake_control_unreachable"); }
  finally { clearTimeout(timeout); }
  if (!response.ok) throw new Error(`meeting_minutes_intake_control_http_${response.status}`);
  const state = await response.json();
  if (state?.intakePaused !== paused) throw new Error("meeting_minutes_intake_control_state_mismatch");
  return state;
}
