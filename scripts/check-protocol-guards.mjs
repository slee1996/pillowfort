// Check shipped expressions, not a second implementation of the relay. Only the scalar
// fragment below is translated. Object presence, membership lookup and signature verification
// are external Boolean inputs; unsupported syntax is an error rather than an uninterpreted pass.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const ts = createRequire(new URL('../client/package.json', import.meta.url))('typescript');
const out = process.argv[2];
if (!out) throw Error('Usage: node scripts/check-protocol-guards.mjs OUTPUT_DIRECTORY [Z3]');
const solver = process.argv[3] ?? 'z3';
mkdirSync(out, {recursive:true});
const sources = {}, results = [];
function source(name) {
  const bytes = readFileSync(new URL('../' + name, import.meta.url));
  sources[name] = createHash('sha256').update(bytes).digest('hex');
  return ts.createSourceFile(name, bytes.toString(), ts.ScriptTarget.Latest, true);
}
function one(items, what) { assert.equal(items.length, 1, what); return items[0]; }
function nodes(root, pred) {
  const found = [];
  function visit(node) { if (pred(node)) found.push(node); ts.forEachChild(node, visit); }
  visit(root); return found;
}
const compact = node => node.getText().replace(/\s+/g,'');
const fn = (root, name) => one(nodes(root, n => (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name?.getText() === name), name);
const variable = (root, name) => one(nodes(root, n => ts.isVariableDeclaration(n) && n.name.getText() === name), name).initializer;
const guarded = (root, atomicPath) => one(nodes(root, n => ts.isIfStatement(n) && compact(n.expression).includes(atomicPath)), atomicPath);
const kind = ts.SyntaxKind;
const ops = new Map([[kind.AmpersandAmpersandToken,'and'],[kind.BarBarToken,'or'],[kind.EqualsEqualsEqualsToken,'='],[kind.ExclamationEqualsEqualsToken,'distinct'],[kind.GreaterThanEqualsToken,'>='],[kind.LessThanToken,'<']]);
function compile(n, names) {
  if (ts.isParenthesizedExpression(n)) return compile(n.expression,names);
  if (ts.isBinaryExpression(n) && ops.has(n.operatorToken.kind)) return `(${ops.get(n.operatorToken.kind)} ${compile(n.left,names)} ${compile(n.right,names)})`;
  if (ts.isPrefixUnaryExpression(n) && n.operator === kind.ExclamationToken) return `(not ${compile(n.operand,names)})`;
  if (ts.isStringLiteral(n)) { assert.match(n.text,/^[a-z-]+$/); return `"${n.text}"`; }
  if (n.kind === kind.NullKeyword) return '"@null"';
  if (ts.isIdentifier(n) && n.text === 'undefined') return '"@undefined"';
  const atom = names.get(compact(n));
  assert(atom,`Uninterpreted expression is not authorized: ${n.getText()}`);
  return atom;
}
// Distinct symbols for each independently supplied field. Equality is over arbitrary
// strings/integers, not two sample IDs. Reserved null/undefined tags are not valid opaque IDs.
function prove(label, n, bindings, contract, {rejects=false, assumes='true'}={}) {
  const names=new Map(), declarations=[];
  for (const [name,sort,expression] of bindings) {
    assert(!names.has(expression)); names.set(expression,name); declarations.push(`(declare-const ${name} ${sort})`);
  }
  const value=compile(n,names), accepts=rejects ? `(not ${value})` : value;
  const smt=`(set-logic ALL)\n${declarations.join('\n')}\n(assert ${assumes})\n(define-fun shipped () Bool ${accepts})\n(define-fun contract () Bool ${contract})\n`+
    ['(distinct shipped contract)','shipped','(not shipped)'].map(term=>`(push)\n(assert ${term})\n(check-sat)\n(pop)`).join('\n')+'\n';
  const path=resolve(out,label+'.smt2'); writeFileSync(path,smt);
  const verdicts=execFileSync(solver,['-T:10',path],{encoding:'utf8'}).trim().split(/\s+/);
  assert.deepEqual(verdicts,['unsat','sat','sat'],`${label}: inequivalence or vacuous decision`);
  results.push({label,source:n.getSourceFile().fileName,line:1+n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line,verdicts,formulaSha256:createHash('sha256').update(smt).digest('hex')});
}
const bool=(n,e)=>[n,'Bool',e], word=(n,e)=>[n,'String',e], num=(n,e)=>[n,'Int',e];
const relay=source('src/secureRelayV4.ts'), reduce=fn(relay,'reduceSecureRelayV4');
const participant=source('src/participant/secureRoomController.ts'), app=source('src/secureGameReducer.ts'), path=source('src/hostPathWatch.ts');
const grantFields=['v','suite','roomInstance','requestId','tokenId','deviceId','logicalOrder','expiresAt'];
const grant=fn(relay,'grantEquals');
assert.equal(grant.body.statements.length,1); assert(ts.isReturnStatement(grant.body.statements[0]));
prove('M1-exact-grant',grant.body.statements[0].expression,
  grantFields.flatMap(f=>['left','right'].map(side=>(['v','suite','logicalOrder','expiresAt'].includes(f)?num:word)(side+f,side+'.'+f))),
  `(and ${grantFields.map(f=>`(= left${f} right${f})`).join(' ')})`);
const activation=guarded(reduce,'frame.kind==="activate"').thenStatement;
const proofGuard=guarded(activation,'pending.proofFrame.grant.logicalOrder');
assert(compact(proofGuard.thenStatement).includes('returnreject("invalid-admission")'));
prove('M2-activation-proof',proofGuard.expression,[bool('present','pending'),word('status','pending.status'),word('phase','pending.pendingPhase'),word('storedAdmission','pending.admissionId'),word('requestedAdmission','frame.admissionId'),word('storedProof','pending.proofMessageId'),word('requestedProof','frame.proofMessageId'),word('storedKey','pending.signaturePublicKey'),word('requestedKey','frame.signaturePublicKey'),bool('proofStored','pending.proofFrame'),num('proofOrder','pending.proofFrame.grant.logicalOrder'),num('next','state.nextLogicalOrder')],
  '(and present (= status "pending") (= phase "awaiting-proof") (= storedAdmission requestedAdmission) (= storedKey requestedKey) (= storedProof requestedProof) proofStored (= next proofOrder))',{rejects:true});
prove('M3-resume-eligibility',variable(reduce,'resumableActive'),[word('admission','existing.admissionId'),word('status','existing.status'),word('prev','existing.resumeStatus'),word('phase','existing.resumePhase')],
  '(and (= admission "@null") (or (= status "active") (and (= status "pending") (= phase "replaying-backlog")) (and (= status "disconnected") (= prev "active"))))');
const receipt=fn(participant,'handleFrameAccepted').body.statements.find(n=>ts.isIfStatement(n) && nodes(n.thenStatement,x=>ts.isBinaryExpression(x) && compact(x)==='this.replayingBacklog=false').length);
assert(receipt,'Missing participant resume-release decision');
prove('M3-participant-completion-receipt',receipt.expression,[word('wire','messageId'),word('pending','this.resumeCompleteRequestId')],'(and (distinct pending "@null") (= wire pending))',{assumes:'(distinct wire "@null")'});
const candidate=fn(relay,'nextSuccessionCandidate'), statements=candidate.body.statements;
assert.equal(statements.length,4); const loop=statements[2]; assert(ts.isForOfStatement(loop));
assert.equal(compact(loop.expression),'policy.event.content.deviceIds'); assert.equal(compact(loop.initializer),'constid');
assert.equal(compact(loop.statement.statements[0]),'constmember=memberById(state,id);');
assert.equal(loop.statement.statements.length,2); const eligible=loop.statement.statements[1];
assert(ts.isIfStatement(eligible) && !eligible.elseStatement && ts.isReturnStatement(eligible.thenStatement));
assert.equal(compact(eligible.thenStatement.expression),'member'); assert.equal(compact(statements[3]),'returnnull;');
prove('M4-ranked-candidate',eligible.expression,[word('status','member?.status'),word('connection','member.connectionId'),bool('needsAdmission','member.requiresFreshAdmission'),bool('tried','policy.attemptedDeviceIds.includes(id)'),bool('retiring','state.pendingZombieRemovals.some(marker=>marker.deviceId===id)')],
  '(and (not retiring) (not tried) (not needsAdmission) (= status "active") (distinct connection "@null"))');
prove('M4-tenure-policy',statements[1].expression,[bool('issued','policy'),word('signer','policy.event.deviceId'),word('host','state.hostDeviceId'),word('type','policy.event.content.type')],
  '(and issued (= host signer) (= type "host-succession-policy"))',{rejects:true});
prove('M4-relay-authorization',variable(reduce,'automaticSuccession'),[word('wire','frame.relayKind'),word('policy','state.pendingHostTransfer?.policyEventId'),word('target','state.pendingHostTransfer.targetDeviceId'),word('actor','actor.deviceId'),word('expected','state.pendingHostTransfer.authorizationId'),word('given','frame.authorizationId')],
  '(and (= actor target) (= given expected) (= wire "host-transfer-accept") (distinct policy "@undefined"))');
const sidecar=guarded(reduce,'verifySecureApplicationEventV4(authorityEvent,member.signaturePublicKey)');
assert(compact(sidecar.thenStatement).includes('returnreject("invalid-reference")'));
prove('M4-verified-sidecar',sidecar.expression,[word('eventRoom','authorityEvent.roomInstance'),word('room','state.roomInstance'),word('signer','authorityEvent.deviceId'),word('actor','actor.deviceId'),num('signedOrder','authorityEvent.logicalOrder'),num('grantOrder','grant.logicalOrder'),word('publicKey','member.signaturePublicKey'),bool('signatureOK','awaitverifySecureApplicationEventV4(authorityEvent,member.signaturePublicKey)')],
  '(and (= room eventRoom) (= actor signer) (= signedOrder grantOrder) (distinct publicKey "@null") signatureOK)',{rejects:true});
prove('M4-relay-acceptance',variable(reduce,'successionAccepted'),[bool('delegated','automaticSuccession'),word('type','authorityEvent?.content.type'),word('choice','authorityEvent.content.action')],
  '(and delegated (= choice "accept") (= type "host-succession"))');
const response=one(nodes(fn(app,'reduceSecureRoomEventV4'),n=>ts.isCaseClause(n) && n.expression.text==='host-succession'),'member response');
const allowed=guarded(response,'policy.deviceIds.includes(event.deviceId)');
assert(compact(allowed.thenStatement).includes('accepted=false;break;'));
prove('M4-peer-policy-binding',allowed.expression,[bool('policyExists','policy'),word('issuer','policy.hostDeviceId'),word('host','state.hostDeviceId'),word('policyId','policy.eventId'),word('given','content.policyEventId'),bool('inPolicy','policy.deviceIds.includes(event.deviceId)'),bool('inRoom','currentMember(state,event.deviceId)')],
  '(and policyExists (= issuer host) (= policyId given) inPolicy inRoom)',{rejects:true});
const reply=fn(path,'acknowledgeHostPath').body.statements[0]; assert(ts.isIfStatement(reply) && compact(reply.thenStatement)==='returnw;');
prove('M4-current-probe',reply.expression,[bool('watch','w'),word('owner','w.deviceId'),word('device','device'),word('socket','w.connectionId'),word('connection','connection'),word('challenge','w.nonce'),word('reply','nonce'),word('phase','w.phase'),num('now','now'),num('due','w.dueAt')],
  '(and watch (= owner device) (= socket connection) (= challenge reply) (or (distinct phase "expire") (< now due)))',{rejects:true});
const report={method:'TypeScript AST decision equivalence; unsatisfiable disagreement and positive/negative satisfiable witnesses for each expression.',scope:'Local guards on parsed inputs. No proof of caller reachability, cryptographic validity, all mutation sites or full TypeScript refinement.',typescript:ts.version,z3:execFileSync(solver,['-version'],{encoding:'utf8'}).trim(),sources,results};
writeFileSync(resolve(out,'guards.json'),JSON.stringify(report,null,2)+'\n');
console.log(`${results.length} production guard equivalences, ${2*results.length} non-vacuity witnesses`);
