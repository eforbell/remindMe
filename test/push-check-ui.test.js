'use strict';
const { test }=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/people.js'),'utf8');
test('remove key invalidates a pending save/check without a stale verified card',async()=>{
 for(const pending of ['save','check']) {
  const handlers={},status={textContent:''};let finish,saved=true;
  const member={id:1,name:'Operator',has_key:true,active_reminders:0};
  const list={innerHTML:'',addEventListener:(event,fn)=>{handlers[event]=fn;}};
  const context={document:{getElementById:id=>id==='person-list'?list:id==='add-form'?{addEventListener(){}}:status},
   RM:{esc:s=>s,avatar:()=>'',relativeAgo:()=>'',toast:()=>{},confirmSheet:async()=>true,api:async(url,opts={})=>{
    if(url==='api/members')return{members:[{...member,has_key:saved}],mirror_enabled:false};
    if(opts.method==='DELETE'){saved=false;return{};}
    return new Promise(resolve=>{finish=resolve;});
   }}};
  vm.createContext(context);vm.runInContext(source,context);await new Promise(resolve=>setImmediate(resolve));
  const input={value:'fixture_secret_1234',focus(){}},button={disabled:false};
  const form={dataset:{keyForm:'1'},querySelector:selector=>selector==='input'?input:button};
  const submit={preventDefault(){},target:{closest:selector=>selector==='[data-key-form]'?form:null}};
  const click=action=>({target:{closest:()=>({dataset:{do:action,id:'1'},disabled:false})}});
  const old=pending==='save'?handlers.submit(submit):handlers.click(click('check'));
  await new Promise(resolve=>setImmediate(resolve));
  await handlers.click(click('clear'));
  const verification={status:'verified',message:'OLD SECRET VERIFIED'};
  finish(pending==='save'?{verification}:verification);await old;
  assert.equal(saved,false);assert.ok(!status.textContent.includes('OLD SECRET VERIFIED'),pending);
 }
});
