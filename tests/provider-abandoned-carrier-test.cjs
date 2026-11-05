// Existing Gateway/SQLite plus extracted production cancellation path; no model proof.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const runtime=process.env.TEST_RUNTIME||path.resolve(__dirname,'../../app/src/main/assets/zcode-runtime');
const {Gateway}=require(path.join(runtime,'gateway.cjs'));
const {CarrierAuthorization}=require(path.join(runtime,'carrier-authorization.cjs'));
const source=fs.readFileSync(path.join(runtime,'bootstrap.cjs'),'utf8');
const begin=source.indexOf('function settleAbandonedCarrier('),end=source.indexOf('const { TOOLS: WS_TOOLS',begin);
assert.ok(begin>0&&end>begin);
for(const mode of ['cancel','runtime-exit','session-change','journal-failure','wrong-scope','already-finished','ui-not-owned','provider-timeout']){
 test('abandoned native carrier: '+mode,async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'abandoned-carrier-'));fs.mkdirSync(path.join(root,'workspace'));
  const gateway=new Gateway().init({root,workspace:path.join(root,'workspace'),mode:'ask'});
  try{
   const auth=new CarrierAuthorization(gateway),args={base64:'YQ=='},content='a'.repeat(64),definition='b'.repeat(64);
   gateway.onAsk=key=>gateway.resolveAnswer(key,{decision:'allow'});
   const op=await auth.authorize('fixture_compute',args,'fixture_session');
   let response,cleared=0,logs=[];
   const pending={approvalOpId:op,toolId:'fixture_compute',callArgs:args,sessionId:'fixture_session',
    nativeDispatcher:mode!=='ui-not-owned',providerContentHash:content,providerDefinitionHash:definition,
    timer:'fixture_timer',resolve:value=>{response=value;}};
   if(mode==='wrong-scope')pending.callArgs={base64:'Yg=='};
   if(mode==='already-finished')auth.finish(op,pending.toolId,args,pending.sessionId,'call_first',{ok:false,error:{code:'EARLIER_ERROR'}},content,definition);
   if(mode==='journal-failure')gateway.db.close();
   const state={carrierEpoch:7,carrierPending:new Map([['call_fixture',pending]]),carrierQueue:[{callId:'call_fixture'}]};
   const context={state,carrierAuthorization:auth,clearTimeout:()=>{cleared++;},log:s=>logs.push(s),purgeVisionFrames:()=>{}};
   vm.createContext(context);vm.runInContext(source.slice(begin,end),context);
   const reason=mode==='runtime-exit'?'RUNTIME_EXITED':mode==='session-change'?'SESSION_CHANGED':mode==='provider-timeout'?'CARRIER_TIMEOUT':'CANCELLED';
   if(mode==='provider-timeout')response={body:context.settleAbandonedCarrier('call_fixture',pending,reason)};
   else{
    context.cancelCarrierPending(reason);
    assert.equal(state.carrierPending.size,0);assert.equal(state.carrierQueue.length,0);assert.equal(state.carrierEpoch,8);assert.equal(cleared,1);
   }
   assert.equal(response.body.ok,false);
   if(['journal-failure','wrong-scope','already-finished'].includes(mode)){
    assert.equal(response.body.error.code,'JOURNAL_RESULT_FAILED');assert.equal(logs.length,1);
    if(mode!=='journal-failure')assert.equal(auth.row(op).result,mode==='already-finished'?'EARLIER_ERROR':null);
   }else{
    assert.equal(response.body.error.code,reason);
    const row=auth.row(op);assert.equal(row.result,mode==='ui-not-owned'?null:reason);
    if(mode!=='ui-not-owned'){
     assert.ok(row.detail.includes('call_id=call_fixture '));assert.ok(row.detail.includes('provider_sha256='+content));assert.ok(row.detail.includes('declaration_sha256='+definition));
     assert.throws(()=>auth.finish(op,pending.toolId,args,pending.sessionId,'call_late',{ok:true},content,definition),/GATEWAY_RESULT_UNBOUND/);
    }
   }
  }finally{try{gateway.db.close();}catch{}fs.rmSync(root,{recursive:true,force:true});}
 });
}
