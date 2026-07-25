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
// Scoped to names a module could plausibly have MEANT to import: an identifier that appears as a bare word,
// that a module it already imports from exports, and that it does not bind locally. That last clause is where
// the difficulty lives — see localNames — because a false positive here trains people to ignore the tool, and a
// false negative is the bug it exists to catch. It caught three real missing imports on its first outings,
// including one (`cost.mjs` → `provOnScreen`) that would have thrown the moment anyone toggled that overlay.
/**
 * Every name the module BINDS locally — so a local that shadows an importable name is not reported as missing.
 *
 * Parameter lists have to be collected from actual function heads, not from "a name inside parentheses". The
 * loose version cannot tell `screenAABB(project, …)` — passing a function by reference, which this codebase does
 * in several places — from a parameter named `project`, and it resolved that the wrong way: the check stayed
 * silent when exactly that import went missing. Dropping parameters altogether is no good either, because
 * `paintBuildIcon(el, id, px)` really does shadow core's `px`. So: only `function name(…)` and `(…) =>` heads.
 */
function localNames(body) {
  const out = new Set();
  for (const m of body.matchAll(/(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  // Anything assigned to. Written so it cannot span a comma: `const px = a, py = b` must yield BOTH names, and
  // a pattern that allowed `,…` between the name and the `=` swallowed the second declarator into the first
  // match — which is how coast.mjs's `py` looked un-declared. Excluding a leading `.` keeps `o.prop =` out.
  for (const m of body.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*=(?![=>])/g)) out.add(m[2]);
  const params = [
    ...body.matchAll(/function\s*[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g),
    ...body.matchAll(/\(([^)]*)\)\s*=>/g),
  ];
  for (const m of params)
    for (const raw of m[1].split(',')) {
      const n = raw.trim().replace(/^\.\.\./, '').split(/[=:\s]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(n)) out.add(n);
    }
  for (const m of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) out.add(m[1]);   // single-param arrow
  return out;
}
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
  // A RE-EXPORT is not a use. `export { kBand } from "./band-math.mjs"` forwards a name without binding it
  // locally, so leaving these in makes every re-exporting module (bands.mjs) look like it uses what it forwards.
  //
  // Note the `*` in the quotes, not `+`: `stripped` has already emptied every string literal, so by the time
  // this runs the specifier reads `from ""`. Requiring a non-empty path matched nothing at all.
  body = body.replace(/^export\s*\{[^}]*\}\s*from\s*["'][^"']*["'];?/gm, '');
  const imported = new Set();
  for (const imp of importsOf.get(f)) for (const n of imp.names) imported.add(n.local);
  const reachable = new Map();     // exported name → the module that exports it
  for (const imp of importsOf.get(f)) {
    if (!imp.from.startsWith('.')) continue;
    const target = resolve(dirname(f), imp.from);
    const ex = exportsOf.get(target);
    if (ex) for (const name of ex) if (!reachable.has(name)) reachable.set(name, imp.from);
  }
  const locals = localNames(body);
  for (const [name, from] of reachable) {
    if (imported.has(name)) continue;
    // Any USE of the bare identifier — not just a call. Three variants slipped past narrower versions of this
    // during the terrain-3d conversions, each costing a headless round to trace back from a blank page:
    //   project(x)          a plain call
    //   f(...project(x))    a spread call, whose leading `...` looks like a member access
    //   screenAABB(project) the identifier as a VALUE, never called at all
    // So the test is simply "does this name appear as a standalone word", with the two things it must not be:
    // a member access (`o.project`, but `...project` is fine) and a property key (`{ project: … }`).
    const used = new RegExp(`(^|[^.:\\w$]|\\.\\.\\.)${name}\\b(?!\\s*:)`);
    if (!used.test(body)) continue;
    if (locals.has(name)) continue;                                 // declared locally — shadowing, not a bug
    console.log(`NOT IMPORTED    ${f}: calls '${name}' — exported by ${from} but absent from its import list`);
    bad++;
  }
}

console.log(bad ? `\n${bad} problem(s)` : `\nOK — ${files.length} modules; imports resolve, are used, and every called import is declared`);
process.exit(bad ? 1 : 0);
