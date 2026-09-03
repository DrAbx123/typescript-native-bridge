#!/usr/bin/env node
// Full-walk checker-API stock differential — the same harness as
// triage-checker-differential, parameterized (see the harness header).
process.argv.push('--full-walk');
await import('./triage-checker-differential.mjs');
