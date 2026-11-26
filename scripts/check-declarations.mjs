import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const knownModule = name => name === 'koyuki' || /(?:^|\/)framework\/index\.[cm]?[jt]sx?$/.test(name);
const factories = new Set(['defineTarget', 'defineUseCase', 'defineCommand', 'bindMutation', 'defineUseCaseGroup']);
const position = (file, path) => ({ file: path.node.loc.filename ?? file, line: path.node.loc.start.line, column: path.node.loc.start.column + 1 });
function unwrap(path) {
  while (path?.node && ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression'].includes(path.node.type)) path = path.get('expression');
  return path;
}
function literal(path) {
  path = unwrap(path);
  if (path?.isStringLiteral() || path?.isNumericLiteral()) return String(path.node.value);
  if (path?.isTemplateLiteral() && path.node.expressions.length === 0) return path.node.quasis[0].value.cooked;
}
function declarationTools(selectedImports) {
  function resolveValue(path, seen = new Set()) {
    path = unwrap(path);
    if (!path?.isIdentifier()) return path;
    const binding = path.scope.getBinding(path.node.name);
    if (binding && selectedImports.has(binding) && !seen.has(binding)) {
      seen.add(binding);
      return resolveValue(selectedImports.get(binding), seen);
    }
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
      // In an object literal this spelling sets the prototype rather than an own data key.
      if (key === '__proto__' && !property.node.computed && !property.node.shorthand) return;
      result.set(key, property.get('value'));
    }
    return result;
  }

  function businessStage(candidate, fallback, budget) {
    const resolved = resolveValue(candidate);
    const composition = workflowLabels(resolved, new Set(), budget);
    if (composition) return {
      labels: composition.labels.map(item => ({ ...item, path: unwrap(candidate)?.isIdentifier() ? candidate : item.path })),
      unresolved: composition.unresolved,
    };
    if (--budget.left < 0) return { path: candidate, reason: 'Business exceeds the static expansion limit of 1024 stages or Workflow construction calls' };
    // A known Workflow.run is an ordinary opaque function in business. Its
    // internal names must not be expanded like an explicit Workflow object.
    if (resolved?.isMemberExpression()) {
      const key = resolved.node.computed ? literal(resolved.get('property')) : resolved.node.property.name;
      if (key === 'run' && rootedComposition(resolved.get('object'))) return { label: fallback, path: candidate };
    }
    let site, value;
    if (resolved?.isCallExpression() && api(resolved.get('callee')) === 'step') {
      site = resolved.get('arguments')[0]; value = site && resolveValue(site);
    } else if (resolved?.isObjectExpression()) {
      const declared = fields(resolved);
      if (declared?.has('name') && declared.has('rule')) { site = declared.get('name'); value = resolveValue(site); }
    }
    if (site) {
      const label = value?.isStringLiteral() || value?.isTemplateLiteral() && value.node.expressions.length === 0 ? literal(value) : undefined;
      if (label !== undefined) return { label, path: unwrap(candidate)?.isIdentifier() ? candidate : site };
      return { path: candidate, reason: 'Business Step name is not a statically resolved string' };
    }
    const binding = resolved?.isIdentifier() ? resolved.scope.getBinding(resolved.node.name) : undefined;
    if (resolved?.isFunctionExpression() || resolved?.isArrowFunctionExpression() || resolved?.isFunctionDeclaration()
      || binding?.constant && binding.path.isFunctionDeclaration()
      || resolved?.isCallExpression() && api(resolved.get('callee')) === 'withInput') return { label: fallback, path: candidate };
    return { path: candidate, reason: 'Business stage is not a statically identified function, Step or Workflow' };
  }

  function businessPipeline(candidate) {
    const entry = resolveValue(candidate);
    const run = entry?.isArrayExpression() ? entry : resolveValue(fields(entry)?.get('run'));
    if (!run?.isArrayExpression() || !run.node.elements.length || run.node.elements.some(node => node === null || node.type === 'SpreadElement')) return;
    return run.get('elements');
  }

  // Only explicit framework construction is recognized. Never infer method ownership
  // from a method name alone, or inspect a predicate/rule body.
  function rootedComposition(candidate, factory = 'workflow', methods = ['then', 'branch']) {
    const seen = new Set();
    for (let path = resolveValue(candidate); path?.isCallExpression() && !seen.has(path.node);) {
      seen.add(path.node);
      const callee = unwrap(path.get('callee'));
      if (api(callee) === factory) return true;
      if (!callee?.isMemberExpression()) return false;
      const method = callee.node.computed ? literal(callee.get('property')) : callee.node.property.name;
      if (!methods.includes(method)) return false;
      path = resolveValue(callee.get('object'));
    }
    return false;
  }

  function processLabels(candidate, ancestors = new Set(), budget = { left: 1024 }, provenRoot = false) {
    const path = resolveValue(candidate);
    if (!path?.isCallExpression() || ancestors.has(path.node) || !provenRoot && !rootedComposition(path, 'process', ['through', 'effect', 'commit'])) return;
    if (--budget.left < 0) return { labels: [], nodes: [path.node], unresolved: [{ path, reason: 'Process exceeds the static expansion limit of 1024 construction calls' }] };
    if (api(path.get('callee')) === 'process') return { labels: [], nodes: [path.node], unresolved: [] };
    const next = new Set(ancestors); next.add(path.node);
    const callee = unwrap(path.get('callee')), args = path.get('arguments');
    const method = callee.node.computed ? literal(callee.get('property')) : callee.node.property.name;
    const result = processLabels(callee.get('object'), next, budget, true);
    if (!result) return;
    const appendWorkflow = (flow, site) => {
      const metadata = flow && workflowLabels(flow, next, budget);
      if (!metadata) result.unresolved.push({ path: site, reason: 'Process Workflow is not a statically resolved local declaration' });
      else {
        // A reused local Workflow must identify the two connection sites, rather
        // than report the same original label literal as both locations.
        result.labels.push(...metadata.labels.map(item => ({ ...item, path: unwrap(site)?.isIdentifier() ? site : item.path })));
        result.unresolved.push(...metadata.unresolved); result.nodes.push(...metadata.nodes);
      }
    };
    if (method === 'through') appendWorkflow(args[0], args[0] ?? path);
    else if (method === 'effect') {
      const label = literal(resolveValue(args[0]));
      if (label === undefined) result.unresolved.push({ path, reason: 'Process effect label is dynamic' });
      else result.labels.push({ label, path: args[0] });
    } else if (method === 'commit') {
      const mutation = resolveValue(args[0]);
      const definition = mutation?.isCallExpression() && api(mutation.get('callee')) === 'bindMutation' && fields(mutation.get('arguments')[0]);
      if (!definition) result.unresolved.push({ path: args[0] ?? path, reason: 'Process commit is not a statically resolved bindMutation declaration' });
      else {
        appendWorkflow(definition.get('workflow'), args[0] ?? path);
        const operation = definition.get('operation'), label = operation && literal(resolveValue(operation));
        if (label === undefined) result.unresolved.push({ path: operation ?? path, reason: 'Process commit operation label is dynamic or absent' });
        else result.labels.push({ label, path: operation });
      }
    }
    result.nodes.push(path.node); return result;
  }
  function workflowLabels(candidate, ancestors = new Set(), budget = { left: 1024 }, provenRoot = false) {
    const path = resolveValue(candidate);
    if (!path?.isCallExpression() || ancestors.has(path.node) || !provenRoot && !rootedComposition(path)) return;
    if (--budget.left < 0) return { labels: [], nodes: [path.node], unresolved: [{ path, reason: 'Workflow exceeds the static expansion limit of 1024 construction calls' }] };
    const next = new Set(ancestors); next.add(path.node);
    const callee = unwrap(path.get('callee'));
    const args = path.get('arguments');
    let result;
    if (api(callee) === 'workflow') result = { labels: [], unresolved: [], nodes: [] };
    else if (callee?.isMemberExpression()) {
      const method = callee.node.computed ? literal(callee.get('property')) : callee.node.property.name;
      if (method !== 'then' && method !== 'branch') return;
      result = workflowLabels(callee.get('object'), next, budget, true);
      if (!result) return;
      if (method === 'branch') {
        const name = literal(resolveValue(args[0]));
        if (name === undefined) result.unresolved.push({ path, reason: 'Workflow branch label is dynamic' });
        else for (const choice of ['yes', 'no']) result.labels.push({ label: `${name}:${choice}`, path: args[0] });
        const paths = fields(args[2]);
        if (!paths) result.unresolved.push({ path, reason: 'Workflow branches are not a statically resolved data object' });
        else for (const choice of ['yes', 'no']) {
          const child = paths.get(choice);
          const branch = child && workflowLabels(child, next, budget);
          if (!branch) result.unresolved.push({ path: child ?? path, reason: 'Workflow branch body is unresolved, cyclic, or exceeds the static expansion limit' });
          else {
            result.labels.push(...branch.labels); result.unresolved.push(...branch.unresolved); result.nodes.push(...branch.nodes);
          }
        }
        result.nodes.push(path.node); return result;
      }
    } else return;
    const label = literal(resolveValue(args[0]));
    if (label === undefined) result.unresolved.push({ path, reason: 'Workflow step label is dynamic' });
    else result.labels.push({ label, path: args[0] });
    result.nodes.push(path.node); return result;
  }

  return { resolveValue, api, fields, processLabels, workflowLabels, businessStage, businessPipeline };
}

// Resolve only named imports of immutable const values or function declarations from the explicit
// input set. No filesystem lookup, package resolution, module import or evaluation.
function selectedSourceImports(parsed) {
  const modules = new Map();
  for (const item of parsed) {
    let program;
    traverse(item.ast, { Program(path) { program = path; path.stop(); } });
    const exports = new Map();
    for (const statement of program.get('body')) {
      if (!statement.isExportNamedDeclaration() || statement.node.source || statement.node.exportKind === 'type') continue;
      const declaration = statement.get('declaration');
      if (declaration?.isVariableDeclaration({ kind: 'const' })) {
        for (const entry of declaration.get('declarations')) if (entry.get('id').isIdentifier()) exports.set(entry.node.id.name, program.scope.getBinding(entry.node.id.name));
      } else if (declaration?.isFunctionDeclaration() && declaration.node.id) {
        exports.set(declaration.node.id.name, program.scope.getBinding(declaration.node.id.name));
      } else for (const entry of statement.get('specifiers')) if (entry.isExportSpecifier() && entry.node.exportKind !== 'type') {
        const name = entry.node.exported.name ?? entry.node.exported.value;
        exports.set(name, program.scope.getBinding(entry.node.local.name));
      }
    }
    const key = resolve(item.file);
    // Duplicate input identities are ambiguous; do not pick an arbitrary source.
    modules.set(key, modules.has(key) ? null : { program, exports });
  }
  const imports = new Map();
  for (const item of modules.values()) {
    if (!item) continue;
    for (const statement of item.program.get('body')) {
      if (!statement.isImportDeclaration() || statement.node.importKind === 'type') continue;
      const specifier = statement.node.source.value;
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
      const absolute = resolve(dirname(item.program.node.loc.filename), specifier);
      const candidates = [absolute];
      if (/\.js$/.test(absolute)) candidates.push(absolute.slice(0, -3) + '.ts', absolute.slice(0, -3) + '.tsx');
      else if (/\.mjs$/.test(absolute)) candidates.push(absolute.slice(0, -4) + '.mts');
      else if (/\.cjs$/.test(absolute)) candidates.push(absolute.slice(0, -4) + '.cts');
      const matches = candidates.filter(candidate => modules.has(candidate));
      if (matches.length !== 1) continue;
      const target = modules.get(matches[0]);
      if (!target) continue;
      for (const entry of statement.get('specifiers')) {
        if (!entry.isImportSpecifier() || entry.node.importKind === 'type') continue;
        const name = entry.node.imported.name ?? entry.node.imported.value;
        const binding = target.exports.get(name);
        if (!binding?.constant) continue;
        const value = binding.path.isFunctionDeclaration() ? binding.path
          : binding.path.isVariableDeclarator() && binding.path.parent.kind === 'const' ? binding.path.get('init') : undefined;
        if (!value?.node) continue;
        const local = item.program.scope.getBinding(entry.node.local.name);
        if (local) imports.set(local, value);
      }
    }
  }
  return imports;
}

/** Parse selected sources only. Never import a module or evaluate an expression. */
export function analyzeDeclarations(files) {
  const diagnostics = [], unresolved = [], ids = new Map(); let checkedDeclarations = 0, checkedOperationIds = 0, checkedBusinessRuleLabels = 0;
  const report = (code, severity, file, path, message, related = []) => diagnostics.push({ code, severity, ...position(file, path), message, related });
  const skip = (file, path, reason) => unresolved.push({ ...position(file, path), reason });
  const operationId = (value, file, path) => {
    checkedOperationIds++;
    if (ids.has(value)) report('REPEATED_OPERATION_ID', 'warning', file, path, `Operation ID ${JSON.stringify(value)} appears in another selected declaration; confirm whether the shared persistence identity is intentional.`, [ids.get(value)]);
    else ids.set(value, position(file, path));
  };
  const parsed = [];
  for (const { file, source } of files) {
    try { parsed.push({ file, ast: parse(source, { sourceType: 'module', sourceFilename: file, plugins: ['typescript', ...(/\.[jt]sx$/i.test(file) ? ['jsx'] : [])], attachComment: false }) }); }
    catch (error) { diagnostics.push({ code: 'PARSE_ERROR', severity: 'error', file, line: error.loc?.line ?? 1, column: (error.loc?.column ?? 0) + 1, message: error.message, related: [] }); }
  }
  const { resolveValue, api, fields, processLabels, workflowLabels, businessStage, businessPipeline } = declarationTools(selectedSourceImports(parsed));
  for (const { file, ast } of parsed) {
    const coveredCompositions = new Set(), reportedLabelPairs = new Set();
    traverse(ast, { CallExpression(path) {
      if (!coveredCompositions.has(path.node)) {
        const processMetadata = processLabels(path);
        const workflow = processMetadata ?? workflowLabels(path);
        if (workflow) {
          checkedDeclarations++;
          workflow.nodes.forEach(node => coveredCompositions.add(node));
          for (const item of workflow.unresolved) skip(file, item.path, item.reason);
          const labels = new Map();
          for (const item of workflow.labels) {
            const previous = labels.get(item.label);
            if (previous) {
              const pair = `${previous.node.loc.filename}:${previous.node.start}:${item.path.node.loc.filename}:${item.path.node.start}:${item.label}`;
              if (!reportedLabelPairs.has(pair)) {
                report(processMetadata ? 'AMBIGUOUS_PROCESS_LABEL' : 'AMBIGUOUS_WORKFLOW_LABEL', 'warning', file, item.path,
                  `${processMetadata ? 'Process' : 'Workflow'} trace label ${JSON.stringify(item.label)} repeats in this declared composition; use distinct labels if traces must identify the stage. This includes alternative branches and does not prove repeated execution or an invalid business rule.`, [position(file, previous)]);
                reportedLabelPairs.add(pair);
              }
            } else labels.set(item.label, item.path);
          }
        }
      }
      const name = api(path.get('callee'));
      if (!factories.has(name) && name !== 'defineTransition' && name !== 'defineApplication' && name !== 'business') return;
      const definition = fields(path.get('arguments')[0]);
      if (!definition) { skip(file, path, 'Definition is not a statically resolved object of data properties'); return; }
      checkedDeclarations++;
      if (factories.has(name)) {
        const operation = definition.get('operation');
        const value = operation && literal(resolveValue(operation));
        if (value === undefined) { skip(file, path, 'Operation ID is dynamic or absent'); return; }
        operationId(value, file, operation);
      } else if (name === 'defineApplication' || name === 'business') {
        const table = definition.get('operations');
        const operations = table && fields(table);
        if (!operations) { skip(file, path, 'Operation table is computed, spread, or supplied by another function'); return; }
        // business.then is already rejected by its public type declaration.
        if (name === 'defineApplication') for (const [key, value] of operations) {
          if (key === 'dismiss' || key.startsWith('@')) report('RESERVED_APPLICATION_OPERATION', 'error', file, value.parentPath.get('key'), `Operation ${JSON.stringify(key)} is reserved by Application; rename the public operation.`);
        }
        if (name === 'business') {
          const budget = { left: 1024 };
          for (const [key, entry] of operations) {
            if (budget.left < 0) continue;
            const stages = businessPipeline(entry);
            if (!stages) { skip(file, entry, `Business ${JSON.stringify(key)} pipeline is not a nonempty static array without holes or spreads`); continue; }
            const labels = new Map();
            for (const [index, candidate] of stages.entries()) {
              const stage = businessStage(candidate, `run:${index + 1}`, budget);
              if (stage.reason) skip(file, stage.path, `${key}[${index}]: ${stage.reason}`);
              else {
                for (const item of stage.unresolved ?? []) skip(file, item.path, `${key}[${index}]: ${item.reason}`);
                for (const item of stage.labels ?? [stage]) {
                  checkedBusinessRuleLabels++;
                  if (labels.has(item.label)) report('AMBIGUOUS_BUSINESS_RULE_LABEL', 'warning', file, item.path,
                    `Business ${JSON.stringify(key)} rule label ${JSON.stringify(item.label)} repeats in this pipeline; use distinct labels if traces must identify the stage. Branch alternatives are included; this is not a type check or a proof of repeated execution.`, [labels.get(item.label)]);
                  else labels.set(item.label, position(file, item.path));
                }
              }
              if (budget.left < 0) break;
            }
          }
        }
        if (name === 'business' && operations.size) {
          if (definition.has('operation')) { skip(file, definition.get('operation'), 'Business operation resolver is not evaluated'); return; }
          const prefix = definition.get('name') && resolveValue(definition.get('name'));
          const value = prefix?.isStringLiteral() || prefix?.isTemplateLiteral() && prefix.node.expressions.length === 0 ? literal(prefix) : undefined;
          if (value === undefined) { skip(file, path, 'Business name is dynamic or absent; default operation IDs are unresolved'); return; }
          for (const [key, entry] of operations) operationId(`${value}.${key}`, file, entry.parentPath.get('key'));
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
  return { schema: 'koyuki.declaration-diagnostics.v1', scope: 'static-source-metadata', checkedDeclarations, checkedOperationIds, checkedBusinessRuleLabels, diagnostics, unresolved };
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
    console.log(`Checked ${report.checkedDeclarations} declarations and ${report.checkedOperationIds} operation IDs; ${report.diagnostics.length} diagnostics; ${report.unresolved.length} unresolved metadata items. This is not a type check or a proof of business correctness.`);
  }
  process.exitCode = report.diagnostics.some(item => item.severity === 'error' || strict && item.severity === 'warning') ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 2; });
}
