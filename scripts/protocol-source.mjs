// Common syntax and provenance for source-based protocol verification, not runtime code.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
export const ts = createRequire(new URL('../client/package.json', import.meta.url))('typescript');
export function source(name, hashes) {
  const bytes = readFileSync(new URL('../' + name, import.meta.url));
  hashes[name] = createHash('sha256').update(bytes).digest('hex');
  const tree = ts.createSourceFile(name, bytes.toString(), ts.ScriptTarget.Latest, true);
  assert.equal(tree.parseDiagnostics.length, 0, `Cannot verify malformed ${name}`);
  return tree;
}
export function one(items, what) { assert.equal(items.length, 1, what); return items[0]; }
export function nodes(root, predicate) {
  const found = [];
  function visit(n) { if (predicate(n)) found.push(n); ts.forEachChild(n, visit); }
  visit(root); return found;
}
export const compact = n => n.getText().replace(/\s+/g,'');
export const fn = (root, name) => one(nodes(root, n => (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name?.getText() === name), name);
export const variable = (root, name) => one(nodes(root, n => ts.isVariableDeclaration(n) && n.name.getText() === name), name).initializer;
export const guarded = (root, atom) => one(nodes(root, n => ts.isIfStatement(n) && compact(n.expression).includes(atom)), atom);
