// Transport admission using the existing Gateway and operation table only.
const crypto = require('node:crypto');
const canonical = value => JSON.stringify(normalize(value));
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, normalize(value[k])]));
  return value;
}
class CarrierAuthorization {
  constructor(gateway, clock = Date.now) {
    this.gateway = gateway; this.clock = clock; this.grants = new Map();
  }
  clear() { this.grants.clear(); }
  row(id) {
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return this.gateway.journalView(500).find(r => r.id === id) || null;
  }
  matches(id, toolId, args, sessionId) {
    const r = this.row(id);
    const recordedAt = Date.parse(r?.ts);
    if (!r || r.decision !== 'allow' || r.tool !== 'mcp__android-host__' + toolId ||
        r.session !== sessionId || r.result || !Number.isFinite(recordedAt) ||
        recordedAt > this.clock() + 2000 || this.clock() - recordedAt > 120000) return false;
    try { return canonical(JSON.parse(r.args)) === canonical(args); } catch { return false; }
  }
  recordBroker(params, permission) {
    const toolId = String(params.toolName || '').replace(/^mcp__android-host__/, '');
    // The visual trio has additional capture/target preflight at execution;
    // its earlier Core grant cannot authorize the enriched execution input.
    if (!String(params.toolName).startsWith('mcp__android-host__') ||
        ['ui_see','ui_tap','ui_screenshot'].includes(toolId) || permission.decision !== 'allow') return;
    if (!this.matches(permission.operationId, toolId, params.input || {}, params.sessionId)) return;
    for (const [id, g] of this.grants) if (this.clock() - g.at > 120000) this.grants.delete(id);
    if (this.grants.size >= 128) this.grants.delete(this.grants.keys().next().value);
    this.grants.set(permission.operationId, {toolId, args:canonical(params.input || {}), sessionId:params.sessionId, at:this.clock()});
  }
  finish(id, toolId, args, sessionId, callId, response, expectedProviderHash = null, expectedDefinitionHash = null) {
    // Finish only the exact admitted intent, in the existing operation table.
    // This does not grant permission or turn an unknown tool into a READ tool.
    if (!this.matches(id, toolId, args, sessionId) ||
        typeof callId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(callId) ||
        typeof response?.ok !== 'boolean') throw Error('GATEWAY_RESULT_UNBOUND');
    const sc = response.structuredContent;
    if (sc?.ok !== undefined && sc.ok !== response.ok) throw Error('GATEWAY_RESULT_CONFLICT');
    if (sc?.tool !== undefined && sc.tool !== toolId) throw Error('GATEWAY_RESULT_CONFLICT');
    if (expectedProviderHash !== null) {
      if (typeof expectedProviderHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedProviderHash))
        throw Error('GATEWAY_PROVIDER_PIN_INVALID');
      // Host-owned provenance is available only after successful dispatch.
      // Early cancellation/integrity errors must still be journalled as errors.
      if (response.ok && sc?.data?._hostProvider?.contentHash !== expectedProviderHash)
        throw Error('GATEWAY_PROVIDER_PIN_MISMATCH');
    }
    if (expectedDefinitionHash !== null) {
      if (expectedProviderHash === null || typeof expectedDefinitionHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDefinitionHash))
        throw Error('GATEWAY_PROVIDER_PIN_INVALID');
      if (response.ok && sc?.data?._hostProvider?.definitionHash !== expectedDefinitionHash)
        throw Error('GATEWAY_PROVIDER_PIN_MISMATCH');
    }
    const r = this.row(id);
    const code = response.error?.code || sc?.error?.code;
    const result = response.ok ? 'ok' :
      (typeof code === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(code) ? code : 'error');
    const detail = 'native_provider_result call_id=' + callId +
      (expectedProviderHash === null ? '' : ' provider_sha256=' + expectedProviderHash) +
      (expectedDefinitionHash === null ? '' : ' declaration_sha256=' + expectedDefinitionHash);
    const finished = this.gateway.db.prepare("update operation set result = ?, detail = coalesce(detail || ' ', '') || ? where id = ? and decision = 'allow' and result is null and tool = ? and session = ? and args = ?")
      .run(result, detail, id, r.tool, r.session, r.args);
    if (finished.changes !== 1) throw Error('GATEWAY_RESULT_NOT_COMMITTED');
    return result;
  }
  async authorize(toolId, args, sessionId, signal) {
    if (!sessionId || !args || typeof args !== 'object' || Array.isArray(args)) throw Error('GATEWAY_INVALID_SCOPE');
    if (signal?.aborted) throw Error('CANCELLED');
    const candidates = [...this.grants].filter(([,g]) => g.toolId === toolId && g.sessionId === sessionId &&
      g.args === canonical(args) && this.clock() - g.at <= 120000);
    if (candidates.length > 1) throw Error('GATEWAY_APPROVAL_AMBIGUOUS');
    let id;
    if (candidates.length === 1) {
      id = candidates[0][0]; this.grants.delete(id); // single use; no replay cache
    } else {
      const requestId = 'carrier_' + crypto.randomUUID();
      let timer, abort;
      const interrupted = new Promise((_, reject) => {
        abort = () => {
          try { this.gateway.timeoutAnswer(requestId); } catch {}
          reject(Error('CANCELLED'));
        };
        signal?.addEventListener('abort', abort, {once:true});
        timer = setTimeout(() => {
          try { this.gateway.timeoutAnswer(requestId); } catch {}
          reject(Error('GATEWAY_TIMEOUT'));
        }, 120000);
      });
      let permission;
      try {
        permission = await Promise.race([interrupted, this.gateway.handlePermission({requestId,
          sessionId, toolName:'mcp__android-host__' + toolId, input:args})]);
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
      if (signal?.aborted) throw Error('CANCELLED');
      if (permission.decision !== 'allow') throw Error('GATEWAY_DENIED');
      id = permission.operationId;
    }
    if (signal?.aborted) throw Error('CANCELLED');
    if (!this.matches(id, toolId, args, sessionId)) throw Error('GATEWAY_INTENT_UNBOUND');
    return id;
  }
}
module.exports = {CarrierAuthorization};
