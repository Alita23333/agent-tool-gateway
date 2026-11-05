// workspace-files.cjs — Phase 8 track 2 bridge-inline workspace file tools
// (contract docs/phases/phase8-workspace-write-contract.md §1.1).
//
// Four WRITE-class host tools exposed through the carrier beside web_search.
// The permission leg (gateway.handlePermission) decides + commits the intent;
// this execution leg validates content, claims the intent, and runs the
// mutation via gateway.runWorkspaceMutation — it NEVER calls handlePermission,
// never classifies and never writes an intent row (§1.1.5).
const path = require("node:path");
const {
  resolveWorkspaceTarget, WORKSPACE_FILE_TOOLS,
} = require("./gateway.cjs");

const WS_MAX_WRITE_BYTES = 1048576;        // decoded content cap (never truncated)
const WS_MAX_ARG_CHARS = 1398168;          // 1398104 (1 MiB base64) + 64
const WS_MAX_PATH_BYTES = 1024, WS_MAX_SEGMENT_BYTES = 255;
const WS_RESERVED_INFIX = ".wtx-tmp";

const SHARED_PROPS = {
  "path": { "type": "string", "description": "Workspace-relative POSIX path, e.g. notes/todo.md. No leading '/', no '..' segment, no backslash, no NUL." },
  "content": { "type": "string", "description": "The file content (utf8 text, or base64 when encoding=base64). Max 1 MiB decoded." },
  "encoding": { "type": "string", "enum": ["utf8", "base64"], "description": "Content encoding. Default utf8. base64 = RFC 4648 standard alphabet with padding." },
  "create_parents": { "type": "boolean", "description": "Create missing parent directories. Default false." },
  "expect_hash": { "type": "string", "description": "Compare-and-swap precondition: the current file's sha256 hex, or the literal \"absent\". Mismatch -> ws_conflict." },
};

function def(toolId, description, required, props) {
  const properties = {};
  for (const k of ["path", "content", "encoding", "create_parents", "expect_hash"]) {
    if (props.includes(k)) properties[k] = SHARED_PROPS[k];
  }
  return {
    toolId,
    description,
    readOnly: false,
    inputSchema: { type: "object", additionalProperties: false, required, properties },
  };
}

const TOOLS = [
  def("workspace_file_create", "Create a new file in the active ZCode workspace. Fails with ws_already_exists if the path exists. Max 1 MiB decoded.", ["path", "content"], ["path", "content", "encoding", "create_parents"]),
  def("workspace_file_overwrite", "Overwrite (upsert) a file in the active workspace. Optional expect_hash compare-and-swap. Max 1 MiB decoded.", ["path", "content"], ["path", "content", "encoding", "create_parents", "expect_hash"]),
  def("workspace_file_append", "Append bytes at EOF; creates the file when absent (result says created:true). Optional expect_hash. Max 1 MiB.", ["path", "content"], ["path", "content", "encoding", "create_parents", "expect_hash"]),
  def("workspace_file_delete", "Delete a file in the active workspace. Fails with ws_not_found when absent. Optional expect_hash.", ["path"], ["path", "expect_hash"]),
];

// ---- validation + decode (E-leg steps 1–2: before the claim, no row) -------
function validateAndDecode(toolId, args) {
  const err = (code, message, extra) => ({ ok: false, error: Object.assign({ code, message }, extra || {}) });
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return err("ws_invalid_input", "arguments must be an object");
  }
  const allowed = new Set(Object.keys(SHARED_PROPS).concat(["content"]));
  for (const k of Object.keys(args)) {
    if (!allowed.has(k)) return err("ws_invalid_input", "unknown field: " + k);
  }
  const needContent = toolId !== "workspace_file_delete";
  if (typeof args.path !== "string" || args.path.length === 0) {
    return err("ws_invalid_input", "path must be a non-empty string");
  }
  if (Buffer.byteLength(args.path) > WS_MAX_PATH_BYTES) return err("ws_invalid_input", "path too long");
  if (args.path.includes(WS_RESERVED_INFIX)) return err("ws_invalid_input", "reserved infix in path");
  if (args.path.includes("\u0000") || /[\u0000-\u001f]/.test(args.path) || args.path.includes("\\")) {
    return err("ws_invalid_input", "path contains forbidden characters");
  }
  if (needContent) {
    if (typeof args.content !== "string") return err("ws_invalid_input", "content must be a string");
    if (args.content.length > WS_MAX_ARG_CHARS) return err("ws_too_large", "content exceeds the argument cap");
  }
  const encoding = args.encoding === undefined ? "utf8" : args.encoding;
  if (!["utf8", "base64"].includes(encoding)) return err("ws_invalid_input", "encoding must be utf8 or base64");
  let contentBuffer = null;
  if (needContent) {
    if (encoding === "base64") {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(args.content)) return err("ws_invalid_input", "malformed base64");
      try { contentBuffer = Buffer.from(args.content, "base64"); }
      catch { return err("ws_invalid_input", "malformed base64"); }
      if (args.content.replace(/={1,2}$/, "").length % 4 === 1) return err("ws_invalid_input", "malformed base64");
    } else {
      contentBuffer = Buffer.from(args.content, "utf8");
    }
    if (contentBuffer.length > WS_MAX_WRITE_BYTES) {
      return err("ws_too_large", "decoded content exceeds " + WS_MAX_WRITE_BYTES + " bytes");
    }
  }
  if (args.expect_hash !== undefined) {
    if (args.expect_hash !== "absent" && !/^[0-9a-f]{64}$/.test(args.expect_hash)) {
      return err("ws_invalid_input", "expect_hash must be 64-hex or \"absent\"");
    }
  }
  if (args.create_parents !== undefined && typeof args.create_parents !== "boolean") {
    return err("ws_invalid_input", "create_parents must be boolean");
  }
  return { ok: true, contentBuffer, expectHash: args.expect_hash, createParents: args.create_parents === true, encoding };
}

const PATH_HINT = "use a workspace-relative path without '..' or a leading '/'";

// The execution-leg handler (§1.1.5 E). gateway = the live Gateway instance.
function handleWorkspaceTool(toolId, args, gateway) {
  const started = Date.now();
  const kind = toolId.slice("workspace_file_".length);
  const envelope = (r) => Object.assign({
    ok: false, tool: toolId, path: (args && args.path) || null, resolvedPath: null,
    operation: null, txnId: null, performed: false, verified: false,
    created: null, bytesWritten: 0, bytesTotal: null,
    beforeHash: null, afterHash: null, reversible: false, backup: null,
    elapsedMs: Date.now() - started, error: null,
  }, r);

  // 1. schema + caps + decode — before the claim, no journal row (WW2)
  const v = validateAndDecode(toolId, args);
  if (!v.ok) return envelope({ error: v.error });

  // 2. resolve (TOCTOU re-check; the permission leg already resolved once)
  const r = resolveWorkspaceTarget(gateway.rootReal, args.path, {
    reservedRoots: [gateway.storeRoot], createParents: v.createParents,
  });
  if (!r.ok) {
    return envelope({ error: { code: "ws_path_outside_workspace", message: "path escapes the workspace root", innerCode: r.code, hint: PATH_HINT } });
  }
  // kind-specific resolver gaps the generic resolver cannot express
  if ((kind === "create" || kind === "overwrite" || kind === "append") && !r.exists && !v.createParents) {
    const parent = path.dirname(r.abs);
    if (!fs_exists(parent) || !fs_isDir(parent)) {
      return envelope({ error: { code: "ws_parent_missing", message: "parent directory does not exist", hint: "pass create_parents:true" } });
    }
  }

  // 3. claim exactly one intent row (fail-closed)
  // the intent row's tool column carries the FULL model-visible name the
  // permission leg journaled — claim with the same name domain
  const claim = gateway.claimWorkspaceIntent({ toolName: "mcp__android-host__" + toolId, targetRel: r.rel, callId: null });
  if (!claim.ok) {
    return envelope({ error: { code: claim.code, message: "could not claim exactly one intent row", detail: claim.detail } });
  }

  // 4. run the mutation (T2–T9 inside the gateway)
  const res = gateway.runWorkspaceMutation({
    txnId: claim.txn.txn_id, rel: r.rel, abs: r.abs, kind,
    contentBuffer: v.contentBuffer, expectHash: v.expectHash, createParents: v.createParents,
  });
  if (!res.ok) {
    return envelope({ error: { code: res.code, message: res.message || ("mutation " + kind + " failed"), innerCode: res.innerCode || undefined } });
  }
  return envelope({
    ok: true, resolvedPath: r.abs, operation: res.operation, txnId: res.txnId,
    performed: true, verified: true, created: res.created,
    bytesWritten: res.bytesWritten, bytesTotal: res.bytesTotal,
    beforeHash: res.beforeHash, afterHash: res.afterHash,
    reversible: res.reversible, backup: res.backup,
  });
}

// tiny fs guards kept local so the module only needs node builtins
const fs = require("node:fs");
function fs_exists(p) { try { fs.statSync(p); return true; } catch { return false; } }
function fs_isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

module.exports = {
  TOOLS, WORKSPACE_FILE_TOOLS, handleWorkspaceTool,
  WS_MAX_WRITE_BYTES, WS_MAX_ARG_CHARS, WS_RESERVED_INFIX,
};
