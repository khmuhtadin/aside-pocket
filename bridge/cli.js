// Runs the official Aside CLI. At most 4 short calls at once; the rest wait in a queue.
import { execFile, spawn } from 'node:child_process'

const MAX = 4

// file = path of the Aside CLI (config.asideCli)
export function createCli(file) {
  let active = 0
  const waiting = []

  function next() {
    while (active < MAX && waiting.length) {
      active++
      waiting.shift()()
    }
  }

  // short call -> {ok, stdout, stderr}
  function run(args, timeoutMs = 20000) {
    return new Promise((resolve) => {
      waiting.push(() => {
        execFile(file, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
          active--
          next()
          resolve({ ok: !err, stdout, stderr: stderr || (err ? err.message : '') })
        })
      })
      next()
    })
  }

  // long call (exec, resume): returns the child process, not counted in the queue
  function start(args) {
    return spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  }

  return { run, start }
}
