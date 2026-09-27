// findCommits: a file of cases. Each case is a command as Claude would
// write it for the Bash tool, and what the hook must understand from it without
// running it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeCommand, unwrapGuardrail, findCommits } from '../../src/core/commit.ts'
import { unmask } from '../../src/core/mask.ts'
import type { CommitIntent } from '../../src/core/types.ts'

function single(command: string): CommitIntent {
  const r = findCommits(command)
  assert.ok(Array.isArray(r), `expected a commit in ${JSON.stringify(command)}, found ${JSON.stringify(analyzeCommand(command))}`)
  assert.equal(r.length, 1)
  return r[0]
}

const base = { all: false, amend: false, allowEmpty: false, paths: [], adds: null }

test('plain commit, repeated -m, attached -m', () => {
  assert.deepEqual(single('git commit -m "Add x"'), { ...base, message: 'Add x' })
  assert.deepEqual(single("git commit -m 'Title' -m 'Body of the message'"), { ...base, message: 'Title\n\nBody of the message' })
  assert.deepEqual(single('git commit -m"attached"'), { ...base, message: 'attached' })
  assert.deepEqual(single('git commit --message=long'), { ...base, message: 'long' })
  assert.deepEqual(single('git commit --message "long"'), { ...base, message: 'long' })
})

test("heredoc inside a substitution: $(cat <<'EOF' … EOF), with ) and && in the message", () => {
  const command = [
    'git commit -m "$(cat <<\'EOF\'',
    'feat(hook): review before the commit',
    '',
    'The body mentions git commit && git push and a lone parenthesis ).',
    '',
    'Co-Authored-By: Test <test@example.invalid>',
    'EOF',
    ')"',
  ].join('\n')
  const i = single(command)
  assert.equal(i.message, [
    'feat(hook): review before the commit', '',
    'The body mentions git commit && git push and a lone parenthesis ).', '',
    'Co-Authored-By: Test <test@example.invalid>',
  ].join('\n'))
  // the same, preceded by git add and followed by git log
  const r = findCommits(`git add src/a.ts tests/a.test.ts && ${command} && git log --oneline -1`)
  assert.ok(Array.isArray(r))
  assert.deepEqual(r[0].adds?.paths, ['src/a.ts', 'tests/a.test.ts'])
  // <<- strips the leading tabs; an unquoted delimiter stays text
  const t = single('git commit -m "$(cat <<-END\n\tTitle\n\tbody\n\tEND\n)"')
  assert.equal(t.message, 'Title\nbody')
})

test('-F file, -F - with a heredoc or a here-string', () => {
  assert.deepEqual(single('git commit -F msg.txt'), { ...base, messageFile: 'msg.txt' })
  assert.deepEqual(single('git commit --file=/tmp/m'), { ...base, messageFile: '/tmp/m' })
  assert.equal(single("git commit -F - <<'EOF'\nFrom stdin\n\nbody\nEOF").message, 'From stdin\n\nbody\n')
  assert.equal(single('git commit -F - <<< "short"').message, 'short')
})

test('directory: cd x &&, git -C, cd in a subshell, env -C', () => {
  assert.equal(single('cd /repo/one && git commit -m x').dir, '/repo/one')
  assert.equal(single('git -C sub commit -m x').dir, 'sub')
  assert.equal(single('cd /repo && git -C sub commit -m x').dir, '/repo/sub')
  assert.equal(single('cd a; cd b && git commit -m x').dir, 'a/b')
  assert.equal(single('cd ~/project && git commit -m x').dir, '~/project')
  assert.equal(single('(cd elsewhere && make) && git commit -m x').dir, undefined)
  assert.equal(single('env -C /repo git commit -m x').dir, '/repo')
  assert.equal(findCommits('cd "$REPO" && git commit -m x'), 'uncertain')
  assert.equal(findCommits('cd - && git commit -m x'), 'uncertain')
  assert.equal(findCommits('git -C "$(pwd)/x" commit -m x'), 'uncertain')
})

test('-a, -am, --amend, --allow-empty, pathspec', () => {
  assert.deepEqual(single('git commit -am "everything"'), { ...base, all: true, message: 'everything' })
  assert.deepEqual(single('git commit --all -m x'), { ...base, all: true, message: 'x' })
  assert.deepEqual(single('git commit --amend --no-edit'), { ...base, amend: true })
  assert.deepEqual(single('git commit --allow-empty -m empty'), { ...base, allowEmpty: true, message: 'empty' })
  assert.deepEqual(single('git commit -m x -- src/a.ts docs/'), { ...base, paths: ['src/a.ts', 'docs/'], message: 'x' })
  assert.deepEqual(single('git commit src/a.ts -m x'), { ...base, paths: ['src/a.ts'], message: 'x' })
  assert.deepEqual(single('git commit -qsnm x'), { ...base, message: 'x' })
  assert.deepEqual(single('git commit -S -m signed'), { ...base, message: 'signed' })
  assert.deepEqual(single('git commit -uno -m x'), { ...base, message: 'x' })
  // --include: the paths enter the index, like a git add
  const inc = single('git commit -i src/a.ts -m x')
  assert.deepEqual(inc.paths, [])
  assert.deepEqual(inc.adds?.paths, ['src/a.ts'])
})

test('git add … && git commit: steps in order, with -A, -u, -f', () => {
  const i = single('git add -A && git add -f build/out.js && git commit -m x')
  assert.deepEqual(i.adds, {
    paths: ['build/out.js'], all: true,
    steps: [
      { paths: [], all: true, update: false, force: false },
      { paths: ['build/out.js'], all: false, update: false, force: true },
    ],
  })
  assert.deepEqual(single('git add -u; git commit -m x').adds?.steps, [{ paths: [], all: false, update: true, force: false }])
  assert.deepEqual(single('git add . && git commit -m x').adds?.paths, ['.'])
  // an add after the commit: it does not count for that commit
  assert.equal(single('git commit -m x && git add y').adds, null)
  // an add in a directory other than the commit's
  assert.equal(findCommits('git -C a add x && git commit -m y'), 'uncertain')
  assert.equal(findCommits('git add "$F" && git commit -m y'), 'uncertain')
  assert.equal(findCommits('git add -p && git commit -m y'), 'uncertain')
  assert.equal(findCommits('for f in a b; do git add "$f"; done && git commit -m y'), 'uncertain')
  // a dry run adds no content
  assert.equal(single('git add -n x && git commit -m y').adds, null)
  assert.equal(single('git add --dry-run x && git commit -m y').adds, null)
})

test('git stage is a synonym of git add: the commit that follows goes through the temporary index', () => {
  assert.deepEqual(single('git stage src/conf.py && git commit -m conf').adds, {
    paths: ['src/conf.py'], all: false, steps: [{ paths: ['src/conf.py'], all: false, update: false, force: false }],
  })
  assert.deepEqual(single('git stage -A; git commit -m x').adds?.steps, [{ paths: [], all: true, update: false, force: false }])
  assert.equal(findCommits('git stage -p && git commit -m y'), 'uncertain')
  assert.equal(findCommits('git stage "$F" && git commit -m y'), 'uncertain')
})

test('git add -N (intent-to-add) is a step to repeat with -N, not a dry run: with -a or with the paths the commit takes the file', () => {
  const intent = { paths: ['x'], all: false, update: false, force: false, intentToAdd: true }
  const a = single('git add --intent-to-add x && git commit -a -m y')
  assert.equal(a.all, true)
  assert.deepEqual(a.adds, { paths: ['x'], all: false, steps: [intent] })
  assert.deepEqual(single('git add -N x && git commit -am y').adds?.steps, [intent])
  assert.deepEqual(single('git add -Nv x && git commit -m y -- x').adds?.steps, [intent])
  const p = single('git add -N x && git commit -m y -- x')
  assert.deepEqual(p.paths, ['x'])
  assert.deepEqual(p.adds?.steps, [intent])
})

test('VAR=… git commit, command, env, time, if', () => {
  assert.equal(single('GIT_AUTHOR_NAME=Test git commit -m x').message, 'x')
  assert.equal(single('env GIT_COMMITTER_DATE=2026-01-01 git commit -m x').message, 'x')
  assert.equal(single('command git commit -m x').message, 'x')
  assert.equal(single('time git commit -m x').message, 'x')
  assert.equal(single('if git commit -m x; then echo ok; fi').message, 'x')
  assert.equal(single('/usr/bin/git commit -m x').message, 'x')
  assert.equal(single('git --no-pager -c user.name=Test commit -m x').message, 'x')
  assert.equal(findCommits('GIT_INDEX_FILE=/tmp/i git commit -m x'), 'uncertain')
  assert.equal(findCommits('GIT_DIR=/elsewhere/.git git commit -m x'), 'uncertain')
  assert.equal(findCommits('git --git-dir=/elsewhere/.git commit -m x'), 'uncertain')
  assert.equal(findCommits('git --work-tree /elsewhere commit -m x'), 'uncertain')
})

test('uncertain: $CMD, aliases and scripts, sudo and sh -c, unknown options, a changed index', () => {
  for (const c of [
    '$CMD commit -m x',
    '$GIT commit',
    'git $SUB -m x commit',
    './scripts/commit.sh',
    'git-commit -m x',
    'sudo git commit -m x',
    'xargs -0 git commit -m x < list',
    "bash -c 'git commit -m x'",
    'sh <<EOF\ngit commit -m x\nEOF',
    'eval "git commit -m x"',
    'git commit --interactive',
    'git commit -p -m x',
    'git commit --mystery -m x',
    'git commit --pathspec-from-file=f',
    'git rm --cached secret.env && git commit -m x',
    'git stash && git commit -m x',
    'echo $(git commit -m x)',
    'git commit -m "$(git log -1 --format=%s && git commit -m y)"',
    'git commit -m "not closed',
  ]) assert.equal(findCommits(c), 'uncertain', c)
  // the reason reaches the log
  const a = analyzeCommand('sudo git commit -m x')
  assert.equal(a.outcome, 'uncertain')
  assert.match(a.reason ?? '', /another program/)
})

test('none: commands that do not make a commit', () => {
  for (const c of [
    'git status',
    'git log --grep commit',
    'git commit-tree HEAD^{tree} -m x',
    'git commit --dry-run -m x',
    'git commit --porcelain',
    'echo commit',
    'grep -rn "commit" docs/',
    "cat > note.txt <<'EOF'\nremember: git commit after the tests\nEOF",
    'git show HEAD --stat  # previous commit',
    'command -v git commit',
    'npm test',
  ]) assert.equal(findCommits(c), 'none', c)
})

test('new branch before the commit: allowed; checkout of files: a changed index', () => {
  assert.equal(single('git checkout -b feat/x && git add a && git commit -m x').adds?.paths[0], 'a')
  assert.equal(single('git switch -c feat/x && git commit -m x').message, 'x')
  assert.equal(findCommits('git checkout -- a.txt && git commit -m x'), 'uncertain')
})

test('two commits in the same command: two intents', () => {
  const r = findCommits('git commit -m one && git add b && git commit -m two')
  assert.ok(Array.isArray(r))
  assert.deepEqual(r.map((i) => i.message), ['one', 'two'])
  assert.equal(r[0].adds, null)
  assert.deepEqual(r[1].adds?.paths, ['b'])
})

test('guardrail placeholders: cd <placeholder> && git commit and git -C <placeholder>, resolved after unmask()', () => {
  const maskMap = [{ real: 'qzprivateclient', placeholder: 'placeholderqz' }]
  const a = single(unmask('cd /work/placeholderqz && git commit -m "fix for placeholderqz"', maskMap))
  assert.equal(a.dir, '/work/qzprivateclient')
  assert.equal(a.message, 'fix for qzprivateclient')
  const b = single(unmask('git -C /work/placeholderqz commit -m x', maskMap))
  assert.equal(b.dir, '/work/qzprivateclient')
})

test("guardrail wrapper (updatedInput): the command inside the heredoc", () => {
  const inside = 'cd /repo && git commit -m "$(cat <<\'EOF\'\nTitle\nEOF\n)"'
  const wrapped = `bash "/home/u/.claude/plugins/cache/g/hooks/run-python.sh" "/home/u/.claude/plugins/cache/g/hooks/mask.py" run <<'__GUARDRAIL_MASK__'\n${inside}\n__GUARDRAIL_MASK__`
  assert.equal(unwrapGuardrail(wrapped), inside)
  assert.equal(unwrapGuardrail(inside), null)
  const i = single(wrapped)
  assert.equal(i.dir, '/repo')
  assert.equal(i.message, 'Title')
  // a lengthened delimiter: the command contains a line equal to the base one
  const long = `bash "/x/run-python.sh" "/x/mask.py" run <<'__GUARDRAIL_MASK___'\ngit commit -m "a\n__GUARDRAIL_MASK__\nb"\n__GUARDRAIL_MASK___`
  assert.equal(single(long).message, 'a\n__GUARDRAIL_MASK__\nb')
})

test('redirections and descriptors: 2>&1, > file, | tee', () => {
  assert.equal(single('git commit -m x 2>&1 | tail -5').message, 'x')
  assert.equal(single('git commit -m x > /tmp/out.txt 2>/dev/null').message, 'x')
  assert.equal(single('git commit -m x &> log.txt').message, 'x')
})

test("quoting: $'…', backslashes, mixed quotes, line continuation with \\\\", () => {
  assert.equal(single("git commit -m $'line one\\nline two'").message, 'line one\nline two')
  assert.equal(single('git commit -m "says \\"hello\\" and \\$HOME"').message, 'says "hello" and $HOME')
  assert.equal(single("git commit -m 'single \"inside\"'").message, 'single "inside"')
  assert.equal(single('git commit \\\n  -m split').message, 'split')
  // a message with a variable stays text: the title is not an instruction
  assert.equal(single('git commit -m "version $V"').message, 'version ')
})
