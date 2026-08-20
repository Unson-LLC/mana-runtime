import { setMeetingMinutesIntakePaused } from "./deploy-gate-check.mjs";

const action = process.argv[2];
if (action !== "pause" && action !== "resume") throw new Error("meeting_minutes_intake_control_action_invalid");

const state = await setMeetingMinutesIntakePaused({
  baseUrl: process.env.UNSON_BUSINESS_WORKER_URL,
  token: process.env.SANDBOX_PROBE_TOKEN,
  paused: action === "pause",
});
console.log(JSON.stringify({
  ok: true,
  intakePaused: state.intakePaused,
  activeRunCount: Array.isArray(state.activeRuns) ? state.activeRuns.length : null,
}));
