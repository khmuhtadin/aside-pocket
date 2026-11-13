import test from 'node:test'
import assert from 'node:assert/strict'
import { SCRAPE, VALIDATE, guesses } from '../catalog.js'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

test('catalog: the repl snippets are valid JavaScript and name no extension id', () => {
  new AsyncFunction(SCRAPE)
  new AsyncFunction(VALIDATE.replace('__ID__', 'Zx9_abcDEF123456').replace('__MODELS__', JSON.stringify([{ group: 'G', name: "It's", guesses: [['g', 'its']] }])))
  assert.ok(!/chrome-extension:\/\/[a-p]{32}/.test(SCRAPE))
  assert.ok(SCRAPE.includes("openTab('chrome://newtab')"))
})

test('catalog: model id guesses from a menu name', () => {
  assert.deepEqual(guesses('Claude', 'Claude Opus 5.5').slice(0, 2), [['claude-code', 'claude-opus-5.5'], ['claude-code', 'claude-opus-5-5']])
  assert.ok(guesses('Acme', 'Acme Combo').some(([p, id]) => p === 'acme' && id === 'combo'))
  assert.ok(guesses('Google', 'Gemini 3.1 Pro Custom Tools').some(([p, id]) => p === 'google' && id === 'gemini-3.1-pro-preview-customtools'))
})
