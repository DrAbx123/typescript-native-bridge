#!/usr/bin/env node
/**
 * Go Type-cast guard gate (issues #69/#70 bug class).
 *
 * TNB's Go-side additions (patches/typescript-go/overlay + the added lines of
 * patches/typescript-go/*.patch) cast *checker.Type values through the As*()
 * families defined in typescript-go/internal/checker/types.go:
 *
 *   - nil-returning — `func (t *TypeBase) AsX() *X { return nil }`: a cast on
 *     the wrong data shape returns nil, so a chained deref (`AsX().field`) or
 *     an unguarded assignment deref is a nil-pointer crash;
 *   - panicking — `func (t *Type) AsX() *X { return t.data.(*X) }`: the cast
 *     itself panics on the wrong data shape.
 *
 * Stock JS reads the same accessors as undefined no-ops (issues #69/#70, where
 * `t.AsInterfaceType().thisType` nil-deref'd on a cloned tuple reference), so
 * either failure mode is a bridge-introduced crash. The two families are
 * derived from types.go (post-patch working tree) — never hardcoded.
 *
 * Rules (each skipped when the flagged line carries `// asguard:exempt <reason>`;
 * for Rule B the flagged line is the assignment line):
 *   Rule A — `As<Family>()` followed directly by `.` on one line: chained
 *            deref (nil-family = nil deref, panicking = hard assertion).
 *   Rule B — `X := ...As<NilFamily>()` where X is deref'd (`X.`) within the
 *            next 5 lines without an `X == nil` / `X != nil` guard. A site
 *            with no X use in the window is not flagged (tripwire heuristic:
 *            a deref beyond the window escapes, by design).
 *
 * Scope:
 *   - patches/typescript-go/overlay — every .go file, all lines (the overlay
 *     is entirely TNB code);
 *   - patches/typescript-go/*.patch — added lines only (`+`, never `+++`),
 *     file tracked from each `+++ b/<path>` header, `.go` targets only. Rule
 *     B's window walks the hunk's added-line sequence, so stock context lines
 *     never count against an added assignment.
 *
 * Usage: node tools/check-go-as-guards.mjs
 * Exit: 0 = no violations.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES_GO = path.join(repoRoot, 'typescript-go', 'internal', 'checker', 'types.go');
const OVERLAY_DIR = path.join(repoRoot, 'patches', 'typescript-go', 'overlay');
const PATCH_DIR = path.join(repoRoot, 'patches', 'typescript-go');

// ── Family derivation (types.go, post-patch working tree) ────────────────────
const typesSrc = fs.readFileSync(TYPES_GO, 'utf8');
const nilFamily = new Set();
for (const m of typesSrc.matchAll(/func \(t \*TypeBase\) (As\w+)\(\)\s*\*\w+\s*\{\s*return nil\s*\}/g)) {
    nilFamily.add(m[1]);
}
const panicFamily = new Set();
for (const m of typesSrc.matchAll(/func \(t \*Type\) (As\w+)\(\)\s*\*\w+\s*\{\s*return t\.data\.\(\*/g)) {
    panicFamily.add(m[1]);
}
const familyNames = [...new Set([...nilFamily, ...panicFamily])];
if (familyNames.length === 0) {
    console.error(`FAIL: no As* cast families derived from ${path.relative(repoRoot, TYPES_GO)}`);
    process.exit(1);
}

const familyAlt = familyNames.join('|');
const nilAlt = [...nilFamily].join('|');
const anyAsCallRe = new RegExp(`\\b(?:${familyAlt})\\(\\)`, 'g');
const ruleARe = new RegExp(`\\b(?:${familyAlt})\\(\\)\\.\\w+`, 'g');
const ruleBCallRe = new RegExp(`\\b(?:${nilAlt})\\(\\)`, 'g');
const assignRe = /(\w+)\s*:=/g;
const exemptRe = /\/\/\s*asguard:exempt\s+\S/;

function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/, '');
}
function derefRe(v) {
    return new RegExp(`\\b${v}\\.`);
}
function guardRe(v) {
    return new RegExp(`\\b${v}\\s*(?:==|!=)\\s*nil\\b|\\bnil\\s*(?:==|!=)\\s*${v}\\b`);
}

const violations = [];
let sitesChecked = 0;

// record: { displayPath, line, text, origin } — text is the raw source line.
function checkLine(rec) {
    rec.exempt = exemptRe.test(rec.text);
    rec.code = stripComments(rec.text);
    if (!rec.exempt) {
        sitesChecked += rec.code.match(anyAsCallRe)?.length ?? 0;
        const chains = rec.code.match(ruleARe);
        if (chains) {
            const family = chains[0].match(/As\w+/)[0];
            violations.push({
                ...rec,
                rule: 'Rule A',
                msg: `chained deref \`${chains[0]}\` (${nilFamily.has(family) ? 'nil-returning' : 'panicking'} cast)`,
            });
        }
    }
}

/** `X := ...As<NilFamily>()` sites on one line, each with the rest-of-line tail. */
function nilAssignments(code) {
    const sites = [];
    for (const call of code.matchAll(ruleBCallRe)) {
        const prefix = code.slice(0, call.index);
        const assigns = [...prefix.matchAll(assignRe)];
        if (assigns.length === 0) continue;
        sites.push({
            varName: assigns[assigns.length - 1][1],
            callName: call[0],
            rest: code.slice(call.index + call[0].length),
        });
    }
    return sites;
}

/** Rule B over a line sequence; the window is the next 5 records (file lines
 *  for the overlay, hunk added-lines for patches). */
function ruleB(recs, idx) {
    const rec = recs[idx];
    if (!rec || rec.exempt) return;
    for (const site of nilAssignments(rec.code)) {
        let deref = derefRe(site.varName).test(site.rest);
        let guard = guardRe(site.varName).test(site.rest);
        for (let j = idx + 1; j <= idx + 5 && j < recs.length && (!deref || !guard); j++) {
            if (!deref) deref = derefRe(site.varName).test(recs[j].code);
            if (!guard) guard = guardRe(site.varName).test(recs[j].code);
        }
        if (deref && !guard) {
            violations.push({
                ...rec,
                rule: 'Rule B',
                msg: `\`${site.varName} := ...${site.callName}\` (nil-returning cast) deref'd within 5 lines with no nil guard`,
            });
        }
    }
}

// ── Scope 1: overlay (all lines) ─────────────────────────────────────────────
function walkOverlay() {
    const files = [];
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.isFile() && e.name.endsWith('.go')) files.push(p);
        }
    })(OVERLAY_DIR);
    for (const f of files) {
        const recs = fs.readFileSync(f, 'utf8').split('\n')
            .map((text, i) => ({ displayPath: path.relative(repoRoot, f), line: i + 1, text, origin: null }));
        recs.forEach(checkLine);
        recs.forEach((_, i) => ruleB(recs, i));
    }
}

// ── Scope 2: patch added lines (hunk-tracked to target file lines) ───────────
function scanPatches() {
    const patchFiles = fs.readdirSync(PATCH_DIR).filter(f => f.endsWith('.patch')).sort();
    for (const pf of patchFiles) {
        const full = path.join(PATCH_DIR, pf);
        const lines = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n').split('\n');
        let target = null;
        let newLine = 0;
        let hunk = [];
        const flushHunk = () => {
            hunk.forEach((_, i) => ruleB(hunk, i));
            hunk = [];
        };
        for (let i = 0; i < lines.length; i++) {
            const raw = lines[i];
            if (raw.startsWith('+++ ')) { target = raw.slice(4).replace(/^b\//, ''); continue; }
            if (raw.startsWith('--- ') || raw.startsWith('diff --git') || raw.startsWith('index ')) {
                target = null;
                newLine = 0;
                continue;
            }
            if (!target) continue;
            if (raw.startsWith('@@')) {
                flushHunk();
                const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
                if (m) newLine = Number(m[1]);
                continue;
            }
            if (raw.startsWith('+')) {
                const rec = {
                    displayPath: path.join('typescript-go', target),
                    line: newLine,
                    text: raw.slice(1),
                    origin: `${path.relative(repoRoot, full)}:${i + 1}`,
                };
                newLine++;
                if (target.endsWith('.go')) {
                    checkLine(rec);
                    hunk.push(rec);
                }
                continue;
            }
            if (raw.startsWith('-') || raw.startsWith('\\')) continue;
            newLine++; // context line
        }
        flushHunk();
    }
}

walkOverlay();
scanPatches();

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`As*() cast families derived from ${path.relative(repoRoot, TYPES_GO)}`);
console.log(`  nil-returning (${nilFamily.size}): ${[...nilFamily].sort().join(', ')}`);
console.log(`  panicking (${panicFamily.size}): ${[...panicFamily].sort().join(', ')}`);
console.log('─'.repeat(78));

if (violations.length) {
    for (const v of violations) {
        const origin = v.origin ? `  [added at ${v.origin}]` : '';
        console.error(`FAIL: ${v.displayPath}:${v.line}: ${v.rule} — ${v.msg}${origin}`);
    }
    console.log(`VERDICT: FAIL (${sitesChecked} sites checked, ${violations.length} violation(s))`);
    process.exit(1);
}

console.log(`VERDICT: PASS (${sitesChecked} sites checked)`);
