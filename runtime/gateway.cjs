// Phase 4 Tool Gateway — map-only boundary (user ruling 2026-09-28, B1).
//
// Interception point: the permission broker round trip. The Agent Core asks
// the client about every tool call that needs approval
// (`interaction/requestPermission`); this Gateway owns classification, policy
// decision, approval flow, journaling, and backup/rollback for everything the
// core asks about, plus the RPC whitelist / policy ceiling for everything the
// WebView layer can send, plus fail-closed answers for client-executed
// automation. Core-internal paths that never consult the broker are closed by
// the config-disable pack written by the bootstrap (R2) — see
// docs/phases/phase4-adjudication.md for the honest fidelity statement (R4).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SCHEMA_VERSION = 3;

// ---------------------------------------------------------------------------
// Phase 8 track 2 (workspace-write contract, docs/phases/phase8-workspace-write-contract.md).
// Tool families registered here so the permission leg can pre-resolve targets.
const WORKSPACE_FILE_TOOLS = new Set([
  "workspace_file_create", "workspace_file_overwrite", "workspace_file_append", "workspace_file_delete",
]);
const UPSTREAM_WRITE_TOOLS = new Set(["Write", "Edit"]);

// The canonical resolver (contract §1.3.1 — normative text, incl. the R3
// createParents branch). One implementation, three call sites: permission leg,
// execution leg, rollback.
const MAX_PATH_BYTES = 4096, MAX_SEGMENT_BYTES = 255;
function resolveWorkspaceTarget(rootReal, relInput, opts) {
  const reservedRoots = (opts && opts.reservedRoots) || [];
  if (typeof relInput !== "string" || relInput.length === 0) return { ok: false, code: "path_invalid" };
  if (Buffer.byteLength(relInput) > MAX_PATH_BYTES) return { ok: false, code: "path_too_long" };
  if (relInput.includes("\u0000")) return { ok: false, code: "path_nul_rejected" };
  if (/[\u0000-\u001f]/.test(relInput)) return { ok: false, code: "path_control_char_rejected" };
  if (relInput.includes("\\")) return { ok: false, code: "path_backslash_rejected" };
  if (relInput.startsWith("/")) return { ok: false, code: "path_absolute_rejected" };
  if (/^[A-Za-z]:/.test(relInput)) return { ok: false, code: "path_absolute_rejected" };
  // normalize on the POSIX form; '..' that survives normalization is a traversal attempt
  const norm = path.posix.normalize(relInput);
  if (norm === "." || norm === "") return { ok: false, code: "path_invalid" };
  const segs = norm.split("/");
  if (segs.some((s) => s === "..")) return { ok: false, code: "path_traversal_rejected" };
  if (segs.some((s) => Buffer.byteLength(s) > MAX_SEGMENT_BYTES)) return { ok: false, code: "path_segment_too_long" };
  // Host control plane: Core reads project configs and native Skill roots on create/resume.
  // Ordinary workspace tools must not turn a data write into changed execution policy or
  // replace Skill instructions. Installation/config materialization is host-owned.
  // Apply the existing reserved-path refusal to normalized descendants too; the absolute
  // resolver, execution leg and rollback all reduce to this same check.
  if (segs.some((s) => [".zcode", ".agents", "zcode.json"].includes(s.toLowerCase())))
    return { ok: false, code: "path_reserved" };
  const rel = segs.join("/");
  const abs = path.join(rootReal, ...segs);
  // defence in depth: never touch the Gateway's own store (journal / backups), even if a
  // misconfiguration or a link made it reachable from the workspace
  if (reservedRoots.some((r) => abs === r || abs.startsWith(r + path.sep)))
    return { ok: false, code: "path_reserved" };

  // closest existing ancestor -> realpath -> containment
  let probe = abs, tailDepth = 0;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return { ok: false, code: "path_escapes_workspace" };
    probe = parent; tailDepth++;
  }
  const ancestorReal = fs.realpathSync(probe);
  if (ancestorReal !== rootReal && !ancestorReal.startsWith(rootReal + path.sep)) {
    return { ok: false, code: "path_escapes_workspace", via: ancestorReal };
  }
  // leaf discipline
  let exists = false, kind = "absent";
  if (tailDepth === 0) {                                   // the leaf itself exists
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return { ok: false, code: "path_symlink_rejected" };
    if (!st.isFile()) return { ok: false, code: "path_not_regular_file" };
    exists = true; kind = "file";
    if (fs.realpathSync(abs) !== abs) {
      // parent chain has a link that changed the location; realpath containment already checked
      return { ok: false, code: "path_symlink_rejected" };
    }
  } else {                                                 // a descendant will be created
    const st = fs.statSync(probe);                          // probe = parent that must exist
    if (!st.isDirectory()) return { ok: false, code: "path_parent_not_directory" };
    // R3: multi-level missing ancestors are legal ONLY under createParents — resolution stays
    // non-mutating (mkdirp happens at execution, inside this already-validated canonical chain);
    // without the flag the immediate-parent rule holds
    if (tailDepth > 1 && !(opts && opts.createParents)) return { ok: false, code: "path_parent_missing" };
  }
  return { ok: true, rel, abs, exists, kind };
}

// The absolute variant (contract §1.3.2) — required by upstream Write/Edit
// absolute targets and legacy rollback rows; a reduction to the resolver.
function containWorkspaceAbsolute(rootReal, absInput, opts) {
  if (typeof absInput !== "string" || absInput.length === 0) return { ok: false, code: "path_invalid" };
  if (absInput.includes("\u0000") || /[\u0000-\u001f]/.test(absInput)) return { ok: false, code: "path_control_char_rejected" };
  if (!path.isAbsolute(absInput)) return { ok: false, code: "path_invalid" };
  let probe = path.dirname(absInput);
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return { ok: false, code: "path_escapes_workspace" };
    probe = parent;
  }
  const canonicalParent = fs.realpathSync(probe);
  if (canonicalParent !== rootReal && !canonicalParent.startsWith(rootReal + path.sep)) {
    return { ok: false, code: "path_escapes_workspace", via: canonicalParent };
  }
  // R6 (implementation-found): relative-ize absInput itself — rebuilding from
  // canonicalParent + basename drops intermediate missing segments when
  // createParents allows a multi-level gap (notes/a.md became a.md).
  const rel = path.posix.normalize(path.relative(rootReal, absInput).split(path.sep).join("/"));
  return resolveWorkspaceTarget(rootReal, rel, opts);
}

function sha256File(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}
function sha256Buf(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
function writeAndFsync(p, data) {
  const fd = fs.openSync(p, "w");
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function newTxnId() {
  return "wtx_" + Date.now().toString(36) + "_" + crypto.randomBytes(3).toString("hex");
}

// ---------------------------------------------------------------------------
// Hard-confirm rule pack (REQUIREMENTS §6; versioned). Matched against Bash
// `command` (multiline-normalized) and against file targets of file tools.
const HARD_CONFIRM_PACK = {
  version: 1,
  rules: [
    { id: "partition-flash-fastboot", re: /\bfastboot\b[^\n]*\b(flash|erase|format|flashing\s+(unlock|lock)|oem\s+(unlock|lock))\b/i },
    { id: "partition-dd", re: /\bdd\b[^\n]*\bof=\s*\/dev\/(block|mmcblk)/i },
    { id: "mkfs", re: /\bmkfs(\.\w+)?\b/i },
    { id: "flash-image", re: /\bflash_image\b|\bflash_all\b/i },
    { id: "factory-reset", re: /\bfactory[\s_-]?reset\b|\bwipe[\s_]?data\b|\brecovery\b[^\n]*--wipe\b|--wipe_data\b/i },
    { id: "bootloader-critical", re: /\bbootloader\b[^\n]*\b(unlock|lock|erase|flash)\b/i },
    { id: "destructive-rm", re: /\brm\s+(-[a-z]*r[a-z]*f?|[a-z]*f[a-z]*r)\b[^\n]*\s(\/data|\/system|\/vendor|\/product|\/sdcard|\/storage)\b/i },
    { id: "critical-device-node", re: /\/dev\/(block|mmcblk[0-9]|by-name)\b/i },
  ],
};

// Base risk classes by tool (capability tiers come from the Android host
// snapshot; class + tier feed the truth table).
// Phase 7 (runbook C2/C3): WebSearch is a billable outbound request → NETWORK
// (was READ); the host's own carrier tools are explicit NETWORK — every OTHER
// mcp__* keeps the PRIVILEGED fail-closed fallback below.
const TOOL_BASE_CLASS = {
  "mcp__android-host__workspace_analyze": "READ",
  "mcp__android-host__text_digest_inspect": "READ",
  Read: "READ", Glob: "READ", Grep: "READ", TodoRead: "READ", TodoWrite: "WRITE",
  Agent: "READ", Skill: "READ", WebSearch: "NETWORK",
  "mcp__android-host__web_search": "NETWORK",
  "mcp__android-host__web_fetch": "NETWORK",
  "mcp__android-host__workspace_file_create": "WRITE",
  "mcp__android-host__workspace_file_overwrite": "WRITE",
  "mcp__android-host__workspace_file_append": "WRITE",
  "mcp__android-host__workspace_file_delete": "WRITE",
  // Phase 8 track 1 (runbook §6.1): reads auto, device writes ask. Explicit
  // rows even though the mcp__* fail-closed default already gives PRIVILEGED —
  // the unit suite pins these (phase7 precedent).
  "mcp__android-host__ui_dump": "READ", "mcp__android-host__ui_find": "READ",
  "mcp__android-host__ui_wait": "READ",
  "mcp__android-host__ui_click": "PRIVILEGED", "mcp__android-host__ui_long_press": "PRIVILEGED",
  "mcp__android-host__ui_type": "PRIVILEGED", "mcp__android-host__ui_scroll": "PRIVILEGED",
  "mcp__android-host__ui_back": "PRIVILEGED",
  // Phase 9 additive classes; decide() and hard-safety precedence unchanged.
  "mcp__android-host__ui_screenshot": "PRIVILEGED",
  "mcp__android-host__ui_see": "NETWORK",
  "mcp__android-host__ui_tap": "PRIVILEGED",
  Write: "WRITE", Edit: "WRITE", ApplyPatch: "WRITE",
  WebFetch: "NETWORK",
  Bash: "PRIVILEGED", js: "PRIVILEGED", "js_reset": "PRIVILEGED",
  CreateWorkflow: "DENIED_DEFERRED", AmendWorkflow: "DENIED_DEFERRED",
  CronCreate: "DENIED_DEFERRED", OffPeakCreate: "DENIED_DEFERRED",
};

// Phase 8 §4.6 stage 2: a re-issued destructive ui_click carries the exact
// target label in args.confirm; matching it here makes the call CRITICAL =>
// hard_confirm in every mode (structurally non-overridable, I2).
const UI_DESTRUCTIVE_VOCAB = /erase|wipe|factory[\s_-]?reset|delete[\s_-]?all|clear[\s_-]?all[\s_-]?data|format|uninstall|remove[\s_-]?account|停用|恢复出厂|清除全部|卸载/i;
function uiHardConfirmHit(input) {
  const c = input && [input.confirm, input.text, input.label].filter(x => typeof x === "string").join(" ");
  if (typeof c !== "string" || !c) return false;
  return UI_DESTRUCTIVE_VOCAB.test(c);
}

function normalizeCommand(input) {
  if (!input || typeof input !== "object") return "";
  return String(input.command || input.file || "");
}

function classify(toolName, input, workspace, rootReal) {
  const base = TOOL_BASE_CLASS[toolName] || (toolName && toolName.startsWith("mcp__") ? "PRIVILEGED" : "PRIVILEGED");
  const cmd = normalizeCommand(input);
  // Phase 8 (contract §1.3.3): the resolved path, when the permission leg
  // pre-resolved one, is authoritative; otherwise the model's raw field.
  const target = String((input && (input.resolved_path || input.file_path || input.path)) || "");
  const hits = [];
  for (const r of HARD_CONFIRM_PACK.rules) {
    const hay = toolName === "Bash" ? cmd : cmd + " " + target;
    if (r.re.test(hay)) hits.push(r.id);
  }
  if (hits.length) return { risk: "CRITICAL", hits, base };
  if (String(toolName).startsWith("mcp__android-host__") && uiHardConfirmHit(input)) {
    return { risk: "CRITICAL", hits: ["ui-destructive-label"], base };
  }
  if (base === "WRITE" && target) {
    if (!path.isAbsolute(target)) {
      // A write-class tool whose target is relative and unresolved here means
      // the permission leg's pre-resolve branch was not taken — defensive
      // fail-closed (contract §1.3.3 item 3); WW1 asserts it never fires.
      return { risk: "PRIVILEGED", hits, base, unresolved: true };
    }
    // canonical containment replaces the shipped string-prefix test (contract
    // §1.3.4 C1–C5 measured the prefix defects)
    const root = rootReal || (workspace ? fs.existsSync(workspace) ? fs.realpathSync(workspace) : workspace : null);
    // the pre-resolve leg already allowed multi-level gaps under
    // create_parents — the containment re-check must apply the same rule or
    // every create_parents write degrades to PRIVILEGED (measured on device)
    const c = root ? containWorkspaceAbsolute(root, target,
      { createParents: !!(input && input.create_parents === true) }) : null;
    if (!c || !c.ok) return { risk: "PRIVILEGED", hits, base, outsideWorkspace: true, inner: c && c.code };
    return { risk: "WRITE", hits, base, contained: { rel: c.rel, abs: c.abs, exists: c.exists } };
  }
  return { risk: base, hits, base };
}

// Truth table (REQUIREMENTS §5): user mode × risk → auto/ask/hard_confirm.
// CRITICAL and DESTRUCTIVE always hard-confirm (§5.1–5.3 + §6 non-bypassable).
function decide(mode, risk) {
  switch (risk) {
    case "CRITICAL": return "hard_confirm";
    case "DENIED_DEFERRED": return "deny";
    case "PRIVILEGED": return mode === "full" ? "auto" : "ask";
    case "WRITE": return mode === "ask" ? "ask" : "auto";
    case "NETWORK": return mode === "ask" ? "ask" : "auto";
    case "READ": return "auto";
    default: return "ask";
  }
}

// RPC policy ceiling: what the WebView/client layer may NEVER send.
const RPC_DENY = [
  { method: "session/setMode", when: (p) => p && (p.mode === "yolo" || p.mode === "auto"), id: "mode-yolo" },
  { method: "workspace/updateDynamicWorkflowPolicy", when: () => true, id: "dwf-policy" },
  { method: "plugins/install", when: () => true, id: "plugin-install" },
  { method: "plugins/marketplace/add", when: () => true, id: "plugin-marketplace" },
  { method: "automation/create", when: (p) => !p || p.mode !== "build", id: "automation-mode" },
  { method: "automation/update", when: () => true, id: "automation-update" },
  { method: "offPeak/create", when: () => true, id: "offpeak" },
  { method: "provider/updateAccountConfig", when: () => true, id: "account-config" },
];

// ---------------------------------------------------------------------------
class Gateway {
  constructor() { this.mode = "ask"; this.workspace = ""; this.db = null; this.root = null; this.rootReal = null; }

  init(opts) {
    this.root = opts.root;
    this.workspace = opts.workspace;
    this.mode = opts.mode || "ask";
    this.rootReal = this.workspace && fs.existsSync(this.workspace) ? fs.realpathSync(this.workspace) : this.workspace;
    this.storeRoot = path.join(this.root, "gateway");       // reserved to the resolver (path_reserved)
    this.settings = Object.assign({
      "backup.cap_bytes": 268435456,                        // G11
      "backup.max_file_bytes": 33554432,                    // G11
      "write.intent_claim_window_ms": 120000,
      "write.event_deadline_ms": 120000,
      "wsfp.max_files": 2000, "wsfp.max_paths": 200,        // G4
    }, opts.settings || {});
    const dir = path.join(this.root, "gateway");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "backups", "v1"), { recursive: true });
    fs.mkdirSync(path.join(dir, "backups", "v1", "quarantine"), { recursive: true });
    const { DatabaseSync } = require("node:sqlite");
    this.db = new DatabaseSync(path.join(dir, "journal.sqlite"));
    // Journal v2 (phase7-runbook §Storage): additive migration — the v1
    // `operation` table and its rows are untouched; `network_request` carries
    // the audit metadata for every egress call (host search pipeline + the
    // folded upstream `network_request_status` events); `allow_rule` is the
    // Gateway-owned mapping target for "always allow this domain" (map audit
    // path 19 — never persisted raw, never a bare toolName allow).
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists operation (
        id integer primary key autoincrement,
        ts text not null,
        session text, task text, tool text, args text,
        provider text, capability text, risk text, mode text,
        decision text, approval_source text, rule_hits text, hard_confirm integer,
        result text, files_modified text,
        before_hash text, after_hash text, backup_path text,
        reversible integer, detail text
      );
      create table if not exists network_request (
        id integer primary key autoincrement,
        ts text not null,
        session text, turn text, tool_call_id text,
        source text not null,
        backend_id text, key_id text,
        method text, scheme text, host text, path_redacted text, query_sha256 text,
        final_host text, redirect_count integer,
        status integer, status_text text, bytes_in integer, bytes_out integer,
        duration_ms integer, timeout_ms integer, retry_count integer, retry_after text,
        cache_hit integer, egress_custom_ca integer, egress_proxied integer,
        egress_proxy_source text, egress_no_proxy_matched integer,
        decision text, approval_source text, policy_mode text,
        result_code text, budget_truncated integer, artifact_path text, notes text
      );
      create index if not exists idx_network_request_ts on network_request(ts);
      create table if not exists allow_rule (
        id integer primary key autoincrement,
        created_ts text not null,
        kind text not null, value text not null, tool text not null,
        source text
      );
      create table if not exists write_txn (
        id integer primary key autoincrement,
        ts text not null,
        txn_id text not null,
        op_id integer,
        ref_op_id integer,
        session text,
        turn text,
        tool_call_id text,
        tool text,
        route text not null check (route in ('inline','upstream_event','rollback','reap','sweep')),
        state text not null check (state in
          ('intent','prepared','executed','verified','completed','failed','refused','uncertain','abandoned','rolled_back')),
        workspace_key text,
        workspace_root text,
        target_rel text,
        target_abs text,
        mutation_kind text,
        before_hash text,
        after_hash text,
        observed_hash text,
        before_size integer,
        after_size integer,
        backup_path text,
        backup_sha256 text,
        backup_generation integer,
        verify text,
        error_code text,
        detail text
      );
      create table if not exists ui_action (
        id integer primary key autoincrement,
        ts text not null,
        session text, turn text,
        tool text not null,
        call_id text,
        op_id integer,
        action text,
        tree_id text, node_id text,
        node_text text,
        args text,
        window_before text, window_after text,
        result text,
        verify text,
        verify_detail text,
        elapsed_ms integer, retries integer,
        nodes_sent integer, bytes_sent integer, truncated integer,
        method text,
        notes text
      );
      create index if not exists idx_ui_action_ts on ui_action(ts);
      create index if not exists idx_write_txn_txn on write_txn(txn_id, id);
      create index if not exists idx_write_txn_op on write_txn(op_id, id);
      create index if not exists idx_write_txn_state on write_txn(state, id);
      create view if not exists v_write_txn_latest as
        select t.* from write_txn t
        join (select txn_id as g_txn, max(id) as g_max from write_txn group by txn_id) m
          on m.g_txn = t.txn_id and m.g_max = t.id;
    `);
    this.db.exec(`pragma user_version = ${SCHEMA_VERSION};`);
    // Durability assertion (contract §2.4 item 5): the intent commit is the
    // "no journal write → no execution" gate, so an OFF synchronous mode is a
    // fail-closed condition, not a warning.
    const syncMode = Number(this.db.prepare("pragma synchronous").get().synchronous);
    if (!(syncMode >= 1)) {
      throw new Error(`gateway: pragma synchronous=${syncMode} (OFF) — refusing mutations (fail-closed)`);
    }
    this._recoverAtInit();
    return this;
  }

  // ---- network audit rows (v2) ---------------------------------------------
  journalNetworkRequest(row) {
    this.db.prepare(
      `insert into network_request (ts, session, turn, tool_call_id, source,
       backend_id, key_id, method, scheme, host, path_redacted, query_sha256,
       final_host, redirect_count, status, status_text, bytes_in, bytes_out,
       duration_ms, timeout_ms, retry_count, retry_after,
       cache_hit, egress_custom_ca, egress_proxied, egress_proxy_source, egress_no_proxy_matched,
       decision, approval_source, policy_mode, result_code, budget_truncated, artifact_path, notes)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      new Date().toISOString(), row.session || null, row.turn || null, row.tool_call_id || null,
      row.source || "unknown", row.backend_id || null, row.key_id || null,
      row.method || null, row.scheme || null, row.host || null, row.path_redacted || null,
      row.query_sha256 || null, row.final_host || null, row.redirect_count ?? null,
      row.status ?? null, row.status_text || null, row.bytes_in ?? null, row.bytes_out ?? null,
      row.duration_ms ?? null, row.timeout_ms ?? null, row.retry_count ?? null, row.retry_after || null,
      row.cache_hit ?? 0, row.egress_custom_ca ? 1 : 0, row.egress_proxied ? 1 : 0,
      row.egress_proxy_source || null, row.egress_no_proxy_matched ? 1 : 0,
      row.decision || null, row.approval_source || null, row.policy_mode || this.mode,
      row.result_code || null, row.budget_truncated ? 1 : 0, row.artifact_path || null, row.notes || null,
    );
    return this.db.prepare("select last_insert_rowid() as id").get().id;
  }

  networkView(limit = 50) {
    return this.db.prepare("select * from network_request order by id desc limit ?").all(limit);
  }

  // ---- domain rule store (audit path 19) -------------------------------------
  // Upstream stores the "always" subject as domain:<host>; this store is the
  // sanctioned mapping target. Loopback/private hosts are never storable.
  _isPublicDomainHost(host) {
    if (!host || typeof host !== "string") return false;
    const h = host.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
    if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
      const b = h.split(".").map(Number);
      if (b[0] === 127 || b[0] === 10 || b[0] === 0 || b[0] >= 224) return false;
      if (b[0] === 172 && b[1] >= 16 && b[1] <= 31) return false;
      if (b[0] === 192 && b[1] === 168) return false;
      if (b[0] === 169 && b[1] === 254) return false;
      if (b[0] === 100 && b[1] >= 64 && b[1] <= 127) return false;
      return true;
    }
    if (h.includes(":")) {
      if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || /^fe[89ab]/.test(h)) return false;
    }
    return h.includes(".");
  }

  addDomainRule(host, tool, source) {
    if (!this._isPublicDomainHost(host)) {
      return { ok: false, error: "loopback/private hosts are not offerable as always-allow" };
    }
    const clean = String(host).toLowerCase().replace(/\.$/, "");
    const existing = this.db.prepare(
      "select id from allow_rule where kind = 'domain' and value = ? and tool = ?"
    ).get(clean, tool);
    if (existing) return { ok: true, id: existing.id, deduped: true };
    this.db.prepare(
      "insert into allow_rule (created_ts, kind, value, tool, source) values (?, 'domain', ?, ?, ?)"
    ).run(new Date().toISOString(), clean, tool, source || "ui");
    return { ok: true };
  }

  domainRuleFor(host, tool) {
    if (!host) return null;
    const clean = String(host).toLowerCase().replace(/\.$/, "");
    return this.db.prepare(
      "select * from allow_rule where kind = 'domain' and value = ? and tool = ?"
    ).get(clean, tool) || null;
  }

  rulesView() {
    return this.db.prepare("select * from allow_rule order by id desc limit 200").all();
  }

  _inputUrlHost(input) {
    const u = input && (input.url || input.baseUrl);
    if (typeof u !== "string") return null;
    try { return new URL(u).hostname.toLowerCase().replace(/\.$/, ""); } catch { return null; }
  }

  journal(row) {
    this.db.prepare(
      `insert into operation (ts, session, task, tool, args, provider, capability, risk, mode,
       decision, approval_source, rule_hits, hard_confirm, result, files_modified,
       before_hash, after_hash, backup_path, reversible, detail)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      new Date().toISOString(), row.session || null, row.task || null, row.tool || null,
      row.args ? JSON.stringify(row.args).slice(0, 4000) : null,
      row.provider || "agent-core", row.capability || null, row.risk || null, this.mode,
      row.decision || null, row.approval_source || null,
      row.ruleHits ? JSON.stringify(row.ruleHits) : null, row.hardConfirm ? 1 : 0,
      row.result || null, row.filesModified ? JSON.stringify(row.filesModified) : null,
      row.beforeHash || null, row.afterHash || null, row.backupPath || null,
      row.reversible ? 1 : 0, row.detail || null,
    );
    return this.db.prepare("select last_insert_rowid() as id").get().id;
  }

  // ---- permission pipeline -----------------------------------------------
  handlePermission(params) {
    const toolName = params.toolName || "?";
    // name domains: the core asks with mcp__android-host__<toolId>, the tool
    // layer speaks <toolId>. Both are the SAME tool — normalize for family
    // checks, journal the FULL name the core used (audit consistency).
    const shortName = toolName.replace(/^mcp__android-host__/, "");
    let input = params.input || {};

    // Permission-leg pre-resolution (contract §1.1.5 P). The resolver's answer
    // is the containment authority; on failure the request is refused with no
    // ask and no journal row (WW2).
    let preResolved = null;
    if (WORKSPACE_FILE_TOOLS.has(shortName)) {
      const c = this._familyPreCheck(shortName, input);
      if (!c.ok) return Promise.resolve({ decision: "deny", reason: "workspace path refused (" + c.code + ")" });
      const r = resolveWorkspaceTarget(this.rootReal, input.path, { reservedRoots: [this.storeRoot], createParents: input.create_parents === true });
      if (!r.ok) return Promise.resolve({ decision: "deny", reason: "workspace path refused (" + r.code + ")" });
      input = { ...input, resolved_path: r.abs };
      preResolved = r;
    } else if (UPSTREAM_WRITE_TOOLS.has(shortName) && input && typeof input.path === "string"
               && !path.isAbsolute(input.path)) {
      // R4: the core resolves upstream relative targets against the workspace
      // cwd; the permission leg judges the same target.
      const r = resolveWorkspaceTarget(this.rootReal, input.path, { reservedRoots: [this.storeRoot] });
      if (!r.ok) return Promise.resolve({ decision: "deny", reason: "workspace path refused (" + r.code + ")" });
      input = { ...input, resolved_path: r.abs };
      preResolved = r;
    }

    const { risk, hits, base, unresolved } = classify(toolName, input, this.workspace, this.rootReal);
    if (unresolved) {
      // Defensive fail-closed (§1.3.3 item 3) — WW1 asserts this never fires.
      return Promise.resolve({ decision: "deny", reason: "unresolved workspace target (implementation defect)" });
    }
    const action = decide(this.mode, risk);
    const capability = risk === "CRITICAL" ? "hard-confirm" :
      toolName === "Bash" ? "shell.app" :
      (toolName === "Write" || toolName === "Edit" || WORKSPACE_FILE_TOOLS.has(shortName)) ? "filesystem.workspace" : null;

    if (action === "auto") {
      let operationId;
      if (this._isWriteTxnTool(shortName)) {
        const ci = this.commitIntent({ params, input, risk, hits, base, decisionSource: `policy:${this.mode}/${risk}` });
        if (!ci.ok) {
          return Promise.resolve({ decision: "deny", reason: "Gateway: " + (ci.code || "intent failed") });
        }
      } else {
        operationId = this.journal({
          session: params.sessionId, tool: toolName, args: input, risk, capability,
          decision: "allow", approval_source: `policy:${this.mode}/${risk}`, ruleHits: hits,
          detail: `base=${base}`,
        });
      }
      return Promise.resolve({ decision: "allow", ...(toolName.startsWith("mcp__android-host__") ? {operationId} : {}), reason: `Gateway policy ${this.mode}/${risk}` });
    }
    if (action === "deny") {
      this.journal({
        session: params.sessionId, tool: toolName, args: input, risk, capability,
        decision: "deny", approval_source: "policy:deferred-class", ruleHits: hits,
        detail: "capability deferred beyond V1 (map audit path 11/12)",
      });
      return Promise.resolve({ decision: "deny", reason: "Deferred beyond V1 by Gateway policy" });
    }
    // domain allow-rule (audit path 19): an explicit "always allow this
    // domain" answer short-circuits later asks for the same host + tool
    const urlHost = this._inputUrlHost(input);
    if (urlHost && this.domainRuleFor(urlHost, toolName)) {
      const operationId = this.journal({
        session: params.sessionId, tool: toolName, args: input, risk, capability,
        decision: "allow", approval_source: "policy:domain-rule", ruleHits: hits,
        detail: `domain rule ${urlHost}`,
      });
      return Promise.resolve({ decision: "allow", ...(toolName.startsWith("mcp__android-host__") ? {operationId} : {}), reason: `Gateway: domain rule for ${urlHost}` });
    }
    // ask / hard_confirm → UI round trip (the caller supplies the asker).
    // Pass the input WITH resolved_path injected — resolveAnswer's
    // commitIntent re-derives containment from it.
    return this.askUi({ ...params, input }, risk, hits, action, capability);
  }

  _isWriteTxnTool(name) {
    return WORKSPACE_FILE_TOOLS.has(name) || UPSTREAM_WRITE_TOOLS.has(name);
  }

  // Cheap, non-mutating shape check before any journal write (§1.1.5 P).
  _familyPreCheck(toolName, input) {
    if (!input || typeof input !== "object") return { ok: false, code: "path_invalid" };
    if (typeof input.path !== "string" || input.path.length === 0) return { ok: false, code: "path_invalid" };
    if (toolName !== "workspace_file_delete" && (typeof input.content !== "string" || input.content.length === 0)) {
      return { ok: false, code: "content_missing" };
    }
    if (typeof input.content === "string" && Buffer.byteLength(Buffer.from(input.content, "utf8")) > 1398168 + 64) {
      return { ok: false, code: "content_too_large" };
    }
    return { ok: true };
  }

  askUi(params, risk, hits, action, capability) {
    // returns a promise resolved by resolveAnswer(); backup for file writes
    // happens on approval inside resolveAnswer.
    return new Promise((resolve) => {
      this._pending = this._pending || new Map();
      const key = String(params.requestId || Math.random().toString(36).slice(2));
      this._pending.set(key, { params, risk, hits, action, capability, resolve });
      if (this.onAsk) {
        this.onAsk(key, {
          toolName: params.toolName, risk, action, hits,
          hardConfirm: action === "hard_confirm",
          input: params.input, reason: params.reason,
        });
      }
      // deny on timeout (bridge supplies the timer)
    });
  }

  resolveAnswer(key, answer) {
    const pend = this._pending && this._pending.get(key);
    if (!pend) return { ok: false, error: "no pending request" };
    this._pending.delete(key);
    const { params, risk, hits, action, capability } = pend;

    if (action === "hard_confirm") {
      // non-bypassable (REQUIREMENTS §6): plain allow is refused; the answer
      // must carry the displayed confirm token (= the request key itself)
      if (answer.decision !== "deny" && answer.confirmToken !== key) {
        this.journal({
          session: params.sessionId, tool: params.toolName, args: params.input, risk,
          capability, decision: "reject", approval_source: answer.source || "ui",
          ruleHits: hits, hardConfirm: 1,
          detail: "hard-confirm answered without token — refused",
        });
        pend.resolve({ decision: "deny", reason: "Hard-confirm requires the displayed confirmation token" });
        return { ok: true, refused: true };
      }
    }

    let backupPath = null, beforeHash = null, reversible = false;
    // "always allow this domain" (audit path 19): mapped into the Gateway rule
    // store, never persisted raw, never a bare toolName allow; loopback/private
    // hosts are refused as rule values (the one-off allow still stands)
    if (answer.decision === "allow" && answer.alwaysDomain && action !== "hard_confirm") {
      const host = this._inputUrlHost(params.input);
      const r = this.addDomainRule(host, params.toolName, answer.source || "ui");
      if (!r.ok) {
        this.journal({
          session: params.sessionId, tool: params.toolName, risk,
          decision: "rule-refused", approval_source: answer.source || "ui",
          detail: `always-domain refused for ${host}: ${r.error}`,
        });
      }
    }

    // Phase 8 (contract §1.4.1): for write-txn tools the approval commits the
    // intent row BEFORE the core is told allow — the durable "no journal write
    // → no execution" gate. The phase-4 pre-image block moves INSIDE
    // commitIntent (for the upstream route it stays permission-side, R1; the
    // inline route backs up at execution T2). An intent failure (backup
    // failure under G1) answers deny.
    // name-domain: the core asks with the FULL mcp__ name — normalize before
    // the family check or the intent is never committed and the execution leg's
    // claim fails with ws_intent_unclaimed (measured on device)
    if (answer.decision === "allow" &&
        this._isWriteTxnTool(String(params.toolName || "").replace(/^mcp__android-host__/, ""))) {
      const ci = this.commitIntent({ params, input: params.input, risk, hits, base: null, decisionSource: answer.source || "ui" });
      if (!ci.ok) {
        pend.resolve({ decision: "deny", reason: "Gateway: " + (ci.code || "intent failed") });
        return { ok: true, refused: true };
      }
      this.journal({
        session: params.sessionId, tool: params.toolName, args: params.input, risk,
        capability, decision: answer.decision, approval_source: answer.source || "ui",
        ruleHits: hits, hardConfirm: action === "hard_confirm" ? 1 : 0,
        detail: `admitted txn=${ci.txnId}` + (action === "hard_confirm" ? " token verified" : ""),
      });
      pend.resolve({ decision: "allow", reason: "Gateway: approved by user" });
      return { ok: true };
    }
    // Bash (G3/G4): accepted, journaled irreversible/unattributed; the
    // workspace fingerprint's before-walk runs now, the after-walk on the
    // tool-result event (completeUpstreamTxn).
    if (answer.decision === "allow" && params.toolName === "Bash") {
      const fp = this._workspaceFingerprint();
      if (fp) pend.wsFingerprint = fp;
    }

    const bashMarker = answer.decision === "allow" && params.toolName === "Bash";
    const operationId = this.journal({
      session: params.sessionId, tool: params.toolName, args: params.input, risk,
      capability, decision: answer.decision, approval_source: answer.source || "ui",
      ruleHits: hits, hardConfirm: action === "hard_confirm" ? 1 : 0,
      beforeHash, backupPath, reversible,
      filesModified: answer.decision === "allow" && (params.input && (params.input.file_path || params.input.path))
        ? [params.input.file_path || params.input.path] : null,
      detail: [
        action === "hard_confirm" ? "token verified" : null,
        // G3/G4: shell-origin mutation, unattributed; before-fingerprint recorded,
        // the after-walk lands on the tool-result event (completeUpstreamTxn)
        bashMarker ? "origin=shell, attribution=none" : null,
        bashMarker && pend.wsFingerprint ? "fp_before=" + pend.wsFingerprint.sha256 + " files=" + pend.wsFingerprint.count : null,
      ].filter(Boolean).join("; ") || null,
    });
    if (bashMarker && pend.wsFingerprint) {
      this._bashBefore = this._bashBefore || new Map();
      this._bashBefore.set(String(params.toolCallId || params.requestId || params.sessionId || ""), {
        sessionId: params.sessionId, fp: pend.wsFingerprint,
      });
    }
    pend.resolve({
      decision: answer.decision === "allow" ? "allow" : "deny",
      ...(String(params.toolName).startsWith("mcp__android-host__") ? {operationId} : {}),
      reason: answer.decision === "allow" ? "Gateway: approved by user" : "Gateway: denied",
    });
    return { ok: true };
  }

  timeoutAnswer(key) {
    const pend = this._pending && this._pending.get(key);
    if (!pend) return;
    this._pending.delete(key);
    this.journal({
      session: pend.params.sessionId, tool: pend.params.toolName, args: pend.params.input,
      risk: pend.risk, decision: "deny", approval_source: "timeout",
      ruleHits: pend.hits, hardConfirm: pend.action === "hard_confirm" ? 1 : 0,
      detail: "no UI answer before timeout",
    });
    pend.resolve({ decision: "deny", reason: "Gateway: approval timeout" });
  }

  // ---- RPC ceiling ---------------------------------------------------------
  rpcGuard(method, params) {
    for (const rule of RPC_DENY) {
      if (method === rule.method && rule.when(params)) {
        this.journal({
          tool: `rpc:${method}`, args: params, risk: "POLICY_MUTATION",
          decision: "deny", approval_source: "rpc-ceiling",
          detail: `blocked by rule ${rule.id}`,
        });
        return { allowed: false, reason: `blocked by Gateway RPC ceiling (${rule.id})` };
      }
    }
    return { allowed: true };
  }

  noteBrowserAutomation(kind) {
    this.journal({ tool: `interaction:${kind}`, risk: "WEB_UI_AUTO", decision: "deny", approval_source: "fail-closed", detail: "browser automation capability-off (map audit path 15)" });
  }

  // ---- Phase 8 track 2: write lifecycle (contract §1.4/§2) ------------------

  _workspaceKey() {
    return this.workspace ? path.basename(this.workspace) : null;
  }

  // G4: sorted "path size mtimeMs" fingerprint; reported as skipped when over budget.
  _workspaceFingerprint() {
    try {
      const maxFiles = this.settings["wsfp.max_files"];
      const files = [];
      const walk = (d) => {
        for (const e of fs.readdirSync(d)) {
          const p = path.join(d, e);
          let st; try { st = fs.lstatSync(p); } catch { continue; }
          if (st.isDirectory()) { walk(p); continue; }
          if (!st.isFile()) continue;
          files.push(p);
          if (files.length > maxFiles) return;
        }
      };
      walk(this.rootReal);
      if (files.length > maxFiles) return { skipped: true, count: files.length };
      files.sort();
      const h = crypto.createHash("sha256");
      for (const p of files) {
        let st; try { st = fs.statSync(p); } catch { continue; }
        h.update(p + " " + st.size + " " + st.mtimeMs + "\n");
      }
      return { sha256: h.digest("hex"), count: files.length };
    } catch { return null; }
  }

  _txnInsert(row) {
    this.db.prepare(
      `insert into write_txn (ts, txn_id, op_id, ref_op_id, session, turn, tool_call_id, tool,
       route, state, workspace_key, workspace_root, target_rel, target_abs, mutation_kind,
       before_hash, after_hash, observed_hash, before_size, after_size,
       backup_path, backup_sha256, backup_generation, verify, error_code, detail)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      new Date().toISOString(), row.txn_id, row.op_id ?? null, row.ref_op_id ?? null,
      row.session || null, row.turn || null, row.tool_call_id || null, row.tool || null,
      row.route, row.state, row.workspace_key || null, row.workspace_root || null,
      row.target_rel || null, row.target_abs || null, row.mutation_kind || null,
      row.before_hash ?? null, row.after_hash ?? null, row.observed_hash ?? null,
      row.before_size ?? null, row.after_size ?? null,
      row.backup_path || null, row.backup_sha256 || null, row.backup_generation ?? null,
      row.verify || null, row.error_code || null, row.detail || null,
    );
  }

  _latestTxn(txnId) {
    return this.db.prepare("select * from v_write_txn_latest where txn_id = ?").get(txnId) || null;
  }
  _txnRows(txnId) {
    return this.db.prepare("select * from write_txn where txn_id = ? order by id").all(txnId);
  }
  _intentRow(txnId) {
    return this.db.prepare("select * from write_txn where txn_id = ? and state = 'intent' order by id limit 1").get(txnId) || null;
  }

  // Terminal transition: terminal txn row + operation row in ONE sqlite
  // transaction (contract §1.4.1), op_id linked both ways. Row fields come from
  // the LATEST state row — the caller may hold an older snapshot (e.g. the
  // intent row taken before executed/verified appended after_hash).
  _terminalTxn(txn, state, o) {
    o = o || {};
    txn = this._latestTxn(txn.txn_id) || txn;
    // State rows are append-only and intentionally sparse. The terminal row
    // and operation projection must retain the committed pre-image fields
    // from the intent row rather than treating a later NULL as "absent".
    const intent = this._intentRow(txn.txn_id) || txn;
    const beforeHash = o.beforeHash !== undefined ? o.beforeHash
      : (txn.before_hash !== null && txn.before_hash !== undefined ? txn.before_hash : intent.before_hash);
    const beforeSize = txn.before_size !== null && txn.before_size !== undefined ? txn.before_size : intent.before_size;
    this.db.exec("begin immediate");
    try {
      const opId = this.journal({
        session: txn.session, tool: txn.tool || "workspace_file",
        args: { rel: txn.target_rel }, risk: o.risk || "WRITE",
        decision: o.decision || "allow", approval_source: o.approval_source || "host",
        result: o.result !== undefined ? o.result : (state === "completed" ? "ok" : state),
        ruleHits: o.ruleHits, beforeHash,
        afterHash: o.afterHash !== undefined ? o.afterHash : txn.after_hash,
        backupPath: o.backupPath !== undefined ? o.backupPath : txn.backup_path,
        reversible: o.reversible !== undefined ? o.reversible : false,
        filesModified: o.filesModified !== undefined ? o.filesModified : [txn.target_rel],
        detail: [o.detailPrefix, "txn=" + txn.txn_id].filter(Boolean).join(" ") + (o.detail ? " " + o.detail : ""),
      });
      this._txnInsert({
        txn_id: txn.txn_id, op_id: opId, ref_op_id: txn.ref_op_id,
        session: txn.session, turn: txn.turn, tool_call_id: txn.tool_call_id, tool: txn.tool,
        route: o.route || txn.route, state,
        workspace_key: txn.workspace_key, workspace_root: txn.workspace_root,
        target_rel: txn.target_rel, target_abs: txn.target_abs, mutation_kind: txn.mutation_kind,
        before_hash: beforeHash,
        after_hash: o.afterHash !== undefined ? o.afterHash : txn.after_hash,
        observed_hash: o.observed_hash !== undefined ? o.observed_hash : txn.observed_hash,
        before_size: beforeSize, after_size: txn.after_size,
        backup_path: o.backupPath !== undefined ? o.backupPath : txn.backup_path,
        backup_sha256: o.backup_sha256 !== undefined ? o.backup_sha256 : txn.backup_sha256,
        backup_generation: o.backup_generation !== undefined ? o.backup_generation : txn.backup_generation,
        verify: o.verify !== undefined ? o.verify : txn.verify,
        error_code: o.error_code || null, detail: o.txnDetail || null,
      });
      this.db.exec("commit");
      return opId;
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
  }

  // The permission-leg intent commit (contract §1.4.1). For the upstream
  // route the pre-image backup happens HERE (R1) — intent + prepared in one
  // dwrite; a backup failure under G1 returns {ok:false, code:'backup_failed'}
  // and the caller must answer deny (T3 journaling is done here).
  commitIntent({ params, input, risk, hits, decisionSource }) {
    const shortName = String(params.toolName || "").replace(/^mcp__android-host__/, "");
    // journal name domain: the workspace family ALWAYS carries the full
    // model-visible name so the execution leg's claim (same domain) joins
    const toolName = WORKSPACE_FILE_TOOLS.has(shortName)
      ? ("mcp__android-host__" + shortName)
      : String(params.toolName || "?");
    const route = WORKSPACE_FILE_TOOLS.has(shortName) ? "inline" : "upstream_event";
    const mutationKind = WORKSPACE_FILE_TOOLS.has(shortName)
      ? shortName.slice("workspace_file_".length)
      : (shortName === "Edit" ? "upstream_edit" : "upstream_write");
    const resolved = input && input.resolved_path
      ? containWorkspaceAbsolute(this.rootReal, input.resolved_path,
          { reservedRoots: [this.storeRoot], createParents: input.create_parents === true })
      : null;
    if (!resolved || !resolved.ok) return { ok: false, code: "path_outside_workspace" };
    const txnId = newTxnId();
    const abs = resolved.abs, rel = resolved.rel, exists = resolved.exists;
    const maxFile = this.settings["backup.max_file_bytes"];
    let beforeHash = null, beforeSize = null, overQuota = false;
    if (exists) {
      try {
        const st = fs.statSync(abs);
        beforeSize = st.size;
        if (st.size > maxFile) { overQuota = true; beforeHash = null; }
        else beforeHash = sha256File(abs);
      } catch { /* unreadable: hash stays null; the execution leg re-checks */ }
    } else {
      beforeHash = "absent";
    }

    const base = {
      txn_id: txnId, session: params.sessionId, turn: params.turnId, tool_call_id: params.toolCallId,
      tool: toolName, route, workspace_key: this._workspaceKey(), workspace_root: this.rootReal,
      target_rel: rel, target_abs: abs, mutation_kind: mutationKind, before_hash: beforeHash,
      before_size: beforeSize,
      detail: `policy=${decisionSource}` + (overQuota ? " hash_policy=size_exceeds_threshold" : ""),
    };

    // Upstream route: pre-image backup now (permission-side), then prepared.
    if (route === "upstream_event") {
      let backup = null;
      if (exists && !overQuota) {
        const pub = this._publishArtifact(txnId, 1, "pre_image", abs, rel);
        if (!pub.ok) {
          // T3: admitted then refused — fail-closed deny (G1)
          this._txnInsert({ ...base, state: "intent" });
          const txn = this._intentRow(txnId);
          this._terminalTxn(txn, "refused", {
            decision: "deny", result: "backup_failed", risk,
            error_code: "backup_failed", route: "inline",
            detailPrefix: `backup_failed: ${pub.code}`,
          });
          return { ok: false, code: "backup_failed" };
        }
        if (pub.sha256 !== beforeHash) {
          // TOCTOU between read and copy — the artifact is not the promised pre-image
          try { fs.unlinkSync(pub.backupPath); } catch {}
          this._txnInsert({ ...base, state: "intent" });
          const txn = this._intentRow(txnId);
          this._terminalTxn(txn, "refused", {
            decision: "deny", result: "backup_failed", risk,
            error_code: "pre_image_changed", route: "inline",
            detailPrefix: "backup_failed: pre_image_changed",
          });
          return { ok: false, code: "backup_failed" };
        }
        backup = pub;
      }
      this.db.exec("begin immediate");
      try {
        this._txnInsert({ ...base, state: "intent",
          backup_path: backup && backup.backupPath, backup_sha256: backup && backup.sha256,
          backup_generation: backup ? 1 : null });
        this._txnInsert({ txn_id: txnId, session: params.sessionId, turn: params.turnId,
          tool_call_id: params.toolCallId, tool: toolName, route, state: "prepared",
          workspace_key: this._workspaceKey(), workspace_root: this.rootReal,
          target_rel: rel, target_abs: abs, mutation_kind: mutationKind,
          backup_path: backup && backup.backupPath, backup_sha256: backup && backup.sha256,
          backup_generation: backup ? 1 : null,
          verify: overQuota ? "skipped" : null, detail: overQuota ? "hash_policy=size_exceeds_threshold" : null });
        this.db.exec("commit");
      } catch (e) { this.db.exec("rollback"); throw e; }
      return { ok: true, txnId, rel, abs, exists, beforeHash, reversible: !!backup };
    }

    // Inline route: intent only; the execution leg claims it and runs T2–T9.
    this._txnInsert({ ...base, state: "intent" });
    return { ok: true, txnId, rel, abs, exists, beforeHash, reversible: false };
  }

  // The claim ledger (§1.1.5): exactly one unclaimed intent row for
  // (tool, target_rel) inside the window, else fail-closed.
  claimWorkspaceIntent({ toolName, targetRel, callId }) {
    const windowMs = this.settings["write.intent_claim_window_ms"];
    const since = new Date(Date.now() - windowMs).toISOString();
    const rows = this.db.prepare(
      `select * from v_write_txn_latest where tool = ? and target_rel = ? and state = 'intent' and ts >= ? order by id`
    ).all(toolName, targetRel, since);
    this._claimed = this._claimed || new Set();
    const unclaimed = rows.filter((r) => !this._claimed.has(r.txn_id));
    if (unclaimed.length === 0) return { ok: false, code: "ws_intent_unclaimed", detail: "none" };
    if (unclaimed.length > 1) return { ok: false, code: "ws_intent_unclaimed", detail: "ambiguous" };
    const txn = unclaimed[0];
    this._claimed.add(txn.txn_id);
    return { ok: true, txn, callId };
  }

  // The execution leg's [2]–[7] (contract §1.1.5 E). Returns the envelope
  // fields; the caller (workspace-files.cjs) shapes the model-facing result.
  runWorkspaceMutation({ txnId, rel, abs, kind, contentBuffer, expectHash, createParents }) {
    const txn = this._latestTxn(txnId);
    if (!txn || txn.state !== "intent") return { ok: false, code: "ws_intent_unclaimed" };
    const maxFile = this.settings["backup.max_file_bytes"];

    // expect_hash CAS (checked after the claim — R2: always closes the txn)
    if (expectHash !== undefined && expectHash !== null) {
      const cur = fs.existsSync(abs) ? sha256File(abs) : "absent";
      if (cur !== expectHash) {
        this._terminalTxn(txn, "refused", {
          decision: "deny", result: "ws_conflict", error_code: "ws_conflict",
          detailPrefix: "expect_hash mismatch",
        });
        return { ok: false, code: "ws_conflict" };
      }
    }

    // kind preconditions
    const exists = fs.existsSync(abs);
    if (kind === "create" && exists) {
      this._terminalTxn(txn, "refused", { decision: "deny", result: "ws_already_exists", error_code: "ws_already_exists" });
      return { ok: false, code: "ws_already_exists" };
    }
    if (kind === "delete" && !exists) {
      this._terminalTxn(txn, "refused", { decision: "deny", result: "ws_not_found", error_code: "ws_not_found" });
      return { ok: false, code: "ws_not_found" };
    }

    // [2] backup (overwrite/append/delete on an existing target)
    let backup = null, reversible = false, hashPolicy = null;
    if (exists && (kind === "overwrite" || kind === "append" || kind === "delete")) {
      const size = fs.statSync(abs).size;
      if (size > maxFile) {
        hashPolicy = "hash_policy=size_exceeds_threshold";
      } else {
        const pub = this._publishArtifact(txnId, 1, "pre_image", abs, rel);
        if (!pub.ok) {
          this._terminalTxn(txn, "refused", {
            decision: "deny", result: "backup_failed", error_code: "backup_failed",
            detailPrefix: `backup_failed: ${pub.code}`,
          });
          return { ok: false, code: "ws_backup_failed" };
        }
        if (pub.sha256 !== txn.before_hash) {
          try { fs.unlinkSync(pub.backupPath); } catch {}
          this._terminalTxn(txn, "refused", {
            decision: "deny", result: "backup_failed", error_code: "pre_image_changed",
            detailPrefix: "backup_failed: pre_image_changed",
          });
          return { ok: false, code: "ws_conflict", innerCode: "pre_image_changed" };
        }
        backup = pub; reversible = true;
      }
    }

    // [3] prepared
    this._txnInsert({ txn_id: txnId, session: txn.session, turn: txn.turn, tool_call_id: txn.tool_call_id,
      tool: txn.tool, route: txn.route, state: "prepared", workspace_key: txn.workspace_key,
      workspace_root: txn.workspace_root, target_rel: txn.target_rel, target_abs: txn.target_abs,
      mutation_kind: txn.mutation_kind, backup_path: backup && backup.backupPath,
      backup_sha256: backup && backup.sha256, backup_generation: backup ? 1 : null,
      verify: hashPolicy ? "skipped" : null, detail: hashPolicy });

    // [4] execute — one synchronous step, no awaits (§1.3 TOCTOU honesty)
    let performed = false, err = null;
    const tmp = abs + ".wtx-tmp." + txnId;
    try {
      if (kind === "create" || kind === "overwrite") {
        if (createParents) fs.mkdirSync(path.dirname(abs), { recursive: true });
        writeAndFsync(tmp, contentBuffer);
        fs.renameSync(tmp, abs);
      } else if (kind === "append") {
        if (createParents) fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.appendFileSync(abs, contentBuffer);
      } else if (kind === "delete") {
        fs.unlinkSync(abs);
      }
      performed = true;
    } catch (e) {
      err = e;
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    }
    if (!performed) {
      this._terminalTxn(txn, "failed", {
        decision: "allow", result: "failed", error_code: "ws_write_failed",
        detailPrefix: "fs error: " + String(err && err.message || err).slice(0, 200),
      });
      return { ok: false, code: "ws_write_failed", performed: false, verified: false };
    }

    // [5] executed (after_hash in the same tick)
    const nowExists = fs.existsSync(abs);
    const afterHash = kind === "delete" ? "absent" : (nowExists ? sha256File(abs) : "absent");
    const afterSize = kind === "delete" ? null : (nowExists ? fs.statSync(abs).size : null);
    this._txnInsert({ txn_id: txnId, session: txn.session, turn: txn.turn, tool_call_id: txn.tool_call_id,
      tool: txn.tool, route: txn.route, state: "executed", workspace_key: txn.workspace_key,
      workspace_root: txn.workspace_root, target_rel: txn.target_rel, target_abs: txn.target_abs,
      mutation_kind: txn.mutation_kind, after_hash: afterHash,
      before_size: txn.before_size, after_size: afterSize,
      backup_path: backup && backup.backupPath, backup_sha256: backup && backup.sha256,
      backup_generation: backup ? 1 : null });

    // [6] verified — re-read and compare
    const observed = kind === "delete" ? (fs.existsSync(abs) ? "present" : "absent")
      : (fs.existsSync(abs) ? sha256File(abs) : "absent");
    const verified = kind === "delete" ? observed === "absent" : observed === afterHash;
    if (!verified) {
      this._terminalTxn(txn, "failed", {
        decision: "allow", result: "failed", error_code: "ws_verify_failed",
        observed_hash: typeof observed === "string" && observed.length === 64 ? observed : null,
        detailPrefix: "re-read mismatch",
      });
      return { ok: false, code: "ws_verify_failed", performed: true, verified: false, afterHash };
    }
    this._txnInsert({ txn_id: txnId, session: txn.session, turn: txn.turn, tool_call_id: txn.tool_call_id,
      tool: txn.tool, route: txn.route, state: "verified", workspace_key: txn.workspace_key,
      workspace_root: txn.workspace_root, target_rel: txn.target_rel, target_abs: txn.target_abs,
      mutation_kind: txn.mutation_kind, after_hash: afterHash, observed_hash: observed,
      backup_path: backup && backup.backupPath, backup_sha256: backup && backup.sha256,
      backup_generation: backup ? 1 : null });

    // [7] terminal completed + operation row (one transaction)
    const reversibleNow = reversible;
    const opId = this._terminalTxn(txn, "completed", {
      decision: "allow", result: "ok",
      reversible: reversibleNow, backupPath: backup && backup.backupPath,
      verify: hashPolicy ? "skipped" : "content_match",
      detailPrefix: hashPolicy || null,
    });
    return {
      ok: true, txnId, operation: opId, rel, abs,
      created: kind === "create" || (kind === "append" && txn.before_hash === "absent"),
      bytesWritten: contentBuffer ? contentBuffer.length : 0,
      bytesTotal: afterSize, beforeHash: txn.before_hash, afterHash,
      reversible: reversibleNow,
      backup: backup ? { available: true, backupId: txnId + ".1", sha256: backup.sha256, bytes: backup.size }
        : { available: false },
    };
  }

  // ---- backup store v1 (contract §1.9) -------------------------------------

  _backupDir() { return path.join(this.root, "gateway", "backups", "v1"); }

  // verify-then-publish (atomic: same-directory tmp + rename; sidecar last)
  _publishArtifact(txnId, generation, kind, sourceAbs, sourceRel) {
    try {
      const dir = this._backupDir();
      const base = path.join(dir, `${txnId}.${generation}`);
      const buf = fs.readFileSync(sourceAbs);
      const sha = sha256Buf(buf);
      const tmp = base + ".bak.tmp";
      writeAndFsync(tmp, buf);
      const copySha = sha256File(tmp);
      if (copySha !== sha) { try { fs.unlinkSync(tmp); } catch {} return { ok: false, code: "copy_corrupt" }; }
      fs.renameSync(tmp, base + ".bak");
      const meta = {
        version: 1, txn_id: txnId, op_id: null, generation, kind, source_rel: sourceRel,
        sha256: sha, size: buf.length, created_at: new Date().toISOString(),
        workspace_key: this._workspaceKey(),
      };
      const metaTmp = base + ".meta.json.tmp";
      writeAndFsync(metaTmp, JSON.stringify(meta));
      fs.renameSync(metaTmp, base + ".meta.json");
      return { ok: true, backupPath: base + ".bak", metaPath: base + ".meta.json", sha256: sha, size: buf.length };
    } catch (e) {
      return { ok: false, code: String(e && e.code || e).slice(0, 120) };
    }
  }

  _readArtifactVerify(backupPath, expectedSha) {
    try {
      const metaPath = backupPath.replace(/\.bak$/, ".meta.json");
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const sha = sha256File(backupPath);
      if (sha !== meta.sha256 || (expectedSha && sha !== expectedSha)) {
        return { ok: false, code: "backup_integrity_mismatch", expected: expectedSha || meta.sha256, actual: sha };
      }
      return { ok: true, buf: fs.readFileSync(backupPath), meta, sha256: sha };
    } catch (e) {
      return { ok: false, code: fs.existsSync(backupPath) ? "meta_missing" : "backup_missing" };
    }
  }

  // LRU eviction keeping the newest generation per target; pinned = referenced
  // by a non-terminal txn. GC is journaled (gateway:backup_gc).
  _enforceRetention() {
    try {
      const cap = this.settings["backup.cap_bytes"];
      const dir = this._backupDir();
      const metas = [];
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".meta.json")) continue;
        try { metas.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))); } catch {}
      }
      let total = metas.reduce((a, m) => a + (m.size || 0), 0);
      if (total <= cap) return;
      const nonTerminal = new Set(
        this.db.prepare(
          `select distinct txn_id from v_write_txn_latest where state in ('intent','prepared','executed','verified')`
        ).all().map((r) => r.txn_id));
      // newest per target survives unconditionally
      const newestPerTarget = new Map();
      for (const m of metas) {
        const k = m.workspace_key + "/" + m.source_rel;
        const cur = newestPerTarget.get(k);
        if (!cur || m.created_at > cur.created_at) newestPerTarget.set(k, m);
      }
      const evictable = metas
        .filter((m) => !nonTerminal.has(m.txn_id) && !newestPerTarget.has(m.workspace_key + "/" + m.source_rel))
        .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
      const evicted = [];
      for (const m of evictable) {
        if (total <= cap) break;
        const base = path.join(dir, `${m.txn_id}.${m.generation}`);
        for (const p of [base + ".bak", base + ".meta.json"]) {
          try { fs.unlinkSync(p); } catch {}
        }
        total -= m.size || 0;
        evicted.push(`${m.txn_id}.${m.generation}(${m.size}B)`);
      }
      if (evicted.length) {
        this.journal({ tool: "gateway:backup_gc", risk: "READ_ONLY", decision: "allow",
          approval_source: "retention", detail: `evicted ${evicted.join(",")} bytes_left=${total}` });
      }
    } catch {}
  }

  // One artifact per boot is re-hashed (contract §1.9 integrity sweep).
  _sweepOneArtifact() {
    try {
      const dir = this._backupDir();
      const metas = fs.readdirSync(dir).filter((f) => f.endsWith(".meta.json")).sort();
      const f = metas[0];
      if (!f) return;
      const base = path.join(dir, f.slice(0, -".meta.json".length));
      const sha = sha256File(base + ".bak");
      const meta = JSON.parse(fs.readFileSync(base + ".meta.json", "utf8"));
      if (sha !== meta.sha256) {
        this._txnInsert({ txn_id: newTxnId(), route: "sweep", state: "failed",
          error_code: "backup_integrity_mismatch", detail: `sweep artifact ${meta.txn_id}.${meta.generation}`,
          backup_path: base + ".bak", backup_sha256: meta.sha256 });
      }
    } catch {}
  }

  // ---- route (b): upstream completion correlation + Bash after-walk ---------

  completeUpstreamTxn(sessionId, toolCallId, kind) {
    // Bash after-fingerprint (G4)
    if (this._bashBefore) {
      const key = String(toolCallId);
      const b = this._bashBefore.get(key) || (sessionId ? [...this._bashBefore.values()].find((v) => v.sessionId === sessionId) : null);
      if (b) {
        this._bashBefore.delete(key);
        const after = this._workspaceFingerprint();
        if (after && after.sha256 && b.fp.sha256) {
          this.journal({ tool: "gateway:bash_effects", risk: "READ_ONLY", decision: "allow",
            approval_source: "fingerprint", result: after.sha256 === b.fp.sha256 ? "unchanged" : "changed",
            detail: `fp_after=${after.sha256} files=${after.count}` });
        }
      }
    }
    // upstream Write/Edit txn completion (T5–T9 have no live writer; the event
    // carries no post-image → completed with the weakest honest verify)
    const rows = this.db.prepare(
      `select * from v_write_txn_latest where route = 'upstream_event' and state in ('intent','prepared')
       and session is ? and tool_call_id is ? order by id desc`
    ).all(sessionId || null, String(toolCallId || null));
    if (!rows.length) return { ok: false, error: "no matching upstream txn" };
    const txn = rows[0];
    if (kind === "tool_call_result") {
      this._terminalTxn(txn, "completed", {
        decision: "allow", result: "unobserved", verify: "event_reported",
        reversible: !!txn.backup_path, detailPrefix: "event_reported (no post-image on the event)",
      });
      return { ok: true, state: "completed" };
    }
    if (kind === "tool_call_error") {
      this._terminalTxn(txn, "failed", {
        decision: "allow", result: "failed", error_code: "upstream_tool_error",
        detailPrefix: "tool_call_error event",
      });
      return { ok: true, state: "failed" };
    }
    return { ok: false, error: "unknown kind" };
  }

  // ---- startup recovery (contract §2.4) + route-(b) reaper -------------------

  _recoverAtInit() {
    const groups = this.db.prepare(
      `select * from v_write_txn_latest where state in ('intent','prepared','executed','verified') limit 500`
    ).all();
    for (const txn of groups) {
      try { this._recoverTxn(txn); } catch {}
    }
    // T17 reaper: upstream intents past the event deadline
    const deadline = this.settings["write.event_deadline_ms"];
    const cutoff = new Date(Date.now() - deadline).toISOString();
    const stale = this.db.prepare(
      `select * from v_write_txn_latest where route = 'upstream_event'
       and state in ('intent','prepared') and ts < ?`
    ).all(cutoff);
    for (const txn of stale) {
      this._txnInsert({ txn_id: txn.txn_id, session: txn.session, turn: txn.turn,
        tool_call_id: txn.tool_call_id, tool: txn.tool, route: "reap", state: "uncertain",
        workspace_key: txn.workspace_key, workspace_root: txn.workspace_root,
        target_rel: txn.target_rel, target_abs: txn.target_abs, mutation_kind: txn.mutation_kind,
        before_hash: txn.before_hash, detail: "no_tool_result_event" });
      this.journal({ tool: txn.tool, risk: "WRITE", decision: "allow", result: "uncertain",
        beforeHash: txn.before_hash, filesModified: [txn.target_rel],
        detail: `txn=${txn.txn_id} recovery:no_tool_result_event` });
    }
    this._quarantineOrphans();
    this._sweepOneArtifact();
    this._enforceRetention();
  }

  _recoverTxn(txn) {
    const abs = txn.target_abs, kind = txn.mutation_kind;
    const observe = () => {
      if (!fs.existsSync(abs)) return "absent";
      try { return sha256File(abs); } catch { return "unreadable"; }
    };
    let state = null, verify = null, rule = "", result = null;
    if (txn.state === "intent") {
      // T10/T11: the executor was never invoked (invariant) — did the target
      // stay at the recorded pre-image?
      const obs = observe();
      const unchanged = txn.before_hash === "absent" ? obs === "absent" : obs === txn.before_hash;
      if (unchanged) { state = "abandoned"; result = "abandoned"; rule = "pre_image_unchanged"; }
      else { state = "uncertain"; result = "uncertain"; rule = "pre_image_changed_out_of_band"; }
    } else if (txn.state === "prepared") {
      // T12/T13: the mutation may have happened — weakest honest presence check
      const wantPresent = kind !== "delete";
      const obs = observe();
      if (wantPresent ? obs !== "absent" : obs === "absent") {
        state = "completed"; verify = wantPresent ? "presence_match" : "absent_match";
        result = "ok"; rule = "end_state_matches_intent";
      } else { state = "uncertain"; result = "uncertain"; rule = "end_state_mismatch"; }
    } else if (txn.state === "executed" || txn.state === "verified") {
      // T14–T16
      const obs = observe();
      if (obs === txn.after_hash) { state = "completed"; verify = "content_match"; result = "ok"; rule = "hash_match"; }
      else { state = "uncertain"; result = "uncertain"; rule = "hash_mismatch"; }
    }
    if (!state) return;
    this._txnInsert({ txn_id: txn.txn_id, session: txn.session, turn: txn.turn,
      tool_call_id: txn.tool_call_id, tool: txn.tool, route: txn.route, state,
      workspace_key: txn.workspace_key, workspace_root: txn.workspace_root,
      target_rel: txn.target_rel, target_abs: txn.target_abs, mutation_kind: kind,
      before_hash: txn.before_hash, after_hash: txn.after_hash,
      observed_hash: typeof observe() === "string" && observe().length === 64 ? observe() : null,
      backup_path: txn.backup_path, backup_sha256: txn.backup_sha256, backup_generation: txn.backup_generation,
      verify, detail: "recovery:" + rule });
    this.journal({ tool: txn.tool, risk: "WRITE", decision: "allow", result,
      beforeHash: txn.before_hash, afterHash: txn.after_hash, backupPath: txn.backup_path,
      reversible: !!txn.backup_path, filesModified: [txn.target_rel],
      detail: `txn=${txn.txn_id} recovery:${rule}` });
  }

  _quarantineOrphans() {
    try {
      const dir = this._backupDir();
      const q = path.join(dir, "quarantine");
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (f.endsWith(".tmp")) { try { fs.unlinkSync(p); } catch {} continue; }
        if (f.endsWith(".meta.json")) {
          const base = p.slice(0, -".meta.json".length);
          if (!fs.existsSync(base + ".bak")) { try { fs.unlinkSync(p); } catch {} }
        } else if (f.endsWith(".bak")) {
          const base = p.slice(0, -".bak".length);
          if (!fs.existsSync(base + ".meta.json")) {
            try { fs.renameSync(p, path.join(q, f)); } catch {}
          }
        }
      }
    } catch {}
  }

  // Phase 8 §6.3: the primary UI-action writer (called by the bridge from
  // /carrier/respond with the claim-ledger op_id already resolved).
  journalUiAction(row) {
    this.db.prepare(
      `insert into ui_action (ts, session, turn, tool, call_id, op_id, action, tree_id, node_id,
       node_text, args, window_before, window_after, result, verify, verify_detail,
       elapsed_ms, retries, nodes_sent, bytes_sent, truncated, method, notes)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      new Date().toISOString(), row.session || null, row.turn || null, row.tool,
      row.call_id || null, row.op_id ?? null, row.action || null,
      row.tree_id || null, row.node_id || null,
      row.node_text ? String(row.node_text).slice(0, 200) : null,
      row.args ? JSON.stringify(row.args).slice(0, 4000) : null,
      row.window_before || null, row.window_after || null,
      row.result || null, row.verify || null, row.verify_detail || null,
      row.elapsed_ms ?? null, row.retries ?? null,
      row.nodes_sent ?? null, row.bytes_sent ?? null, row.truncated ? 1 : 0,
      row.method || null, row.notes || null,
    );
    return this.db.prepare("select last_insert_rowid() as id").get().id;
  }

  uiView(limit = 100) {
    return this.db.prepare("select * from ui_action order by id desc limit ?").all(limit);
  }

  writesView(limit = 100, state) {
    if (state) {
      return this.db.prepare("select * from v_write_txn_latest where state = ? order by id desc limit ?").all(state, limit);
    }
    return this.db.prepare("select * from v_write_txn_latest order by id desc limit ?").all(limit);
  }

  // ---- rollback protocol (contract §4) --------------------------------------
  // Rollback is itself a Gateway operation whose intent commits BEFORE the
  // restore (standing invariant I7). Replaces the phase-4 direct copy.
  rollback(opId) {
    const denyRow = (code, detail) => {
      this.journal({ tool: "gateway:rollback", risk: "WRITE", decision: "deny",
        approval_source: "host", args: { opId },
        detail: `${code}${detail ? " (" + detail + ")" : ""}` });
      return { ok: false, code };
    };
    const row = this.db.prepare("select * from operation where id = ?").get(opId);
    if (!row) return denyRow("rollback_op_not_found");
    // locate the txn group for this op (v3 rows); legacy rows fall through
    const txn = this.db.prepare(
      "select * from v_write_txn_latest where txn_id in (select distinct txn_id from write_txn where op_id = ?)"
    ).get(opId);
    if (!txn) {
      // legacy pre-v3 row: rollback-eligible only with a backup, after_hash and containment
      if (!row.backup_path || !fs.existsSync(row.backup_path)) return denyRow("rollback_not_reversible", "legacy row without artifact");
      if (!row.after_hash) return denyRow("rollback_precondition_unavailable", "legacy row without after_hash");
      let files = [];
      try { files = JSON.parse(row.files_modified || "[]"); } catch {}
      const target = Array.isArray(files) ? files[0] : files;
      if (!target || typeof target !== "string" || !path.isAbsolute(target)) return denyRow("rollback_not_reversible", "no absolute target");
      const c = containWorkspaceAbsolute(this.rootReal, target, { reservedRoots: [this.storeRoot] });
      if (!c.ok) return denyRow("rollback_containment_refused", c.code);
      const cur = fs.existsSync(c.abs) ? sha256File(c.abs) : "absent";
      if (cur !== row.after_hash) return denyRow("rollback_precondition_failed");
      return this._rollbackRestoreLegacy(row, c);
    }
    if (!["completed", "uncertain"].includes(txn.state)) return denyRow("rollback_not_reversible", `state=${txn.state}`);
    if (txn.workspace_key && txn.workspace_key !== this._workspaceKey()) return denyRow("rollback_workspace_changed");
    const rr = resolveWorkspaceTarget(this.rootReal, txn.target_rel, { reservedRoots: [this.storeRoot] });
    if (!rr.ok) return denyRow("rollback_containment_refused", rr.code);
    const abs = rr.abs, rel = rr.rel;
    const kind = txn.mutation_kind;
    const cur = fs.existsSync(abs) ? sha256File(abs) : "absent";

    // Q7 precondition table
    let action = null;
    if (kind === "create" || kind === "upstream_write" || kind === "upstream_edit") {
      if (txn.after_hash === "absent" || cur === "absent") action = "noop_absent";
      else if (cur === txn.after_hash) action = "delete_created";
      else return denyRow("rollback_precondition_failed");
      // upstream kinds: only treat as create-shaped when the pre-image was absent
      if (kind !== "create" && txn.before_hash !== "absent") {
        if (cur === txn.after_hash) action = "restore_file";
        else if (cur === "absent") return denyRow("rollback_target_missing");
        else return denyRow("rollback_precondition_failed");
      }
    } else if (kind === "delete") {
      if (cur === "absent") action = "restore_file";
      else if (cur === txn.before_hash) action = "noop_at_pre_image";
      else return denyRow("rollback_target_recreated");
    } else { // overwrite / append
      if (!txn.after_hash) return denyRow("rollback_precondition_unavailable");
      if (cur === "absent") return denyRow("rollback_target_missing");
      if (cur !== txn.after_hash) return denyRow("rollback_precondition_failed");
      action = "restore_file";
    }
    if (action === "noop_absent") return { ok: true, noop: "already_absent" };
    if (action === "noop_at_pre_image") return { ok: true, noop: "already_at_pre_image" };

    // step 5: the rollback's own intent — committed BEFORE any mutation (I7)
    const txnId = newTxnId();
    const rollbackKind = action === "delete_created" ? "rollback_delete" : "rollback_restore";
    this._txnInsert({ txn_id: txnId, session: txn.session, tool: "gateway:rollback",
      route: "rollback", state: "intent", ref_op_id: opId,
      workspace_key: this._workspaceKey(), workspace_root: this.rootReal,
      target_rel: rel, target_abs: abs, mutation_kind: rollbackKind,
      before_hash: cur, detail: `rollback of operation ${opId} txn=${txn.txn_id}` });

    // step 6: pre-rollback backup of the current image (G1: failure refuses)
    let preBackup = null;
    if (cur !== "absent") {
      const size = fs.statSync(abs).size;
      if (size <= this.settings["backup.max_file_bytes"]) {
        preBackup = this._publishArtifact(txnId, 1, "pre_rollback", abs, rel);
        if (!preBackup.ok) {
          this._terminalTxn(this._latestTxn(txnId), "refused", {
            decision: "deny", result: "backup_failed", error_code: "backup_failed",
            detailPrefix: `backup_failed: ${preBackup.code}` });
          return { ok: false, code: "rollback_backup_failed" };
        }
      }
    }
    this._txnInsert({ txn_id: txnId, session: txn.session, tool: "gateway:rollback",
      route: "rollback", state: "prepared", ref_op_id: opId,
      workspace_key: this._workspaceKey(), workspace_root: this.rootReal,
      target_rel: rel, target_abs: abs, mutation_kind: rollbackKind, before_hash: cur,
      backup_path: preBackup && preBackup.backupPath, backup_sha256: preBackup && preBackup.sha256,
      backup_generation: preBackup ? 1 : null });

    // step 7: artifact integrity of the ORIGINAL pre-image
    let artifact = null;
    if (action === "restore_file") {
      if (!txn.backup_path) {
        this._terminalTxn(this._latestTxn(txnId), "refused", {
          decision: "deny", result: "rollback_backup_unavailable", error_code: "rollback_backup_unavailable" });
        return { ok: false, code: "rollback_backup_unavailable" };
      }
      if (!fs.existsSync(txn.backup_path)) {
        this._terminalTxn(this._latestTxn(txnId), "refused", {
          decision: "deny", result: "rollback_backup_missing", error_code: "rollback_backup_missing" });
        return { ok: false, code: "rollback_backup_missing" };
      }
      artifact = this._readArtifactVerify(txn.backup_path, txn.backup_sha256);
      if (!artifact.ok) {
        this._terminalTxn(this._latestTxn(txnId), "refused", {
          decision: "deny", result: "rollback_backup_integrity_mismatch", error_code: "rollback_backup_integrity_mismatch",
          detailPrefix: `expected=${artifact.expected || "?"} actual=${artifact.actual || "?"}` });
        return { ok: false, code: "rollback_backup_integrity_mismatch" };
      }
    }

    // step 8: the restore / conditional delete (atomic rename)
    try {
      if (action === "restore_file") {
        const tmp = abs + ".wtx-tmp." + txnId;
        writeAndFsync(tmp, artifact.buf);
        fs.renameSync(tmp, abs);
      } else if (action === "delete_created") {
        fs.unlinkSync(abs);
      }
    } catch (e) {
      this._terminalTxn(this._latestTxn(txnId), "failed", {
        decision: "allow", result: "rollback_write_failed", error_code: "rollback_write_failed",
        detailPrefix: String(e).slice(0, 160) });
      return { ok: false, code: "rollback_write_failed" };
    }

    // steps 9–11: executed → verified → terminal + rolled_back on the original
    const restoredHash = fs.existsSync(abs) ? sha256File(abs) : "absent";
    this._txnInsert({ txn_id: txnId, session: txn.session, tool: "gateway:rollback",
      route: "rollback", state: "executed", ref_op_id: opId,
      workspace_key: this._workspaceKey(), workspace_root: this.rootReal,
      target_rel: rel, target_abs: abs, mutation_kind: rollbackKind,
      before_hash: cur, after_hash: restoredHash,
      backup_path: preBackup && preBackup.backupPath,
      backup_sha256: preBackup && preBackup.sha256,
      backup_generation: preBackup ? 1 : null });
    const wantHash = action === "delete_created" ? "absent" : (artifact && artifact.sha256);
    if (restoredHash !== wantHash) {
      this._terminalTxn(this._latestTxn(txnId), "failed", {
        decision: "allow", result: "rollback_verify_failed", error_code: "rollback_verify_failed" });
      return { ok: false, code: "rollback_verify_failed", target: abs };
    }
    this._txnInsert({ txn_id: txnId, session: txn.session, tool: "gateway:rollback",
      route: "rollback", state: "verified", ref_op_id: opId,
      workspace_key: this._workspaceKey(), workspace_root: this.rootReal,
      target_rel: rel, target_abs: abs, mutation_kind: rollbackKind,
      before_hash: cur, after_hash: restoredHash, observed_hash: restoredHash,
      backup_path: preBackup && preBackup.backupPath,
      backup_sha256: preBackup && preBackup.sha256,
      backup_generation: preBackup ? 1 : null, verify: "content_match" });
    const rbTxn = this._latestTxn(txnId);
    const newOpId = this._terminalTxn(rbTxn, "completed", {
      decision: "allow", result: "ok", reversible: !!preBackup,
      backupPath: preBackup && preBackup.backupPath,
      beforeHash: cur, afterHash: restoredHash, observed_hash: restoredHash,
      verify: "content_match",
      detailPrefix: `rollback of operation ${opId}`, filesModified: [rel],
    });
    this._txnInsert({ txn_id: txn.txn_id, session: txn.session, tool: txn.tool,
      route: txn.route, state: "rolled_back", ref_op_id: newOpId,
      workspace_key: txn.workspace_key, workspace_root: txn.workspace_root,
      target_rel: rel, target_abs: abs, mutation_kind: kind,
      before_hash: txn.before_hash, after_hash: txn.after_hash,
      backup_path: txn.backup_path, backup_sha256: txn.backup_sha256,
      backup_generation: txn.backup_generation,
      detail: `rolled back by txn=${txnId}` });
    return { ok: true, target: abs, afterHash: restoredHash, txnId, operation: newOpId };
  }

  _rollbackRestoreLegacy(row, c) {
    const artifact = this._readArtifactVerify(row.backup_path, row.before_hash);
    if (!artifact.ok) return { ok: false, code: "rollback_backup_integrity_mismatch" };
    const txnId = newTxnId();
    this._txnInsert({ txn_id: txnId, tool: "gateway:rollback", route: "rollback", state: "intent",
      ref_op_id: row.id, workspace_key: this._workspaceKey(), workspace_root: this.rootReal,
      target_rel: c.rel, target_abs: c.abs, mutation_kind: "rollback_restore",
      before_hash: sha256File(c.abs), detail: `legacy rollback of operation ${row.id}` });
    const tmp = c.abs + ".wtx-tmp." + txnId;
    writeAndFsync(tmp, artifact.buf);
    fs.renameSync(tmp, c.abs);
    this.journal({ tool: "gateway:rollback", risk: "WRITE", decision: "allow", approval_source: "host",
      filesModified: [c.rel], beforeHash: row.after_hash, afterHash: sha256File(c.abs),
      backupPath: row.backup_path, reversible: 0, detail: `legacy rollback of operation ${row.id}` });
    return { ok: true, target: c.abs };
  }


  journalView(limit = 50) {
    return this.db.prepare("select * from operation order by id desc limit ?").all(limit);
  }

  pendingView() {
    const out = [];
    if (this._pending) {
      for (const [key, p] of this._pending) {
        out.push({
          requestId: key, toolName: p.params.toolName, risk: p.risk, action: p.action,
          hardConfirm: p.action === "hard_confirm", hits: p.hits,
          urlHost: this._inputUrlHost(p.params.input),
        });
      }
    }
    return out;
  }
}

module.exports = { Gateway, classify, decide, HARD_CONFIRM_PACK, UI_DESTRUCTIVE_VOCAB, resolveWorkspaceTarget, containWorkspaceAbsolute, WORKSPACE_FILE_TOOLS, UPSTREAM_WRITE_TOOLS };
