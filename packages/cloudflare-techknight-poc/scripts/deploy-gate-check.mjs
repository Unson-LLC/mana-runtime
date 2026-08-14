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
  if (!response.ok) throw new Error(`meeting_minutes_deploy_gate_http_${response.status}`);
  const gate = await response.json();
  if (gate?.allowed !== true) {
    const count = Array.isArray(gate?.activeRuns) ? gate.activeRuns.length : "unknown";
    throw new Error(`meeting_minutes_deploy_blocked_active_runs:${count}`);
  }
}
