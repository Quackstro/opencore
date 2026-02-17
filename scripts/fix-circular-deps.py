#!/usr/bin/env python3
"""Patch bundler output issues in dist/.

1. Circular __exportAll imports: tsdown/rollup sometimes creates circular chunks
   where __exportAll is imported from a chunk that itself imports back. Node.js
   hits a TDZ error. Fix: inline the helper in affected files.

2. Reserved word 'in' used as import alias for __exportAll in plugin-sdk chunks.
   Node.js can't resolve the live binding due to circular deps. Fix: inline the
   helper in those files too.
"""
import glob, re, sys

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

# ---------------------------------------------------------------------------
# Fix 1: Inline __exportAll imported from subagent-registry circular chunks
# ---------------------------------------------------------------------------
CIRCULAR_PATTERN = re.compile(r'import \{ \w+ as __exportAll \} from "\./subagent-registry-[^"]+\.js";\n')

count1 = 0
for f in glob.glob('dist/**/*.js', recursive=True):
    with open(f, 'r') as fh:
        content = fh.read()
    new_content = CIRCULAR_PATTERN.sub(INLINE, content)
    if new_content != content:
        with open(f, 'w') as fh:
            fh.write(new_content)
        count1 += 1

print(f"[1/2] Patched {count1} files with inlined __exportAll (subagent-registry)")

# ---------------------------------------------------------------------------
# Fix 2: Inline __exportAll imported as reserved word 'in' from reply chunks
# ---------------------------------------------------------------------------
RESERVED_PATTERN = re.compile(r'import \{ \w+ as __exportAll \} from "\./reply-[^"]+\.js";\n')

count2 = 0
for f in glob.glob('dist/**/*.js', recursive=True):
    with open(f, 'r') as fh:
        content = fh.read()
    new_content = RESERVED_PATTERN.sub(INLINE, content)
    if new_content != content:
        with open(f, 'w') as fh:
            fh.write(new_content)
        count2 += 1

print(f"[2/2] Patched {count2} files with inlined __exportAll (reply/in)")
