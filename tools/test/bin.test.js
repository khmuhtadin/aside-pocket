// The shell wrapper, the argument handling of tools/cli.js and install.sh, run for real but
// with a temporary HOME and data directory: no Aside, no Tailscale, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = path.join(import.meta.dirname, '..', '..')
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aside-pocket-test-')))

// a HOME with a data directory whose config names the Node that runs the tests
function fakeHome() {
  const home = tmp()
  const dir = path.join(home, 'data')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: 8787, node: process.execPath }, null, 2) + '\n')
  const env = { HOME: home, PATH: '/usr/bin:/bin', ASIDE_POCKET_DIR: dir }
  return { home, dir, env }
}

const run = (file, args, env) => spawnSync(file, args, { encoding: 'utf8', env, timeout: 30000 })

test('bin/aside-pocket finds the app through a symlink and Node through config.json', () => {
  const { home, env } = fakeHome()
  const link = path.join(home, 'aside-pocket')
  fs.symlinkSync(path.join(ROOT, 'bin', 'aside-pocket'), path.join(home, 'first-link'))
  fs.symlinkSync('first-link', link) // a relative link to a link
  const r = run(link, ['help'], env)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^Usage: aside-pocket <command>/)
})

test('bin/aside-pocket says so when there is no Node', () => {
  const home = tmp()
  const r = run(path.join(ROOT, 'bin', 'aside-pocket'), ['help'], { HOME: home, PATH: '/usr/bin:/bin', ASIDE_POCKET_DIR: path.join(home, 'none') })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /Node was not found/)
})

test('command line: a wrong command or option exits 1 with a short message', () => {
  const { env } = fakeHome()
  for (const args of [['nope'], ['setup', '--port', 'abc'], ['pair', '--purge']]) {
    const r = run(path.join(ROOT, 'bin', 'aside-pocket'), args, env)
    assert.equal(r.status, 1, args.join(' '))
    assert.ok(r.stderr.length > 0 && !r.stderr.includes('    at '), r.stderr)
  }
})

test('command line: status and doctor before setup say what to do', () => {
  const { home } = fakeHome()
  const env = { HOME: home, PATH: '/usr/bin:/bin', ASIDE_POCKET_DIR: path.join(home, 'empty') }
  for (const command of ['status', 'doctor']) {
    const r = run(process.execPath, [path.join(ROOT, 'tools', 'cli.js'), command], env)
    assert.equal(r.status, 1, command)
    assert.equal(r.stderr.trim(), 'Not set up yet. Run: aside-pocket setup')
  }
  assert.ok(!fs.existsSync(path.join(home, 'empty')))
})

test('install.sh stops when Aside is not installed', () => {
  const { env } = fakeHome()
  const r = run('/bin/sh', [path.join(ROOT, 'install.sh')], env)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /Aside was not found/)
})

test('install.sh installs from a tarball, links the command, and upgrades in place when run again', () => {
  const { home, dir, env } = fakeHome()
  const aside = path.join(home, '.aside/cli/Aside CLI.app/Contents/MacOS/aside')
  fs.mkdirSync(path.dirname(aside), { recursive: true })
  fs.writeFileSync(aside, '#!/bin/sh\n', { mode: 0o755 })

  // a tarball shaped like a GitHub archive: one top-level folder
  const src = path.join(tmp(), 'aside-pocket-main')
  fs.mkdirSync(src)
  for (const name of ['bin', 'bridge', 'tools', 'package.json', 'install.sh']) fs.cpSync(path.join(ROOT, name), path.join(src, name), { recursive: true })
  const tarball = path.join(path.dirname(src), 'main.tar.gz')
  assert.equal(run('/usr/bin/tar', ['-czf', tarball, '-C', path.dirname(src), 'aside-pocket-main'], env).status, 0)

  const install = (stdin) => spawnSync('/bin/sh', stdin ? [] : [path.join(ROOT, 'install.sh')], {
    encoding: 'utf8', timeout: 30000, input: stdin, env: { ...env, ASIDE_POCKET_TARBALL: 'file://' + tarball, ASIDE_POCKET_NO_SETUP: '1' },
  })
  const first = install()
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /not on your PATH/)
  const link = path.join(home, '.local/bin/aside-pocket')
  assert.equal(fs.readlinkSync(link), path.join(dir, 'app/bin/aside-pocket'))
  assert.match(run(link, ['help'], env).stdout, /^Usage: aside-pocket/)

  // again, piped like `curl | sh`: the app is replaced, the data stays
  fs.writeFileSync(path.join(dir, 'token'), 'keep me')
  fs.writeFileSync(path.join(dir, 'app/stale-file'), 'old')
  const second = install(fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8'))
  assert.equal(second.status, 0, second.stderr)
  assert.ok(!fs.existsSync(path.join(dir, 'app/stale-file')))
  assert.equal(fs.readFileSync(path.join(dir, 'token'), 'utf8'), 'keep me')
  assert.deepEqual(fs.readdirSync(dir).sort(), ['app', 'config.json', 'token'])
  assert.match(run(link, ['help'], env).stdout, /^Usage: aside-pocket/)

  // a download that is not the app leaves the installed one alone
  const junk = path.join(path.dirname(src), 'junk.tar.gz')
  run('/usr/bin/tar', ['-czf', junk, '-C', path.dirname(aside), 'aside'], env)
  const bad = spawnSync('/bin/sh', [path.join(ROOT, 'install.sh')], { encoding: 'utf8', env: { ...env, ASIDE_POCKET_TARBALL: 'file://' + junk, ASIDE_POCKET_NO_SETUP: '1' } })
  assert.equal(bad.status, 1)
  assert.match(run(link, ['help'], env).stdout, /^Usage: aside-pocket/)
})
