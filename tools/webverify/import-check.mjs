// Static check: every named import resolves to a real export, and no module imports a symbol it
// doesn't use. Cheap guard against the ReferenceError class of bug the sea.mjs extraction can cause
// (a moved symbol still referenced, or a now-unused import left behind).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || 'web/js');
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith('.mjs') && !e.endsWith('.test.mjs')) files.push(p);
  }
})(ROOT);

const exportsOf = new Map();   // file -> Set(exported names)
const importsOf = new Map();   // file -> [{from, names}]
const srcOf = new Map();

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  srcOf.set(f, src);
  const ex = new Set();
  // export const/let/function/class NAME
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) ex.add(m[1]);
  // export { a, b as c }
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm))
    for (const part of m[1].split(','))
      { const t = part.trim(); if (t) ex.add((t.split(/\s+as\s+/)[1] || t).trim()); }
  exportsOf.set(f, ex);

  const imps = [];
  for (const m of src.matchAll(/^import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/gm)) {
    const names = m[1].split(',').map(s => s.trim()).filter(Boolean)
      .map(s => { const [orig, alias] = s.split(/\s+as\s+/).map(x => x.trim()); return { orig, local: alias || orig }; });
    imps.push({ from: m[2], names, raw: m[0] });
  }
  importsOf.set(f, imps);
}

let bad = 0;
for (const f of files) {
  for (const imp of importsOf.get(f)) {
    if (!imp.from.startsWith('.')) continue;
    const target = resolve(dirname(f), imp.from);
    if (!exportsOf.has(target)) { console.log(`MISSING MODULE  ${f} -> ${imp.from}`); bad++; continue; }
    const ex = exportsOf.get(target);
    for (const n of imp.names) {
      if (!ex.has(n.orig)) { console.log(`NOT EXPORTED    ${f}: '${n.orig}' from ${imp.from}`); bad++; }
      // used anywhere outside the import statement itself?
      const body = srcOf.get(f).replace(imp.raw, '');
      if (!new RegExp(`\\b${n.local.replace(/\$/g, '\\$')}\\b`).test(body)) {
        console.log(`UNUSED IMPORT   ${f}: '${n.local}' from ${imp.from}`); bad++;
      }
    }
  }
}
// The MIRROR of the checks above, and the one that actually bites. The two directions are not the same
// question: above is "is every import real and used?", this is "is every USE imported?" — a module that calls
// `project(...)` while its import list from core.mjs only names `pxr` passes every check above and then throws
// ReferenceError on the first paint. That happened twice during the terrain-3d P2 call-site conversion
// (`pll`, then `project`), each time costing a full headless round to diagnose from a blank page.
//
// Deliberately conservative, because a false positive here is worse than a miss: only identifiers that the
// module CALLS as functions, that a module it already imports from exports, and that are not declared locally.
// A shadowing local (`const project = ...`) is therefore not flagged, and neither is anything reached through a
// namespace or a property.
const DECL = n => new RegExp(`(?:function|const|let|var|class)\\s+${n}\\b|\\b${n}\\s*(?:,[^=]*)?=[^=>]|\\(\\s*(?:[^)]*,\\s*)?${n}\\s*[,)]`);
// COMMENTS MUST GO FIRST. This codebase comments densely and names the symbols it discusses — half of
// terrain3d.mjs's prose mentions project() and K_TEX — so scanning raw source reports the documentation as
// dead code. Strings go too: a name inside a template or a selector is not a call.
const stripped = s => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')                       // block comments (incl. the file headers)
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')                    // line comments, but not the // in a URL
  .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')                // template literals
  .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""');  // plain strings
for (const f of files) {
  const src = srcOf.get(f);
  let body = stripped(src);
  for (const imp of importsOf.get(f)) body = body.replace(stripped(imp.raw), '');
  const imported = new Set();
  for (const imp of importsOf.get(f)) for (const n of imp.names) imported.add(n.local);
  const reachable = new Map();     // exported name → the module that exports it
  for (const imp of importsOf.get(f)) {
    if (!imp.from.startsWith('.')) continue;
    const target = resolve(dirname(f), imp.from);
    const ex = exportsOf.get(target);
    if (ex) for (const name of ex) if (!reachable.has(name)) reachable.set(name, imp.from);
  }
  for (const [name, from] of reachable) {
    if (imported.has(name)) continue;
    // A CALL, not a member access and not a property key: `o.project(x)` is someone else's method and
    // `{ project: (x) => … }` is a definition, so neither may be preceded by `.` or `:`.
    if (!new RegExp(`(^|[^.:\\w$])${name}\\s*\\(`).test(body)) continue;
    if (DECL(name).test(body)) continue;                            // declared locally — shadowing, not a bug
    console.log(`NOT IMPORTED    ${f}: calls '${name}' — exported by ${from} but absent from its import list`);
    bad++;
  }
}

console.log(bad ? `\n${bad} problem(s)` : `\nOK — ${files.length} modules; imports resolve, are used, and every called import is declared`);
process.exit(bad ? 1 : 0);
