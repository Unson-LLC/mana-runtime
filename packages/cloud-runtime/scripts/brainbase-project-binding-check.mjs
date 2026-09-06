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
  const rawTargets = vars.TASK_BOARD_TARGETS_JSON;
  if (typeof rawTargets !== "string") throw new Error("meeting_minutes_brainbase_project_check_config_missing:TASK_BOARD_TARGETS_JSON");
  let parsedTargets;
  try { parsedTargets = JSON.parse(rawTargets); } catch { throw new Error("meeting_minutes_brainbase_project_check_config_invalid:TASK_BOARD_TARGETS_JSON"); }
  const targets = Array.isArray(parsedTargets) ? parsedTargets : parsedTargets?.targets;
  if (!Array.isArray(targets)) throw new Error("meeting_minutes_brainbase_project_check_config_invalid:TASK_BOARD_TARGETS_JSON");
  const targetsById = new Map(targets.map((target) => [clean(target?.targetId), target]));
  const requiredCodes = new Set();
  const contextCodes = new Set();
  const taskScopeCodes = new Set();
  for (const destination of destinations) {
    const id = clean(destination?.id) || "unknown";
    const contextCode = clean(destination?.contextProjectCode);
    const taskCodes = Array.isArray(destination?.taskProjectCodes) ? destination.taskProjectCodes.map(clean).filter(Boolean) : [];
    const targetId = clean(destination?.taskBoardTargetId);
    if (!contextCode || taskCodes.length === 0 || !targetId) throw new Error(`meeting_minutes_brainbase_project_check_binding_missing:${id}`);
    const target = targetsById.get(targetId);
    const targetCodes = Array.isArray(target?.projectCodes) ? target.projectCodes.map(clean).filter(Boolean) : [];
    if (!target || taskCodes.some((code) => !targetCodes.includes(code))) {
      throw new Error(`meeting_minutes_brainbase_project_check_target_mismatch:${id}:${targetId}`);
    }
    requiredCodes.add(contextCode);
    contextCodes.add(contextCode);
    for (const code of taskCodes) { requiredCodes.add(code); taskScopeCodes.add(code); }
    for (const code of targetCodes) { requiredCodes.add(code); taskScopeCodes.add(code); }
  }
  return { destinations, requiredCodes: [...requiredCodes].sort(),
    contextCodes: [...contextCodes].sort(), taskCodes: [...taskScopeCodes].sort() };
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

async function fetchJson({ url, token, timeoutMs, fetchImpl, errorPrefix }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: controller.signal });
  } catch { throw new Error(`${errorPrefix}_unreachable`); }
  finally { clearTimeout(timer); }
  if (!response.ok) throw new Error(`${errorPrefix}_http_${response.status}`);
  let body;
  try { body = await response.json(); } catch { throw new Error(`${errorPrefix}_response_invalid`); }
  return body;
}

async function fetchAuthorizedProjectCodes(options) {
  return projectCodesFromGraphResponse(await fetchJson(options));
}

async function assertCanonicalTaskApiReachable(options) {
  const body = await fetchJson(options);
  if (!body || typeof body !== "object" || !Array.isArray(body.items)) {
    throw new Error(`${options.errorPrefix}_response_invalid`);
  }
}

async function assertTaskProjectCodeReadable({ code, baseUrl, token, timeoutMs, fetchImpl }) {
  const url = new URL("/api/companion/tasks", baseUrl);
  url.searchParams.set("project_code", code);
  url.searchParams.set("limit", "1");
  const errorPrefix = `meeting_minutes_brainbase_project_check_task_scope:${code}`;
  const body = await fetchJson({ url, token, timeoutMs, fetchImpl, errorPrefix });
  if (!body || typeof body !== "object" || !Array.isArray(body.items)) {
    throw new Error(`${errorPrefix}_response_invalid`);
  }
  const matches = body.items.some((item) => Array.isArray(item?.project_codes)
    && item.project_codes.map(clean).includes(code));
  if (!matches) throw new Error(`${errorPrefix}_missing`);
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
  configPath, taskBaseUrl, graphBaseUrl, taskToken, graphToken, timeoutMs = 10_000, fetchImpl = fetch,
} = {}) {
  if (!clean(taskToken)) throw new Error("meeting_minutes_brainbase_project_check_auth_missing:task");
  if (!clean(graphToken)) throw new Error("meeting_minutes_brainbase_project_check_auth_missing:graph");
  let config;
  try { config = JSON.parse(await readFile(configPath ?? new URL("../wrangler.unson-business.jsonc", import.meta.url), "utf8")); }
  catch { throw new Error("meeting_minutes_brainbase_project_check_config_invalid"); }
  const resolvedGraphBaseUrl = clean(graphBaseUrl) || clean(config?.vars?.BRAINBASE_GRAPH_API_BASE_URL);
  const resolvedTaskBaseUrl = clean(taskBaseUrl) || clean(config?.vars?.BRAINBASE_TASK_API_BASE_URL);
  if (!resolvedTaskBaseUrl) throw new Error("meeting_minutes_brainbase_project_check_auth_missing:task_url");
  if (!resolvedGraphBaseUrl) throw new Error("meeting_minutes_brainbase_project_check_auth_missing:graph_url");
  const { contextCodes, taskCodes: requiredTaskCodes } = collectMeetingMinutesProjectBindings(config);
  const graphUrl = new URL("/api/info/graph/entities", resolvedGraphBaseUrl);
  graphUrl.searchParams.set("type", "project"); graphUrl.searchParams.set("limit", "500");
  const taskApiUrl = new URL("/api/companion/tasks", resolvedTaskBaseUrl);
  taskApiUrl.searchParams.set("limit", "1");
  const graphCodes = await fetchAuthorizedProjectCodes({ url: graphUrl, token: graphToken, timeoutMs, fetchImpl,
    errorPrefix: "meeting_minutes_brainbase_project_check_graph" });
  await assertCanonicalTaskApiReachable({ url: taskApiUrl, token: taskToken, timeoutMs, fetchImpl,
    errorPrefix: "meeting_minutes_brainbase_project_check_task_api" });
  const taskCodes = await fetchAuthorizedProjectCodes({ url: graphUrl, token: taskToken, timeoutMs, fetchImpl,
    errorPrefix: "meeting_minutes_brainbase_project_check_task_scope" });
  const graphCodeSet = new Set(graphCodes);
  const taskCodeSet = new Set(taskCodes);
  const missingGraph = contextCodes.filter((code) => !graphCodeSet.has(code));
  if (missingGraph.length > 0) throw new Error(`meeting_minutes_brainbase_project_check_graph_missing:${missingGraph.join(",")}`);
  const taskReadbackCodes = requiredTaskCodes.filter((code) => !taskCodeSet.has(code));
  await Promise.all(taskReadbackCodes.map((code) => assertTaskProjectCodeReadable({ code,
    baseUrl: resolvedTaskBaseUrl, token: taskToken, timeoutMs, fetchImpl })));
  return { graph: { requiredCodes: contextCodes, authorizedCodes: graphCodes },
    task: { requiredCodes: requiredTaskCodes, authorizedCodes: [...new Set([...taskCodes, ...taskReadbackCodes])].sort(), apiReachable: true } };
}
