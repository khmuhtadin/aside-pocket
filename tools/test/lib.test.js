import test from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, mask, tailnetSelf, serveState, httpsDisabled, plist } from '../lib.js'

test('mask hides e-mail addresses, tailnet hosts and the home path', () => {
  const home = '/home/tester'
  assert.equal(mask('allowed logins: you@example.com, second.person+tag@mail.example.org', home), 'allowed logins: y***@example.com, s***@mail.example.org')
  assert.equal(mask('https://my-mac.tail0000.ts.net:8443/api/health -> 401', home), 'https://<host>.ts.net:8443/api/health -> 401')
  assert.equal(mask('/home/tester/.aside/cli/Aside CLI.app/Contents/MacOS/aside 1.2.3', home), '~/.aside/cli/Aside CLI.app/Contents/MacOS/aside 1.2.3')
  assert.equal(mask('dev.asidepocket.bridge, /home/tester/Library/LaunchAgents/dev.asidepocket.bridge.plist', home), 'dev.asidepocket.bridge, ~/Library/LaunchAgents/dev.asidepocket.bridge.plist')
  const all = mask('you@example.com on my-mac.tail0000.ts.net in /home/tester/x', home)
  assert.ok(!/you@|my-mac|tail0000|someone/.test(all), all)
  assert.equal(mask(['', 'Users', 'other.name', '.aside/runtime/bin/node'].join('/'), home), '~/.aside/runtime/bin/node')
  assert.equal(mask('127.0.0.1:8787', home), '127.0.0.1:8787')
})

test('parseArgs: commands and their options', () => {
  assert.deepEqual(parseArgs([]), { command: 'help' })
  assert.deepEqual(parseArgs(['--help']), { command: 'help' })
  assert.deepEqual(parseArgs(['setup']), { command: 'setup' })
  assert.deepEqual(parseArgs(['setup', '--port', '8797', '--https-port', '8444']), { command: 'setup', port: 8797, httpsPort: 8444 })
  assert.deepEqual(parseArgs(['setup', '--port=9000']), { command: 'setup', port: 9000 })
  assert.deepEqual(parseArgs(['logs', '-f']), { command: 'logs', follow: true })
  assert.deepEqual(parseArgs(['uninstall', '--purge']), { command: 'uninstall', purge: true })
  for (const command of ['pair', 'status', 'doctor', 'catalog', 'update']) assert.deepEqual(parseArgs([command]), { command })
})

test('parseArgs: bad input is a short message, not a crash', () => {
  for (const argv of [['nope'], ['setup', '--port'], ['setup', '--port', 'abc'], ['setup', '--port', '80'], ['setup', '--port', '70000'],
    ['setup', '--https-port', '8443x'], ['setup', '--purge'], ['pair', '--port', '9000'], ['uninstall', '-f'], ['status', 'extra']]) {
    assert.throws(() => parseArgs(argv), (e) => e.stop === true && e.message.length > 0, argv.join(' '))
  }
})

test('tailnetSelf: login state, host name without the dot, HTTPS certificates', () => {
  assert.deepEqual(tailnetSelf({ BackendState: 'Running', Self: { DNSName: 'my-mac.tail0000.ts.net.' }, CertDomains: ['my-mac.tail0000.ts.net'] }),
    { loggedIn: true, host: 'my-mac.tail0000.ts.net', https: true })
  assert.deepEqual(tailnetSelf({ BackendState: 'Running', Self: { DNSName: 'my-mac.tail0000.ts.net.' }, CertDomains: null }),
    { loggedIn: true, host: 'my-mac.tail0000.ts.net', https: false })
  assert.deepEqual(tailnetSelf({ BackendState: 'NeedsLogin', Self: { DNSName: '' } }), { loggedIn: false, host: '', https: false })
  assert.deepEqual(tailnetSelf(null), { loggedIn: false, host: '', https: false })
})

test('serveState: free, ours or taken, per HTTPS port', () => {
  const host = 'my-mac.tail0000.ts.net'
  const serve = {
    TCP: { 8443: { HTTPS: true }, 8444: { HTTPS: true }, 5000: { TCPForward: '127.0.0.1:22' } },
    Web: {
      [host + ':8443']: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8787' } } },
      [host + ':8444']: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } },
    },
  }
  assert.equal(serveState(serve, host, 8443, 8787), 'ours')
  assert.equal(serveState(serve, host, 8443, 8797), 'taken') // same HTTPS port, other bridge port
  assert.equal(serveState(serve, host, 8444, 8787), 'taken')
  assert.equal(serveState(serve, host, 5000, 8787), 'taken')
  assert.equal(serveState(serve, host, 8445, 8787), 'free')
  assert.equal(serveState({}, host, 8443, 8787), 'free')
  const two = { TCP: { 8443: { HTTPS: true } }, Web: { [host + ':8443']: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8787' }, '/x': { Path: '/tmp' } } } } }
  assert.equal(serveState(two, host, 8443, 8787), 'taken')
})

test('httpsDisabled recognises certificate errors only', () => {
  assert.ok(httpsDisabled('your Tailscale account does not support getting TLS certs'))
  assert.ok(httpsDisabled('ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR'))
  assert.ok(httpsDisabled('HTTPS is not enabled for this tailnet'))
  assert.ok(!httpsDisabled('ECONNREFUSED'))
  assert.ok(!httpsDisabled('listener already exists for port 8444'))
})

test('plist: paths come from the arguments and are XML-escaped', () => {
  const text = plist({ label: 'dev.asidepocket.bridge', node: '/a/node', app: '/apps/R&D <x>', dataDir: '/data dir' })
  assert.ok(text.includes('<key>Label</key><string>dev.asidepocket.bridge</string>'))
  assert.ok(text.includes('<string>/a/node</string>\n    <string>/apps/R&amp;D &lt;x&gt;/bridge/server.js</string>'))
  assert.ok(text.includes('<key>ASIDE_POCKET_DIR</key><string>/data dir</string>'))
  assert.ok(text.includes('<string>/data dir/logs/bridge.err.log</string>'))
  assert.ok(text.includes('<key>KeepAlive</key><true/>'))
})
