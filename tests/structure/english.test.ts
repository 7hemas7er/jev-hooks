// The repository is in English (AGENTS.md). scripts/check-english.ts looks for
// leftover Italian; this test runs it on the repository and checks what it catches and
// what it leaves alone. The Italian samples are composed from pieces at run time, so
// that this file passes its own scan.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkEnglish, italianWords, renderFindings, scanText } from '../../scripts/check-english.ts'
import { createRepo } from '../helpers/git-repo.ts'

const THRESHOLD = 'sog' + 'lia'                      // Italian for threshold
const OF_THE = 'del' + 'la'
const ALREADY = 'gi' + String.fromCharCode(0xe0)    // an accented ending
const WHY = 'perch' + String.fromCharCode(0xe9)

test('the repository has no Italian outside the data that keeps it on purpose', () => {
  const findings = checkEnglish()
  assert.deepEqual(findings, [], renderFindings(findings))
})

test('Italian is found in prose, in every identifier style and in accented words', () => {
  assert.deepEqual(italianWords(`// the ${THRESHOLD} ${OF_THE} lane`), [THRESHOLD, OF_THE])
  const capitalized = THRESHOLD[0].toUpperCase() + THRESHOLD.slice(1)
  assert.deepEqual(italianWords(`const min${capitalized} = 1`), [capitalized])
  assert.deepEqual(italianWords(`MIN_${THRESHOLD.toUpperCase()}_2`), [THRESHOLD.toUpperCase()])
  assert.deepEqual(italianWords(`${ALREADY} done, ${WHY} not`), [ALREADY, WHY])
})

test('English words spelled like Italian ones, and recorded names, are not findings', () => {
  assert.deepEqual(italianWords('per file, come in, del x, non-empty data, a note, NEL, git commit -uno'), [])
  assert.deepEqual(italianWords('café naïve résumé'), [])
  const variant = 'attu' + 'ale'
  const placeholder = `{{${'SEG' + 'RETO'}:${'alta' + '_entropia'}}}`
  assert.deepEqual(italianWords(`variant ${variant}, ${placeholder}`), [])
})

test('JSON: question texts and detector patterns are skipped, notes and labels are not', () => {
  const doc = JSON.stringify({
    check: {
      label: `${THRESHOLD} label`,
      instructions: `${OF_THE} question`,
      criteria: { true: THRESHOLD, [THRESHOLD]: 'x' },
    },
    variant: { question: { instructions: THRESHOLD }, _approach: `about ${OF_THE}` },
    detectors: [{ name: 'x', regex: `ignore|${THRESHOLD}` }],
  })
  assert.deepEqual(scanText('config/x.json', doc).map((f) => `${f.where} ${f.word}`), [
    `check.label ${THRESHOLD}`,
    `variant._approach ${OF_THE}`,
  ])
})

test('the pragmas skip one line, the next line or a block', () => {
  const text = [
    `a ${THRESHOLD} // check-english: allow`,
    '// check-english: allow-next-line',
    `b ${THRESHOLD}`,
    `c ${THRESHOLD}`,
    '<!-- check-english: off -->',
    `d ${THRESHOLD}`,
    '<!-- check-english: on -->',
    `e ${THRESHOLD}`,
  ].join('\n')
  assert.deepEqual(scanText('x.md', text).map((f) => f.where), ['4', '8'])
})

test('tracked files are scanned, datasets, results and the upstream question set are not', () => {
  const repo = createRepo()
  try {
    const italian = `${OF_THE} ${THRESHOLD}\n`
    repo.write('src/a.ts', `// ${italian}`)
    repo.write('bench/dev.jsonl', `{"title": "${italian.trim()}"}\n`)
    repo.write('bench/results/run/report.md', italian)
    repo.write('tests/data/checks-original.json', `{"x": "${italian.trim()}"}\n`)
    repo.write('docs/b.md', 'all English\n')
    repo.commit('test: files')
    repo.write('src/untracked.ts', italian)
    const found = checkEnglish(repo.dir)
    assert.deepEqual(found.map((f) => `${f.file}:${f.where} ${f.word}`), [`src/a.ts:1 ${OF_THE}`, `src/a.ts:1 ${THRESHOLD}`])
  } finally {
    repo.close()
  }
})
