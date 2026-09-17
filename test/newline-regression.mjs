// Isolated real-browser regression using ONLY the locally installed DSH bundle.
// No DSH server, user settings, session, or model request is touched.
// Usage: node test/newline-regression.mjs <local conversation/lib/client.js>
// Browser: CHROME_PATH override, else existing Chrome/Edge.
// playwright-core is a LOCAL-ONLY dev tool (never a package dependency):
// resolved from a local install, $PLAYWRIGHT_CORE_PATH, or the npm global dir.
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
let chromium
const playwrightCandidates = [
  'playwright-core',
  process.env.PLAYWRIGHT_CORE_PATH,
  path.join(process.env.APPDATA ?? '', 'npm/node_modules/playwright-core'),
  path.join(process.env.APPDATA ?? '', 'npm/node_modules/playwright/node_modules/playwright-core'),
].filter(Boolean)
for (const candidate of playwrightCandidates) {
  try { ;({ chromium } = require(candidate)); break } catch (error) { /* try next */ }
}
if (typeof chromium?.launch !== 'function') {
  console.error('playwright-core not found. This test is local-only; install it WITHOUT adding it to the package:')
  console.error('  npm i --no-save playwright-core   (or a local dev install; do not commit the manifest change)')
  console.error('or point PLAYWRIGHT_CORE_PATH at an existing installation.')
  process.exit(1)
}

const candidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean)
const executablePath = typeof process.env.CHROME_PATH === 'string' && process.env.CHROME_PATH !== ''
  ? process.env.CHROME_PATH
  : (candidates.find(candidate => existsSync(candidate)) ?? undefined)
const bundle = await readFile(process.argv[2], 'utf8')
const plugin = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const lexicalStart = bundle.indexOf('\n', bundle.indexOf('//#region ../../../node_modules/.pnpm/lexical@'))
const lexicalEnd = bundle.indexOf('//#region lib/types/', lexicalStart)
assert(lexicalStart > 0 && lexicalEnd > lexicalStart, 'local vendored Lexical region found')
const keymapStart = bundle.indexOf('\n', bundle.indexOf('//#region lib/types/client/input/editor/keymap.js'))
const keymapEnd = bundle.indexOf('//#endregion', keymapStart)
const browser = await chromium.launch({ executablePath, headless: true })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.setContent('<div data-input-scroll><div data-composer-input="true" contenteditable="true" style="white-space:pre-wrap"></div></div><textarea id="other"></textarea>')
  await page.addScriptTag({ content: `(() => {
    ${bundle.slice(lexicalStart, lexicalEnd)}
    ${bundle.slice(keymapStart, keymapEnd)}
    const editor = ys({namespace: 'regression', onError: e => { throw e } });
    O$1(editor);
    O(editor, z(), 300);
    window.editor = editor;
    window.draftText = () => {
      const walk = n => n.type === 'linebreak' ? '\\n' : n.text ?? (n.children || []).map(walk).join('');
      return walk(editor.getEditorState().toJSON().root);
    };
    window.sent = [];
    registerComposerKeymap(editor, {
      arbitrate: () => 'pass', dismissPopup() {}, space: () => false,
      canSubmit: () => true, submit: () => window.sent.push(window.draftText()),
    });
    editor.setRootElement(document.querySelector('[data-composer-input]'));
    window.setBindings = value => { window.bindings = value; window.changed?.(); };
    window.setBindings({send:['ctrl+enter'], newline:['enter','shift+enter'], interrupt:[]});
    window.__ModuleLoader__ = {load({factory}) {
      const p = factory(() => ({}));
      window.disposePlugin = p.apply({
        effect: fn => fn(),
        locale: {register() {}, bind: () => key => key},
        settingsScope: {bind: () => ({getSnapshot: () => ({value: window.bindings}), subscribe: fn => {window.changed = fn}})},
        slots: {inject() {}},
      });
    }};
  })()` })
  await page.addScriptTag({ content: plugin })
  const input = page.locator('[data-composer-input]')
  const text = () => page.evaluate(() => window.draftText())
  async function expectText(expected, label) {
    await page.waitForFunction(expected => window.draftText() === expected, expected, {timeout: 2000}).catch(async () => {
      assert.equal(await text(), expected, label)
    })
    assert.equal(await text(), expected, label)
    console.log('PASS:', label)
  }
  await input.click()
  await page.keyboard.type('hello')
  await page.keyboard.press('Enter')
  await page.keyboard.type('world')
  await expectText('hello\nworld', 'Enter inserts one newline in Lexical state')
  assert.deepEqual(await page.evaluate(() => window.sent), [], 'newline must not submit')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('end')
  await expectText('hello\nworld\nend', 'Shift+Enter inserts exactly one newline')
  await page.keyboard.press('Control+Enter')
  assert.deepEqual(await page.evaluate(() => window.sent), ['hello\nworld\nend'], 'send uses native pipeline with multiline draft')
  console.log('PASS: Ctrl+Enter submits the complete multiline state')
  await page.evaluate(() => window.setBindings({send:['ctrl+enter'], newline:['alt+enter'], interrupt:[]}))
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  await page.waitForFunction(() => window.getSelection().toString() === 'end')
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.keyboard.press('Alt+Enter')
  await page.keyboard.type('replacement')
  await expectText('hello\nworld\n\nreplacement', 'custom newline replaces selection and preserves caret')
  await page.keyboard.press('Control+z')
  await expectText('hello\nworld\n\n', 'undo removes subsequent typing')
  await page.keyboard.press('Control+z')
  await expectText('hello\nworld\nend', 'newline participates in Lexical undo history')
  await page.keyboard.press('Control+y')
  await expectText('hello\nworld\n\n', 'newline participates in redo history')
  await page.locator('#other').fill('untouched')
  await page.locator('#other').press('Enter')
  assert.equal(await page.locator('#other').inputValue(), 'untouched\n')
  await page.evaluate(() => window.setBindings({send:['enter','ctrl+enter'], newline:['shift+enter'], interrupt:[]}))
  await input.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Shift+Enter')
  await expectText('hello\nworld\n\n\n', 'pristine native Shift+Enter remains functional')
  assert.deepEqual(errors, [], 'no browser errors')
  console.log('All isolated local-DSH browser regressions passed.')
} finally {
  await browser.close()
}
