// Real existing Gateway/SQLite boundary; no model or provider process execution.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const runtime=process.env.TEST_RUNTIME||path.resolve(__dirname,'../../app/src/main/assets/zcode-runtime');
const {Gateway}=require(path.join(runtime,'gateway.cjs'));
const {CarrierAuthorization}=require(path.join(runtime,'carrier-authorization.cjs'));
for(const mode of ['match','wrong-definition','missing-definition','invalid-definition','definition-without-content','cancelled']) {
  test('declaration settlement: '+mode,async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'declaration-settlement-'));
    fs.mkdirSync(path.join(root,'workspace'));
    const gateway=new Gateway().init({root,workspace:path.join(root,'workspace'),mode:'ask'});
    try {
      const auth=new CarrierAuthorization(gateway),content='a'.repeat(64),declaration='b'.repeat(64),args={base64:''};
      let prompts=0;
      gateway.onAsk=id=>{prompts++;gateway.resolveAnswer(id,{decision:'allow'});};
      const id=await auth.authorize('fixture_compute',args,'session_fixture');
      assert.equal(prompts,1);assert.equal(auth.row(id).risk,'PRIVILEGED');
      const response=mode==='cancelled'?{ok:false,error:{code:'CANCELLED'}}:
        {ok:true,structuredContent:{ok:true,tool:'fixture_compute',data:{_hostProvider:{contentHash:content,
          ...(mode==='missing-definition'?{}:{definitionHash:mode==='wrong-definition'?'c'.repeat(64):declaration})}}}};
      const finish=()=>auth.finish(id,'fixture_compute',args,'session_fixture','call_fixture',response,
        mode==='definition-without-content'?null:content,mode==='invalid-definition'?'invalid':declaration);
      if(['match','cancelled'].includes(mode)) {
        assert.equal(finish(),mode==='match'?'ok':'CANCELLED');
        const row=auth.row(id);assert.equal(row.result,mode==='match'?'ok':'CANCELLED');
        assert.ok(row.detail.includes('provider_sha256='+content));
        assert.ok(row.detail.includes('declaration_sha256='+declaration));
        assert.throws(finish,/GATEWAY_RESULT_UNBOUND/);
      } else {
        assert.throws(finish,/GATEWAY_PROVIDER_PIN_(INVALID|MISMATCH)/);
        assert.equal(auth.row(id).result,null);
      }
    } finally {gateway.db.close();fs.rmSync(root,{recursive:true,force:true});}
  });
}
