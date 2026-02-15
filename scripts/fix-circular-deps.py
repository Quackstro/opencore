#!/usr/bin/env python3
"""Patch circular __exportAll imports in bundled dist output.

tsdown/rollup sometimes creates circular chunks where __exportAll (a bundler helper)
is imported from a chunk that itself imports from the chunk defining __exportAll.
This causes a TDZ error at module evaluation time in Node.js.

Fix: inline the __exportAll helper in affected files.
"""
import glob, sys

INLINE = '''var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
\tlet target = {};
\tfor (var name in all) {
\t\t__defProp(target, name, {
\t\t\tget: all[name],
\t\t\tenumerable: true
\t\t});
\t}
\tif (!no_symbols) {
\t\t__defProp(target, Symbol.toStringTag, { value: "Module" });
\t}
\treturn target;
};
'''

# Find the pattern: import { XX as __exportAll } from "./subagent-registry-HASH.js";
import re
PATTERN = re.compile(r'import \{ \w+ as __exportAll \} from "\./subagent-registry-[^"]+\.js";\n')

count = 0
for f in glob.glob('dist/*.js'):
    with open(f, 'r') as fh:
        content = fh.read()
    new_content = PATTERN.sub(INLINE, content)
    if new_content != content:
        with open(f, 'w') as fh:
            fh.write(new_content)
        count += 1

print(f"Patched {count} files with inlined __exportAll")
if count == 0:
    print("No circular __exportAll imports found (may already be fixed)")
