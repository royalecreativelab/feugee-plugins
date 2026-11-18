// Hermes Bridge: stdio proxy (bin/hb-mcp-proxy.js) <-> panel MCP server (endpoint.json, own vs external caller, budgets, closed panel).
const assert=require("assert"), path=require("path"), fs=require("fs"), cp=require("child_process"), os=require("os");
const REPO=path.join(__dirname,"..","..","Feugee_HermesBridge_CEP");
require(REPO+"/js/envato-session.js");
require(REPO+"/js/envato.js");
require(REPO+"/js/mcp.js");
const FH=fs.mkdtempSync(path.join(os.tmpdir(),"hbhome-")); const DATA=path.join(FH,"Library/Application Support/HermesBridge");
const calls=[];
const srv=new global.AeMcpServer({ frameDir:FH, endpointFile:path.join(DATA,"endpoint.json"), ownPid:()=>999999,
  evalHost:(expr,cb)=>{ calls.push(expr); if(/hbEval/.test(expr)) return cb(JSON.stringify({ok:false,error:"ReferenceError: foo is undefined",line:3})); cb(JSON.stringify({ok:true,data:{comp:{name:"Main"}}})); },
  onCall:c=>calls.push("call:"+c.name+":"+c.external), onDone:()=>{} , maxExtCalls:3});
function proxy(msgs){ return new Promise(res=>{ const p=cp.spawn(process.execPath,[REPO+"/bin/hb-mcp-proxy.js","ae"],{env:{...process.env,HOME:FH}}); let out=""; p.stdout.on("data",d=>out+=d); p.on("exit",()=>res(out.trim().split("\n").map(l=>JSON.parse(l)))); msgs.forEach(m=>p.stdin.write(JSON.stringify(m)+"\n")); setTimeout(()=>p.stdin.end(),1500); }); }
(async()=>{
  await srv.start();
  const ep=JSON.parse(fs.readFileSync(path.join(DATA,"endpoint.json"),"utf8")); assert.ok(ep.token&&ep.url.includes(String(srv.port)));
  assert.strictEqual((fs.statSync(path.join(DATA,"endpoint.json")).mode&0o777),0o600);
  let r=await proxy([{jsonrpc:"2.0",id:1,method:"tools/list"},{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"get_comp",arguments:{}}},{jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"run_script",arguments:{code:"foo()"}}}]);
  assert.strictEqual(r[0].result.tools.length,9);
  assert.deepStrictEqual(r[0].result.tools.slice(-3).map(t=>t.name),["envato_search","import_media","envato_account"]);
  const byId=Object.fromEntries(r.map(x=>[x.id,x]));
  assert.ok(byId[2].result.content[0].text.includes("Main")); assert.strictEqual(byId[2].result.isError,false);
  assert.ok(/SCRIPT ERROR/.test(byId[3].result.content[0].text)); assert.strictEqual(byId[3].result.isError,false,"script error must not trip the circuit breaker");
  assert.ok(calls.includes("call:get_comp:true"),"proxy call is external (pid mismatch)");
  assert.ok(!srv.listedAt,"external tools/list must not satisfy own boot check");
  // no call cap: 4th+ external call still goes through
  r=await proxy([{jsonrpc:"2.0",id:4,method:"tools/call",params:{name:"get_comp"}},{jsonrpc:"2.0",id:5,method:"tools/call",params:{name:"get_comp"}}]);
  assert.ok(r.every(x=>!/^LIMIT/.test(x.result.content[0].text) && x.result.isError===false),"external calls are never capped");
  // own agent (pid matches) -> listedAt
  srv.ownPid=()=>process.pid; // proxy's parent = this node process
  await proxy([{jsonrpc:"2.0",id:6,method:"tools/list"}]); await new Promise(r=>setTimeout(r,300));
  assert.ok(srv.listedAt,"own agent tools/list sets listedAt");
  srv.stop(); assert.ok(!fs.existsSync(path.join(DATA,"endpoint.json")),"endpoint removed on stop");
  r=await proxy([{jsonrpc:"2.0",id:7,method:"tools/call",params:{name:"get_comp"}}]);
  assert.ok(/panel tidak terbuka/.test(r[0].result.content[0].text) && r[0].result.isError);
  console.log("AE proxy/server: all assertions passed");
})().catch(e=>{console.error("FAIL",e.message);process.exit(1)});
