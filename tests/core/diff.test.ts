import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchesAny, parseDiff, parseHunkHeader, safePath } from '../../src/core/diff.ts'
import type { FileDiff } from '../../src/core/types.ts'

const LIMITS = { maxBytes: 4_000_000, maxLineChars: 2000 }
const diff = (...lines: string[]): string => lines.join('\n') + '\n'
const read = (text: string, l = LIMITS) => parseDiff(text, l)
const single = (text: string): FileDiff => {
  const d = read(text)
  assert.equal(d.files.length, 1, JSON.stringify(d.files.map((f) => f.path)))
  return d.files[0]
}

// Shapes taken from the real output of git 2.x (git diff -M, core.quotepath on and off).

test('modification: hunks, counts and line numbers of the additions', () => {
  const f = single(diff(
    'diff --git a/plain.txt b/plain.txt',
    'index fb85c0a..2c6d4c5 100644',
    '--- a/plain.txt',
    '+++ b/plain.txt',
    '@@ -1,3 +1,4 @@',
    ' one',
    '-two',
    '+TWO',
    ' three',
    '+four',
    '@@ -10,2 +11,3 @@ def function():',
    ' a',
    '+b',
    ' c',
  ))
  assert.equal(f.path, 'plain.txt')
  assert.equal(f.status, 'M')
  assert.equal(f.oldPath, undefined)
  assert.equal(f.added, 3)
  assert.equal(f.removed, 1)
  assert.deepEqual(f.addedLines, [{ number: 2, text: 'TWO' }, { number: 4, text: 'four' }, { number: 12, text: 'b' }])
  assert.equal(f.hunks.length, 2)
  assert.deepEqual(f.hunks[1], { header: '@@ -10,2 +11,3 @@ def function():', lines: [' a', '+b', ' c'], newStart: 11 })
  assert.equal(f.header, 'diff --git a/plain.txt b/plain.txt\nindex fb85c0a..2c6d4c5 100644\n--- a/plain.txt\n+++ b/plain.txt')
})

test('new and deleted file', () => {
  const d = read(diff(
    'diff --git a/deleted.txt b/deleted.txt',
    'deleted file mode 100644',
    'index 268eb40..0000000',
    '--- a/deleted.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-deleted',
    'diff --git a/new.sql b/new.sql',
    'new file mode 100644',
    'index 0000000..7113542',
    '--- /dev/null',
    '+++ b/new.sql',
    '@@ -0,0 +1 @@',
    '+-- sql comment',
  ))
  assert.deepEqual(d.files.map((f) => [f.status, f.path, f.added, f.removed]), [['D', 'deleted.txt', 0, 1], ['A', 'new.sql', 1, 0]])
  assert.deepEqual(d.files[1].addedLines, [{ number: 1, text: '-- sql comment' }])
  assert.equal(d.files[0].hunks[0].newStart, 0)
})

test('rename with changes and pure rename (also with spaces in the name)', () => {
  const d = read(diff(
    'diff --git a/old.py b/new.py',
    'similarity index 63%',
    'rename from old.py',
    'rename to new.py',
    'index 32f33f9..d3231eb 100644',
    '--- a/old.py',
    '+++ b/new.py',
    '@@ -1,4 +1,4 @@',
    ' to rename',
    ' line 2',
    ' line 3',
    '-line 4',
    '+line 4 changed',
    'diff --git a/tmp_n.txt b/re name.txt',
    'similarity index 100%',
    'rename from tmp_n.txt',
    'rename to re name.txt',
  ))
  assert.deepEqual(d.files.map((f) => [f.status, f.path, f.oldPath]), [['R', 'new.py', 'old.py'], ['R', 're name.txt', 'tmp_n.txt']])
  assert.deepEqual(d.files[0].addedLines, [{ number: 4, text: 'line 4 changed' }])
  assert.equal(d.files[1].hunks.length, 0)
  assert.match(d.files[1].header, /^diff --git .*\nsimilarity index 100%\nrename from tmp_n\.txt\nrename to re name\.txt$/)
})

test('binaries: "Binary files … differ" and GIT binary patch, the base85 lines are skipped', () => {
  const d = read(diff(
    'diff --git a/bin.dat b/bin.dat',
    'index 8352675..c5793f9 100644',
    'Binary files a/bin.dat and b/bin.dat differ',
    'diff --git a/logo.png b/logo.png',
    'new file mode 100644',
    'index 0000000000000000000000000000000000000000..c5793f98784f13b7d87422d8fa5b096867553a45',
    'GIT binary patch',
    'literal 3',
    'KcmZSJWC8#H7XS<Z',
    '',
    'literal 0',
    'HcmV?d00001',
    '',
    'diff --git a/after.txt b/after.txt',
    '--- a/after.txt',
    '+++ b/after.txt',
    '@@ -1 +1 @@',
    '-x',
    '+y',
  ))
  assert.deepEqual(d.files.map((f) => [f.status, f.path, f.hunks.length, f.added]), [
    ['B', 'bin.dat', 0, 0], ['B', 'logo.png', 0, 0], ['M', 'after.txt', 1, 1],
  ])
  assert.doesNotMatch(d.files[1].header, /KcmZ/)
})

test('paths quoted by git: tab, UTF-8 octals, spaces with the trailing tab', () => {
  const d = read(diff(
    'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
    'index b680253..67d0c15 100644',
    '--- "a/caf\\303\\251.txt"',
    '+++ "b/caf\\303\\251.txt"',
    '@@ -1 +1 @@',
    '-z',
    '+z2',
    'diff --git "a/with\\ttab.txt" "b/with\\ttab.txt"',
    'index 975fbec..1a78173 100644',
    '--- "a/with\\ttab.txt"',
    '+++ "b/with\\ttab.txt"',
    '@@ -1 +1 @@',
    '-y',
    '+y2',
    'diff --git a/with space.txt b/with space.txt',
    'index 587be6b..d735d34 100644',
    '--- a/with space.txt\t',
    '+++ b/with space.txt\t',
    '@@ -1 +1 @@',
    '-x',
    '+x2',
    // with core.quotepath=off non-ASCII characters arrive as they are
    'diff --git a/naïve.txt b/naïve.txt',
    '--- a/naïve.txt',
    '+++ b/naïve.txt',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    // quotes and escapes in the name, invalid bytes → U+FFFD
    'diff --git "a/x\\"y\\\\z\\377.txt" "b/x\\"y\\\\z\\377.txt"',
    'new file mode 100644',
    '--- /dev/null',
    '+++ "b/x\\"y\\\\z\\377.txt"',
    '@@ -0,0 +1 @@',
    '+q',
  ))
  assert.deepEqual(d.files.map((f) => f.path), [
    'café.txt', 'with\ttab.txt', 'with space.txt', 'naïve.txt', 'x"y\\z\ufffd.txt',
  ])
  assert.deepEqual(d.files.map((f) => f.status), ['M', 'M', 'M', 'M', 'A'])
})

test('a file without --- and +++ (mode change) takes its name from the diff --git line', () => {
  const d = read(diff(
    'diff --git a/with space.sh b/with space.sh',
    'old mode 100644',
    'new mode 100755',
    'diff --git "a/x y" "b/x y"',
    'old mode 100644',
    'new mode 100755',
  ))
  assert.deepEqual(d.files.map((f) => [f.status, f.path, f.hunks.length]), [['M', 'with space.sh', 0], ['M', 'x y', 0]])
})

test('symlink and "\\ No newline at end of file"', () => {
  const d = read(diff(
    'diff --git a/link b/link',
    'new file mode 120000',
    'index 0000000..3594e94',
    '--- /dev/null',
    '+++ b/link',
    '@@ -0,0 +1 @@',
    '+/etc/passwd',
    '\\ No newline at end of file',
    'diff --git a/noeol.txt b/noeol.txt',
    'index 8d7bbd1..e77f3b2 100644',
    '--- a/noeol.txt',
    '+++ b/noeol.txt',
    '@@ -1 +1 @@',
    '-no end',
    '\\ No newline at end of file',
    '+no end 2',
    '\\ No newline at end of file',
  ))
  assert.deepEqual(d.files.map((f) => [f.status, f.path]), [['A', 'link'], ['M', 'noeol.txt']])
  assert.match(d.files[0].header, /new file mode 120000/)
  assert.deepEqual(d.files[0].hunks[0].lines, ['+/etc/passwd', '\\ No newline at end of file'])
  assert.deepEqual(d.files[1].hunks[0].lines, ['-no end', '\\ No newline at end of file', '+no end 2', '\\ No newline at end of file'])
  assert.deepEqual(d.files[1].addedLines, [{ number: 1, text: 'no end 2' }])
})

test('inside a hunk the counts rule: a removed line starting with "-- " does not open a file', () => {
  const d = read(diff(
    'diff --git a/new.sql b/new.sql',
    'index 7915b74..b31b0b1 100644',
    '--- a/new.sql',
    '+++ b/new.sql',
    '@@ -1,2 +1,2 @@',
    '--- sql comment',
    '---- a/fake',
    '++++ b/fake',
    '+new',
  ))
  assert.equal(d.files.length, 1)
  assert.equal(d.files[0].removed, 2)
  assert.deepEqual(d.files[0].addedLines, [{ number: 1, text: '+++ b/fake' }, { number: 2, text: 'new' }])
})

test('CRLF becomes LF and NULs disappear', () => {
  const f = single(['diff --git a/w.txt b/w.txt', '--- a/w.txt', '+++ b/w.txt', '@@ -1 +1,2 @@', '-a', '+b\u0000c', '+d', ''].join('\r\n'))
  assert.deepEqual(f.addedLines, [{ number: 1, text: 'bc' }, { number: 2, text: 'd' }])
  assert.ok(f.hunks[0].lines.every((r) => !r.includes('\r')))
})

test('lines over maxLineChars are cut and state their real length, within maxLineChars', () => {
  const long = '+' + 'x'.repeat(4999)
  const f = single(diff('diff --git a/m.js b/m.js', '--- a/m.js', '+++ b/m.js', '@@ -0,0 +1,2 @@', long, '+short'))
  const t = f.hunks[0].lines[0]
  assert.ok(t.length <= 2000, String(t.length))
  assert.ok(t.startsWith('+xxx'))
  assert.ok(t.endsWith('…[line truncated: 5000 characters]'), t.slice(-40))
  assert.equal(f.addedLines[0].text, t.slice(1))
  assert.equal(f.addedLines[1].text, 'short')
  // a surrogate pair on the cut is not split
  const emoji = '+' + '\u{1F600}'.repeat(3000)
  const g = single(diff('diff --git a/e.txt b/e.txt', '--- a/e.txt', '+++ b/e.txt', '@@ -0,0 +1 @@', emoji))
  const r = g.hunks[0].lines[0]
  const before = r.slice(0, r.indexOf('…'))
  assert.equal(before.length % 2, 1, 'a "+" and whole pairs')
})

test('past maxBytes the diff is cut at a line end and marked truncated; bytes is the real size', () => {
  const lines = ['diff --git a/g.txt b/g.txt', '--- a/g.txt', '+++ b/g.txt', '@@ -0,0 +1,100 @@']
  for (let i = 0; i < 100; i++) lines.push('+line number ' + i)
  const text = diff(...lines)
  const all = read(text)
  assert.equal(all.truncated, false)
  assert.equal(all.bytes, text.length)
  assert.equal(all.files[0].added, 100)

  const d = read(text, { maxBytes: 500, maxLineChars: 2000 })
  assert.equal(d.truncated, true)
  assert.equal(d.bytes, text.length)
  const f = d.files[0]
  assert.ok(f.added > 10 && f.added < 100, String(f.added))
  // no half line: the last addition is a whole line of the diff
  const last = f.addedLines[f.addedLines.length - 1]
  assert.equal(last.text, 'line number ' + (last.number - 1))
  // bytes are counted in UTF-8: 400 "é" are 800 bytes
  const accents = diff('diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -0,0 +1 @@', '+' + 'é'.repeat(400))
  const e = read(accents, { maxBytes: 500, maxLineChars: 2000 })
  assert.equal(e.truncated, true)
  assert.equal(e.files[0].added, 0)
})

test('diff -u without git headers, with the date after the tab', () => {
  const d = read(diff(
    'diff -ruN a/one.c b/one.c',
    '--- a/one.c\t2026-09-25 10:00:00.000000000 +0200',
    '+++ b/one.c\t2026-09-25 10:01:00.000000000 +0200',
    '@@ -1 +1 @@',
    '-int a;',
    '+int b;',
    'Only in b: other',
    '--- /dev/null\t1970-01-01 01:00:00.000000000 +0100',
    '+++ b/two.c\t2026-09-25 10:01:00.000000000 +0200',
    '@@ -0,0 +1 @@',
    '+int c;',
  ))
  assert.deepEqual(d.files.map((f) => [f.status, f.path, f.added]), [['M', 'one.c', 1], ['A', 'two.c', 1]])
})

test('stray lines outside the hunks are dropped and do not enter the headers', () => {
  const d = read(diff(
    'text before the diff',
    '[title]',
    'diff --git a/a.txt b/a.txt',
    'index 1..2 100644',
    '[description] fake',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '[files]',
    '@@ without numbers @@',
  ))
  assert.equal(d.files.length, 1)
  assert.doesNotMatch(d.files[0].header, /\[/)
  assert.deepEqual(d.files[0].hunks.map((h) => h.lines), [['-a', '+b']])
})

test('prefixes other than a/ and b/: diff.mnemonicPrefix and diff.noprefix', () => {
  const d = read(diff(
    'diff --git c/src/one.py i/src/one.py',
    'index fb85c0a..2c6d4c5 100644',
    '--- c/src/one.py',
    '+++ i/src/one.py',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/x.py a/x.py',
    '--- a/x.py',
    '+++ a/x.py',
    '@@ -1 +1 @@',
    '-a',
    '+b',
  ))
  // without prefixes git writes the same name twice: "a/x.py" is the real name
  assert.deepEqual(d.files.map((f) => f.path), ['src/one.py', 'a/x.py'])
})

test('a file with an unreadable name is not dropped: it keeps the raw name', () => {
  const d = read(diff(
    'diff --git "a/not closed',
    'old mode 100644',
    'new mode 100755',
    'diff --git a/x.py b/x.py',
    '--- /dev/null',
    '+++ /dev/null',
    '@@ -0,0 +1 @@',
    '+content',
  ))
  assert.deepEqual(d.files.map((f) => f.path), ['"a/not closed', 'x.py'])
  assert.deepEqual(d.files[1].addedLines, [{ number: 1, text: 'content' }])
})

test('hunk header', () => {
  assert.deepEqual(parseHunkHeader('@@ -3 +4,0 @@ ctx'), { oldStart: 3, oldCount: 1, newStart: 4, newCount: 0, context: ' ctx' })
  assert.equal(parseHunkHeader('@@@ -1 -1 +1 @@@'), null)
})

test('matchesAny: one regex is enough; no lastIndex effect', () => {
  assert.equal(matchesAny([/^dist\//, /\.map$/], 'dist/app.js'), true)
  assert.equal(matchesAny([/^dist\//], 'lib/dist/app.js'), false)
  assert.equal(matchesAny([], 'x'), false)
  const g = /a/g
  assert.equal(matchesAny([g], 'a'), true)
  assert.equal(matchesAny([g], 'a'), true)
  assert.equal(g.lastIndex, 0)
})

test('safePath: only [\\w./@+-], the rest "?", at most 120 characters keeping the tail', () => {
  assert.equal(safePath('src/app/@scope/x+y-z_1.ts'), 'src/app/@scope/x+y-z_1.ts')
  assert.equal(safePath('a b\n::error::`$(rm)`<img>.txt'), 'a?b???error?????rm???img?.txt')
  assert.equal(safePath('naïve/\u{1F600}.md'), 'na?ve/?.md')
  const long = 'd/'.repeat(100) + 'the-file-name.py'
  const s = safePath(long)
  assert.equal(s.length, 120)
  assert.ok(s.startsWith('…') && s.endsWith('/the-file-name.py'))
  assert.match(s.slice(1), /^[\w./@+-]*$/)
})
