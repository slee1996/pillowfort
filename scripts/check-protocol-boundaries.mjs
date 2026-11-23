// Analyze the published implementation, with no network, no runtime hooks and no
// execution of the systems under test. A site has to satisfy its contract on
// every modeled normal path that reaches it; a rejected await is not a receipt.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ts,source,one,nodes,compact,fn,variable} from './protocol-source.mjs';
import {paths} from './protocol-effect-paths.mjs';
const out=process.argv[2]; if(!out) throw Error('Usage: node scripts/check-protocol-boundaries.mjs OUTPUT_DIRECTORY');
const hashes={}, results=[], controls=[];
const room=source('src/room.ts',hashes), engine=source('src/participant/secureRoomEngine.ts',hashes), idb=source('src/participant/cryptoStateStore.ts',hashes);
const call=(n,name)=>ts.isCallExpression(n)&&compact(n.expression)===name;
const awaited=(n,name)=>ts.isAwaitExpression(n)&&call(n.expression,name);
const signature=(n,text)=>ts.isAwaitExpression(n)&&compact(n.expression)===text;
const line=n=>n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line+1;
function enclosing(n,p) {for(let x=n.parent;x;x=x.parent)if(p(x))return x;throw Error('Missing enclosing definition');}
const owner=n=>enclosing(n,ts.isFunctionLike);
const method=n=>enclosing(n,ts.isMethodDeclaration);
function binding(n,name) {
  for(let x=n.parent;x;x=x.parent)if(ts.isBlock(x)) {
    const declarations=x.statements.filter(ts.isVariableStatement).flatMap(s=>[...s.declarationList.declarations]).filter(d=>d.name.getText()===name);
    if(declarations.length){const d=one(declarations,name);assert(d.parent.flags&ts.NodeFlags.Const,`Mutable ${name}`);return d;}
  }
  throw Error(`Unbound ${name}`);
}
function demand(ok,n,why) {if(!ok)throw Error(`${n.getSourceFile().fileName}:${line(n)}: ${why}`);}
function check(label,body,site,need,contract) {
  const masks=new Set();
  function inspect(n,s) {
    if(n===site){demand(need(s),n,label);masks.add(s);}
  }
  const flow=paths(body.statements,{
    expression(n,s){inspect(n,s);return contract.expression?.(n,s)??s;},
    exit(n,s){inspect(n,s);return contract.exit?.(n,s)??s;}, branch:contract.branch,
  });
  if(!site)for(const s of [...flow.normal,...flow.returned]){demand(need(s),body,label);masks.add(s);}
  assert(masks.size,`${label}: unreachable publication`);
  results.push({label,source:body.getSourceFile().fileName,line:line(site??body),reachableFactMasks:[...masks].sort((a,b)=>a-b)});
}
const has=(s,b)=>(s&b)===b;
function addAwait(text,bit){return(n,s)=>signature(n,text)?s|bit:s;}
function node(root,text) {return one(nodes(root,n=>compact(n)===text),text);}
function receiptPaths(root) {
  const sites=nodes(root,n=>call(n,'this.dispatchSecureEffects')||call(n,'this.sendSecure')&&n.arguments[1]&&ts.isObjectLiteralExpression(n.arguments[1])&&n.arguments[1].properties.some(p=>ts.isPropertyAssignment(p)&&compact(p)==='type:"authenticated"'));
  assert.equal(sites.filter(n=>call(n,'this.dispatchSecureEffects')).length,5,'inventory every transition effect dispatcher');
  assert.equal(sites.length,7,'inventory every positive authentication or effect publication');
  for(const site of sites) {
    const dispatch=call(site,'this.dispatchSecureEffects'),target=binding(site,'transition');
    if(dispatch)assert.equal(compact(site.arguments[0]),'transition.effects');
    else assert(site.arguments[1].properties.some(p=>compact(p)==='roomInstance:transition.state.roomInstance'));
    check('relay/'+method(site).name.getText()+'/'+(dispatch?'effects':'authenticated'),owner(site).body,site,s=>has(s,1),{
      expression(n,s){return awaited(n,'this.persistSecureRelayState')&&compact(n.expression.arguments[0])==='transition.state'&&binding(n,'transition')===target?s|1:s;}
    });
  }
}
receiptPaths(room);
const persist=fn(room,'persistSecureRelayState'), destroy=fn(room,'destroyRoom');
function transaction(root) {
  const t=one(nodes(root,n=>awaited(n,'this.state.storage.transaction')),'awaited durable transaction');
  const cb=t.expression.arguments[0];assert(ts.isArrowFunction(cb)&&ts.isBlock(cb.body));return [t,cb.body];
}
const [writeTx,writeBody]=transaction(persist),[eraseTx,eraseBody]=transaction(destroy);
for(const text of ['this.secureRelayState=relayState','this.secureRelayManifest=prepared.manifest'])
  check('relay/publish '+text,persist.body,node(persist,text),s=>has(s,1),{expression:(n,s)=>n===writeTx?s|1:s});
const manifest='transaction.put(SECURE_RELAY_MANIFEST_KEY_V4,prepared.manifest)';
const expectedPrior=one(nodes(writeBody,n=>ts.isIfStatement(n)&&compact(n.expression).includes('current.sha256!==previous.sha256')),'authoritative CAS');
const prerequisites=['!previous&&currentRaw!==undefined','!current||current.generation!==previous.generation','current.stateRevision!==previous.stateRevision','current.sha256!==previous.sha256','legacyKey!==undefined','legacyBlocked===true','storedRoomId!==this.roomId'];
for(const x of prerequisites)assert(compact(expectedPrior.expression).includes(x),x);
const wFacts={expression:addAwait(manifest,2),branch:(c,t,s)=>c===expectedPrior.expression&&!t?s|1:s};
check('relay/transaction includes current-manifest comparison and next manifest write',writeBody,null,s=>has(s,3),wFacts);
const chunkLoop=one(nodes(writeBody,n=>ts.isForStatement(n)&&compact(n.condition)==='index<prepared.chunks.length'),'each next-state chunk');
assert.equal(compact(chunkLoop.initializer),'letindex=0');assert.equal(compact(chunkLoop.incrementor),'index++');
check('relay/each entered chunk iteration writes its generation and index',chunkLoop.statement,null,s=>has(s,1),{expression:addAwait('transaction.put(secureRelayChunkKeyV4(generation,index),prepared.chunks[index])',1)});
for(const name of ['this.broadcastSecureTerminal','this.notifyIdleSockets']) {
  const site=one(nodes(destroy,n=>call(n,name)),name);
  check('relay/idle '+name,destroy.body,site,s=>has(s,1),{expression:(n,s)=>n===eraseTx?s|1:s});
}
const take=one(nodes(eraseBody,n=>ts.isIfStatement(n)&&compact(n.expression)==='disposableKeys.length'),'deletable records');
const recipients=one(nodes(eraseBody,n=>ts.isIfStatement(n)&&compact(n.expression)==='recipients'),'notice recipients');
check('relay/idle commit deletes disposable records and records nonempty notice recipients',eraseBody,null,s=>has(s,15),{
 expression(n,s){if(signature(n,'transaction.deleteAlarm()'))s|=1;if(signature(n,'transaction.delete(disposableKeys)'))s|=2;if(signature(n,'transaction.put(IDLE_NOTICE_KEY,recipients)'))s|=4;if(signature(n,'this.saveAlarmSchedule({"idle-notice":Date.now()},transaction)'))s|=8;return s;},
 branch(c,t,s){return !t&&c===take.expression?s|2:!t&&c===recipients.expression?s|12:s;}
});
const changed=fn(engine,'runMlsMutation'), local=fn(engine,'persistDurable'), retire=fn(engine,'retire');
const prepared=node(changed,'prepared.result()');
check('participant/prepared result follows the selected durable operation',changed.body,prepared,s=>has(s,1)&&has(s,2),{
 branch(c,t,s){return compact(c)==='prepared.retireAfterCommit'?s|(t?4:8):s;},
 expression(n,s){if(signature(n,'plan(transition)'))s|=1;if(signature(n,'this.retire()')&&has(s,4)||signature(n,'this.persistDurable(prepared.durable)')&&has(s,8))s|=2;return s;}
});
for(const text of ['this.durable=cloneSecureRoomDurableStateV1(next)','this.revision=result.revision'])
  check('participant/publish '+text,local.body,node(local,text),s=>has(s,15),{
    expression(n,s){if(signature(n,'protectSecureRoomStateV1(next,this.roomSecret)')&&compact(n.parent.left)==='wrapped')return s|1;
      if(signature(n,'this.store.compareAndSetOpaqueState(this.storeKey,this.revision,wrapped)')&&compact(n.parent.name)==='result')return s|2;return s;},
    branch(c,t,s){return !t&&compact(c)==='!result.committed'?s|4:!t&&compact(c)==='!this.lease.isActive()||this.lease.signal.aborted'?s|8:s;}
  });
check('participant/retirement follows an acknowledged erase of this revision',retire.body,node(retire,'this.retired=true'),s=>has(s,3),{
 expression(n,s){return signature(n,'this.store.compareAndDeleteOpaqueState(this.storeKey,this.revision)')&&compact(n.parent.left)==='erased'?s|1:s;},
 branch:(c,t,s)=>!t&&compact(c)==='!erased.erased'?s|2:s
});
function storeBoundaries(root) {
  const store=one(nodes(root,n=>ts.isClassDeclaration(n)&&n.name?.text==='CryptoStateStore'),'browser IndexedDB store');
  for(const [name,write,result] of [['compareAndSetOpaqueState','store.put(record)','committed'],['compareAndDeleteOpaqueState','store.delete(roomInstance)','erased']]) {
    const op=fn(store,name);
    assert.equal(compact(variable(op,'done')),'transactionDone(transaction)');
    assert.equal(compact(variable(op,'store')),'transaction.objectStore(CRYPTO_STATE_STORE)');
    assert.equal(compact(variable(op,'currentRevision')),'prior?.revision??null');
    const returns=nodes(op,n=>ts.isReturnStatement(n)&&owner(n)===op);
    assert.equal(returns.length,2,`${name}: classify every returned result`);
    const success=one(returns.filter(n=>ts.isObjectLiteralExpression(n.expression)&&n.expression.properties.some(p=>compact(p)===result+':true')),name+' positive receipt');
    check('IndexedDB/'+name+': strict transaction, same revision, write request, then oncomplete',op.body,success,s=>has(s,31),{
      expression(n,s){if(call(n,'database.transaction')&&compact(n.arguments[1])==='"readwrite"'&&compact(n.arguments[2])==='{durability:"strict"}'&&compact(n.parent.left)==='transaction')s|=1;
        if(signature(n,'requestResult(store.get(roomInstance))'))s|=2;
        if(signature(n,'requestResult('+write+')')&&has(s,7))s|=8;
        if(ts.isAwaitExpression(n)&&compact(n.expression)==='done'&&has(s,8))s|=16;return s;},
      branch:(c,t,s)=>!t&&compact(c)==='currentRevision!==expectedRevision'?s|4:s
    });
  }
}
const done=fn(idb,'transactionDone');
const resolving=one(nodes(done,n=>call(n,'resolve')),'unique transaction success');
assert.equal(compact(owner(resolving).parent.left),'transaction.oncomplete');
const rejecting=one(nodes(done,n=>call(n,'reject')),'transaction abort');assert.equal(compact(owner(rejecting).parent.left),'transaction.onabort');
storeBoundaries(idb);
// Negative controls are in-memory edits to this local verifier input. No modified
// program is built or executed. Each change must fail the publication contract,
// not just fail to parse or change the number of observed sites.
function control(label,tree,scope,from,to,inspect,expected){
 const start=scope.getStart(),end=scope.end,part=tree.text.slice(start,end);assert.equal(part.split(from).length,2,label);
 const altered=ts.createSourceFile(tree.fileName,tree.text.slice(0,start)+part.replace(from,to)+tree.text.slice(end),ts.ScriptTarget.Latest,true);
 assert.equal(altered.parseDiagnostics.length,0,label);const checkpoint=results.length;
 assert.throws(()=>inspect(altered),expected,label);results.length=checkpoint;controls.push(label);
}
const command=fn(room,'handleSecureFrame');
control('dispatch after an unawaited write',room,command,'await this.persistSecureRelayState','void this.persistSecureRelayState',receiptPaths,/relay\/handleSecureFrame\/effects/);
control('dispatch after a caught write rejection',room,command,'this.sendSecureError(ws, "persistence-failed");\n        return;','this.sendSecureError(ws, "persistence-failed");',receiptPaths,/relay\/handleSecureFrame\/effects/);
control('persist a different transition before dispatch',room,command,'persistSecureRelayState(transition.state','persistSecureRelayState(state',receiptPaths,/relay\/handleSecureFrame\/effects/);
const browserStore=one(nodes(idb,n=>ts.isClassDeclaration(n)&&n.name?.text==='CryptoStateStore'),'browser store');
const cas=fn(browserStore,'compareAndSetOpaqueState');
control('publish at request success without transaction completion',idb,cas,'await done;\n      return { committed: true','void done;\n      return { committed: true',storeBoundaries,/IndexedDB\/compareAndSetOpaqueState/);
control('take a normal branch that skips the write',idb,cas,'await requestResult(store.put(record))','if (revision > 1) await requestResult(store.put(record))',storeBoundaries,/IndexedDB\/compareAndSetOpaqueState/);
mkdirSync(out,{recursive:true});writeFileSync(resolve(out,'boundaries.json'),JSON.stringify({method:'Nondeterministic path analysis of selected released TypeScript call sites. Receipts accrue only on normal returns; rejected promises take exceptional edges.',scope:'Same-invocation ordering, not a model of all aliases, cryptography, disk persistence, scheduler fairness, WebSocket receipt or all TypeScript behavior.',typescript:ts.version,sources:hashes,sites:results,negativeControls:controls},null,2)+'\n');
console.log(`${results.length} implementation publication obligations passed; ${controls.length} in-memory negative controls rejected.`);
