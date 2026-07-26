#!/usr/bin/env node
// bundle-dataset.mjs — extract one dataset out of a world bundle, or splice one back in.
//
// The world bundle (studio → /api/world-bundle → FixtureWorldSource) is the source of truth for
// invariant world data, but the *exporters* that produce that data are dev tools that read and write
// loose `target/generated/**` JSON files. This is the adapter between the two, so a re-stamp can run
// through the real exporter instead of a second copy of its rules re-implemented in JS
// (docs/realms.md §Drift warning).
//
//   node tools/bundle-dataset.mjs get <bundle[.gz]> /map/provinces.json <out.json>
//   node tools/bundle-dataset.mjs put <bundle[.gz]> /map/provinces.json <in.json>
//
// `put` rewrites the bundle in place, preserving its `meta`, its dataset order and its gzipping. It
// refuses to write a dataset the bundle does not already have — this patches, it does not extend.
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';

const [, , cmd, bundlePath, key, filePath] = process.argv;
if (!cmd || !bundlePath || !key || !filePath) {
  console.error('usage: bundle-dataset.mjs get|put <bundle[.gz]> <dataset-key> <file.json>');
  process.exit(2);
}

const gz = bundlePath.endsWith('.gz');
const raw = readFileSync(bundlePath);
const bundle = JSON.parse((gz ? gunzipSync(raw) : raw).toString('utf8'));
if (!bundle.resources || !(key in bundle.resources)) {
  console.error(`bundle ${bundlePath} has no dataset ${key}`);
  process.exit(1);
}

if (cmd === 'get') {
  const data = bundle.resources[key];
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  console.log(`${key}: ${Array.isArray(data) ? data.length + ' rows' : typeof data} → ${filePath}`);
} else if (cmd === 'put') {
  const next = JSON.parse(readFileSync(filePath, 'utf8'));
  const before = bundle.resources[key];
  bundle.resources[key] = next;
  const json = JSON.stringify(bundle);
  writeFileSync(bundlePath, gz ? gzipSync(json) : Buffer.from(json, 'utf8'));
  const n = a => (Array.isArray(a) ? a.length : '?');
  console.log(`${key}: ${n(before)} → ${n(next)} rows, wrote ${bundlePath}`);
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
}
