const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'), lab=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-archive-'));
let failed=false;
try {
 const rt=path.join(lab,'runtime');fs.cpSync(path.join(root,'runtime'),rt,{recursive:true});
 fs.copyFileSync(path.join(root,'integration-fixtures/bootstrap.cjs'),path.join(rt,'bootstrap.cjs'));
 const env={...process.env,TEST_RUNTIME:rt,SPIKE_ROOT:lab,TMPDIR:lab};
 for(const [file,test] of [['gateway-unittest.cjs',false],['wws-unittest.cjs',false],['provider-settlement-regression.cjs',false],['provider-declaration-settlement-test.cjs',true],['provider-abandoned-carrier-test.cjs',true]]) {
  console.log('SUITE '+file);const result=cp.spawnSync(process.execPath,[...(test?['--test']:[]),path.join(__dirname,file)],{env,encoding:'utf8'});
  process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');if(result.status!==0){failed=true;break;}
 }
} finally {fs.rmSync(lab,{recursive:true,force:true});}
process.exitCode=failed?1:0;
