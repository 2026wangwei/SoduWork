'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const rules = require('../main/access-control/policy');
const catalog = require('../main/agent-runtime/runtime-catalog');
const { createRunnerRuntimeAdapter, getRunnerSessionDetails } = require('../main/agent-runtime/runner-adapter');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let n = 0; n < 400; n++) { if (check()) return; await delay(10); } throw Error('Timed out'); }

async function fixture(t, adapterId='qwen', { pendingRestore=false, mismatch=false, fail=false,
  mode='readonly', effective='current-turn' }={}) {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-runner-live-'));
  const capability={schema:rules.SCHEMA,supported:true,modes:[...rules.MODES],canChangeDuringSession:true,changeTakesEffect:effective};
  let policy=rules.create(mode,cwd), pending=pendingRestore ? rules.next('standard',cwd,policy,1) : null;
  let status='done', permissions=[], release=null, pollRelease=null, pollEntered=null;
  const calls=[];
  const adapter=createRunnerRuntimeAdapter({runtimeSpec:catalog.runtime(adapterId),
    modelConfig:{fetchModel:async()=>({ok:true,model:{id:'fixture',key:'fixture'}})},
    runnerRuntime:{async rpc(op,payload,timeout){
      calls.push({op,payload,timeout});
      if(op==='runtime.detect')return{ok:true,data:{accessControl:capability}};
      if(op==='job.session'){
        const reply={ok:true,data:{status,accessPolicy:policy,nextAccessPolicy:pending,accessControl:capability,items:[],pendingPermissions:permissions}};
        if(pollRelease){pollEntered?.();await pollRelease;}
        return reply;
      }
      if(op==='job.comment'){policy=payload.cfg.accessPolicy;status='running';return{ok:true,data:{ok:true}};}
      if(op==='job.access'){
        assert.equal(payload.applyDuringTurn,effective==='current-turn');
        if(release)await release;
        if(fail)return{ok:false,data:{ok:false,error:'No safe native resume'}};
        if(effective==='next-turn')pending=payload.accessPolicy;
        else if(!mismatch){policy=payload.accessPolicy;pending=null;permissions=[];}
        return{ok:true,data:{ok:true,effective,accessPolicy:policy,nextAccessPolicy:pending,
          appliedAccessPolicy:{...policy,state:'applied'},pendingPermissions:permissions}};
      }
      if(op==='job.permission'){permissions=[];return{ok:true,data:{ok:true}};}
      if(op==='job.stop'){status='stopped';return{ok:true,data:{ok:true}};}
      throw Error(op);
    }}});
  const session=await adapter.resumeSession({native:{runner:{openOptions:{ref:'live-'+adapterId,resumePath:'same-run',cwd}}}});
  const handle=getRunnerSessionDetails(session).handle;
  t.after(async()=>{await session.dispose();fs.rmSync(cwd,{recursive:true,force:true});});
  await until(()=>handle.snapshot().accessControl.canChangeDuringSession);
  return{cwd,session,handle,calls,setStatus:value=>{status=value;},setPending:value=>{pending=value;},
    setPermission:()=>{permissions=[{requestId:'command',policyRevision:1,action:'command.execute'}];},
    holdPoll:()=>{let resolve;const entered=new Promise(r=>{pollEntered=r;});pollRelease=new Promise(r=>{resolve=r;});return{entered,release:()=>{pollRelease=null;resolve();}};},
    hold:()=>{let resolve;release=new Promise(r=>{resolve=r;});return resolve;}};
}

for (const effective of ['current-turn', 'next-turn']) {
  test('Runner preserves the requirement completion when full access applies ' + effective, async t => {
    const f = await fixture(t, 'opencode', {mode:'standard', effective});
    const receipts = [];
    const turn = f.handle.submit('Write a report', [], {taskId:'issue', afterTurn:status=>receipts.push(status)});
    await until(()=>f.calls.some(row=>row.op==='job.comment'));
    f.setPermission();
    await until(()=>f.handle.snapshot().pendingPermissions?.length);
    const before = f.handle.snapshot().accessPolicy;
    const change = await f.handle.setAccessPolicy(rules.next('full',f.cwd,before,before.revision),before.revision);
    assert.deepEqual(change,{ok:true,effective});
    if (effective === 'next-turn') {
      assert.equal(f.handle.snapshot().accessPolicy.mode,'standard');
      const pending = f.handle.snapshot().pendingPermissions[0];
      assert.equal((await f.handle.answerUi({...pending,decision:'once'})).ok,true);
    }
    fs.writeFileSync(path.join(f.cwd,'report.md'),'# Completed report');
    f.setStatus('done');
    const result = await turn.completion;
    assert.deepEqual(receipts,['completed']);
    assert.equal(result.snapshot.status,'idle');
    assert.ok(result.ok && !result.cancelled);
    assert.equal(f.calls.filter(row=>row.op==='job.comment').length,1);
    assert.equal(f.calls.some(row=>row.op==='job.stop'),false);
  });
}

test('Runner refuses an implicit plugin repair after an access change and releases the active turn', async t => {
  const f = await fixture(t, 'opencode', {mode:'standard'});
  const receipts = [];
  const turn = f.handle.submit('Generate a plugin', [], {taskId:'issue', afterTurn:status=>receipts.push(status)});
  await until(()=>f.calls.some(row=>row.op==='job.comment'));
  const policy = f.handle.snapshot().accessPolicy;
  await f.handle.setAccessPolicy(rules.next('full',f.cwd,policy,policy.revision),policy.revision);
  fs.writeFileSync(path.join(f.cwd,'soduwork-plugin-draft.json'),'{invalid JSON');
  f.setStatus('done');
  const result = await turn.completion;
  assert.equal(result.ok,false);
  assert.equal(result.failureKind,'plugin-repair');
  assert.equal(result.snapshot.status,'unreachable');
  assert.equal(f.handle.inFlight(),false);
  assert.deepEqual(receipts,['failed']);
  assert.equal(f.calls.filter(row=>row.op==='job.comment').length,1);
});

for(const id of ['qwen','codex-harness','opencode'])test(id+' applies confirmed current-turn policy without replaying user prompt',async t=>{
  const f=await fixture(t,id);
  let completed=false;
  const turn=f.session.send({text:'original user task'});
  turn.completion.then(()=>{completed=true;});
  await until(()=>f.calls.some(row=>row.op==='job.comment'));
  const release=f.hold();
  const change=f.handle.setAccessPolicy(rules.next('full',f.cwd,f.handle.snapshot().accessPolicy,1),1);
  await until(()=>f.calls.some(row=>row.op==='job.access'));
  assert.equal(f.handle.snapshot().accessPolicy.mode,'readonly');
  assert.equal(completed,false);
  release();
  assert.deepEqual(await change,{ok:true,effective:'current-turn'});
  assert.equal(f.handle.snapshot().accessPolicy.mode,'full');
  assert.equal(f.handle.snapshot().accessPolicy.revision,2);
  assert.equal(f.handle.snapshot().nextAccessPolicy,null);
  assert.equal(f.calls.filter(row=>row.op==='job.comment').length,1);
  assert.equal(completed,false);
  f.setStatus('done');await turn.completion;
});

test('new Runner applies restored pending choice immediately and clears pending state',async t=>{
  const f=await fixture(t,'qwen',{pendingRestore:true});
  assert.equal(f.handle.snapshot().accessPolicy.mode,'standard');
  assert.equal(f.handle.snapshot().accessPolicy.revision,3);
  assert.equal(f.handle.snapshot().nextAccessPolicy,null);
  assert.equal(f.calls.filter(row=>row.op==='job.access').length,1);
  assert.equal(f.calls.filter(row=>row.op==='job.comment').length,0);
});

for(const option of ['mismatch','fail'])test('Runner '+option+' never reports an unconfirmed new policy',async t=>{
  const f=await fixture(t,'qwen',{[option]:true});
  const changed=await f.handle.setAccessPolicy(rules.next('full',f.cwd,f.handle.snapshot().accessPolicy,1),1);
  assert.equal(changed.ok,false);
  assert.equal(f.handle.snapshot().accessPolicy.mode,'readonly');
  assert.equal(f.handle.snapshot().nextAccessPolicy,null);
});

test('failed current-turn change clears its pending choice and ignores a late transitional poll',async t=>{
  const f=await fixture(t,'qwen',{fail:true});
  const turn=f.session.send({text:'keep the original task running'});
  await until(()=>f.calls.some(row=>row.op==='job.comment'));
  const release=f.hold(),target=rules.next('full',f.cwd,f.handle.snapshot().accessPolicy,1);
  const changing=f.handle.setAccessPolicy(target,1);
  f.setPending(target);
  await until(()=>f.handle.snapshot().nextAccessPolicy?.revision===2);
  const late=f.holdPoll();
  await late.entered;
  release();
  assert.equal((await changing).ok,false);
  assert.equal(f.handle.snapshot().nextAccessPolicy,null);
  f.setPending(null);
  late.release();
  await delay(80);
  assert.equal(f.handle.snapshot().accessPolicy.mode,'readonly');
  assert.equal(f.handle.snapshot().nextAccessPolicy,null);
  f.setStatus('done');await turn.completion;
});
