#!/usr/bin/env node
// Publish fully processed output from the pinned `aztec compile`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const dir = path.dirname(fileURLToPath(import.meta.url));
const expected = fs.readFileSync(path.join(dir, '../../../.aztec-version'), 'utf8').trim();
const actual = execFileSync('aztec', ['--version'], { encoding: 'utf8' }).trim();
if (actual !== expected) throw new Error(`Expected Aztec ${expected}, got ${actual}`);
const input = process.argv[2] ?? path.join(dir, '../../../billboard/target/billboard_contract-Billboard.json');
const artifact = JSON.parse(fs.readFileSync(input, 'utf8'));
if (!artifact.transpiled || artifact.functions.some(f => f.custom_attributes?.includes('abi_private') && !f.verification_key)) {
  throw new Error('Artifact is not fully processed. Run aztec compile with the pinned toolchain first.');
}
const outputs = process.argv[3] ? [process.argv[3]] : [path.join(dir, 'billboard_artifact.json'), path.join(dir, 'deploy/billboard_artifact.json')];
for (const output of outputs) {
  fs.writeFileSync(output, JSON.stringify(artifact));
  console.log(`Published artifact: ${output}`);
}
