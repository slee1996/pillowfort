// Finite abstract interpretation over a TypeScript statement slice. Bits are facts
// acquired on the current invocation, not line numbers. Branches are nondeterministic;
// promises can reject and calls can throw. All loop iterations reach a fixed point.
import assert from 'node:assert/strict';
import {ts} from './protocol-source.mjs';
const K=ts.SyntaxKind;
const unique = xs => [...new Set(xs)];
const normal = (n=[]) => ({normal:n, returned:[], thrown:[], broken:[], continued:[]});
const exits = ['normal','returned','thrown','broken','continued'];
function merge(...flows) { return Object.fromEntries(exits.map(k=>[k,unique(flows.flatMap(f=>f[k]))])); }
function then(a, f) { return merge({...a,normal:[]},f(a.normal)); }
function map(states, apply) { return unique(states.map(apply)); }
export function paths(statements, contract) {
  function expr(n, states) {
    if (!n || !states.length || ts.isFunctionLike(n) || ts.isTypeNode(n)) return normal(states);
    if (ts.isConditionalExpression(n)) return then(expr(n.condition,states), q => merge(expr(n.whenTrue,q),expr(n.whenFalse,q)));
    if (ts.isBinaryExpression(n) && [K.AmpersandAmpersandToken,K.BarBarToken,K.QuestionQuestionToken].includes(n.operatorToken.kind))
      return then(expr(n.left,states), q=>merge(normal(q),expr(n.right,q)));
    assert(!ts.isStatement(n) && !ts.isClassLike(n) && !ts.isYieldExpression(n),`Unsupported expression ${ts.SyntaxKind[n.kind]}`);
    let a=normal(states); ts.forEachChild(n, child=>{a=then(a,q=>expr(child,q));});
    const q=a.normal;
    // Overapproximate exceptions, including implicit conversions and accessors.
    // A spurious exception can reveal an unproved path, never create a receipt.
    a.thrown=unique([...a.thrown,...q]);
    a.normal=map(q,s=>contract.expression?.(n,s)??s);
    // Optional calls and element/property accesses may skip an effect. Never
    // derive an unconditional fact merely because an optional callee exists.
    if (ts.isOptionalChain(n)) a.normal=unique([...states,...a.normal]);
    return a;
  }
  function seq(items, s) { let a=normal(s);for(const item of items)a=then(a,q=>stmt(item,q));return a; }
  function stmt(n,states) {
    if (!states.length) return normal();
    if(ts.isBlock(n))return seq(n.statements,states);
    if(ts.isVariableStatement(n))return expr(n.declarationList,states);
    if(ts.isExpressionStatement(n))return expr(n.expression,states);
    if(ts.isReturnStatement(n)||ts.isThrowStatement(n)) {
      const a=expr(n.expression,states), q=map(a.normal,s=>contract.exit?.(n,s)??s);
      return merge({...a,normal:[]},{...normal(),[ts.isReturnStatement(n)?'returned':'thrown']:q});
    }
    if(ts.isIfStatement(n))return then(expr(n.expression,states),q=>{
      const branch=truth=>map(q,s=>contract.branch?.(n.expression,truth,s)??s);
      return merge(stmt(n.thenStatement,branch(true)),n.elseStatement?stmt(n.elseStatement,branch(false)):normal(branch(false)));
    });
    if(ts.isTryStatement(n)) {
      let a=stmt(n.tryBlock,states);
      if(n.catchClause) a=merge({...a,thrown:[]},stmt(n.catchClause.block,a.thrown));
      if(!n.finallyBlock)return a;
      return merge(...exits.map(k=>{const f=stmt(n.finallyBlock,a[k]);return merge({...f,normal:[]},{...normal(),[k]:f.normal});}));
    }
    if(ts.isBreakStatement(n)||ts.isContinueStatement(n)) {
      assert(!n.label,'Labeled loop exit is not supported'); return {...normal(),[ts.isBreakStatement(n)?'broken':'continued']:states};
    }
    if(ts.isForOfStatement(n)||ts.isForStatement(n)) {
      const entry=ts.isForOfStatement(n)?expr(n.expression,states):expr(n.initializer,states);
      return then(entry,q=>{
        let all=normal(),todo=q;const seen=new Set(q);
        while(todo.length) {
          const tested=ts.isForStatement(n)?expr(n.condition,todo):{...normal(todo),thrown:todo};
          const step=then(tested,body=>stmt(n.statement,body));
          const repeat={...step,normal:unique([...step.normal,...step.continued]),continued:[],broken:[]};
          const inc=ts.isForStatement(n)?then(repeat,s=>expr(n.incrementor,s)):repeat;
          const next=inc.normal.filter(s=>!seen.has(s));for(const s of next)seen.add(s);
          all=merge(all,tested,normal(step.broken),{...inc,normal:[]});todo=next;
        }
        return all;
      });
    }
    if(ts.isEmptyStatement(n))return normal(states);
    throw Error(`Unsupported control flow ${ts.SyntaxKind[n.kind]} at ${n.getSourceFile().fileName}:${n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line+1}`);
  }
  return seq(statements,[0]);
}
