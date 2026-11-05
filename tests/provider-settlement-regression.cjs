// Actual Gateway/SQLite settlement and extracted production responder. No model/device claims.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const runtime = process.env.TEST_RUNTIME || path.resolve(__dirname, '../../app/src/main/assets/zcode-runtime');
const {Gateway} = require(path.join(runtime, 'gateway.cjs'));
const {CarrierAuthorization} = require(path.join(runtime, 'carrier-authorization.cjs'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-settlement-'));
fs.mkdirSync(path.join(root, 'workspace'));
const gateway = new Gateway().init({root, workspace:path.join(root, 'workspace'), mode:'ask'});
const auth = new CarrierAuthorization(gateway);
const hash = 'a'.repeat(64), args = {base64:''}, session = 'fixture';
let checks = 0, prompts = 0;
gateway.onAsk = key => { prompts++; gateway.resolveAnswer(key, {decision:'allow'}); };
const success = tool => ({ok:true, structuredContent:{ok:true, tool, data:{_hostProvider:{contentHash:hash}}}});
async function intent(tool = 'sample_inspect') { return auth.authorize(tool, args, session); }
function finish(id, tool = 'sample_inspect', response = success(tool), expected = hash) {
  return auth.finish(id, tool, args, session, 'call_fixture', response, expected);
}
async function test(name, fn) { await fn(); checks++; console.log('PASS ' + name); }
(async () => {
  await test('unknown provider remains PRIVILEGED and asks; exact successful row completed', async () => {
    const before = prompts, id = await intent();
    assert.equal(prompts, before + 1); assert.equal(auth.row(id).risk, 'PRIVILEGED');
    assert.equal(finish(id), 'ok'); assert.equal(auth.row(id).result, 'ok');
    assert.ok(auth.row(id).detail.includes('provider_sha256=' + hash));
    assert.ok(auth.row(id).detail.includes('call_id=call_fixture'));
  });
  for (const tool of ['device_info_identity', 'text_digest_inspect']) await test(tool + ' existing risk ceiling retained', async () => {
    const before = prompts, id = await intent(tool);
    assert.equal(auth.row(id).risk, tool === 'text_digest_inspect' ? 'READ' : 'PRIVILEGED');
    assert.equal(prompts, before + (tool === 'text_digest_inspect' ? 0 : 1));
    assert.equal(finish(id, tool, success(tool), null), 'ok');
  });
  await test('failed provider call without success provenance records bounded error', async () => {
    const id = await intent();
    assert.equal(finish(id, undefined, {ok:false, structuredContent:{error:{code:'PROVIDER_INTEGRITY_FAILED'}}}), 'PROVIDER_INTEGRITY_FAILED');
  });
  await test('untrusted error detail cannot enter journal result', async () => {
    const id = await intent(); assert.equal(finish(id, undefined, {ok:false, error:{code:'\nsecret detail'}}), 'error');
  });
  for (const kind of ['arguments','session','tool','missing-row','duplicate','pin','invalid-pin','missing-pin','conflicting-ok','conflicting-tool','missing-ok','call-id']) {
    await test('reject ' + kind + ' without overwriting admitted result', async () => {
      const id = await intent(); let op = id, tool = 'sample_inspect', input = args, sid = session,
        response = success(tool), expected = hash, call = 'call_fixture';
      if (kind === 'arguments') input = {base64:'YQ=='};
      if (kind === 'session') sid = 'other';
      if (kind === 'tool') tool = 'other_inspect';
      if (kind === 'missing-row') op = 99999999;
      if (kind === 'duplicate') finish(id);
      if (kind === 'pin') expected = 'b'.repeat(64);
      if (kind === 'invalid-pin') expected = '../invalid';
      if (kind === 'missing-pin') delete response.structuredContent.data._hostProvider;
      if (kind === 'conflicting-ok') response.structuredContent.ok = false;
      if (kind === 'conflicting-tool') response.structuredContent.tool = 'other_inspect';
      if (kind === 'missing-ok') delete response.ok;
      if (kind === 'call-id') call = 'bad\ncall';
      assert.throws(() => auth.finish(op, tool, input, sid, call, response, expected), /GATEWAY_/);
      assert.equal(auth.row(id).result, kind === 'duplicate' ? 'ok' : null);
    });
  }
  await test('SQL compare-and-set refuses row completed between check and commit', async () => {
    const id = await intent(), db = gateway.db;
    gateway.db = {prepare(sql) {
      if (!sql.startsWith('update operation set result')) return db.prepare(sql);
      const statement = db.prepare(sql);
      return {run(...values) { db.prepare('update operation set result=? where id=?').run('prior', id); return statement.run(...values); }};
    }};
    try { assert.throws(() => finish(id), /GATEWAY_RESULT_NOT_COMMITTED/); }
    finally { gateway.db = db; }
    assert.equal(auth.row(id).result, 'prior');
  });
  await test('pending scope comes from registered Dispatcher metadata, not caller metadata; UI stays separate', async () => {
    const source = fs.readFileSync(path.join(runtime, 'bootstrap.cjs'), 'utf8');
    const start = source.indexOf('const nativeDefinition =');
    const end = source.indexOf('if (!nativeWorker &&', start);
    assert.ok(start > 0 && end > start);
    const block = source.slice(start, end);
    for (const kind of ['provider','fixed','ui','invalid','unknown']) {
      const definition = kind === 'unknown' ? null : {toolId:kind === 'ui' ? 'ui_inspect' : 'sample_inspect', metadata:
        kind === 'ui' ? {} : {canonicalToolId:'sample.inspect', ...(kind === 'fixed' ? {} : {providerContentHash:kind === 'invalid' ? '../bad' : hash})}};
      const call = {toolId:definition?.toolId || 'unknown', meta:{providerContentHash:'b'.repeat(64), nativeDispatcher:true}};
      const sends = [];
      const result = vm.runInNewContext('(function(){' + block + '; return {nativeDispatcher,providerContentHash};})()',
        {call, state:{workerTools:definition ? [definition] : []}, send:(...v) => sends.push(v)});
      if (kind === 'invalid') {
        assert.equal(sends.length, 1); assert.equal(sends[0][1].error.code, 'GATEWAY_PROVIDER_PIN_INVALID');
      } else {
        assert.equal(result.nativeDispatcher, ['provider','fixed'].includes(kind));
        assert.equal(result.providerContentHash, kind === 'provider' ? hash : null);
      }
    }
  });
  await test('real responder refuses success on SQLite failure, stale binding, epoch or pin', async () => {
    const source = fs.readFileSync(path.join(runtime, 'bootstrap.cjs'), 'utf8');
    const start = source.indexOf('if (pend.nativeDispatcher)'); assert.ok(start > 0);
    const block = source.slice(start, source.indexOf('// Phase 8 6.3:', start));
    for (const mode of ['success','error','journal-failure','unbound','epoch','pin']) {
      const id = await intent(), replies = [], sends = [], db = gateway.db;
      const response = mode === 'error' ? {ok:false, error:{code:'CANCELLED'}} : success('sample_inspect');
      const pend = {nativeDispatcher:true, toolId:'sample_inspect', approvalOpId:id, callArgs:args,
        sessionId:mode === 'unbound' ? 'other' : session, providerContentHash:mode === 'pin' ? 'b'.repeat(64) : hash,
        epoch:mode === 'epoch' ? 1 : 0, resolve:v => replies.push(v)};
      if (mode === 'journal-failure') gateway.db = {prepare(sql) {
        if (sql.startsWith('update operation set result')) throw Error('injected write failure');
        return db.prepare(sql);
      }};
      try { vm.runInNewContext('(function(){' + block + '})()', {pend, state:{carrierEpoch:0}, carrierAuthorization:auth,
        callId:'call_fixture', ok:response.ok, error:response.error, structuredContent:response.structuredContent,
        send:(...v) => sends.push(v)}); }
      finally { gateway.db = db; }
      if (['success','error'].includes(mode)) {
        assert.equal(replies.length, 0); assert.equal(sends.length, 0);
        assert.equal(auth.row(id).result, mode === 'success' ? 'ok' : 'CANCELLED');
      } else {
        assert.equal(replies.length, 1); assert.equal(sends.length, 1);
        assert.equal(replies[0].body.ok, false); assert.equal(replies[0].body.error.code, 'JOURNAL_RESULT_FAILED');
        assert.equal(auth.row(id).result, null);
      }
    }
  });
  await test('no journal cannot admit provider', async () => {
    const original = gateway.journal;
    gateway.journal = () => {throw Error('no journal');};
    try { await assert.rejects(intent(), /no journal/); } finally { gateway.journal = original; }
  });
  await test('real closed journal cannot finish success', async () => {
    const id = await intent(); gateway.db.close(); assert.throws(() => finish(id), /not open|closed/i);
  });
  console.log('RESULT ' + checks + ' PASS');
})().catch(e => {console.error(e); process.exitCode = 1;}).finally(() => {
  try {gateway.db.close();} catch {} fs.rmSync(root, {recursive:true, force:true});
});
