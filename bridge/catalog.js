// Builds <data dir>/models.json: every model each Aside account can use, as {id, name, group}.
// Run it after an Aside update or after connecting a provider: aside-pocket catalog
//
// Aside has no command that lists models. So per account this script:
// 1. finds the id of Aside's extension from the URL of a new tab,
// 2. reads the model names from the model menu of Aside's side panel (opens the menu, clicks nothing),
// 3. guesses each model's provider/modelId from its name,
// 4. keeps the guesses Aside accepts when set on a throwaway session (no turn is run for that).
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DATA_DIR, loadConfig } from './config.js'

let CLI // path of the Aside CLI, set by main()
const PROVIDERS = { Aside: ['aside'], ChatGPT: ['openai-codex'], Claude: ['claude-code'], Google: ['google'] }

// stdout of an Aside CLI call; throws with the CLI's own last error line
function cli(args, { check = true } = {}) {
  const r = spawnSync(CLI, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 })
  if (check && r.status !== 0) {
    throw new Error(`aside ${args[0]} failed: ` + ((r.stderr || '').trim().split('\n').pop() || r.error?.message || `exit ${r.status}`))
  }
  return r.stdout
}
const repl = (account, code) => {
  // a repl call whose code throws exits non-zero but still reports the error as JSON
  const { run } = JSON.parse(cli(['repl', '--account', account, '--json', code], { check: false }) || '{"run":{"error":"aside repl gave no output"}}')
  if (run.error) throw new Error(run.error.split('\n')[0])
  return JSON.parse(run.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').split('\n').pop())
}

// the side panel's model menu -> {"Claude": ["Claude Opus 5.5", ...], ...}
export const SCRAPE = `
const tab = await openTab('chrome://newtab');
await sleep(1000);
// the new tab page is one of Aside's own pages: chrome-extension://<extension id>/newtab.html
const [scheme, , extension] = tab.url().split('/');
if (scheme !== 'chrome-extension:' || !extension) throw new Error('could not find the Aside extension id (the new tab is not an Aside page)');
const p = await openTab('chrome-extension://' + extension + '/sidepanel.html');
await sleep(2000);
const label = await p.evaluate(() => {
  const all = [...document.querySelectorAll('button')];
  const i = all.findIndex((b) => (b.getAttribute('aria-label') || b.innerText).trim() === 'Project');
  return all[i + 1].innerText.trim();
});
await p.getByRole('button', { name: label, exact: true }).last().click();
await sleep(600);
const groups = await p.evaluate(() => {
  const items = [...document.querySelector('[role="menu"]').querySelectorAll('[role="menuitem"]')];
  return items.map((el) => el.innerText.trim()).filter((t) => t !== 'Settings');
});
const out = {};
for (const group of groups) {
  await p.getByRole('menuitem', { name: group, exact: true }).hover();
  await sleep(600);
  out[group] = await p.evaluate(() => {
    const menus = [...document.querySelectorAll('[role="menu"]')];
    return [...menus[menus.length - 1].querySelectorAll('[role^="menuitem"]')].map((el) => el.innerText.replace(/\\s+/g, ' ').trim());
  });
}
await p.keyboard.press('Escape');
await p.keyboard.press('Escape');
console.log(JSON.stringify(out));`

// tries each guess on the throwaway session; Aside rejects models the account cannot use
export const VALIDATE = `
const found = [];
for (const m of __MODELS__) {
  for (const [provider, modelId] of m.guesses) {
    try {
      await aside.sessions.update('__ID__', { model: { provider, modelId, thinkingLevel: 'low', fastMode: false } });
      found.push({ id: provider + '/' + modelId, name: m.name, group: m.group });
      break;
    } catch {}
  }
}
console.log(JSON.stringify(found));`

export function guesses(group, name) {
  const slug = name.toLowerCase().replace(/\s+/g, '-')
  const ids = [
    slug,
    slug.replaceAll('.', '-'),
    slug.replace(group.toLowerCase() + '-', ''), // "Acme Combo" -> combo
    slug + '-preview',
    slug + '-latest',
    slug.replace('-custom-tools', '-preview-customtools'), // Google's name for "Custom Tools"
    slug.replace('-custom-tools', '-customtools'),
  ]
  const providers = PROVIDERS[group] || [group.toLowerCase().replace(/\s+/g, '-')]
  return providers.flatMap((p) => [...new Set(ids)].map((id) => [p, id]))
}

function fatal(message) {
  console.error(message)
  console.error('The model list was not changed. The app still works: type a provider/modelId by hand.')
  process.exit(1)
}

function main() {
  CLI = loadConfig().asideCli
  if (!CLI) fatal('Aside CLI not found. Run: aside-pocket setup')
  let accounts
  try {
    accounts = JSON.parse(cli(['account', 'list', '--json'])).accounts
  } catch (e) {
    fatal('Could not list Aside accounts (is Aside open and signed in?): ' + e.message.split('\n')[0].slice(0, 160))
  }

  const out = {}
  for (const a of accounts) {
    if (a.authStatus !== 'active') continue
    const id = 'u' + a.id
    let account, helper
    try {
      const open = JSON.parse(cli(['host', 'profiles', '--account', id, '--json'])).profiles.find((p) => p.connected)
      if (!open) {
        console.log(`${id}: skipped (its browser profile is not open in Aside)`)
        continue
      }
      account = id + ':' + open.profileId
      const menu = repl(account, SCRAPE)
      const models = Object.entries(menu).flatMap(([group, names]) => names.map((name) => ({ group, name, guesses: guesses(group, name) })))
      helper = JSON.parse(cli(['exec', '--json', '--account', account, '--permission', 'guard', '--effort', 'low', '--timeout', '90s',
        'Aside Pocket model catalog helper. Do not browse. Reply with only the word ok.'])).session.id
      out[id] = repl(account, VALIDATE.replace('__ID__', helper).replace('__MODELS__', JSON.stringify(models)))
      const missed = models.filter((m) => !out[id].some((f) => f.name === m.name && f.group === m.group))
      console.log(`${id}: ${out[id].length} of ${models.length} models` + (missed.length ? `, no id found for: ${missed.map((m) => m.group + ' ' + m.name).join(', ')}` : ''))
    } catch (e) {
      console.log(`${id}: skipped (${e.message.split('\n')[0].slice(0, 160)})`)
    }
    try {
      if (helper) cli(['session', 'archive', helper, '--account', account])
    } catch {
      console.log(`${id}: could not archive the helper session ${helper}; archive it in Aside`)
    }
  }

  if (!Object.keys(out).length) fatal('No account gave a model list (each needs its browser profile open in Aside).')

  // an account that failed this time keeps the list it had
  const file = path.join(DATA_DIR, 'models.json')
  const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
  fs.writeFileSync(file, JSON.stringify({ ...old, ...out }, null, 2), { mode: 0o600 })
  fs.chmodSync(file, 0o600)
  console.log('Wrote the model list for ' + Object.keys(out).join(', ') + '. The app shows it within 10 minutes.')
}

if (import.meta.main) main()
