// Backend rules: where a key goes, which URLs are accepted, when http is allowed.
// These are the rules that, if wrong, send a TypeSafe key in clear text over the LAN
// or a Bearer over the internet: every case of the design has its own line here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  authority, isLocalHost, requestHeaders, parseUrl, normalizeUrl, sanitize, resolveBackend, sameOrigin,
} from '../../src/core/backend.ts'
import type { BackendSources, ParsedUrl } from '../../src/core/backend.ts'
import type { Backend, Result } from '../../src/core/types.ts'

// Fake, recognizable keys: nothing that looks like a real secret enters the repo.
const TS_KEY = 'fake-typesafe-api-key'
const USER_KEY = 'fake-user-key-value'
const ENV_KEY = 'fake-env-api-key'

function ok<T>(e: Result<T>): T {
  if (!e.ok) assert.fail(`expected ok, found ${e.error.kind}: ${e.error.message}`)
  return e.value
}

function ko<T>(e: Result<T>): { kind: string; message: string } {
  if (e.ok) assert.fail(`expected an error, found ${JSON.stringify(e.value)}`)
  return e.error
}

// ─── parseUrl ─────────────────────────────────────────────────────────────────

test('parseUrl: scheme, host, port and path read by hand', () => {
  const cases: [string, ParsedUrl][] = [
    ['http://192.168.1.50:8017', { scheme: 'http', host: '192.168.1.50', port: 8017, path: '/' }],
    ['https://api.typesafe.ai', { scheme: 'https', host: 'api.typesafe.ai', port: 443, path: '/' }],
    ['  HTTP://Rizzo.Local:8017/v1/  ', { scheme: 'http', host: 'rizzo.local', port: 8017, path: '/v1/' }],
    ['https://spark.tail1234.ts.net./rizzo', { scheme: 'https', host: 'spark.tail1234.ts.net', port: 443, path: '/rizzo' }],
    ['http://rizzo_reviewer:8017', { scheme: 'http', host: 'rizzo_reviewer', port: 8017, path: '/' }],
    ['http://localhost:/', { scheme: 'http', host: 'localhost', port: 80, path: '/' }],
    ['https://proxy.example.com/a/%7Euser/v1', { scheme: 'https', host: 'proxy.example.com', port: 443, path: '/a/%7Euser/v1' }],
  ]
  for (const [s, expected] of cases) assert.deepEqual(ok(parseUrl(s)), expected, s)
})

test('parseUrl: IPv6 in square brackets, in canonical form', () => {
  const cases: [string, string, number][] = [
    ['http://[::1]:8017/v1', '::1', 8017],
    ['http://[0:0:0:0:0:0:0:1]/', '::1', 80],
    ['https://[FD7A:115C:A1E0::0001]:8019', 'fd7a:115c:a1e0::1', 8019],
    ['http://[::ffff:192.168.1.50]:8017', '::ffff:c0a8:132', 8017],
    ['http://[2001:db8:0:0:1:0:0:1]', '2001:db8::1:0:0:1', 80],
    ['http://[1:2:3:4:5:6:7:8]', '1:2:3:4:5:6:7:8', 80],
  ]
  for (const [s, host, port] of cases) {
    const u = ok(parseUrl(s))
    assert.equal(u.host, host, s)
    assert.equal(u.port, port, s)
  }
  assert.equal(authority(ok(parseUrl('http://[::1]:8017'))), '[::1]:8017')
  assert.equal(authority(ok(parseUrl('https://[::1]:443'))), '[::1]')
})

test('parseUrl: rejects credentials, queries, fragments and ambiguous forms', () => {
  const rejected = [
    'http://user:secret-word@192.168.1.50:8017',
    'http://token@host',
    'http://host/v1?key=1',
    'http://host/#x',
    'ftp://host',
    'host:8017',
    '//host',
    'http:/host',
    'http://',
    'http:///v1',
    'http://host:0',
    'http://host:65536',
    'http://host:80a',
    'http://host:-1',
    // IPv4 that the WHATWG parser would read differently: octal, hexadecimal, integer
    'http://010.0.0.1',
    'http://0x7f.0.0.1',
    'http://0x7f.1',
    'http://2130706433',
    'http://1.2.3.4.5',
    'http://256.0.0.1',
    'http://foo.123',
    'http://[::1',
    'http://[::1]x',
    'http://[::1]:80:90',
    'http://[fe80::1%25eth0]',
    'http://[1::2::3]',
    'http://[1:2:3:4:5:6:7:8:9]',
    'http://::1:8017',
    'http://ho st',
    'http://host\\@evil.com/',
    'http://hòst.it',
    'http://host/a b',
    'http://host/<script>',
    'http://host\n/v1',
    'http://a..b',
    '',
    '   ',
  ]
  for (const s of rejected) {
    const e = ko(parseUrl(s))
    assert.equal(e.kind, 'config', s)
    assert.match(e.message, /^invalid URL: /, s)
  }
  // the message does not repeat the URL: it would contain the credentials
  assert.doesNotMatch(ko(parseUrl('http://mario:secret-word@host')).message, /secret-word|mario/)
})

// ─── normalizeUrl and sameOrigin ──────────────────────────────────────────

test('normalizeUrl strips a trailing "/", "/v1" and "/v1/systemone" and appends /v1/systemone', () => {
  const expected = 'http://192.168.1.50:8017/v1/systemone'
  for (const s of ['http://192.168.1.50:8017', 'http://192.168.1.50:8017/', 'http://192.168.1.50:8017/v1', 'http://192.168.1.50:8017/v1/',
    'http://192.168.1.50:8017/v1/systemone', 'http://192.168.1.50:8017/v1/systemone/', 'HTTP://192.168.1.50:8017//']) {
    assert.equal(ok(normalizeUrl(s)), expected, s)
  }
  assert.equal(ok(normalizeUrl('https://proxy.example.com/rizzo/v1')), 'https://proxy.example.com/rizzo/v1/systemone')
  assert.equal(ok(normalizeUrl('https://api.typesafe.ai:443')), 'https://api.typesafe.ai/v1/systemone')
  assert.equal(ok(normalizeUrl('http://[::1]:8017/')), 'http://[::1]:8017/v1/systemone')
  assert.equal(ok(normalizeUrl('http://localhost:80/v1')), 'http://localhost/v1/systemone')
  assert.equal(ko(normalizeUrl('http://host/?x')).kind, 'config')
})

test('sameOrigin compares scheme, host and port, not the path', () => {
  assert.equal(sameOrigin('http://192.168.1.50:8017', 'http://192.168.1.50:8017/v1/systemone'), true)
  assert.equal(sameOrigin('https://api.typesafe.ai', 'https://API.typesafe.ai:443/v1'), true)
  assert.equal(sameOrigin('http://[::1]:8017', 'http://[0::1]:8017/x'), true)
  assert.equal(sameOrigin('http://192.168.1.50:8017', 'http://192.168.1.50:8019'), false)
  assert.equal(sameOrigin('http://192.168.1.50:8017', 'https://192.168.1.50:8017'), false)
  assert.equal(sameOrigin('http://192.168.1.50', 'http://192.168.1.51'), false)
  assert.equal(sameOrigin('http://a:b@192.168.1.50', 'http://192.168.1.50'), false)
  assert.equal(sameOrigin('', ''), false)
})

// ─── isLocalHost ──────────────────────────────────────────────────────────────────

test('isLocalHost: loopback, private networks, Tailscale, *.ts.net, *.local and localhost', () => {
  const local = [
    '127.0.0.1', '127.1.2.3', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.50',
    '100.64.0.1', '100.64.0.10', '100.127.255.255', 'localhost', 'LOCALHOST', 'localhost.',
    'spark.tail1234.ts.net', 'rizzo.local', 'Rizzo.Local', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:10.0.0.1',
    '[::ffff:192.168.1.1]', '::ffff:7f00:1',
  ]
  const publicHosts = [
    '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '8.8.8.8', '192.169.0.1', '11.0.0.1',
    'api.typesafe.ai', 'ts.net', '.ts.net', 'local', 'evil.com', 'localhost.evil.com', 'evil-ts.net', 'ts.net.evil.com',
    '010.0.0.1', '0x7f.0.0.1', '2130706433', '127.1', 'fd7a:115c:a1e0::1', 'fe80::1', '::ffff:8.8.8.8', '::',
    '', 'foo.local/x', 'foo.local:8017', 'user@rizzo.local', '[::1',
  ]
  for (const h of local) assert.equal(isLocalHost(h), true, h)
  for (const h of publicHosts) assert.equal(isLocalHost(h), false, h)
})

// ─── resolveBackend: (URL, key, model) layers ─────────────────────────────────

// Layers of the command hooks: userConfig, then JEV_HOOKS_*, then TYPESAFE_*.
function hook(o: { review?: string; apiKey?: string; model?: string; envUrl?: string; envKey?: string; tsKey?: string; tsBase?: string; tsModel?: string }): BackendSources {
  return {
    layers: [
      { name: 'userConfig', url: o.review, key: o.apiKey, model: o.model },
      { name: 'JEV_HOOKS_*', url: o.envUrl, key: o.envKey },
    ],
    typesafe: { key: o.tsKey, baseUrl: o.tsBase, model: o.tsModel },
  }
}

test('review_url on the LAN without api_key, with TYPESAFE_API_KEY in the environment: no key', () => {
  const b = ok(resolveBackend(hook({ review: 'http://192.168.1.50:8017', tsKey: TS_KEY })))
  assert.equal(b.key, '')
  assert.equal(b.layer, 'userConfig')
  assert.equal(b.url, 'http://192.168.1.50:8017/v1/systemone')
  assert.equal(b.host, '192.168.1.50:8017')
  assert.equal(b.local, true)
  assert.equal(requestHeaders(b).Authorization, undefined)
})

test('the key is taken only from the layer that gave the URL', () => {
  // api_key set in userConfig without review_url: the URL comes from JEV_HOOKS_URL, the key does not
  const b = ok(resolveBackend(hook({ apiKey: USER_KEY, envUrl: 'http://10.0.0.5:8017' })))
  assert.equal(b.layer, 'JEV_HOOKS_*')
  assert.equal(b.key, '')
  // and the other way round: JEV_HOOKS_KEY does not go to the userConfig URL
  const c = ok(resolveBackend(hook({ review: 'http://10.0.0.5:8017', envUrl: 'http://10.0.0.5:8017', envKey: ENV_KEY })))
  assert.equal(c.layer, 'userConfig')
  assert.equal(c.key, '')
  const d = ok(resolveBackend(hook({ review: 'http://10.0.0.5:8017', apiKey: USER_KEY, envKey: ENV_KEY })))
  assert.equal(d.key, USER_KEY)
  assert.equal(requestHeaders(d).Authorization, `Bearer ${USER_KEY}`)
})

test('an empty or blank URL means "not configured" for that layer', () => {
  const b = ok(resolveBackend(hook({ review: '   ', apiKey: USER_KEY, envUrl: 'http://127.0.0.1:8017', envKey: ENV_KEY })))
  assert.equal(b.layer, 'JEV_HOOKS_*')
  assert.equal(b.key, ENV_KEY)
  const e = ko(resolveBackend(hook({ review: '', apiKey: USER_KEY })))
  assert.equal(e.kind, 'not_configured')
  assert.match(e.message, /review_url/)
  assert.equal(ko(resolveBackend({ layers: [] })).kind, 'not_configured')
})

test('TYPESAFE_API_KEY applies only towards api.typesafe.ai or the TYPESAFE_BASE_URL host', () => {
  // the key alone: the SDKs' default root
  const a = ok(resolveBackend(hook({ tsKey: TS_KEY, tsModel: 'jev-1.13.0' })))
  assert.equal(a.url, 'https://api.typesafe.ai/v1/systemone')
  assert.equal(a.key, TS_KEY)
  assert.equal(a.layer, 'TYPESAFE_*')
  assert.equal(a.model, 'jev-1.13.0')
  assert.equal(a.host, 'api.typesafe.ai')
  assert.equal(a.local, false)
  // with TYPESAFE_BASE_URL the key goes to that host
  const b = ok(resolveBackend(hook({ tsKey: TS_KEY, tsBase: 'https://typesafe.proxy.example.com' })))
  assert.equal(b.url, 'https://typesafe.proxy.example.com/v1/systemone')
  assert.equal(b.key, TS_KEY)
  // TYPESAFE_BASE_URL without a key (SDKs pointed at a rizzo): URL yes, key no
  const c = ok(resolveBackend(hook({ tsBase: 'http://192.168.1.50:8017' })))
  assert.equal(c.key, '')
  assert.equal(c.layer, 'TYPESAFE_*')
  // an earlier layer with the TypeSafe URL does not take the key from the environment
  const d = ko(resolveBackend(hook({ review: 'https://api.typesafe.ai', tsKey: TS_KEY })))
  assert.equal(d.kind, 'not_configured')
  assert.match(d.message, /requires a key/)
})

test('explicit --url: a key only from a layer with the same origin', () => {
  const cli = (url: string, o: { envUrl?: string; envKey?: string; tsKey?: string; tsBase?: string }): BackendSources => ({
    explicitUrl: url,
    layers: [{ name: 'JEV_HOOKS_*', url: o.envUrl, key: o.envKey, model: 'jev-latest' }],
    typesafe: { key: o.tsKey, baseUrl: o.tsBase },
  })
  // same origin: the key goes through
  const a = ok(resolveBackend(cli('http://192.168.1.50:8017/v1', { envUrl: 'http://192.168.1.50:8017', envKey: ENV_KEY })))
  assert.equal(a.key, ENV_KEY)
  assert.match(a.layer, /explicit url, key from JEV_HOOKS_\*/)
  // different port, host or scheme: no key
  for (const url of ['http://192.168.1.50:8019', 'http://192.168.1.51:8017', 'https://192.168.1.50:8017']) {
    assert.equal(ok(resolveBackend(cli(url, { envUrl: 'http://192.168.1.50:8017', envKey: ENV_KEY, tsKey: TS_KEY }))).key, '', url)
  }
  // no layer: no key
  assert.equal(ok(resolveBackend(cli('http://127.0.0.1:8765', {}))).key, '')
  // TYPESAFE_API_KEY towards the TypeSafe host yes, towards another host no
  assert.equal(ok(resolveBackend(cli('https://api.typesafe.ai', { tsKey: TS_KEY }))).key, TS_KEY)
  assert.equal(ok(resolveBackend(cli('https://typesafe.proxy.example.com/v1', { tsKey: TS_KEY, tsBase: 'https://typesafe.proxy.example.com' }))).key, TS_KEY)
  assert.equal(ok(resolveBackend(cli('https://other.example.com', { tsKey: TS_KEY }))).key, '')
  // --url towards TypeSafe without any usable key: an error before sending
  assert.equal(ko(resolveBackend(cli('https://api.typesafe.ai', { envUrl: 'http://127.0.0.1:1', envKey: ENV_KEY }))).kind, 'not_configured')
})

test('api_key applies to review_url and to a router_url on the same host: same layer, same (URL, key, model)', () => {
  // the router builds its userConfig layer from router_url || review_url and
  // router_api_key || api_key, api_key only when router_url has review_url's scheme and
  // host (routerBackend, tested in tests/core/router.test.ts): the key stays inside the
  // layer the user wrote
  const options = { review_url: 'http://192.168.1.50:8017', router_url: 'http://192.168.1.50:8019', api_key: USER_KEY, router_api_key: '' }
  const reviewer = ok(resolveBackend({ layers: [{ name: 'userConfig', url: options.review_url, key: options.api_key }] }))
  const router = ok(resolveBackend({ layers: [{ name: 'userConfig', url: options.router_url || options.review_url, key: options.router_api_key || options.api_key }] }))
  assert.equal(reviewer.key, USER_KEY)
  assert.equal(router.key, USER_KEY)
  assert.equal(router.url, 'http://192.168.1.50:8019/v1/systemone')
})

test('http guard: LAN and 100.64/10 yes, public host no, before sending anything', () => {
  for (const url of ['http://192.168.1.50:8017', 'http://100.64.0.10:8017', 'http://spark.tail1234.ts.net:8017', 'http://localhost:8017', 'http://[::1]:8017', 'http://rizzo.local']) {
    assert.equal(ok(resolveBackend({ layers: [{ name: 'userConfig', url, key: USER_KEY }] })).local, true, url)
  }
  for (const url of ['http://8.8.8.8:8017', 'http://rizzo.example.com', 'http://api.typesafe.ai', 'http://100.128.0.1', 'http://[fd7a:115c:a1e0::1]:8017']) {
    const e = ko(resolveBackend({ layers: [{ name: 'userConfig', url, key: USER_KEY }] }))
    assert.equal(e.kind, 'config', url)
    assert.match(e.message, /use https/, url)
    assert.doesNotMatch(e.message, new RegExp(USER_KEY))
  }
  // https towards a public host is fine, and it is not local (redaction applies)
  const b = ok(resolveBackend({ layers: [{ name: 'userConfig', url: 'https://rizzo.example.com/', key: USER_KEY }] }))
  assert.equal(b.local, false)
  assert.equal(b.url, 'https://rizzo.example.com/v1/systemone')
})

test('TypeSafe without a key is an error; rizzo without a key is not', () => {
  const e = ko(resolveBackend({ layers: [{ name: 'userConfig', url: 'https://api.typesafe.ai/v1' }] }))
  assert.equal(e.kind, 'not_configured')
  assert.match(e.message, /api\.typesafe\.ai requires a key/)
  assert.equal(ok(resolveBackend({ layers: [{ name: 'userConfig', url: 'http://127.0.0.1:8017' }] })).key, '')
})

test('an invalid URL in the winning layer is an error, without falling back to the next layer', () => {
  const e = ko(resolveBackend(hook({ review: 'http://user:secret-word@192.168.1.50:8017', envUrl: 'http://127.0.0.1:8017' })))
  assert.equal(e.kind, 'config')
  assert.match(e.message, /credentials.*\(source: userConfig\)/)
  assert.doesNotMatch(e.message, /secret-word/)
})

test('key with spaces, line breaks or non-ASCII: an error that does not quote it', () => {
  for (const key of ['abc def', 'abc\ndef', 'abcé', 'abc\u0000']) {
    const e = ko(resolveBackend({ layers: [{ name: 'userConfig', url: 'http://127.0.0.1:8017', key }] }))
    assert.equal(e.kind, 'config')
    assert.equal(e.message.includes(key), false)
  }
  // spaces and line breaks around the key (a file read with its final newline) are stripped
  assert.equal(ok(resolveBackend({ layers: [{ name: 'userConfig', url: 'http://127.0.0.1:8017', key: `  ${USER_KEY}\n` }] })).key, USER_KEY)
})

test('the model comes from the same layer, otherwise jev-latest', () => {
  assert.equal(ok(resolveBackend(hook({ review: 'http://127.0.0.1:8017' }))).model, 'jev-latest')
  assert.equal(ok(resolveBackend(hook({ review: 'http://127.0.0.1:8017', model: 'rizzo-latest', tsModel: 'jev-9' }))).model, 'rizzo-latest')
  assert.equal(ko(resolveBackend(hook({ review: 'http://127.0.0.1:8017', model: 'x'.repeat(129) }))).kind, 'config')
})

// ─── requestHeaders and sanitize ──────────────────────────────────────────────

test('headers: the Bearer only if there is a key, JSON always', () => {
  const b: Backend = { url: 'http://127.0.0.1:8017/v1/systemone', key: USER_KEY, model: 'jev-latest', local: true, host: '127.0.0.1:8017' }
  assert.deepEqual(requestHeaders(b), { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${USER_KEY}` })
  assert.deepEqual(requestHeaders({ ...b, key: '' }), { 'Content-Type': 'application/json', Accept: 'application/json' })
})

test('sanitize removes the key wherever it appears, before truncating', () => {
  const k = 'key"with/odd+characters'
  const t = sanitize(`a ${k} b ${JSON.stringify(k)} c ${encodeURIComponent(k)} Bearer ${k}`, k)
  assert.equal(t.includes(k), false)
  assert.equal(t.includes(JSON.stringify(k).slice(1, -1)), false)
  assert.equal(t.includes(encodeURIComponent(k)), false)
  assert.match(t, /\[key\]/)
  // a key straddling the cut point does not leave a piece behind ("[key]" is shorter
  // than the key: 298 characters before it keep the replaced text over 300)
  const long = `${'x'.repeat(298)}${USER_KEY}`
  const r = sanitize(long, USER_KEY, 300)
  assert.equal(r.includes(USER_KEY.slice(0, 5)), false)
  assert.ok(r.length <= 300)
  assert.ok(r.endsWith('…'))
})

test('sanitize truncates at max characters, without splitting a surrogate and without control characters', () => {
  assert.equal(sanitize('x'.repeat(1000), '').length, 300)
  assert.equal(sanitize('short', ''), 'short')
  const emoji = sanitize(`${'a'.repeat(298)}😀😀`, '', 300)
  assert.ok(!/[\ud800-\udbff]…$/.test(emoji))
  assert.equal(sanitize('red \u001b[31mX\u001b[0m\r\nend \u202eevil', ''), 'red  [31mX [0m end  evil')
  // empty key: no replacements (split on "" would break up every character)
  assert.equal(sanitize('abc', ''), 'abc')
  assert.equal(sanitize('abc', '   '), 'abc')
})
