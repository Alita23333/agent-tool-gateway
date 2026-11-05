// Phase 2 host bootstrap — runs inside the APK-owned Node runtime on Android.
//
// Modes (SPIKE_MODE):
//   real — Phase 2 host skeleton: app-server + loopback bridge with token
//          gate, reverse-request auto-responder (deny-by-default permission
//          answers in the CORRECT stdio shape {id,result:{decision}} per
//          upstream-map §Security audit), session list/read endpoints, SSE
//          event streaming. No mock model, no auto smoke turn.
//   mock — hermetic Phase 0 demo (loopback mock model + tool-call round trip).
//
// Bridge contract (docs/upstream-map.md insertion points 1/2):
// - lives in the FGS-owned node process (core tears down ~100ms after client
//   disconnect — the bridge is the single protocol client, never the Activity)
// - must answer every server-N reverse request (re-announce + timeout would
//   otherwise deny/stall); permission requests are surfaced to attached UI
//   clients and auto-DENIED when nobody answers in time (safe default)
// - loopback only; /rpc, /status, /events, /sessions require the bridge token
//   (X-Bridge-Token header or ?t= query — the WebView page gets it from its URL)
const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = process.env.SPIKE_ROOT || path.dirname(process.argv[1]);
const RUNTIME = path.join(ROOT, "runtime");
const WS_ROOT = path.join(ROOT, "workspaces");
const ACTIVE_WS_FILE = path.join(ROOT, "active-workspace");
function activeWorkspace() {
  try {
    const n = fs.readFileSync(ACTIVE_WS_FILE, "utf8").trim();
    if (n && !n.includes("/") && !n.includes("..")) return n;
  } catch {}
  return "default";
}
const WORKSPACE = path.join(WS_ROOT, activeWorkspace());
fs.mkdirSync(WORKSPACE, { recursive: true });
const HTTP_PORT = Number(process.env.SPIKE_HTTP_PORT || 8765);
const MOCK_PORT = Number(process.env.SPIKE_MOCK_PORT || 18080);
const ZCODE = path.join(RUNTIME, "zcode.cjs");
const TOKEN = process.env.BRIDGE_TOKEN || "";
const PERMISSION_TIMEOUT_MS = Number(process.env.PERMISSION_TIMEOUT_MS || 15000);

const MODE = process.env.SPIKE_MODE === "mock" ? "mock" : "real";

// Phase 4 Tool Gateway (map-only boundary). Loads before anything spawns.
const { Gateway } = require(path.join(RUNTIME, "gateway.cjs"));
// Phase 8 (module-level: the http handlers reference these before the
// in-handler declarations would initialize — TDZ measured on device)
const uiTree = require("./ui-tree.cjs");
// Phase 9 W3: the vision pipeline (ui_see, bridge-inline)
const visionPipeline = require("./vision-pipeline.cjs");
const SHOTS = path.join(RUNTIME, "vision", "shots");
let liveUiRaw = null;
function purgeVisionFrames() {
  liveUiRaw = null;
  try { for (const f of fs.readdirSync(SHOTS)) fs.unlinkSync(path.join(SHOTS, f)); } catch {}
}
purgeVisionFrames(); // process restart never resurrects live screen observations
function frameMetadata(id, session) {
  if (!/^shot_[a-f0-9]{32}$/.test(id || "")) return null;
  try {
    const rows = JSON.parse(fs.readFileSync(path.join(SHOTS, "index.json"), "utf8"));
    const row = rows.find(x => x.shotId === id && x.sessionId === session);
    if (!row || row.filename !== id + ".jpeg" || row.bytes > 153600 || Date.now()-row.capturedAt > 30000) return null;
    return row;
  } catch { return null; }
}
function settleAbandonedCarrier(callId, pending, reason) {
  let body = {ok:false,error:{code:reason}};
  if (pending.nativeDispatcher) {
    try {
      // Cancellation ends the already admitted operation; it grants no new authority.
      // Use the same exact scope and CAS writer as an ordinary Dispatcher result.
      carrierAuthorization.finish(pending.approvalOpId, pending.toolId, pending.callArgs || {},
        pending.sessionId, callId, body, pending.providerContentHash, pending.providerDefinitionHash);
    } catch {
      body = {ok:false,error:{code:"JOURNAL_RESULT_FAILED",message:"Cancelled provider result could not be committed"}};
      log("abandoned native carrier result could not be journalled");
    }
  }
  return body;
}
function cancelCarrierPending(reason) {
  state.carrierEpoch = (state.carrierEpoch || 0) + 1;
  if (typeof carrierAuthorization !== "undefined") carrierAuthorization.clear();
  for (const [id, pending] of (state.carrierPending || new Map())) {
    clearTimeout(pending.timer);
    pending.resolve({status:200, body:settleAbandonedCarrier(id, pending, reason)});
    state.carrierPending.delete(id);
  }
  state.carrierQueue = [];
  for (const controller of (state.analysisControllers || new Set())) controller.abort();
  for (const controller of (state.visionControllers || new Set())) controller.abort();
  state.visionCache?.clear();
  purgeVisionFrames();
}
const { TOOLS: WS_TOOLS, handleWorkspaceTool } = require("./workspace-files.cjs");
const workspaceAnalysis = require("./workspace-analysis.cjs");

const gateway = new Gateway().init({
  root: ROOT,
  workspace: WORKSPACE,
  mode: process.env.GATEWAY_MODE || "ask",
});
gateway.onAsk = (key, info) => {
  broadcast({ type: "permission", requestId: key, ...info });
};

// Phase 7 host-owned web search (web-search.cjs pipeline; the model-visible
// carrier tool mcp__android-host__web_search). Config is materialized by the
// Kotlin settings path into files/runtime/search/search_config.json; the
// bridge re-reads it on mtime change (settings save → effect, no respawn).
const { WEB_SEARCH_TOOL, executeSearch } = require(path.join(RUNTIME, "web-search.cjs"));
const SEARCH_CONFIG_PATH = path.join(ROOT, "runtime", "search", "search_config.json");
const searchState = { config: null, mtimeMs: -1, lastResultCode: null };
function loadSearchConfig() {
  try {
    const st = fs.statSync(SEARCH_CONFIG_PATH);
    if (searchState.config && st.mtimeMs === searchState.mtimeMs) return searchState.config;
    searchState.config = JSON.parse(fs.readFileSync(SEARCH_CONFIG_PATH, "utf8"));
    searchState.mtimeMs = st.mtimeMs;
    log("search config loaded: " + ((searchState.config.backends || []).map((b) => b.id).join(",") || "empty"));
  } catch {
    searchState.config = null;
    searchState.mtimeMs = -1;
  }
  return searchState.config;
}
// Lab flags (scriptable test levers, never UI settings — the Phase 6 pattern):
// labsearch relaxes https-only + loopback FOR THE CONFIGURED BACKEND ORIGIN
// ONLY; carrier.disabled is the device-side kill switch for the MCP carrier
// (nothing sets CARRIER_ENABLED on device — RuntimeEnv has no such key).
const LAB_SEARCH = process.env.SPIKE_LAB_SEARCH === "1" || fs.existsSync(path.join(ROOT, "labsearch.enabled"));
const LAB_VISION = fs.existsSync(path.join(ROOT, "labvision.enabled"));
const CARRIER_OFF = process.env.CARRIER_ENABLED === "0" || fs.existsSync(path.join(ROOT, "carrier.disabled"));

fs.mkdirSync(WORKSPACE, { recursive: true });
// No task-file mutation during runtime initialization.

const state = {
  labVision: null,
  phase: "booting",
  mode: MODE,
  nodeVersion: process.version,
  arch: process.arch,
  workspace: WORKSPACE,
  evidence: [],
  events: [],
  permissionsSeen: 0,
  startedAt: Date.now(),
};
const log = (line) => {
  state.evidence.push(`${new Date().toISOString()} ${line}`);
  if (state.evidence.length > 400) state.evidence.splice(0, state.evidence.length - 400);
  broadcast({ type: "log", line });
};

// ---------------------------------------------------------- app-server child
// W7: network.* levers (proxy / no-proxy / CA file) materialize into the
// child env (aliases measured working: CONNECT through a loopback proxy was
// observed with env vars) — the CLI config network.* is written at boot too.
function networkEnv() {
  const cfg = loadSearchConfig();
  const net = (cfg && cfg.network) || {};
  const env = {};
  if (net.httpProxy) {
    env.HTTP_PROXY = net.httpProxy; env.HTTPS_PROXY = net.httpProxy;
    env.http_proxy = net.httpProxy; env.https_proxy = net.httpProxy;
  }
  if (net.noProxy) { env.NO_PROXY = net.noProxy; env.no_proxy = net.noProxy; }
  if (net.caCertFile) env.NODE_EXTRA_CA_CERTS = net.caCertFile;
  return env;
}
const childEnv = {
  ...process.env,
  ...networkEnv(),
  HOME: ROOT,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: path.join(RUNTIME, "provider", "zcode-builtin.json"),
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(RUNTIME, "provider", "personal_provider_config.json"),
  OPENSSL_CONF: "/dev/null",
};
// optional fetch diagnostics for the app-server child (diag-fetch.cjs)
if (process.env.DIAG_FETCH) {
  childEnv.NODE_OPTIONS = "--require " + path.join(RUNTIME, "diag-fetch.cjs");
}
let child = null;
let childSeq = 0;
const childResponses = new Map();
// session/create params by request id (for the setThoughtLevel repair)
const pendingCreates = new Map();
const DEFAULT_THOUGHT_LEVEL = process.env.DEFAULT_THOUGHT_LEVEL || "disabled";

// every client->server message passes through here; remember create params
// Fresh native observation before coordinate authorization; READ uses the same Gateway.
const { CarrierAuthorization } = require("./carrier-authorization.cjs");
var carrierAuthorization = new CarrierAuthorization(gateway);
function boundInternalApproval(toolId, input, sessionId, operationId) {
  const operation = gateway.journalView(500).find(r => r.id === operationId);
  if (!operation || operation.decision !== "allow" || operation.tool !== "mcp__android-host__" + toolId ||
      operation.session !== sessionId || operation.args !== JSON.stringify(input)) throw Error("GATEWAY_INTENT_UNBOUND");
  return operation.id;
}
async function tapPreflight(args, sessionId, signal) {
  if (!Number.isInteger(args.x) || !Number.isInteger(args.y)) throw Error("ui_invalid_input");
  const approved = await gateway.handlePermission({requestId:"preflight_" + require("node:crypto").randomUUID(),
    sessionId,toolName:"mcp__android-host__ui_dump",input:{}});
  if (approved.decision !== "allow" || signal.aborted) throw Error("ui_cancelled");
  const approvalOpId = boundInternalApproval("ui_dump", {}, sessionId, approved.operationId);
  const callId = "preflight_" + require("node:crypto").randomUUID();
  const dump = await new Promise(resolve => {
    state.carrierPending = state.carrierPending || new Map(); state.carrierQueue = state.carrierQueue || [];
    const finish = r => {clearTimeout(timer); signal.removeEventListener("abort",abort);
      state.carrierPending.delete(callId); state.carrierQueue = state.carrierQueue.filter(x=>x.callId!==callId); resolve(r.body?.structuredContent);};
    const abort = () => finish({body:{structuredContent:{ok:false}}});
    const timer = setTimeout(abort,8000); signal.addEventListener("abort",abort,{once:true});
    state.carrierPending.set(callId,{resolve:finish,timer,toolId:"ui_dump",callArgs:{},approvalOpId,sessionId,epoch:state.carrierEpoch || 0});
    state.carrierQueue.push({callId,toolId:"ui_dump",arguments:{},meta:{sessionId}});
  });
  if (!dump?.ok || !liveUiRaw || dump.treeId !== "g" + liveUiRaw.generation || signal.aborted) throw Error("ui_preflight_failed");
  if (liveUiRaw.truncatedRaw) throw Error("ui_preflight_truncated");
  const labels = [args.label || ""];
  function walk(n) {
    if (n.vis === false) return;
    const b = n.b;
    if (Array.isArray(b) && args.x >= b[0] && args.y >= b[1] && args.x < b[2] && args.y < b[3] && !n.pwd)
      labels.push(n.t || "", n.cd || "");
    for (const child of n.children || []) walk(child);
  }
  for (const node of liveUiRaw.nodes || []) walk(node);
  const label = labels.filter(Boolean).join(" | ");
  if (label.length > 2000) throw Error("ui_preflight_too_large");
  return {treeId:dump.treeId,label,epoch:liveUiRaw.observationEpoch};
}
function forwardToChild(msgStr) {
  try {
    const m = JSON.parse(msgStr);
    const session = m.params?.sessionId;
    if (session && ["session/send", "session/resume"].includes(m.method) && session !== state.activeSession) {
      cancelCarrierPending("SESSION_CHANGED"); state.activeSession = session;
    }
    if ((!session || session === state.activeSession) && /^session\/(?:stop|cancel|delete|dispose)$/.test(m.method || "")) cancelCarrierPending("CANCELLED");
    if (m && m.method === "session/create" && Number.isInteger(m.id)) {
      pendingCreates.set(m.id, m.params || {});
    }
  } catch {}
  const m = JSON.parse(msgStr);
  if (m.id === undefined) {
    if (m.method !== "session/stop") throw Error("request id required");
    child.stdin.write(msgStr + "\n");
    return;
  }
  skillBindings.dispatch(m.method, m.params || {}).then(
    reply => handleCoreMessage({ ...reply, id: m.id }),
    error => handleCoreMessage({ id: m.id, error: { code: -32071, message: "技能会话准备失败：" + error.message, data: { code: error.message } } }),
  );
}

function answerServerRequest(m) {
  // Every server-initiated request must be answered or the FIFO queue stalls
  // (upstream re-announces with backoff then times out; timeouts on
  // permissions behave as denial). Correct stdio shapes per upstream-rpc F3.
  if (m.method === "session/requestRuntimePreferences") {
    return {
      nativeSearchEnhancementsEnabled: false,
      memoryEnabled: false,
      askUserQuestionAutoResolutionEnabled: true,
    };
  }
  if (m.method === "interaction/requestPermission") {
    // Phase 4 Gateway pipeline: classify → decide → ask/hard-confirm/deny,
    // journal, backup on approved file writes
    state.permissionsSeen++;
    const approvalEpoch = state.carrierEpoch || 0;
    const p = Promise.resolve(gateway.handlePermission(m.params)).then(permission => {
      if (approvalEpoch !== (state.carrierEpoch || 0)) return {decision:"deny",reason:"session cancelled"};
      carrierAuthorization.recordBroker(m.params, permission);
      const {operationId, ...wirePermission} = permission;
      return wirePermission; // internal operation identity is never a Core protocol change
    });
    // W-T2.0 (F18): the gateway's pending map is keyed on params.requestId
    // (gateway.cjs askUi), not the JSON-RPC id — keying on m.id made this
    // timeout a no-op. Prefer the permission requestId, fall back defensively.
    const key = String((m.params && m.params.requestId) || m.id);
    setTimeout(() => gateway.timeoutAnswer(key), PERMISSION_TIMEOUT_MS);
    return p;
  }
  if (m.method === "interaction/requestUserInput") {
    // no interactive input surface in the skeleton; signal skip
    return { action: "cancel" };
  }
  if (m.method === "interaction/browserList" || m.method === "interaction/browserExecute") {
    // client-executed browser automation is fail-closed (map audit path 15)
    gateway.noteBrowserAutomation(m.method.split("/")[1]);
    return {};
  }
  return {};
}

function startChild() {
  child = spawn(process.execPath, [ZCODE, "app-server"], { stdio: ["pipe", "pipe", "pipe"], env: childEnv });
  state.childPid = child.pid;
  log(`app-server spawned pid=${child.pid} mode=${MODE}`);
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (!m.method && wireResponses.has(m.id)) {
        const resolve = wireResponses.get(m.id); wireResponses.delete(m.id); resolve(m);
      } else handleCoreMessage(m);
    }
  });
  child.stderr.on("data", (d) => broadcast({ type: "stderr", line: d.toString().slice(0, 400) }));
  child.on("exit", (code) => {
    cancelCarrierPending("RUNTIME_EXITED"); state.childPid = null; log(`app-server exited code=${code}`);
    for (const resolve of wireResponses.values()) resolve({ error: { code: -32072, message: "CORE_EXITED" } });
    wireResponses.clear();
  });
}

function handleCoreMessage(m) {
      state.events.push(m);
      if (state.events.length > 800) state.events.splice(0, state.events.length - 800);
      broadcast({ type: "rpc", message: m });
      // host-side session index (upstream keeps its list app-side too — the
      // core's session/list only enumerates LIVE sessions, so the host owns
      // the persistent index; upstream-map D9 "desktop session store split")
      if (m.result && m.result.session && m.result.session.sessionId) {
        indexSession(m.result.session.sessionId, m.result.session.mode);
        // Core0.16.9 requires deliveryKind. The persistent bridge owns the Core
        // connection; Activity/SSE reconnects do not turn it into a replay client.
        rpc("session/subscribe", { sessionId: m.result.session.sessionId, deliveryKind: "desktop-continuous" }, 8000).then((r) => {
          if (r.error) log("session/subscribe failed: " + JSON.stringify(r.error).slice(0, 100));
        });
      }
      // persistence guard (phase2-f1-session-persistence.md): session/create
      // flattens `model` to "providerId/modelId" and drops options — without
      // a reasoning level the turn dies in model_creation BEFORE the session
      // row is ever written (silent 0-row persistence). Mirror the desktop
      // host's repair: auto-issue setThoughtLevel after creates that lack one.
      if (m.result && m.result.session && m.result.session.sessionId) {
        const cid = Number(m.id);
        const cp = cid >= 0 ? pendingCreates.get(cid) : null;
        if (cp && cp.thoughtLevel === undefined) {
          rpc("session/setThoughtLevel", {
            sessionId: m.result.session.sessionId,
            thoughtLevel: DEFAULT_THOUGHT_LEVEL,
          }, 8000).then((r) => {
            if (r.error) log("setThoughtLevel repair failed: " + JSON.stringify(r.error).slice(0, 120));
          });
        }
        if (cid >= 0) pendingCreates.delete(cid);
      }
      if (m.method === "session/event" && m.params && m.params.payload && m.params.payload.title) {
        indexTitle(m.params.sessionId, m.params.payload.title);
      }
      // Phase 8 W-T2.6 (route b, contract G7/§1.4.3): upstream tool completion
      // correlation. The event carries no post-image — completed txns close
      // with the weakest honest verify; a missing event is the reaper's job.
      if (m.method === "session/event" && m.params && m.params.payload) {
        const pl = m.params.payload;
        if (pl.type === "tool_call_result" || pl.type === "tool_call_error") {
          try {
            gateway.completeUpstreamTxn(m.params.sessionId, pl.toolCallId ?? pl.tool_call_id ?? pl.callId, pl.type);
          } catch (e) { log("upstream txn fold failed: " + String(e).slice(0, 120)); }
        }
      }
      // Phase 7 W6: fold the core's own network_request_status session events
      // (upstream WebFetch/WebSearch egress) into the Gateway journal so the
      // upstream path stops being invisible to the host audit. The exact
      // payload field names are static-only (event type enum @1235487) — map
      // defensively and keep the raw payload (truncated) in notes.
      if (m.method === "session/event" && m.params && m.params.payload &&
          m.params.payload.type === "network_request_status") {
        const p = m.params.payload;
        try {
          gateway.journalNetworkRequest({
            session: m.params.sessionId,
            source: p.toolName === "WebSearch" ? "upstream.websearch" : "upstream.webfetch",
            method: p.method || null, scheme: p.scheme || null, host: p.host || null,
            path_redacted: p.path || null,
            status: typeof p.status === "number" ? p.status : null,
            bytes_in: p.bytes ?? p.bytesIn ?? null,
            duration_ms: p.durationMs ?? p.duration_ms ?? null,
            cache_hit: (p.cacheHit || p.cache_hit) ? 1 : 0,
            egress_proxied: (p.proxied || p.proxyUsed) ? 1 : 0,
            decision: "allow",
            approval_source: p.preapproved ? "upstream-preapproved" : "ui",
            result_code: p.errorCode ? String(p.errorCode) : (typeof p.status === "number" ? "ok" : null),
            notes: JSON.stringify(p).slice(0, 300),
          });
        } catch {}
      }
      if (m.id !== undefined && typeof m.id === "string" && m.method) {
        Promise.resolve(answerServerRequest(m)).then((result) => {
          child.stdin.write(JSON.stringify({ id: m.id, result }) + "\n");
        });
        return;
      }
      const waiter = m.id !== undefined && childResponses.get(m.id);
      if (waiter) { childResponses.delete(m.id); waiter(m); }

}

// ---- persistent session index (host-owned; survives node restarts) ----
const INDEX_PATH = path.join(ROOT, "sessions-index.json");
function readIndex() {
  const rows = readSkillJson(INDEX_PATH, []);
  if (!Array.isArray(rows)) throw Error("SKILL_SESSION_INDEX_INVALID");
  return rows;
}
function writeIndex(list) {
  try { atomicSkillWrite(INDEX_PATH, Buffer.from(JSON.stringify(list, null, 2))); } catch (e) { log("index write failed: " + e); }
}
function indexSession(sessionId, mode) {
  const list = readIndex();
  if (!list.some((s) => s.sessionId === sessionId)) {
    list.push({ sessionId, mode: mode || "build", title: "", createdAt: Date.now() });
    writeIndex(list);
    log("session indexed: " + sessionId);
  }
}
function indexTitle(sessionId, title) {
  const list = readIndex();
  const hit = list.find((s) => s.sessionId === sessionId);
  if (hit && title && hit.title !== title) { hit.title = String(title).slice(0, 120); writeIndex(list); }
}
function rpc(method, params, timeoutMs = 15000) {
  const id = ++childSeq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { childResponses.delete(id); resolve({ error: { message: "rpc timeout " + method } }); }, timeoutMs);
    childResponses.set(id, (m) => { clearTimeout(timer); resolve(m); });
    forwardToChild(JSON.stringify({ id, method, params }));
  });
}

// One host queue owns supported Core request/config lifecycle transitions. Reverse requests
// and notifications continue immediately; the model's Skill implementation remains untouched.
const { SkillSessionBindings, atomicWrite: atomicSkillWrite, readJson: readSkillJson } = require("./skill-session-bindings.cjs");
const { ProviderReviewBindings } = require("./provider-review-bindings.cjs");
const providerBindings = new ProviderReviewBindings({root:ROOT});
let wireSequence = 0;
const wireResponses = new Map();
function invokeCore(method, params) {
  return new Promise((resolve, reject) => {
    if (!child || !child.stdin.writable) return reject(Error("CORE_NOT_RUNNING"));
    const id = "android-host-" + (++wireSequence);
    wireResponses.set(id, resolve);
    try { child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); }
    catch (error) { wireResponses.delete(id); reject(error); }
  });
}
const skillBindings = new SkillSessionBindings({ root: ROOT, workspace: WORKSPACE, invoke: invokeCore,
  providerBindings,
  onFatal: code => {
    log("Skill lifecycle uncertain; runtime restart required: " + code);
    cancelCarrierPending("RUNTIME_RESTART_REQUIRED");
    child?.kill("SIGKILL");
    setImmediate(() => process.exit(74));
  },
});

// ---------------------------------------------------------------- mock model
// (mock mode only — Phase 0 hermetic demo, unchanged behavior)
function pickTool(tools) {
  const flat = (tools || []).map((t) => t.function || t);
  for (const p of ["Read", "view", "read"]) {
    const hit = flat.find((f) => f.name === p);
    if (hit) return hit;
  }
  return null;
}
function buildArgs(tool) {
  if (["Read", "view", "read"].includes(tool.name)) {
    return { file_path: path.join(WORKSPACE, "hello.txt"), offset: 1, limit: 20 };
  }
  return {};
}
const mockServer = MODE === "mock" ? http.createServer((req, res) => {
  if (req.method === "POST" && req.url.startsWith("/v1/chat/completions")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let messages = [], tools = [], stream = false;
      try { const j = JSON.parse(body); messages = j.messages || []; tools = j.tools || []; stream = !!j.stream; } catch {}
      const tool = pickTool(tools);
      const doTool = tool && !messages.some((m) => m.role === "tool");
      res.setHeader("content-type", stream ? "text/event-stream" : "application/json");
      if (stream) {
        const base = { id: "cmpl-s", object: "chat.completion.chunk", created: 0, model: "mock-model" };
        const chunk = (delta, fin) => "data: " + JSON.stringify({ ...base, choices: [{ index: 0, finish_reason: fin, delta }] }) + "\n\n";
        if (doTool) {
          const args = JSON.stringify(buildArgs(tool));
          res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: tool.name, arguments: "" } }] }, null));
          res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }, null));
          res.write(chunk({}, "tool_calls"));
        } else {
          res.write(chunk({ role: "assistant", content: "SPIKE-OK tool-call round trip completed on Android" }, null));
          res.write(chunk({}, "stop"));
        }
        res.end("data: [DONE]\n\n");
      } else if (doTool) {
        res.end(JSON.stringify({
          choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: tool.name, arguments: JSON.stringify(buildArgs(tool)) } }] } }],
        }));
      } else {
        res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "SPIKE-OK" } }] }));
      }
    });
    return;
  }
  res.statusCode = 404; res.end("{}");
}) : null;

// ------------------------------------------- lab mocks (Phase 6 acceptance)
// Two distinct OpenAI-compatible endpoints (A/B) served by the bridge process
// so on-device acceptance can prove multi-provider routing and vision
// separation with zero code changes to zcode.cjs. Enabled ONLY when the host
// opts in (env SPIKE_LAB_MOCKS=1 or the control file <root>/labmocks.enabled,
// created by the verify script before app start) — loopback only, like every
// other bridge surface.
const LAB_ENABLED =
  process.env.SPIKE_LAB_MOCKS === "1" || fs.existsSync(path.join(ROOT, "labmocks.enabled"));
const lab = { endpoints: {} };

function summarizeBody(s) {
  return {
    hasImageUrl: s.includes('"image_url"'),
    hasDataImage: s.includes("data:image"),
    hasOmissionNotice: s.includes("Media omitted from provider request"),
    hasToolResultMedia: s.includes("Tool result media from"),
    hasReadImagePlaceholder: s.includes("[Attached image/png: Read image]"),
  };
}

function labRecord(name, bodyStr) {
  const ep = lab.endpoints[name] || (lab.endpoints[name] = { count: 0, bodies: [] });
  ep.count++;
  if (typeof bodyStr === "string") {
    const summary = summarizeBody(bodyStr);
    ep.bodies.push({ n: ep.count, ts: Date.now(), summary, raw: bodyStr.length > 262144 ? bodyStr.slice(0, 262144) : bodyStr });
    if (ep.bodies.length > 12) ep.bodies.shift();
    try {
      fs.mkdirSync(path.join(ROOT, "mock-capture"), { recursive: true });
      fs.writeFileSync(path.join(ROOT, "mock-capture", `${name}-${ep.count}.json`), bodyStr);
    } catch {}
  }
}

function labHandler(name) {
  return (req, res) => {
    if (!(req.method === "POST" && req.url.startsWith("/v1/chat/completions"))) {
      res.statusCode = 404; res.end("{}"); return;
    }
    const auth = req.headers["authorization"] || "";
    if (!auth.startsWith("Bearer sk-lab")) {
      // auth/business-error path: exercises the measured 401 -> provider_not_configured taxonomy
      labRecord(name, null);
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${auth.slice(0, 20) || "<none>"}`, type: "invalid_request_error" } }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      labRecord(name, body);
      let j = {};
      try { j = JSON.parse(body); } catch {}
      const messages = j.messages || [], tools = j.tools || [], stream = !!j.stream;
      // ---- Phase 7 lab directives (phase7-runbook §B): the LAST user message
      // may instruct a tool call; a forced name absent from tools[] is still
      // emitted (V1.4: the core must refuse it before execution).
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const uText = lastUser == null ? "" :
        (typeof lastUser.content === "string" ? lastUser.content : JSON.stringify(lastUser.content ?? ""));
      const dSearch = uText.match(/USE:web_search:(\S+)/);
      const dNative = uText.match(/USE:WebSearch:(\S+)/);
      const dFetch = uText.match(/USE:WebFetch:(\S+)/);
      const dRaw = uText.match(/USE:raw:(\S+?):(\{.*\})/);
      // turn-scoped: a directive fires when THIS user turn has no tool call
      // yet (the old conversation-global hasToolMsg check silently disabled
      // every directive after the first tool call — measured on device)
      const lastUserIdx = messages.reduce((acc, m, i) => (m.role === "user" ? i : acc), -1);
      const turnHasCall = messages.slice(lastUserIdx + 1).some((m) =>
        (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) || m.role === "tool");
      const hasToolMsg = turnHasCall;
      const carrierSearch = (tools || []).find((t) => /__web_search$/.test((t.function || t).name || ""));
      let doTool = null, toolName = null, toolArgs = {};
      if (!hasToolMsg) {
        // repeat directives in the same session are legitimate (each new user
        // turn may ask for another call); hasToolMsg alone prevents same-turn
        // re-emission loops
        if (dSearch && carrierSearch) { toolName = carrierSearch.function ? carrierSearch.function.name : carrierSearch.name; toolArgs = { query: dSearch[1], count: 5 }; doTool = toolName; }
        else if (dNative) { toolName = "WebSearch"; toolArgs = { query: dNative[1] }; doTool = "WebSearch"; }
        else if (dFetch) { toolName = "WebFetch"; toolArgs = { url: dFetch[1], prompt: "Summarise the page in one line." }; doTool = "WebFetch"; }
        else if (dRaw) { toolName = dRaw[1]; try { toolArgs = JSON.parse(dRaw[2]); } catch { toolArgs = {}; } doTool = toolName; }
      }
      // scripted fallback: with tools and no tool result yet, Read the probe
      // file (verify6-read.png when a verify script seeded one, else the
      // workspace hello.txt); afterwards finish with a labelled summary that
      // echoes the received reasoning_effort and model id (V1.6 evidence)
      const readTool = (tools || []).find((t) => (t.function || t).name === "Read");
      if (!doTool && !hasToolMsg && readTool) {
        const png = path.join(WORKSPACE, "verify6-read.png");
        const readPath = fs.existsSync(png) ? png : path.join(WORKSPACE, "hello.txt");
        toolName = "Read"; toolArgs = { file_path: readPath, offset: 1, limit: 20 }; doTool = "Read";
      }
      let finalText = `[${name}] ok effort=${j.reasoning_effort || "-"} model=${j.model || "-"}`;
      if (hasToolMsg) {
        const lastTool = [...messages].reverse().find((m) => m.role === "tool");
        const tc = typeof lastTool.content === "string" ? lastTool.content : JSON.stringify(lastTool.content ?? "");
        finalText += ` TOOLRESULT: ${tc.slice(0, 260)}`;
      }
      res.setHeader("content-type", stream ? "text/event-stream" : "application/json");
      const base = { id: "cmpl-lab", object: "chat.completion.chunk", created: 0, model: j.model || "lab" };
      const chunk = (delta, fin) => "data: " + JSON.stringify({ ...base, choices: [{ index: 0, finish_reason: fin, delta }] }) + "\n\n";
      if (stream) {
        if (doTool) {
          const args = JSON.stringify(toolArgs);
          res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: doTool, arguments: "" } }] }, null));
          res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }, null));
          res.write(chunk({}, "tool_calls"));
        } else {
          res.write(chunk({ role: "assistant", content: finalText }, null));
          res.write(chunk({}, "stop"));
        }
        res.end("data: [DONE]\n\n");
      } else if (doTool) {
        res.end(JSON.stringify({
          choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: doTool, arguments: JSON.stringify(toolArgs) } }] } }],
        }));
      } else {
        res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: finalText } }] }));
      }
    });
  };
}

function startLabMock(name, port) {
  // listen errors (e.g. a port held by an orphaned process from a previous
  // force-stop cycle — measured: force-stop does not always kill node
  // children) must never hang the boot: resolve with a log line instead.
  return new Promise((resolve) => {
    const srv = http.createServer(labHandler(name));
    srv.once("error", (e) => { log(`lab mock ${name} listen FAILED on ${port}: ${e.code}`); resolve(); });
    srv.listen(port, "127.0.0.1", () => { log(`lab mock ${name} on 127.0.0.1:${port}/v1`); resolve(); });
  });
}

// ------------------------- lab search mocks (Phase 7, phase7-runbook §B)
// Mock A = Brave shape (GET /res/v1/web/search, X-Subscription-Token),
// Mock B = Tavily shape (POST /search, Bearer) — both on LAB_SEARCH_PORT,
// scripted by the query string; Mock C = loopback forward proxy (CONNECT
// logging, 502) for V3.2; LAB_TLS_PORT serves a self-signed lab cert for the
// V3.4 CA-lever check. Enabled ONLY under the labsearch control file/env.
const LAB_SEARCH_PORT = Number(process.env.SPIKE_LAB_SEARCH_PORT || 18083);
const LAB_PROXY_PORT = Number(process.env.SPIKE_LAB_PROXY_PORT || 18085);
const LAB_TLS_PORT = Number(process.env.SPIKE_LAB_TLS_PORT || 18086);
const labSearch = { endpoints: {}, proxyLog: [] };

function labSearchSummarize(s) {
  return {
    hasQuery: /q=|[?&]q=/.test(s.slice(0, 400)) || s.includes('"query"'),
    hasToken: s.includes("X-Subscription-Token") || /"authorization"/i.test(s.slice(0, 200)),
  };
}
function labSearchRecord(name, bodyStr, req) {
  const ep = labSearch.endpoints[name] || (labSearch.endpoints[name] = { count: 0, bodies: [] });
  ep.count++;
  if (bodyStr != null) {
    ep.bodies.push({
      n: ep.count, ts: Date.now(),
      summary: { method: req && req.method, url: req && req.url, auth: !!(req && (req.headers["x-subscription-token"] || req.headers["authorization"])) },
      raw: String(bodyStr).slice(0, 8192),
    });
    if (ep.bodies.length > 12) ep.bodies.shift();
    try {
      fs.mkdirSync(path.join(ROOT, "search-capture"), { recursive: true });
      fs.writeFileSync(path.join(ROOT, "search-capture", `${name}-${ep.count}.json`), String(bodyStr));
    } catch {}
  }
}

function searchMockResults(query) {
  // deterministic fixtures keyed off the query (phase7-runbook §B table)
  if (query === "lab:ok") {
    return {
      results: [
        { title: "Caf&eacute; &#8212; <b>Best</b> coffee &amp; more", url: "https://example.com/cafe", snippet: "A caf&eacute; &#8212; test &amp; result", published: "2026-09-01" },
        { title: "Duplicate variant", url: "https://www.example.com/cafe#frag", snippet: "should collapse with the first" },
        { title: "Bad scheme dropped", url: "ftp://example.com/file", snippet: "ftp must be filtered" },
      ],
    };
  }
  if (query === "lab:big") {
    const results = [];
    for (let i = 0; i < 40; i++) {
      results.push({ title: "T".repeat(300) + i, url: `https://example.com/big/${i}`, snippet: "S".repeat(900) });
    }
    return { results };
  }
  return {
    results: [
      { title: "Default result one", url: "https://example.com/one", snippet: "first default result" },
      { title: "Default result two", url: "https://example.com/two", snippet: "second default result" },
    ],
  };
}

function labSearchServer(req, res) {
  const url = req.url || "";
  // Mock A — Brave shape
  if (req.method === "GET" && url.startsWith("/res/v1/web/search")) {
    const token = req.headers["x-subscription-token"];
    labSearchRecord("mockA", `${req.method} ${url} | X-Subscription-Token: ${token || "<none>"}`, req);
    if (!token || !String(token).startsWith("sk-lab")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid subscription token" } }));
      return;
    }
    const q = new URL(url, "http://x").searchParams.get("q") || "";
    if (q === "lab:401") { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "unauthorized" } })); return; }
    if (q === "lab:429") { res.writeHead(429, { "retry-after": "30", "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "rate limited" } })); return; }
    if (q === "lab:500") { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "boom" } })); return; }
    if (q === "lab:notjson") { res.writeHead(200, { "content-type": "text/plain" }); res.end("this is not json"); return; }
    if (q === "lab:slow") { setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(searchMockResults(q))); }, 8000); return; }
    if (q === "lab:empty") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ web: { results: [] } })); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ web: { results: searchMockResults(q).results.map((r) => ({ title: r.title, url: r.url, description: r.snippet, page_age: r.published })) } }));
    return;
  }
  // Mock B — Tavily shape
  if (req.method === "POST" && url.startsWith("/search")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const auth = req.headers["authorization"] || "";
      labSearchRecord("mockB", `${req.method} ${url} | Authorization: ${auth.slice(0, 24)} | ${body.slice(0, 200)}`, req);
      if (!auth.startsWith("Bearer sk-lab")) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
        return;
      }
      let q = "";
      try { q = JSON.parse(body).query || ""; } catch {}
      const mapped = searchMockResults(q).results.map((r) => ({ title: r.title, url: r.url, content: r.snippet }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ query: q, answer: "The caf\u00e9 \u2014 test answer", results: mapped }));
    });
    return;
  }
  res.statusCode = 404; res.end("{}");
}

// Mock C — loopback forward proxy: logs absolute-URI requests and CONNECT
// tunnels, answers 502 (V3.2 evidence shape from the desktop experiments).
function labProxyServer(req, resOrSocket, head) {
  if (req.method === "CONNECT") {
    labSearch.proxyLog.push({ kind: "CONNECT", method: req.method, url: req.url, ts: Date.now() });
    resOrSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    resOrSocket.destroy();
    return;
  }
  labSearch.proxyLog.push({ kind: "request", method: req.method, url: req.url, ts: Date.now() });
  if (typeof resOrSocket.writeHead === "function") {
    resOrSocket.writeHead(502, { "content-type": "application/json" });
    resOrSocket.end(JSON.stringify({ error: "lab proxy: no upstream" }));
  }
}

function startLabSearch() {
  // every listener is hang-proof: a port conflict resolves with a log line
  // (the verify scripts clear orphans, but the boot must never depend on it)
  const listenSafe = (srv, port, what) => new Promise((resolve) => {
    srv.once("error", (e) => { log(`lab ${what} listen FAILED on ${port}: ${e.code}`); resolve(); });
    srv.listen(port, "127.0.0.1", () => { log(`lab ${what} on 127.0.0.1:${port}`); resolve(); });
  });
  // Phase 9: the lab vision mock (deterministic VLM answers on loopback)
  if (LAB_VISION) {
    visionPipeline.startLabVision(ROOT, log).then(({ server, state: vs }) => {
      // project: only counters/facts — the server object itself must never
      // be JSON-serialized into /status (leaks net internals; measured)
      state.labVision = { port: visionPipeline.LABVISION_PORT, count: () => vs.count,
        lastQuestion: () => vs.lastQuestion, listenError: () => vs.listenError || null };
      log("labvision mock on 127.0.0.1:" + visionPipeline.LABVISION_PORT);
    });
  }
  return Promise.all([
    listenSafe(http.createServer(labSearchServer), LAB_SEARCH_PORT, "search mocks A/B"),
    (() => {
      const srv = http.createServer(labProxyServer);
      srv.on("connect", (req, sock, head) => labProxyServer(req, sock, head));
      return listenSafe(srv, LAB_PROXY_PORT, "proxy C");
    })(),
    (() => {
      try {
        const tlsDir = path.join(RUNTIME, "lab-tls");
        const key = fs.readFileSync(path.join(tlsDir, "server-key.pem"));
        const cert = fs.readFileSync(path.join(tlsDir, "server.pem"));
        const srv = https.createServer({ key, cert }, (req, res) => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("TLS-LAB-OK");
        });
        return listenSafe(srv, LAB_TLS_PORT, "TLS server");
      } catch (e) { log("lab TLS server skipped (no certs): " + e); return Promise.resolve(); }
    })(),
  ]);
}

// --------------------------------------------------------------- http bridge
const sseClients = new Set();
function broadcast(payload) {
  const line = "data: " + JSON.stringify(payload) + "\n\n";
  for (const res of sseClients) res.write(line);
}

const PAGE = `<!doctype html><meta charset="utf-8">
<title>ZCode Android host</title>
<style>
 body{font-family:monospace;background:#111;color:#ddd;padding:10px;margin:0}
 h1{font-size:14px;color:#8cf;margin:8px 0 4px}
 .ok{color:#6f6}.bad{color:#f66}.dim{color:#888}
 pre{white-space:pre-wrap;word-break:break-all;font-size:11px;margin:4px 0}
 #log{height:26vh;overflow:auto;background:#000;padding:6px;border:1px solid #333}
 #evt{height:22vh;overflow:auto;background:#080818;padding:6px;border:1px solid #333}
 #sessions div{padding:6px;margin:4px 0;background:#1a1a2e;border-radius:6px;cursor:pointer}
 .pill{display:inline-block;background:#234;padding:2px 8px;border-radius:8px;margin:2px;font-size:11px}
 button{background:#234;color:#ddd;border:1px solid #456;padding:6px 12px;border-radius:6px}
</style>
<h1>ZCode Android host <span class="dim">(Phase 2 skeleton)</span></h1>
<div id="status">connecting…</div>
<div id="perm"></div>
<h1>capabilities <button onclick="loadCaps()">refresh</button></h1>
<div id="caps" class="dim">—</div>
<h1>sessions <button onclick="loadSessions()">refresh</button></h1>
<div id="sessions" class="dim">—</div>
<h1>bridge log</h1><pre id="log"></pre>
<h1>protocol events</h1><pre id="evt"></pre>
<script>
 const q=new URLSearchParams(location.search); const T=q.get('t')||'';
 const H={'X-Bridge-Token':T};
 const $=id=>document.getElementById(id);
 async function refresh(){
   try{
     const s=await (await fetch('/status?t='+T,{headers:H})).json();
     $('status').innerHTML='phase <b>'+s.phase+'</b> · mode '+s.mode+' · node '+s.nodeVersion+
       ' · permissions seen '+s.permissionsSeen+
       ' <span class="'+(s.phase==='ready'?'ok':'dim')+'">'+(s.phase==='ready'?'READY':'')+'</span>';
   }catch(e){$('status').textContent='bridge unreachable: '+e}
 }
 async function loadCaps(){
   try{
     const r=await (await fetch('/capabilities?t='+T,{headers:H})).json();
     const el=$('caps'); el.className=''; el.innerHTML='';
     const res=r.resolved||{};
     for(const [cap,d] of Object.entries(res)){
       const cls=d.availability==='AVAILABLE'?'ok':(d.availability==='UNAVAILABLE'?'bad':'dim');
       const div=document.createElement('div');
       div.className='pill';
       div.innerHTML='<span class="'+cls+'">'+d.availability+'</span> '+cap+
         ' <span class="dim">@'+d.providerId+' ('+d.privilege+')</span>';
       div.title=d.scope+' | '+d.limitations+' | '+d.health;
       el.appendChild(div);
     }
   }catch(e){$('caps').innerHTML='<span class="bad">failed: '+e+'</span>'}
 }
 async function loadSessions(){
   try{
     const r=await (await fetch('/sessions?t='+T,{headers:H})).json();
     const el=$('sessions'); el.className=''; el.innerHTML='';
     const list=r.sessions||[];
     if(!list.length){el.innerHTML='<span class="dim">no sessions yet</span>';return}
     for(const s of list.slice(0,20)){
       const d=document.createElement('div');
       d.textContent=(s.sessionId||s.id||'?')+' · '+(s.title||s.summary||'');
       d.onclick=()=>readSession(s.sessionId||s.id);
       el.appendChild(d);
     }
   }catch(e){$('sessions').innerHTML='<span class="bad">failed: '+e+'</span>'}
 }
 async function readSession(id){
   const r=await (await fetch('/session/read?t='+T+'&id='+encodeURIComponent(id),{headers:H})).json();
   const msgs=(r.snapshot&&r.snapshot.messages)||[];
   const last=(msgs[msgs.length-1]&&msgs[msgs.length-1].content)||'';
   alert(id+'\\nmessages: '+msgs.length+'\\nlast: '+String(last).slice(0,200));
 }
 const es=new EventSource('/events?t='+T);
 es.onmessage=e=>{
   const m=JSON.parse(e.data);
   if(m.type==='log'){$('log').textContent+=m.line+'\\n';$('log').scrollTop=1e9}
   else if(m.type==='rpc'){$('evt').textContent+=JSON.stringify(m.message).slice(0,500)+'\\n';$('evt').scrollTop=1e9}
   else if(m.type==='permission'){
     const p=m.info||{};
     const hc=!!p.hardConfirm;
     const tok=m.requestId;
     $('perm').innerHTML='⚠ '+(hc?'<b class="bad">HARD CONFIRM</b> ':'')+'permission: <b>'+(p.toolName||'?')+'</b> '+
       '<span class="dim">'+(p.risk||'')+' '+(p.hits&&p.hits.length?('rules:'+p.hits.join(',')):'')+'</span><br>'+
       '<pre>'+String(JSON.stringify(p.input||{})).slice(0,400)+'</pre>'+
       (hc?'confirmation token: <b>'+tok+'</b> — type it to allow: <input id="tok" size="14"> ':'')+
       '<button onclick="answerPerm(\\''+tok+'\\',\\'allow\\')">allow</button> '+
       '<button onclick="answerPerm(\\''+tok+'\\',\\'deny\\')">deny</button>';
     refresh();
   }
 };
 async function answerPerm(rid,decision){
   const tok=($('tok')&&$('tok').value)||'';
   $('perm').innerHTML='';
   const r=await (await fetch('/respond?t='+T,{method:'POST',headers:{...H,'Content-Type':'application/json'},
     body:JSON.stringify({requestId:rid,decision,confirmToken:tok})})).json();
   if(r.refused)alert('hard-confirm refused: token required');
 }
 refresh();loadCaps();loadSessions();setInterval(refresh,3000);
</script>`;

function authorized(req, url) {
  if (!TOKEN) return true; // no token configured (debug builds) — loopback only
  const q = url.searchParams.get("t");
  const h = req.headers["x-bridge-token"];
  return q === TOKEN || h === TOKEN;
}

const bridge = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const send = (code, body, type) => {
    res.writeHead(code, { "content-type": type || "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  if (url.pathname === "/") { send(200, PAGE, "text/html"); return; }
  if (!authorized(req, url)) { send(401, { error: "bad or missing bridge token" }); return; }

  if (url.pathname === "/status") {
    // Phase 8 W3 (runbook 5.3, A17): project the carrier state instead of
    // spreading it - state.carrierQueue holds a pending call's arguments and
    // /status is read by the bridge's own WebView page.
    const cc = state.carrierCounters || {};
    state.carrier = {
      workerPolls: cc.workerPolls || 0,
      workerCallsAnswered: cc.workerCallsAnswered || 0,
      inlineCalls: cc.inlineCalls || 0,
      lastCallId: cc.lastCallId || null,
      lastCallTool: cc.lastCallTool || null,
      workerRegistered: Array.isArray(state.workerTools) && state.workerTools.length > 0,
      queueDepth: (state.carrierQueue || []).length,
    };
    send(200, { ...state, events: undefined, evidence: undefined,
      carrierQueue: undefined, carrierPending: undefined, carrierArgs: undefined });
    return;
  }
  if (url.pathname === "/ui/status") {
    send(200, {
      a11y: (state.uiHealth = state.uiHealth || { serviceBound: false, lastScreen: null, lastEventTs: null, generations: 0 }),
      workerRegistered: Array.isArray(state.workerTools) && state.workerTools.some((x) => String(x.toolId || x.name || "").startsWith("ui_")),
      lab: fs.existsSync(path.join(String(process.env.SPIKE_ROOT || "."), "uilab.enabled")),
    });
    return;
  }
  if (url.pathname === "/ui/render" && req.method === "POST") {
    // C6: the Kotlin worker owns the walk and sends the raw node list; THIS
    // process owns every model-facing rule (ui-tree.cjs). The raw list never
    // leaves this hop; opts.find runs the ui_find selector over the render.
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { raw, opts, find } = JSON.parse(body);
        liveUiRaw = raw;
        const r = uiTree.renderSnapshot(raw || {}, opts || {});
        const nodeTargets = r.nodeTargets;
        delete r.nodeTargets; // private host addressing map, never model content
        const out = { ok: true, render: r, nodeTargets };
        if (find) out.matches = uiTree.findNodes(r.nodes, find);
        send(200, out);
      } catch (e) { send(400, { ok: false, error: String(e).slice(0, 200) }); }
    });
    return;
  }
  if (url.pathname === "/ui/selftest" && req.method === "POST") {
    send(403, {ok:false,error:{code:"SELFTEST_DISABLED",message:"Use the authorized carrier observation path"}});
    return;
  }
  if (url.pathname === "/gateway/ui") {
    const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
    send(200, { mode: gateway.mode, ui_actions: gateway.uiView(limit) });
    return;
  }
  if (url.pathname === "/capabilities") {
    // capability snapshot published by the Android host (Phase 3)
    try {
      send(200, JSON.parse(fs.readFileSync(path.join(ROOT, "capabilities.json"), "utf8")));
    } catch (e) {
      send(503, { error: "capabilities not published yet: " + e });
    }
    return;
  }
  if (url.pathname === "/resolve") {
    // provider-agnostic capability resolution for the agent surface
    const cap = url.searchParams.get("capability") || "";
    try {
      const snap = JSON.parse(fs.readFileSync(path.join(ROOT, "capabilities.json"), "utf8"));
      const d = cap && snap.resolved && snap.resolved[cap];
      if (d) send(200, { resolved: d });
      else send(404, { error: "no provider for capability: " + cap });
    } catch (e) {
      send(503, { error: "capabilities not published yet: " + e });
    }
    return;
  }
  if (url.pathname === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(": connected\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }
  if (url.pathname === "/workspaces") {
    // Phase 5: workspace registry + active flag + per-workspace file listing
    try {
      const active = activeWorkspace();
      fs.mkdirSync(WS_ROOT, { recursive: true });
      const names = fs.readdirSync(WS_ROOT).filter((n) =>
        n !== activeWorkspace() + ".tmp" && fs.statSync(path.join(WS_ROOT, n)).isDirectory());
      const out = names.sort().map((n) => {
        const dir = path.join(WS_ROOT, n);
        const files = fs.readdirSync(dir).slice(0, 50);
        return { name: n, active: n === active, fileCount: fs.readdirSync(dir).length, files };
      });
      send(200, { active, workspaces: out });
    } catch (e) { send(500, { error: String(e) }); }
    return;
  }
  if (url.pathname === "/workspaces/switch" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { name } = JSON.parse(body);
        if (!name || typeof name !== "string" || name.includes("/") || name.includes("..")) {
          return send(400, { error: "invalid workspace name" });
        }
        fs.mkdirSync(path.join(WS_ROOT, name), { recursive: true });
        fs.writeFileSync(ACTIVE_WS_FILE, name);
        send(200, { ok: true, active: name, note: "takes effect for new sessions and on next runtime restart" });
      } catch (e) { send(400, { error: String(e) }); }
    });
    return;
  }
  // ---- Android tool carrier (model-visible mcp__android-host__* tools) ----
  // Two execution halves (phase7-runbook §Tool surface §1):
  //  * HOST-REGISTERED tools (web_search — bridge-resident pipeline) are
  //    dispatched INLINE by /carrier/call: no Kotlin worker needed, so the
  //    Phase 7 acceptance does not depend on the pending Phase 8 worker.
  //  * ANDROID-DISPATCHER tools (Phase 8 device tools) keep the pull loop:
  //    /carrier/register (worker) + /carrier/next + /carrier/respond.
  // The MCP carrier child (android-carrier.cjs, spawned by the Agent Core via
  // user-config mcp.servers) calls /carrier/call and blocks for the result.
  const hostTools = [WEB_SEARCH_TOOL, visionPipeline.UI_SEE_TOOL, workspaceAnalysis.TOOL, ...WS_TOOLS];
  // INLINE_DISPATCH (contract §1.1/W-T2.5): host-registered tools answered by
  // the bridge itself; only Android-dispatcher tools keep the worker pull loop.
  const INLINE_DISPATCH = {
    workspace_analyze: async (call) => {
      const controller = new AbortController();
      (state.analysisControllers = state.analysisControllers || new Set()).add(controller);
      const abort = () => controller.abort();
      call.cancelSignal?.addEventListener('abort', abort, {once:true});
      if (call.cancelSignal?.aborted) controller.abort();
      try { return await workspaceAnalysis.executeAnalysis({...call,cancelSignal:controller.signal},gateway,carrierAuthorization); }
      finally {call.cancelSignal?.removeEventListener('abort',abort);state.analysisControllers.delete(controller);}
    },
    web_search: (call) => {
      const cfg = loadSearchConfig() || {};
      return executeSearch({
        config: cfg,
        args: call.arguments,
        session: (call.meta && call.meta.sessionId) || call.sessionId || null,
        lab: searchLabContext(),
        sessionCapOverride: process.env.SEARCH_SESSION_CAP,
        journal: (row) => gateway.journalNetworkRequest(row),
      }).then((r) => {
        searchState.lastResultCode = r.ok ? "ok" : ((r.error && r.error.code) || "error");
        return r.ok
          ? { ok: true, text: r.text, structuredContent: r.structuredContent }
          : { ok: false, error: r.error };
      });
    },
    ui_see: async (call) => {
      const sessionKey = call.meta?.sessionId || state.activeSession;
      if (!sessionKey) return {ok:false,error:{code:"SESSION_REQUIRED"}};
      const controller = new AbortController();
      (state.visionControllers = state.visionControllers || new Set()).add(controller);
      call.cancelSignal?.addEventListener("abort", () => controller.abort(), {once:true});
      if (call.cancelSignal?.aborted) controller.abort();
      const clock = setTimeout(() => controller.abort(), 29000);
      const internalCall = async (toolId, iargs) => {
        if (controller.signal.aborted) throw new Error("vision_cancelled");
        const permission = await gateway.handlePermission({
          requestId:"vision_" + require("node:crypto").randomUUID(), sessionId:sessionKey,
          toolName:"mcp__android-host__" + toolId, input:iargs,
        });
        if (permission.decision !== "allow" || controller.signal.aborted) throw new Error("vision_capture_denied");
        const approvalOpId = boundInternalApproval(toolId, iargs, sessionKey, permission.operationId);
        const wantId = "internal_" + require("node:crypto").randomUUID();
        state.carrierQueue = state.carrierQueue || []; state.carrierPending = state.carrierPending || new Map();
        return new Promise(resolve => {
          const finish = result => {
            clearTimeout(timer); controller.signal.removeEventListener("abort", abort);
            state.carrierPending.delete(wantId);
            state.carrierQueue = state.carrierQueue.filter(x => x.callId !== wantId);
            resolve(result.body?.structuredContent || result.body);
          };
          const abort = () => finish({body:{ok:false,error:{code:"vision_cancelled"}}});
          const timer = setTimeout(() => finish({body:{ok:false,error:{code:"internal_call_timeout"}}}), 20000);
          controller.signal.addEventListener("abort", abort, {once:true});
          state.carrierPending.set(wantId, {resolve:finish,timer,toolId,callArgs:iargs,approvalOpId,sessionId:sessionKey,epoch:state.carrierEpoch || 0});
          state.carrierQueue.push({toolId,arguments:iargs,callId:wantId,meta:{sessionId:sessionKey}});
        });
      };
      const renderFrame = async () => {
        const dump = await internalCall("ui_dump", {maxNodes:600});
        if (!dump || dump.ok === false) return null;
        return {generation:Number(String(dump.treeId).slice(1)),render:{nodes:dump.snapshot?.nodes || []},
          screenW:dump.snapshot?.screenW,screenH:dump.snapshot?.screenH,rotation:dump.snapshot?.rotation,
          observationEpoch:liveUiRaw?.observationEpoch};
      };
      const shotMeta = id => frameMetadata(id, sessionKey);
      const readShot = id => {
        const row = shotMeta(id); if (!row) return null;
        try {
          const f = path.join(SHOTS,row.filename);
          if (fs.lstatSync(f).isSymbolicLink() || fs.statSync(f).size !== row.bytes) return null;
          const bytes = fs.readFileSync(f);
          return require("node:crypto").createHash("sha256").update(bytes).digest("hex") === row.sha256 ? bytes : null;
        } catch { return null; }
      };
      state.visionCounts = state.visionCounts || new Map(); state.visionCache = state.visionCache || new Map();
      const now = Date.now();
      const hits = (state.visionCounts.get(sessionKey) || []).filter(t => now-t < 3600000);
      state.visionCounts.set(sessionKey,hits);
      try {
        return await visionPipeline.executeSee(call, {
          spikeRoot:ROOT, internalCall, renderFrame, readShot, shotMeta, sessionKey, signal:controller.signal, lab:LAB_VISION, config:call.visionConfig,
          sessionCount:() => hits.length,
          cacheGet:key => state.visionCache.get(key),
          cachePut:(key,value) => { if (state.visionCache.size >= 20) state.visionCache.delete(state.visionCache.keys().next().value); state.visionCache.set(key,value); },
          journal:row => { const id = gateway.journalNetworkRequest(row); if(row.result_code === "started") hits.push(Date.now()); return id; },
        });
      } finally { clearTimeout(clock); state.visionControllers.delete(controller); }
    },
    ...Object.fromEntries(WS_TOOLS.map((t) => [t.toolId, (call) => {
      const r = handleWorkspaceTool(t.toolId, call.arguments || {}, gateway);
      return Promise.resolve({
        ok: r.ok,
        text: r.ok
          ? `${t.toolId} ${r.path} ok (${r.bytesWritten}B, txn=${r.txnId})`
          : `${t.toolId} ${r.path} failed: ${r.error && r.error.code}`,
        structuredContent: r,
      });
    }])),
  };
  function searchLabContext() {
    if (!LAB_SEARCH) return null;
    const cfg = loadSearchConfig();
    const b = (cfg && cfg.backends || []).find((x) => x && x.enabled !== false);
    if (!b) return null;
    try { return { host: new URL(b.baseUrl).hostname.toLowerCase() }; } catch { return null; }
  }
  if (url.pathname === "/carrier/register" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { tools } = JSON.parse(body);
        state.workerTools = Array.isArray(tools) ? tools : [];
        log("carrier registered " + state.workerTools.length + " android tools (worker)");
        send(200, { ok: true });
      } catch (e) { send(400, { error: String(e) }); }
    });
    return;
  }
  if (url.pathname === "/carrier/tools") {
    send(200, { tools: [...hostTools, ...((state.workerTools || []))] });
    return;
  }
  if (url.pathname === "/carrier/active") {
    const pending = state.carrierPending?.get(url.searchParams.get("callId"));
    const authorized = !!pending && (carrierAuthorization.matches(pending.approvalOpId, pending.toolId, pending.callArgs || {}, pending.sessionId) && pending.epoch === (state.carrierEpoch || 0));
    send(200, {active:!!pending, authorized, operationId:authorized ? pending.approvalOpId : null}); return;
  }
  if (url.pathname === "/vision/status") {
    const cfg = visionPipeline.loadVisionConfig(ROOT);
    send(200, {configured:!!cfg, provider:cfg?.providerId || null, model:cfg?.modelId || null,
      host:cfg ? new URL(cfg.baseUrl).hostname : null, route:"explicit-provider-text-result", lab:LAB_VISION}); return;
  }
  if (url.pathname === "/carrier/next") {
    // Kotlin worker long-poll: hand the oldest pending carrier call
    state.carrierCounters = state.carrierCounters || {};
    state.carrierCounters.workerPolls = (state.carrierCounters.workerPolls || 0) + 1;
    let stopped = false;
    let pollTimer;
    res.on("close", () => { stopped = true; clearTimeout(pollTimer); });
    const wait = () => {
      if (stopped || res.destroyed || res.writableEnded) return;
      const p = (state.carrierQueue && state.carrierQueue[0]) || null;
      if (p) {
        state.carrierQueue.shift();
        const pending = state.carrierPending?.get(p.callId);
        if (!pending || !carrierAuthorization.matches(
            pending.approvalOpId, p.toolId, p.arguments || {}, p.meta?.sessionId)) {
          if (pending) {clearTimeout(pending.timer); state.carrierPending.delete(p.callId);
            pending.resolve({status:200,body:{ok:false,error:{code:"GATEWAY_INTENT_UNBOUND"}}});}
          pollTimer = setTimeout(wait, 0); return;
        }
        return send(200, p);
      }
      pollTimer = setTimeout(wait, 500);
    };
    wait();
    return;
  }
  if (url.pathname === "/carrier/respond" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { callId, ok, text, structuredContent, artifacts, error } = JSON.parse(body);
        const pend = state.carrierPending && state.carrierPending.get(callId);
        if (!pend) return send(404, { error: "no pending carrier call" });
        clearTimeout(pend.timer);
        state.carrierPending.delete(callId);
        state.carrierCounters = state.carrierCounters || {};
        state.carrierCounters.workerCallsAnswered = (state.carrierCounters.workerCallsAnswered || 0) + 1;
        // Dispatcher tools finish the exact admitted operation; UI retains its own writer below.
        if (pend.nativeDispatcher) {
          try {
            if (pend.epoch !== (state.carrierEpoch || 0)) throw Error("CANCELLED");
            carrierAuthorization.finish(pend.approvalOpId, pend.toolId, pend.callArgs || {},
              pend.sessionId, callId, {ok, error, structuredContent}, pend.providerContentHash, pend.providerDefinitionHash);
          } catch {
            const failed = {ok:false,error:{code:"JOURNAL_RESULT_FAILED",message:"Provider result could not be committed to the admitted Gateway operation"}};
            pend.resolve({status:200,body:failed}); send(200,failed); return;
          }
        }
        // Phase 8 6.3: the primary ui_action writer. The claim ledger (A16)
        // binds op_id to the one unclaimed ask-time operation row for this
        // tool inside the carrier window - zero/many means NULL+join_ambiguous.
        if (String(pend.toolId || "").startsWith("ui_")) {
          try {
            const sc = structuredContent || {};
            const windowMs = Number(process.env.CARRIER_CALL_TIMEOUT_MS || 120000);
            const now = Date.now();
            const candidates = gateway.journalView(200).filter((r) =>
              r.tool === "mcp__android-host__" + pend.toolId &&
              (now - Date.parse(r.ts)) <= windowMs &&
              !(state.uiClaimedOps && state.uiClaimedOps.has(r.id)));
            const claimed = pend.approvalOpId ? gateway.journalView(500).find(r=>r.id===pend.approvalOpId) :
              null;
            if (claimed) (state.uiClaimedOps = state.uiClaimedOps || new Set()).add(claimed.id);
            const uiId = gateway.journalUiAction({
              tool: "mcp__android-host__" + pend.toolId,
              call_id: callId,
              op_id: claimed ? claimed.id : null,
              action: sc.action || String(pend.toolId).slice(3),
              tree_id: sc.treeId || null, node_id: sc.nodeId || null,
              node_text: sc.nodeText || null,
              args: sc.passwordNode ? { text: "[redacted]" } : (pend.callArgs || null),
              window_before: sc.before ? (sc.before.app + "/" + (sc.before.screen || "")) : null,
              window_after: sc.after ? (sc.after.app + "/" + (sc.after.screen || "")) : null,
              result: ok === false ? ((sc.error && sc.error.code) || "error") : "ok",
              verify: sc.verified === true ? "verified" : sc.verified === false ? "unverified" : "skipped",
              verify_detail: sc.evidence || (sc.error && sc.error.hint) || null,
              elapsed_ms: sc.elapsedMs ?? null, retries: sc.retries ?? null,
              nodes_sent: (sc.snapshot && sc.snapshot.nodes) ? sc.snapshot.nodes.length : null,
              bytes_sent: typeof text === "string" ? text.length : null,
              method: sc.method || null,
              notes: claimed ? null : "join_ambiguous",
            });
            if (claimed) {
              gateway.db.prepare("update operation set detail = coalesce(detail || ' ', '') || ? where id = ?")
                .run("ui_action_id=" + uiId, claimed.id);
            }
          } catch (e) { log("ui_action journal failed: " + String(e).slice(0, 120)); }
        }
        if (String(callId).startsWith("selftest_")) {
          state.uiSelftest = { ok, text: typeof text === "string" ? text.split("\n").slice(0, 8).join("\n") : null };
        }
        pend.resolve({ status: 200, body: { ok, text, structuredContent, artifacts, error } });
        send(200, { ok: true });
      } catch (e) { send(400, { error: String(e) }); }
    });
    return;
  }
  if (url.pathname === "/carrier/call" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const call = JSON.parse(body);
        const admissionEpoch = state.carrierEpoch || 0;
        delete call.approvalOpId;
        const nativeDefinition = (state.workerTools || []).find(t => t.toolId === call.toolId);
        const nativeWorker = !!nativeDefinition;
        // Snapshot only host-registered Dispatcher metadata, never model-supplied call.meta.
        const nativeDispatcher = nativeWorker && !String(call.toolId).startsWith("ui_") &&
          typeof nativeDefinition.metadata?.canonicalToolId === "string";
        let providerContentHash = nativeDispatcher ? (nativeDefinition.metadata.providerContentHash ?? null) : null;
        let providerDefinitionHash = null, providerSessionPin = null;
        if (providerContentHash !== null && (typeof providerContentHash !== "string" || !/^[a-f0-9]{64}$/.test(providerContentHash)))
          return send(200,{ok:false,error:{code:"GATEWAY_PROVIDER_PIN_INVALID"}});
        if (!nativeWorker && !INLINE_DISPATCH[call.toolId]) return send(200,{ok:false,error:{code:"UNKNOWN_TOOL"}});
        if (nativeWorker || call.toolId === "ui_see" || call.toolId === "web_search" || call.toolId === "workspace_analyze") {
          const sessionId = call.meta?.sessionId || state.activeSession;
          if (!sessionId || (state.activeSession && sessionId !== state.activeSession))
            return send(200,{ok:false,error:{code:"SESSION_MISMATCH"}});
          call.meta = {...call.meta,sessionId};
          delete call.meta.providerContentHash; delete call.meta.providerDefinitionHash;
          if (nativeDispatcher && providerContentHash !== null) {
            // Resolve host session metadata, not the latest worker version or caller hashes.
            providerSessionPin = providerBindings.route(skillBindings.providerPin(sessionId,
              nativeDefinition.metadata.canonicalToolId), nativeDefinition, call);
            providerContentHash = providerSessionPin.contentHash;
            providerDefinitionHash = providerSessionPin.definitionHash;
          }
          const controller = new AbortController();
          res.on("close", () => {if (!res.writableEnded) controller.abort();});
          call.cancelSignal = controller.signal;
          if (!["ui_see","ui_tap","ui_screenshot"].includes(call.toolId))
            call.approvalOpId = await carrierAuthorization.authorize(call.toolId, call.arguments || {}, sessionId, controller.signal);
        }
        if (["ui_see","ui_tap","ui_screenshot"].includes(call.toolId)) {
          const controller = new AbortController();
          res.on("close", () => { if (!res.writableEnded) controller.abort(); });
          call.cancelSignal = controller.signal;
          const sessionId = state.activeSession || call.meta?.sessionId;
          if (!sessionId) return send(200,{ok:false,error:{code:"SESSION_REQUIRED"}});
          call.meta = {...call.meta,sessionId};
          let approvalInput = call.arguments || {};
          if (call.toolId === "ui_see") {
            call.visionConfig = visionPipeline.loadVisionConfig(ROOT);
            if (call.visionConfig) approvalInput = {...approvalInput,baseUrl:call.visionConfig.baseUrl,
              providerId:call.visionConfig.providerId,modelId:call.visionConfig.modelId,
              visionConfigHash:require("node:crypto").createHash("sha256").update(JSON.stringify(call.visionConfig)).digest("hex")};
          }
          if (call.toolId === "ui_tap") {
            const target = await tapPreflight(call.arguments || {},sessionId,controller.signal);
            call.arguments = {...call.arguments,label:target.label};
            call.meta.tapTreeId = target.treeId;
            call.meta.tapEpoch = target.epoch;
            approvalInput = call.arguments;
          }
          const permission = await gateway.handlePermission({requestId:"carrier_" + require("node:crypto").randomUUID(),
            sessionId,toolName:"mcp__android-host__" + call.toolId,input:approvalInput});
          if (permission.decision !== "allow" || controller.signal.aborted) return send(200,{ok:false,error:{code:"GATEWAY_DENIED"}});
          const operation = gateway.journalView(500).find(r=>r.id===permission.operationId);
          if (!operation || operation.decision !== "allow" || operation.tool !== "mcp__android-host__" + call.toolId ||
              operation.session !== sessionId || operation.args !== JSON.stringify(approvalInput))
            return send(200,{ok:false,error:{code:"GATEWAY_INTENT_UNBOUND"}});
          call.approvalOpId = operation.id;
        }
        if (admissionEpoch !== (state.carrierEpoch || 0) || call.cancelSignal?.aborted)
          return send(200,{ok:false,error:{code:"CANCELLED"}});
        if (providerSessionPin && !providerBindings.verify(providerSessionPin)) throw Error("PROVIDER_SESSION_PIN_UNAVAILABLE");
        call.callId = "call_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        // Metadata-only observability applies equally to INLINE and worker routes.
        broadcast({ type: "carrier-call", callId: call.callId, toolId: call.toolId,
          argumentKeys: call.arguments && typeof call.arguments === "object" ? Object.keys(call.arguments) : [], ts: Date.now() });
        // ---- inline dispatch for bridge-registered host tools (W2/W-T2.5) ----
        const inline = INLINE_DISPATCH[call.toolId];
        if (inline) {
          state.carrierCounters = state.carrierCounters || {};
          state.carrierCounters.inlineCalls = (state.carrierCounters.inlineCalls || 0) + 1;
          inline(call)
            .then((r) => send(200, r))
            .catch((e) => send(200, { ok: false, error: { code: "ws_internal", message: String(e).slice(0, 300) } }));
          return;
        }
        // ---- worker path (Android dispatcher tools, Phase 8) ----
        state.carrierQueue = state.carrierQueue || [];
        state.carrierPending = state.carrierPending || new Map();
        state.carrierQueue.push(call);
        state.carrierCounters = state.carrierCounters || {};
        state.carrierCounters.lastCallId = call.callId;
        state.carrierCounters.lastCallTool = call.toolId;
        const timer = setTimeout(() => {
          const pend = state.carrierPending.get(call.callId);
          if (pend) {
            state.carrierPending.delete(call.callId);
            state.carrierQueue = state.carrierQueue.filter(x => x.callId !== call.callId);
            pend.resolve({ status: 200, body: settleAbandonedCarrier(call.callId, pend, "CARRIER_TIMEOUT") });
          }
        }, Number(process.env.CARRIER_CALL_TIMEOUT_MS || 120000));
        // answer the MCP child when the Kotlin worker responds
        new Promise((resolve) => state.carrierPending.set(call.callId,
          { resolve, timer, toolId: call.toolId, callArgs: call.arguments, approvalOpId:call.approvalOpId, sessionId:call.meta?.sessionId,
            nativeDispatcher, providerContentHash, providerDefinitionHash, epoch:admissionEpoch }))
          .then((r) => send(r.status, r.body));
        res.on("close", () => {
          if (res.writableEnded) return;
          const pending = state.carrierPending.get(call.callId);
          if (pending) {
            clearTimeout(pending.timer); state.carrierPending.delete(call.callId);
            pending.resolve({status:200,body:settleAbandonedCarrier(call.callId, pending, "CANCELLED")});
          }
          state.carrierQueue = state.carrierQueue.filter(x => x.callId !== call.callId);
        });
      } catch (e) {
        const code = String(e?.message || e);
        if (/^(GATEWAY_|PROVIDER_SESSION_|CANCELLED)/.test(code)) send(200,{ok:false,error:{code}});
        else send(400,{error:String(e)});
      }
    });
    return;
  }

  if (url.pathname === "/sessions") {
    // merged view: host-owned persistent index + live sessions from the core
    rpc("session/list", {}).then((m) => {
      const live = (m.result && (m.result.sessions || m.result)) || [];
      const liveIds = new Set((Array.isArray(live) ? live : []).map((s) => s.sessionId || s.id));
      const merged = readIndex().map((s) => ({ ...s, live: liveIds.has(s.sessionId) }));
      send(200, { sessions: merged });
    });
    return;
  }
  if (url.pathname === "/session/resume") {
    const id = url.searchParams.get("id") || "";
    rpc("session/resume", {
      sessionId: id,
      workspace: { workspacePath: WORKSPACE, workspaceKey: "spike" },
    }, 20000).then((m) => send(200, m.result || { error: m.error }));
    return;
  }
  if (url.pathname === "/session/read") {
    const id = url.searchParams.get("id") || "";
    rpc("session/read", { sessionId: id }, 20000).then((m) => send(200, { snapshot: m.result || m.error }));
    return;
  }
  if (url.pathname === "/respond" && req.method === "POST") {
    // UI answers a pending permission request through the Gateway
    // (hard-confirm requires the displayed confirmToken = requestId;
    // alwaysDomain maps the answer into the Gateway domain rule store)
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { requestId, decision, confirmToken, alwaysDomain } = JSON.parse(body);
        const r = gateway.resolveAnswer(String(requestId), { decision, confirmToken, alwaysDomain, source: "ui" });
        send(r.ok ? 200 : 404, r);
      } catch (e) { send(400, { error: String(e) }); }
    });
    return;
  }
  if (url.pathname === "/gateway/journal") {
    send(200, { mode: gateway.mode, operations: gateway.journalView(Number(url.searchParams.get("limit") || 50)) });
    return;
  }
  if (url.pathname === "/gateway/network") {
    send(200, { mode: gateway.mode, network_requests: gateway.networkView(Number(url.searchParams.get("limit") || 100)) });
    return;
  }
  if (url.pathname === "/gateway/rules") {
    send(200, { rules: gateway.rulesView() });
    return;
  }
  // Phase 8 W-T2.5: the write-transaction inspection surface (contract §3.5)
  if (url.pathname === "/gateway/writes") {
    const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
    const stateFilter = url.searchParams.get("state") || null;
    send(200, { mode: gateway.mode, write_txns: gateway.writesView(limit, stateFilter) });
    return;
  }
  if (url.pathname === "/search/status") {
    // redacted effective search config — the same truth the executor uses
    const cfg = loadSearchConfig() || {};
    const backends = (cfg.backends || []).map((b) => ({
      id: b.id, enabled: b.enabled !== false,
      host: (() => { try { return new URL(b.baseUrl).host; } catch { return null; } })(),
      hasKey: !!(cfg._keys && cfg._keys[b.id]), defaultCount: b.defaultCount || 8,
      timeoutMs: b.timeoutMs || 60000,
    }));
    send(200, {
      lab: LAB_SEARCH, carrierOff: CARRIER_OFF,
      labVision: state.labVision ? { port: state.labVision.port, count: state.labVision.count(),
        lastQuestion: state.labVision.lastQuestion(), listenError: state.labVision.listenError() } : null,
      backends,
      network: cfg.network || null, limits: cfg.limits || null,
      lastResultCode: searchState.lastResultCode,
    });
    return;
  }
  if (url.pathname === "/labsearch/status") {
    const out = {};
    for (const [name, ep] of Object.entries(labSearch.endpoints)) {
      out[name] = { count: ep.count, bodies: ep.bodies.map((b) => ({ n: b.n, summary: b.summary })) };
    }
    send(200, { enabled: LAB_SEARCH, endpoints: out, proxy: labSearch.proxyLog || [] });
    return;
  }
  if (url.pathname === "/labsearch/body") {
    const name = url.searchParams.get("ep") || "";
    const n = Number(url.searchParams.get("n") || 0);
    const ep = labSearch.endpoints[name];
    const hit = ep && ep.bodies.find((b) => b.n === n);
    if (!hit) return send(404, { error: "no captured body" });
    send(200, { n, raw: hit.raw });
    return;
  }
  if (url.pathname === "/labsearch/ca-diag") {
    // V3.4 CA lever: spawn the app-owned node with/without
    // NODE_EXTRA_CA_CERTS against the lab TLS server (verification stays ON)
    if (!LAB_SEARCH) return send(403, { error: "lab search not enabled" });
    const mode = url.searchParams.get("mode") === "ca" ? "ca" : "plain";
    const script = "fetch('https://127.0.0.1:" + LAB_TLS_PORT + "/').then(r=>r.text())" +
      ".then(t=>{console.log('FETCH-OK',t.trim());process.exit(0)})" +
      ".catch(e=>{console.log('FETCH-ERR',(e&&e.cause&&e.cause.code)||String(e));process.exit(0)})";
    const env = { ...process.env };
    delete env.NODE_EXTRA_CA_CERTS;
    if (mode === "ca") env.NODE_EXTRA_CA_CERTS = path.join(RUNTIME, "lab-tls", "ca.pem");
    const p = spawn(process.execPath, ["-e", script], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("exit", (code) => send(200, { mode, code, output: out.trim().slice(0, 400) }));
    return;
  }
  if (url.pathname === "/gateway/pending") {
    send(200, { pending: gateway.pendingView() });
    return;
  }
  if (url.pathname === "/gateway/rollback" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { send(200, gateway.rollback(Number(JSON.parse(body).id))); }
      catch (e) { send(400, { error: String(e) }); }
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/rpc") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const m = JSON.parse(body);
        // Gateway RPC ceiling (policy mutation from the UI layer is refused)
        if (typeof m.method === "string") {
          const g = gateway.rpcGuard(m.method, m.params);
          if (!g.allowed) return send(403, { blocked: true, reason: g.reason });
        }
        forwardToChild(JSON.stringify(m));
        send(200, { forwarded: true });
      } catch (e) { send(400, { error: String(e) }); }
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/rpc-wait") {
    // synchronous RPC: forwards through the same FIFO + repair pipeline as
    // /rpc (incl. the setThoughtLevel repair), but waits for the app-server's
    // answer — Phase 6 probes, session driving, error-taxonomy capture
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const m = JSON.parse(body);
        if (typeof m.method !== "string") return send(400, { error: "method required" });
        const g = gateway.rpcGuard(m.method, m.params);
        if (!g.allowed) return send(403, { blocked: true, reason: g.reason });
        rpc(m.method, m.params || {}, Number(m.timeoutMs || 15000)).then((r) => send(200, r));
      } catch (e) { send(400, { error: String(e) }); }
    });
    return;
  }
  if (url.pathname === "/labmocks/status") {
    const out = {};
    for (const [name, ep] of Object.entries(lab.endpoints)) {
      out[name] = { count: ep.count, bodies: ep.bodies.map((b) => ({ n: b.n, summary: b.summary })) };
    }
    send(200, { enabled: LAB_ENABLED, endpoints: out });
    return;
  }
  if (url.pathname === "/labmocks/body") {
    const name = url.searchParams.get("ep") || "";
    const n = Number(url.searchParams.get("n") || 0);
    const ep = lab.endpoints[name];
    const hit = ep && ep.bodies.find((b) => b.n === n);
    if (!hit) return send(404, { error: "no captured body" });
    send(200, { n, raw: hit.raw });
    return;
  }
  send(404, { error: "not found" });
});

// ------------------------------------------------------------- storage preflight
// Desktop-parity contract (upstream-ui F2/F7): the host runs a one-shot
// `app-server --stdio --prepare-storage --cwd <workspace>` before the main
// server. Without it the workspace/project registration rows never exist and
// every session-row insert fails "FOREIGN KEY constraint failed" — sessions
// then never persist and session/resume is impossible (diagnosed 2026-09-28).
function prepareStorage() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath,
      [ZCODE, "app-server", "--stdio", "--prepare-storage", "--cwd", WORKSPACE],
      { stdio: ["pipe", "pipe", "pipe"], env: childEnv });
    let out = "";
    const done = (ok, why) => {
      try { p.kill(); } catch {}
      resolve({ ok, why });
    };
    const timer = setTimeout(() => done(false, "timeout"), 30000);
    p.stdout.on("data", (d) => {
      out += d.toString();
      let idx;
      while ((idx = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, idx).trim(); out = out.slice(idx + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.method === "startup/storagePath") {
          // answer the handshake: reuse the existing db
          const reply = { result: { reuse: true } };
          if (m.id !== undefined) reply.id = m.id;
          p.stdin.write(JSON.stringify(reply) + "\n");
        } else if (m.method === "startup/storagePrepared" || m.method === "startup/storageState") {
          const phase = m.params && m.params.phase;
          if (phase === "ready" || m.method === "startup/storagePrepared") {
            clearTimeout(timer); done(true, "prepared");
          }
        }
      }
    });
    p.stderr.on("data", () => {});
    p.on("exit", (code) => { clearTimeout(timer); done(code === 0, "exit " + code); });
  });
}

// ---------------------------------------------------------------------- boot
(async () => {
  state.phase = "hardening";
  // R2: config-disable of core-internal paths that never consult the broker
  // (forced-yolo runners, plugin hooks/MCP spawns — map audit paths 2/4/10/11).
  // PLUS the model-visible Android tool carrier: one host-declared MCP server
  // (mcp.servers user config — measured to survive plugins.enabled:false).
  // The user layer is HOME-based (~/.zcode/cli/config.json); we own HOME.
  // Phase 7 W3: the device-side kill switch is the carrier.disabled control
  // file (nothing sets CARRIER_ENABLED on device — RuntimeEnv has no key).
  // W7: network.* levers (proxy/CA/timeout) from the search config merge in.
  // F1 (receiving review 2026-10-03): the host-declared disable config must be
  // WRITTEN, READ BACK and VERIFIED before the Core may start. Any anomaly in
  // that chain (existing-config read/parse failure, write failure, read-back
  // mismatch, semantic verification failure) aborts the boot BEFORE startChild
  // with explicit diagnostics — the old catch-and-log was measured to reach
  // startChild with an unverified config. Recovery: delete the host-owned
  // config file named in the diagnostic and restart.
  state.configDisableError = null;
  try {
    const cfgDir = path.join(ROOT, ".zcode", "cli");
    fs.mkdirSync(cfgDir, { recursive: true });
    const cfgFile = path.join(cfgDir, "config.json");
    let cfg = {};
    if (fs.existsSync(cfgFile)) {
      // fail-closed on unreadable/corrupt EXISTING config: this file is
      // host-owned generated state; we will not guess its prior contents
      try {
        cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
        if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("not a JSON object");
      } catch (e2) {
        throw new Error("existing config unreadable/corrupt (" + String(e2.message || e2).slice(0, 80) +
          "); delete " + cfgFile + " to regenerate");
      }
    }
    cfg.features = { ...(cfg.features || {}), memory: false };
    cfg.memory = { ...(cfg.memory || {}), extractionEnabled: false };
    cfg.plugins = { ...(cfg.plugins || {}), enabled: false };
    const netCfg = (loadSearchConfig() || {}).network;
    if (netCfg && (netCfg.httpProxy || netCfg.noProxy || netCfg.caCertFile || netCfg.timeout)) {
      cfg.network = { ...(cfg.network || {}), ...netCfg };
      log("network.* levers materialized: " + JSON.stringify(netCfg));
    }
    if (!CARRIER_OFF) {
      cfg.mcp = { ...(cfg.mcp || {}), servers: { ...(cfg.mcp?.servers || {}), "android-host": {
        type: "stdio",
        command: process.execPath,
        args: [path.join(RUNTIME, "android-carrier.cjs")],
      } } };
    } else {
      if (cfg.mcp && cfg.mcp.servers) delete cfg.mcp.servers["android-host"];
      log("carrier disabled via control file/env — mcp declaration omitted");
    }
    const written = JSON.stringify(cfg, null, 2);
    fs.writeFileSync(cfgFile, written);
    const readBack = fs.readFileSync(cfgFile, "utf8");      // read-back step
    if (readBack !== written) throw new Error("config read-back mismatch (truncated/partial write)");
    const applied = JSON.parse(readBack);                    // parse check
    if (!applied || typeof applied !== "object") throw new Error("config read-back not a JSON object");
    if (applied.features?.memory !== false || applied.memory?.extractionEnabled !== false ||
        applied.plugins?.enabled !== false) {
      throw new Error("config verification failed: disable flags not applied");
    }
    const hostMcp = applied.mcp && applied.mcp.servers && applied.mcp.servers["android-host"];
    if (!CARRIER_OFF && (!hostMcp || hostMcp.type !== "stdio")) {
      throw new Error("config verification failed: android-host MCP declaration missing");
    }
    if (CARRIER_OFF && hostMcp) {
      throw new Error("config verification failed: carrier declared while kill-switch is OFF");
    }
    log("config-disable pack written, read back and verified (memory/plugins off; carrier " +
      (CARRIER_OFF ? "omitted" : "declared") + ")");
  } catch (e) {
    // F1 fail-closed: never start the Core with an unverified disable config.
    state.configDisableError = String((e && e.message) || e).slice(0, 240);
    state.phase = "config-disable-failed";
    log("FATAL config-disable: " + state.configDisableError + " — Core will NOT start");
    // diagnostics only: bring the bridge up for /status; skip endpoint
    // materialization, storage preflight, lab servers and startChild entirely
    await new Promise((r) => bridge.listen(HTTP_PORT, "127.0.0.1", r));
    return;
  }
  // carrier endpoint discovery file (the MCP spawn path's env pass-through is
  // uninstrumented — the carrier prefers this file; 0600, holds the token)
  try {
    fs.mkdirSync(path.join(RUNTIME, "carrier"), { recursive: true });
    const epFile = path.join(RUNTIME, "carrier", "endpoint.json");
    fs.writeFileSync(epFile, JSON.stringify({ port: HTTP_PORT, token: TOKEN }));
    fs.chmodSync(epFile, 0o600);
  } catch (e) { log("carrier endpoint file write failed: " + e); }

  state.phase = "preparing-storage";
  if (MODE === "mock") {
    await new Promise((r) => mockServer.listen(MOCK_PORT, "127.0.0.1", r));
    log(`mock model on 127.0.0.1:${MOCK_PORT}/v1`);
  }
  if (LAB_SEARCH) {
    await startLabSearch();
  }
  const prep = await prepareStorage();
  log("storage preflight: " + JSON.stringify(prep));
  if (LAB_ENABLED) {
    await startLabMock("alpha", Number(process.env.SPIKE_LAB_PORT_A || 18081));
    await startLabMock("beta", Number(process.env.SPIKE_LAB_PORT_B || 18082));
  }
  state.phase = "starting";
  startChild();
  await new Promise((r) => setTimeout(r, 1200));
  await new Promise((r) => bridge.listen(HTTP_PORT, "127.0.0.1", r));
  log(`bridge on http://127.0.0.1:${HTTP_PORT}/ (loopback only, token ${TOKEN ? "on" : "OFF"})`);
  state.phase = "ready";

  if (MODE === "mock") {
    // Phase 0 hermetic smoke turn (mock provider only)
    const sel = { providerId: "mock", modelId: "mock-model" };
    const conn = await rpc("provider/testModelConnectivity", {
      workspace: { workspacePath: WORKSPACE, workspaceKey: "spike" }, selection: sel,
    });
    log("connectivity: " + JSON.stringify(conn.result || conn.error).slice(0, 120));
    const created = await rpc("session/create", {
      workspace: { workspacePath: WORKSPACE, workspaceKey: "spike" },
      model: { ...sel, options: { reasoningLevel: "disabled" } },
    });
    const sid = created.result && created.result.session && created.result.session.sessionId;
    if (sid) {
      log("mock sessionId = " + sid);
      await rpc("session/send", { sessionId: sid, content: "Read hello.txt and tell me its contents." });
    }
  }
})();
