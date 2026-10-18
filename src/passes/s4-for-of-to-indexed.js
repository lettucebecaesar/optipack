/**
 * S4 for-of-to-indexed — convert `for (const v of it)` to an indexed loop,
 * only when the iterable is statically provably an array.
 *
 * Bail conditions:
 *  - `for await`
 *  - iterable not provably an array (host returns, Map/Set, strings, generators)
 *  - destructuring binding with rest elements
 *  - a scope binding named `Symbol` (iterator protocol could be shadowed)
 *  - non-identifier / non-array-pattern bindings
 *
 * Semantics preserved:
 *  - per-iteration binding (const inside the loop body)
 *  - live `.length` checks (pushes during iteration extend the loop, exactly
 *    like the array iterator)
 *  - break/continue/return/labels untouched
 */
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { provablyArray } from '../pass-utils.js';

const _traverse = traverse.default || traverse;

export const ID = 'for-of-to-indexed';
export const CODE = 'S4';

function indexExpr(arrName, idxName, offset) {
  const idx = offset === 0 ? t.identifier(idxName) : t.binaryExpression('+', t.identifier(idxName), t.numericLiteral(offset));
  return t.memberExpression(t.identifier(arrName), idx, true);
}

export default function forOfToIndexed(programPath, ctx) {
  programPath.traverse({
    ForOfStatement(path) {
      const node = path.node;
      const line = node.loc ? node.loc.start.line : 0;
      if (ctx.isDisabled(path, ID, CODE)) return;

      const fail = (reason) => {
        ctx.bail(line, CODE, reason);
        return;
      };

      if (node.await) return fail('for await loop');
      if (path.scope.getBinding('Symbol')) return fail('Symbol shadowed in scope');

      if (!t.isVariableDeclaration(node.left) || node.left.declarations.length !== 1) {
        return fail('loop head is not a single declarator');
      }
      const declarator = node.left.declarations[0];
      const id = declarator.id;
      const kind = node.left.kind;

      if (t.isIdentifier(id)) {
        if (id.name === 'arguments' || id.name === 'eval') return fail('loop variable is arguments/eval');
        // Reassignment of a let/var loop variable is fine (translate to let).
      } else if (t.isArrayPattern(id)) {
        for (const el of id.elements) {
          if (el && t.isRestElement(el)) return fail('destructuring with rest element');
          if (el && !t.isIdentifier(el) && !t.isAssignmentPattern(el)) {
            return fail('unsupported destructuring element');
          }
          if (el && t.isAssignmentPattern(el) && !t.isIdentifier(el.left)) {
            return fail('unsupported destructuring default target');
          }
        }
      } else {
        return fail('loop variable is not an identifier or array pattern');
      }

      const prov = provablyArray(node.right, path);
      if (!prov.array) return fail('iterable not provably an array');

      // Choose the array reference: direct identifier when immutable, else a hoisted const.
      let arrName;
      const pre = [];
      if (t.isIdentifier(node.right)) {
        const binding = path.scope.getBinding(node.right.name);
        if (binding && binding.constantViolations.length === 0) {
          arrName = node.right.name;
        }
      }
      if (!arrName) {
        arrName = path.scope.generateUid('opArr');
        pre.push(t.variableDeclaration('const', [t.variableDeclarator(t.identifier(arrName), node.right)]));
      }
      const idxName = path.scope.generateUid('opI');

      // Binding declarations inside the loop body.
      const bindDecls = [];
      const declKind = kind === 'const' ? 'const' : 'let';
      const pushDecl = (name, readExpr, deflt) => {
        if (deflt) {
          bindDecls.push(t.variableDeclaration('let', [t.variableDeclarator(t.identifier(name), readExpr)]));
          bindDecls.push(
            t.ifStatement(
              t.binaryExpression('===', t.identifier(name), t.identifier('undefined')),
              t.expressionStatement(t.assignmentExpression('=', t.identifier(name), deflt))
            )
          );
        } else {
          bindDecls.push(t.variableDeclaration(declKind, [t.variableDeclarator(t.identifier(name), readExpr)]));
        }
      };
      if (t.isIdentifier(id)) {
        pushDecl(id.name, indexExpr(arrName, idxName, 0), null);
      } else {
        // Array pattern: read the element once, then index into it.
        const elemUid = path.scope.generateUid('opEl');
        bindDecls.push(t.variableDeclaration('const', [
          t.variableDeclarator(t.identifier(elemUid), indexExpr(arrName, idxName, 0)),
        ]));
        id.elements.forEach((el, k) => {
          if (!el) return; // hole
          const elemRead = t.memberExpression(t.identifier(elemUid), t.numericLiteral(k), true);
          if (t.isIdentifier(el)) pushDecl(el.name, elemRead, null);
          else pushDecl(el.left.name, elemRead, el.right);
        });
      }

      // Loop body: binding decls + original body (wrapped when it was a block).
      const bodyStmts = [...bindDecls];
      if (t.isBlockStatement(node.body)) {
        bodyStmts.push(node.body); // nested block preserves shadowing
      } else {
        bodyStmts.push(node.body);
      }
      const forNode = t.forStatement(
        t.variableDeclaration('let', [t.variableDeclarator(t.identifier(idxName), t.numericLiteral(0))]),
        t.binaryExpression('<', t.identifier(idxName), t.memberExpression(t.identifier(arrName), t.identifier('length'))),
        t.updateExpression('++', t.identifier(idxName)),
        t.blockStatement(bodyStmts)
      );

      const replacement = pre.length > 0 ? t.blockStatement([...pre, forNode]) : forNode;
      path.replaceWith(replacement);
      ctx.applied(ID);
    },
  });
}
