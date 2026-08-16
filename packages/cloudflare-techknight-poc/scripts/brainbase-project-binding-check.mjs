import { readFile } from "node:fs/promises";

const clean = (value) => typeof value === "string" ? value.trim() : "";

export function collectMeetingMinutesProjectBindings(config) {
  const vars = config?.vars;
  if (!vars || typeof vars !== "object") throw new Error("meeting_minutes_brainbase_project_check_config_missing");
  const parseArray = (name) => {
    const raw = vars[name];
    if (typeof raw !== "string") throw new Error(`meeting_minutes_brainbase_project_check_config_missing:${name}`);
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error(`meeting_minutes_brainbase_project_check_config_invalid:${name}`); }
    if (!Array.isArray(parsed)) throw new Error(`meeting_minutes_brainbase_project_check_config_invalid:${name}`);
    return parsed;
  };
  const destinations = [...parseArray("MEETING_MINUTES_DESTINATIONS_JSON"), ...parseArray("MEETING_MINUTES_ADDITIONAL_DESTINATIONS_JSON")];
  const targets = parseArray("TASK_BOARD_TARGETS_JSON");
  const targetsById = new Map(targets.map((target) => [clean(target?.targetId), target]));
  const requiredCodes = new Set();
  for (const destination of destinations) {
    const id = clean(destination?.id) || "unknown";
    const contextCode = clean(destination?.contextProjectCode);
    const taskCodes = Array.isArray(destination?.taskProjectCodes) ? destination.taskProjectCodes.map(clean).filter(Boolean) : [];
    const targetId = clean(destination?.taskBoardTargetId);
    if (!contextCode || taskCodes.length === 0 || !targetId) throw new Error(`meeting_minutes_brainbase_project_check_binding_missing:${id}`);
    const target = targetsById.get(targetId);
    const targetCodes = Array.isArray(target?.projectCodes) ? target.projectCodes.map(clean).filter(Boolean) : [];
    if (!target || JSON.stringify([...new Set(targetCodes)].sort()) !== JSON.stringify([...new Set(taskCodes)].sort())) {
      throw new Error(`meeting_minutes_brainbase_project_check_target_mismatch:${id}:${targetId}`);
    }
    requiredCodes.add(contextCode);
    for (const code of taskCodes) requiredCodes.add(code);
    for (const code of targetCodes) requiredCodes.add(code);
  }
  return { destinations, requiredCodes: [...requiredCodes].sort() };
}

export function projectCodesFromGraphResponse(body) {
  const records = body && typeof body === "object" && Array.isArray(body.records) ? body.records : undefined;
  if (!records) throw new Error("meeting_minutes_brainbase_project_check_response_invalid");
  const codes = records.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const payload = item.payload && typeof item.payload === "object" ? item.payload : {};
    return [item.id, item.project_code, item.projectCode, payload.project_code, payload.projectCode, payload.code].map(clean).filter(Boolean);
  });
  return [...new Set(codes)].sort();
}

export async function assertBrainbaseMeetingMinutesProjects({
  configPath = new URL("../wrangler.unson-business.jsonc", import.meta.url), baseUrl, token, timeoutMs = 10_000, fetchImpl = fetch,
} = {}) {
  let config;
  try { config = JSON.parse(await readFile(configPath, "utf8")); } catch { throw new Error("meeting_minutes_brainbase_project_check_config_invalid"); }
  const resolvedBaseUrl = clean(baseUrl) || clean(config?.vars?.BRAINBASE_GRAPH_API_BASE_URL) || clean(config?.vars?.BRAINBASE_TASK_API_BASE_URL);
  if (!resolvedBaseUrl || !clean(token)) throw new Error("meeting_minutes_brainbase_project_check_auth_missing");
  const { requiredCodes } = collectMeetingMinutesProjectBindings(config);
  const url = new URL("/api/info/graph/entities", resolvedBaseUrl);
  url.searchParams.set("type", "project"); url.searchParams.set("limit", "500");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: controller.signal });
  } catch { throw new Error("meeting_minutes_brainbase_project_check_unreachable"); }
  finally { clearTimeout(timer); }
  if (!response.ok) throw new Error(`meeting_minutes_brainbase_project_check_http_${response.status}`);
  let body;
  try { body = await response.json(); } catch { throw new Error("meeting_minutes_brainbase_project_check_response_invalid"); }
  const authorized = new Set(projectCodesFromGraphResponse(body));
  const missing = requiredCodes.filter((code) => !authorized.has(code));
  if (missing.length > 0) throw new Error(`meeting_minutes_brainbase_project_check_missing:${missing.join(",")}`);
  return { requiredCodes, authorizedCodes: [...authorized] };
}

export async function assertBrainbaseMeetingMinutesRuntimeProjects({
  configPath, baseUrl, taskToken, graphToken, timeoutMs = 10_000, fetchImpl = fetch,
} = {}) {
  if (!clean(taskToken)) throw new Error("meeting_minutes_brainbase_project_check_auth_missing:task");
  if (!clean(graphToken)) throw new Error("meeting_minutes_brainbase_project_check_auth_missing:graph");
  const graph = await assertBrainbaseMeetingMinutesProjects({
    configPath, baseUrl, token: graphToken, timeoutMs, fetchImpl,
  });
  const task = await assertBrainbaseMeetingMinutesProjects({
    configPath, baseUrl, token: taskToken, timeoutMs, fetchImpl,
  });
  return { graph, task };
}
