// wws-unittest.cjs — Phase 8 track 2 desktop unit suite (workspace-write
// contract lifecycle). Runs against a temp lab with the real gateway.cjs +
// workspace-files.cjs; exit 0 = green. The on-device WW matrix lives in
// verify-phase8.sh; this is the deterministic core it re-asserts.
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execSync } = require("node:child_process");

// runtime discovery: on a DEVICE SPIKE_ROOT points at app files/ whose
// runtime/ already holds the real modules (use in place, lab stays throwaway);
// on desktop the modules are copied from the repo tree as before.
// lab location: os.tmpdir() is the TERMUX /usr/tmp on the device libnode
// (EACCES measured) — inside SPIKE_ROOT (app files/) when running on-device
const onDevice = fs.existsSync(path.join(process.env.SPIKE_ROOT || ".", "runtime", "gateway.cjs"));
// mkdtemp is patched in the TERMUX libnode build (lstat $PREFIX → EACCES,
// measured on device) — a plain named dir under files/ works everywhere
const labBase = onDevice ? process.env.SPIKE_ROOT : os.tmpdir();
const LAB = path.join(labBase, "p8wws-lab");
fs.rmSync(LAB, { recursive: true, force: true });
fs.mkdirSync(LAB, { recursive: true });
const WS = path.join(LAB, "workspaces", "default");
fs.mkdirSync(WS, { recursive: true });
const SPIKE = process.env.SPIKE_ROOT || "";
let RT;
if (fs.existsSync(path.join(SPIKE, "runtime", "gateway.cjs"))) {
  RT = path.join(SPIKE, "runtime");
} else {
  RT = path.join(LAB, "runtime");
  fs.mkdirSync(RT, { recursive: true });
  const SRC = path.join(__dirname, "..", "spike", "poc-app", "app", "src", "main");
  for (const f of ["gateway.cjs", "workspace-files.cjs"]) {
    fs.copyFileSync(path.join(SRC, "assets", "runtime", f), path.join(RT, f));
  }
}

const { Gateway, resolveWorkspaceTarget, containWorkspaceAbsolute } = require(path.join(RT, "gateway.cjs"));
const { TOOLS, handleWorkspaceTool } = require(path.join(RT, "workspace-files.cjs"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("OK   " + name); }
  else { fail++; console.log("FAIL " + name + (detail !== undefined ? " — " + JSON.stringify(detail)?.slice(0, 220) : "")); }
}

const g = new Gateway().init({ root: LAB, workspace: WS, mode: "full" }); // full → WRITE auto
const rootReal = g.rootReal;

// ---- W-T2.2 resolver vectors (E5 shape + R3) ------------------------------
check("resolver rejects traversal", !resolveWorkspaceTarget(rootReal, "a/../../x").ok);
check("resolver rejects absolute", resolveWorkspaceTarget(rootReal, "/etc/passwd").code === "path_absolute_rejected");
check("resolver rejects backslash", resolveWorkspaceTarget(rootReal, "a\\..\\x").code === "path_backslash_rejected");
check("resolver rejects multi-level missing (no flag)", resolveWorkspaceTarget(rootReal, "d1/d2/f.txt").code === "path_parent_missing");
check("resolver allows multi-level missing with createParents", resolveWorkspaceTarget(rootReal, "d1/d2/f.txt", { createParents: true }).ok === true);
check("resolver rejects reserved store", resolveWorkspaceTarget(rootReal, "../../gateway/journal.sqlite").code === "path_traversal_rejected");
fs.writeFileSync(path.join(WS, "keep.txt"), "x");
check("resolver accepts existing file", resolveWorkspaceTarget(rootReal, "keep.txt").exists === true);
check("contain absolute inside", containWorkspaceAbsolute(rootReal, path.join(rootReal, "keep.txt")).ok === true);
// on-device os.tmpdir() is the TERMUX prefix (EACCES on realpath) — use a
// real path outside the workspace that the app can still stat
const OUTSIDE = path.join(path.dirname(rootReal), "outside-p8.txt");
check("contain absolute outside", containWorkspaceAbsolute(rootReal, OUTSIDE).ok === false);

// ---- journal v3 migration (fresh + existing rows) --------------------------
check("user_version is 3", g.db.prepare("pragma user_version").get().user_version === 3);
check("write_txn table exists", !!g.db.prepare("select name from sqlite_master where name='write_txn'").get());

// ---- the two legs: inline tools end-to-end --------------------------------
g.commitIntent({ params: { toolName: "workspace_file_create", sessionId: "s1" }, input: { path: "notes/a.md", create_parents: true, resolved_path: path.join(rootReal, "notes/a.md") }, risk: "WRITE" });
const create = handleWorkspaceTool("workspace_file_create", { path: "notes/a.md", content: "# hello\n", create_parents: true }, g);
if (!create.ok) console.log("CREATE-ERR:", JSON.stringify(create.error));
check("create ok", create.ok === true, create);
check("create envelope fields", create.txnId?.startsWith("wtx_") && create.created === true && create.afterHash?.length === 64 && create.performed && create.verified, create);
const rows1 = g.writesView(10).filter((t) => t.txn_id === create.txnId);
check("create txn terminal completed", rows1[0]?.state === "completed" && rows1[0]?.verify === "content_match", rows1[0]);
const opRows = g.journalView(5);
check("create operation row at terminal (full model-visible name)", opRows.some((r) => (r.tool || "").endsWith("__workspace_file_create") && r.result === "ok" && r.detail?.includes("txn=" + create.txnId)), opRows[0]);
check("create file content", fs.readFileSync(path.join(WS, "notes/a.md"), "utf8") === "# hello\n");

// create again -> ws_already_exists (intent committed by permission leg is
// simulated by a direct commitIntent, as the full/auto path does)
const intentAgain = g.commitIntent({ params: { toolName: "workspace_file_create", sessionId: "s1" }, input: { path: "notes/a.md", resolved_path: path.join(rootReal, "notes/a.md") }, risk: "WRITE" });
check("second create intent committed", intentAgain.ok === true);
const createAgain = handleWorkspaceTool("workspace_file_create", { path: "notes/a.md", content: "x" }, g);
check("second create refused ws_already_exists", createAgain.ok === false && createAgain.error?.code === "ws_already_exists", createAgain.error);
check("second create txn refused + deny row", g.writesView(10).some((t) => t.txn_id === intentAgain.txnId && t.state === "refused" && t.error_code === "ws_already_exists"));

// overwrite with backup + rollback
const owIntent = g.commitIntent({ params: { toolName: "workspace_file_overwrite", sessionId: "s1" }, input: { path: "notes/a.md", resolved_path: path.join(rootReal, "notes/a.md") }, risk: "WRITE" });
const ow = handleWorkspaceTool("workspace_file_overwrite", { path: "notes/a.md", content: "# world\n" }, g);
check("overwrite ok + reversible + backup descriptor", ow.ok === true && ow.reversible === true && ow.backup?.available === true && ow.backup?.sha256?.length === 64, ow);
check("overwrite before/after hashes", ow.beforeHash === create.afterHash && ow.afterHash !== ow.beforeHash);
const bak = ow.backup && fs.existsSync(path.join(LAB, "gateway", "backups", "v1", ow.txnId + ".1.bak"));
check("backup artifact + sidecar on disk", bak === true);

// expect_hash CAS (R2: closes the txn, writes deny row)
const casIntent = g.commitIntent({ params: { toolName: "workspace_file_overwrite", sessionId: "s1" }, input: { path: "notes/a.md", resolved_path: path.join(rootReal, "notes/a.md") }, risk: "WRITE" });
const cas = handleWorkspaceTool("workspace_file_overwrite", { path: "notes/a.md", content: "z", expect_hash: "0".repeat(64) }, g);
check("expect_hash mismatch -> ws_conflict", cas.ok === false && cas.error?.code === "ws_conflict", cas.error);
const casTxn = g.writesView(10).find((t) => t.txn_id === casIntent.txnId);
check("conflict txn refused (R2)", casTxn?.state === "refused" && casTxn?.error_code === "ws_conflict", casTxn);
check("conflict deny operation row", g.journalView(3).some((r) => r.decision === "deny" && r.result === "ws_conflict"));

// append creates when absent + reports created
g.commitIntent({ params: { toolName: "workspace_file_append", sessionId: "s1" }, input: { path: "log/l.txt", create_parents: true, resolved_path: path.join(rootReal, "log/l.txt") }, risk: "WRITE" });
const ap = handleWorkspaceTool("workspace_file_append", { path: "log/l.txt", content: "line1\n", create_parents: true }, g);
if (!ap.ok) console.log("AP-ERR:", JSON.stringify(ap.error));
check("append creates + create_parents", ap.ok === true && ap.created === true && ap.beforeHash === "absent", ap);

// ---- rollback protocol (§4) ------------------------------------------------
// rollback the overwrite: current image must equal its after_hash
const owOp = g.db.prepare("select id from operation where tool like '%workspace_file_overwrite' and result = 'ok' order by id desc limit 1").get();
const rb1 = g.rollback(owOp.id);
check("rollback overwrite ok", rb1.ok === true && rb1.code === undefined, rb1);
check("rollback restored content", fs.readFileSync(path.join(WS, "notes/a.md"), "utf8") === "# hello\n");
const rbTxnRows = g.db.prepare("select * from write_txn where state = 'rolled_back'").all();
check("rolled_back appended to original txn", rbTxnRows.length >= 1);

// rollback the create (delete_created): content still the created bytes
fs.writeFileSync(path.join(WS, "notes/a.md"), "# hello\n");
const crOp = g.db.prepare("select id from operation where tool like '%workspace_file_create' and result = 'ok' order by id limit 1").get();
const sha = require("node:crypto").createHash("sha256").update("# hello\n").digest("hex");
const rb2 = g.rollback(crOp.id);
check("rollback create -> delete_created", rb2.ok === true && !fs.existsSync(path.join(WS, "notes/a.md")), rb2);

// precondition failure: edit after the op, then rollback refuses
fs.writeFileSync(path.join(WS, "log/l.txt"), "line1\nline2-edited\n");
const apOp = g.db.prepare("select id from operation where tool like '%workspace_file_append' and result = 'ok' order by id desc limit 1").get();
const rb3 = g.rollback(apOp.id);
check("rollback refuses when edited later", rb3.ok === false && rb3.code === "rollback_precondition_failed", rb3);
const denyRoll = g.journalView(3).find((r) => r.tool === "gateway:rollback" && r.decision === "deny");
check("rollback refusal journaled", !!denyRoll === true);

fs.writeFileSync(path.join(WS, "del-target.txt"), "to-be-deleted");
const delIntent = g.commitIntent({ params: { toolName: "workspace_file_delete", sessionId: "s1" }, input: { path: "del-target.txt", resolved_path: path.join(rootReal, "del-target.txt") }, risk: "WRITE" });
const del = handleWorkspaceTool("workspace_file_delete", { path: "del-target.txt" }, g);
check("delete ok", del.ok === true && del.afterHash === "absent" && del.reversible === true, del);

// ---- upstream route (R1): permission-leg backup + route-b completion ------
fs.writeFileSync(path.join(WS, "up.txt"), "upstream-before");
const upIntent = g.commitIntent({ params: { toolName: "Write", sessionId: "sup1", toolCallId: "tc1" }, input: { path: "up.txt", resolved_path: path.join(rootReal, "up.txt") }, risk: "WRITE" });
check("upstream intent ok", upIntent.ok === true, upIntent);
const upTxns = g.db.prepare("select * from write_txn where txn_id = ? order by id").all(upIntent.txnId);
check("upstream intent+prepared in permission leg with backup (R1)",
  upTxns.length === 2 && upTxns[0].state === "intent" && upTxns[1].state === "prepared" && !!upTxns[0].backup_path === true,
  upTxns.map((t) => t.state));
const done = g.completeUpstreamTxn("sup1", "tc1", "tool_call_result");
check("route-b completion unobserved", done.ok === true);
const upTerm = g.writesView(5).find((t) => t.txn_id === upIntent.txnId);
check("upstream terminal completed/event_reported", upTerm?.state === "completed" && upTerm?.verify === "event_reported", upTerm);
check("upstream op row result unobserved", g.journalView(3).some((r) => r.result === "unobserved"));

// ---- recovery (§2.4): simulate crash states, re-init, verify terminal ------
// build: intent row whose target is unchanged -> abandoned
const abTxn = g.commitIntent({ params: { toolName: "workspace_file_overwrite", sessionId: "rc1" }, input: { path: "keep.txt", resolved_path: path.join(rootReal, "keep.txt") }, risk: "WRITE" });
// prepared row whose target changed as the intent wanted (simulate by manual insert)
const pTxn = newTxnProbe(g, "prepared", "notes/r.txt", "overwrite", "absent");
fs.writeFileSync(path.join(WS, "notes/r.txt"), "recovered");
const g2 = new Gateway().init({ root: LAB, workspace: WS, mode: "full" });
const abAfter = g2.writesView(50).find((t) => t.txn_id === abTxn.txnId);
check("recovery: unchanged intent -> abandoned", abAfter?.state === "abandoned", abAfter);
const pAfter = g2.writesView(50).find((t) => t.txn_id === pTxn);
check("recovery: prepared matching end state -> completed (weak verify)", pAfter?.state === "completed" && ["presence_match", "absent_match"].includes(pAfter.verify), pAfter);
check("recovery rows marked", g2.journalView(5).some((r) => r.detail?.includes("recovery:")));

// ---- migration from a real v2 journal --------------------------------------
const LAB2 = path.join(labBase, "p8wws2-lab");
fs.rmSync(LAB2, { recursive: true, force: true });
fs.mkdirSync(LAB2, { recursive: true });
const WS2 = path.join(LAB2, "workspaces", "default");
fs.mkdirSync(WS2, { recursive: true });
fs.mkdirSync(path.join(LAB2, "gateway"), { recursive: true });
{
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(LAB2, "gateway", "journal.sqlite"));
  db.exec(`create table operation (id integer primary key autoincrement, ts text not null, session text, task text, tool text, args text,
    provider text, capability text, risk text, mode text, decision text, approval_source text, rule_hits text, hard_confirm integer,
    result text, files_modified text, before_hash text, after_hash text, backup_path text, reversible integer, detail text);
    insert into operation (ts, tool, decision) values ('2026-01-01', 'Write', 'allow');
    pragma user_version = 2;`);
  db.close();
}
const g3 = new Gateway().init({ root: LAB2, workspace: WS2, mode: "full" });
check("v2 -> v3 keeps rows + bumps version", g3.db.prepare("pragma user_version").get().user_version === 3
  && g3.db.prepare("select count(*) c from operation").get().c === 1);

// ---- tool surface sanity ----------------------------------------------------
check("four tools defined readOnly:false", TOOLS.length === 4 && TOOLS.every((t) => t.readOnly === false));
check("schemas additionalProperties:false", TOOLS.every((t) => t.inputSchema.additionalProperties === false));

function newTxnProbe(gw, state, rel, kind, beforeHash) {
  const txnId = "wtx_probe_" + Math.random().toString(36).slice(2, 8);
  gw._txnInsert({ txn_id: txnId, session: "rc1", tool: "workspace_file_" + (kind === "delete" ? "delete" : "overwrite"),
    route: "inline", state, workspace_key: gw._workspaceKey(), workspace_root: gw.rootReal,
    target_rel: rel, target_abs: path.join(gw.rootReal, rel), mutation_kind: kind, before_hash: beforeHash });
  return txnId;
}

console.log("RESULT: PASS=" + pass + " FAIL=" + fail);
process.exit(fail === 0 ? 0 : 1);
