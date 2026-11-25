import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const knownModule = name => name === 'koyuki' || /(?:^|\/)framework\/index\.[cm]?[jt]sx?$/.test(name);
const factories = new Set(['defineTarget', 'defineUseCase', 'defineCommand', 'bindMutation', 'defineUseCaseGroup']);
const position = (file, path) => ({ file, line: path.node.loc.start.line, column: path.node.loc.start.column + 1 });
function unwrap(path) {
  while (path?.node && ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression'].includes(path.node.type)) path = path.get('expression');
  return path;
}
function literal(path) {
  path = unwrap(path);
  if (path?.isStringLiteral() || path?.isNumericLiteral()) return String(path.node.value);
  if (path?.isTemplateLiteral() && path.node.expressions.length === 0) return path.node.quasis[0].value.cooked;
}
function resolveValue(path, seen = new Set()) {
  path = unwrap(path);
  if (!path?.isIdentifier()) return path;
  const binding = path.scope.getBinding(path.node.name);
  if (!binding || !binding.constant || !binding.path.isVariableDeclarator() || binding.path.parent.kind !== 'const' || seen.has(binding)) return path;
  seen.add(binding); return resolveValue(binding.path.get('init'), seen);
}
function api(path) {
  path = unwrap(path);
  if (!path?.node) return;
  if (path.isIdentifier()) {
    const binding = path.scope.getBinding(path.node.name);
    if (binding?.path.isImportSpecifier() && binding.path.node.importKind !== 'type') {
      const declaration = binding.path.parentPath;
      if (declaration.node.importKind !== 'type' && knownModule(declaration.node.source.value)) return binding.path.node.imported.name ?? binding.path.node.imported.value;
    }
  } else if (path.isMemberExpression()) {
    const owner = path.get('object');
    const binding = owner.isIdentifier() ? owner.scope.getBinding(owner.node.name) : undefined;
    if (binding?.path.isImportNamespaceSpecifier() && binding.path.parent.importKind !== 'type' && knownModule(binding.path.parent.source.value)) {
      return path.node.computed ? literal(path.get('property')) : path.node.property.name;
    }
  }
}
function fields(path) {
  path = resolveValue(path);
  if (!path?.isObjectExpression() || path.node.properties.some(node => node.type !== 'ObjectProperty')) return;
  const result = new Map();
  for (const property of path.get('properties')) {
    const key = property.node.computed ? literal(property.get('key')) : property.node.key.name ?? literal(property.get('key'));
    if (key === undefined) return;
    result.set(key, property.get('value'));
  }
  return result;
}

/** Parse declarations only. Never import a target module, resolve imports, or evaluate an expression. */
export function analyzeDeclarations(files) {
  const diagnostics = [], unresolved = [], ids = new Map(); let checkedDeclarations = 0;
  const report = (code, severity, file, path, message, related = []) => diagnostics.push({ code, severity, ...position(file, path), message, related });
  const skip = (file, path, reason) => unresolved.push({ ...position(file, path), reason });
  for (const { file, source } of files) {
    let ast;
    try { ast = parse(source, { sourceType: 'module', sourceFilename: file, plugins: ['typescript', ...(/\.[jt]sx$/i.test(file) ? ['jsx'] : [])], attachComment: false }); }
    catch (error) { diagnostics.push({ code: 'PARSE_ERROR', severity: 'error', file, line: error.loc?.line ?? 1, column: (error.loc?.column ?? 0) + 1, message: error.message, related: [] }); continue; }
    traverse(ast, { CallExpression(path) {
      const name = api(path.get('callee'));
      if (!factories.has(name) && name !== 'defineTransition' && name !== 'defineApplication' && name !== 'business') return;
      const definition = fields(path.get('arguments')[0]);
      if (!definition) { skip(file, path, 'Definition is not a statically resolved object of data properties'); return; }
      checkedDeclarations++;
      if (factories.has(name)) {
        const operation = definition.get('operation');
        const value = operation && literal(resolveValue(operation));
        if (value === undefined) { skip(file, path, 'Operation ID is dynamic or absent'); return; }
        if (ids.has(value)) report('REPEATED_OPERATION_ID', 'warning', file, operation, `Operation ID ${JSON.stringify(value)} appears in another selected declaration; confirm whether the shared persistence identity is intentional.`, [ids.get(value)]);
        else ids.set(value, position(file, operation));
      } else if (name === 'defineApplication' || name === 'business') {
        const table = definition.get('operations');
        const operations = table && fields(table);
        if (!operations) { skip(file, path, 'Operation table is computed, spread, or supplied by another function'); return; }
        // business.then is already rejected by its public type declaration.
        if (name === 'defineApplication') for (const [key, value] of operations) {
          if (key === 'dismiss' || key.startsWith('@')) report('RESERVED_APPLICATION_OPERATION', 'error', file, value.parentPath.get('key'), `Operation ${JSON.stringify(key)} is reserved by Application; rename the public operation.`);
        }
      } else {
        const labels = new Map();
        const stage = (candidate, fallback) => {
          const resolved = resolveValue(candidate);
          let label = fallback, site = candidate;
          if (resolved?.isCallExpression() && api(resolved.get('callee')) === 'step') {
            const argument = resolved.get('arguments')[0];
            label = literal(resolveValue(argument)); site = argument ?? resolved;
            if (label === undefined) { skip(file, resolved, 'Step label is dynamic'); return; }
          } else if (!resolved?.node || !['ArrowFunctionExpression', 'FunctionExpression'].includes(resolved.node.type) && !(resolved.isIdentifier() && resolved.scope.getBinding(resolved.node.name)?.path.isFunctionDeclaration())) {
            skip(file, candidate, 'Stage is not a named step or a statically identified ordinary function'); return;
          }
          if (labels.has(label)) report('AMBIGUOUS_STEP_LABEL', 'warning', file, site, `Step label ${JSON.stringify(label)} repeats in this transition; use distinct labels if traces must identify the stage. Repetition does not prove an invalid business rule.`, [labels.get(label)]);
          else labels.set(label, position(file, site));
        };
        if (definition.has('validate')) stage(definition.get('validate'), 'validate');
        if (definition.has('require')) {
          const required = resolveValue(definition.get('require'));
          if (!required?.isArrayExpression() || required.node.elements.some(node => !node || node.type === 'SpreadElement')) skip(file, required ?? path, 'Requirements are not a statically resolved tuple');
          else required.get('elements').forEach((value, index) => stage(value, `require:${index + 1}`));
        }
        if (definition.has('evolve')) stage(definition.get('evolve'), 'evolve');
      }
    } });
  }
  return { schema: 'koyuki.declaration-diagnostics.v1', scope: 'static-source-metadata', checkedDeclarations, diagnostics, unresolved };
}

async function main(args) {
  const json = args.includes('--json'), strict = args.includes('--strict');
  const paths = args.filter(arg => !['--json', '--strict'].includes(arg));
  if (!paths.length || paths.some(path => path.startsWith('--'))) throw Error('Usage: node scripts/check-declarations.mjs [--json] [--strict] file.ts ...');
  const files = await Promise.all(paths.map(async file => ({ file, source: await readFile(file, 'utf8') })));
  const report = analyzeDeclarations(files);
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    for (const item of report.diagnostics) {
      console.log(`${item.file}:${item.line}:${item.column} ${item.severity} ${item.code}: ${item.message}`);
      for (const related of item.related) console.log(`  related: ${related.file}:${related.line}:${related.column}`);
    }
    for (const item of report.unresolved) console.log(`${item.file}:${item.line}:${item.column} unresolved: ${item.reason}`);
    console.log(`Checked ${report.checkedDeclarations} declarations; ${report.diagnostics.length} diagnostics; ${report.unresolved.length} unresolved metadata items. This is not a type check or a proof of business correctness.`);
  }
  process.exitCode = report.diagnostics.some(item => item.severity === 'error' || strict && item.severity === 'warning') ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 2; });
}
