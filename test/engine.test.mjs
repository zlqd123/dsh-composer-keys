/**
 * Engine tests for dsh-composer-keys.
 *
 * client.js is a hand-written browser bundle: its pure gesture engine lives at
 * the top of the same file and is exposed via the
 * globalThis.__COMPOSER_KEYS_TEST_HOOKS__ assignment inside the IIFE. These
 * tests evaluate the real shipped source (no copy, no build) with a plain
 * new Function wrapper — window stays undefined, so only the engine runs.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = await readFile(path.join(here, '..', 'client.js'), 'utf8')

function loadHooks() {
  const factory = new Function(`${source}\n;return globalThis.__COMPOSER_KEYS_TEST_HOOKS__;`)
  return factory()
}

const hooks = loadHooks()
const {
  normalizeEventGesture,
  parseBinding,
  gestureMatchesBinding,
  gestureMatchesList,
  actionForGesture,
  isPristineDefaults,
  moveGesture,
  sanitizeBindings,
  bindingsEqual,
  cloneBindings,
  prettifyBinding,
} = hooks

const NATIVE = { send: ['enter', 'ctrl+enter'], newline: ['shift+enter'] }
const CHAT_STYLE = { send: ['ctrl+enter'], newline: ['enter', 'shift+enter'] }

test('loadHooks: the shipped client.js exposes a full hook set', () => {
  for (const key of [
    'normalizeEventGesture', 'parseBinding', 'gestureMatchesBinding', 'gestureMatchesList',
    'actionForGesture', 'isPristineDefaults', 'moveGesture', 'sanitizeBindings',
    'bindingsEqual', 'cloneBindings', 'prettifyBinding',
  ]) {
    assert.equal(typeof hooks[key], 'function', `hook ${key} missing`)
  }
})

test('normalizeEventGesture: canonical chord strings', () => {
  assert.equal(normalizeEventGesture({ key: 'Enter' }), 'enter')
  assert.equal(normalizeEventGesture({ key: 'Enter', ctrlKey: true }), 'ctrl+enter')
  assert.equal(normalizeEventGesture({ key: 'Enter', metaKey: true }), 'meta+enter')
  assert.equal(normalizeEventGesture({ key: 'Enter', shiftKey: true }), 'shift+enter')
  assert.equal(normalizeEventGesture({ key: 'Enter', ctrlKey: true, shiftKey: true }), 'ctrl+shift+enter')
  assert.equal(normalizeEventGesture({ key: 'a', ctrlKey: true, altKey: true }), 'ctrl+alt+a')
  assert.equal(normalizeEventGesture({ key: 'A', shiftKey: true }), 'shift+a')
  assert.equal(normalizeEventGesture({ key: ' ' }), 'space')
  assert.equal(normalizeEventGesture({ key: 'ArrowUp' }), 'arrowup')
  // Modifier order in the OUTPUT is canonical regardless of physical order.
  assert.equal(normalizeEventGesture({ key: 'k', altKey: true, ctrlKey: true, shiftKey: true, metaKey: true }), 'ctrl+alt+shift+meta+k')
})

test('normalizeEventGesture: pure modifier presses form no gesture', () => {
  for (const key of ['Control', 'Alt', 'Shift', 'Meta', 'CapsLock']) {
    assert.equal(normalizeEventGesture({ key }), '', `${key} alone`)
    assert.equal(normalizeEventGesture({ key, ctrlKey: true, shiftKey: true }), '', `${key} with modifiers held`)
  }
  assert.equal(normalizeEventGesture(undefined), '')
  assert.equal(normalizeEventGesture({}), '')
  assert.equal(normalizeEventGesture({ key: '' }), '')
})

test('normalizeEventGesture: IME composition events are ordinary input to the engine', () => {
  // The IME guard itself lives in the DOM listener; the engine must not need
  // special cases. A composition Enter normalizes like any other Enter —
  // interception is prevented upstream by the isComposing check.
  assert.equal(normalizeEventGesture({ key: 'Enter', isComposing: true }), 'enter')
})

test('parseBinding: accepts canonical chords, any modifier order, mod alias', () => {
  assert.deepEqual(parseBinding('enter'), { ctrl: false, alt: false, shift: false, meta: false, mod: false, key: 'enter' })
  assert.deepEqual(parseBinding('ctrl+enter'), { ctrl: true, alt: false, shift: false, meta: false, mod: false, key: 'enter' })
  assert.deepEqual(parseBinding('ENTER+CTRL'), parseBinding('ctrl+enter'))
  assert.equal(parseBinding('control+enter').ctrl, true) // e.key-style alias accepted
  assert.equal(parseBinding('mod+k').mod, true)
  assert.equal(parseBinding('accel+k').mod, true)
  assert.equal(parseBinding('cmd+k').meta, true)
  assert.equal(parseBinding('command+k').meta, true)
  // Explicit extra requirement alongside the alias survives parsing.
  const explicit = parseBinding('mod+ctrl+k')
  assert.equal(explicit.mod, true)
  assert.equal(explicit.ctrl, true)
  assert.equal(explicit.key, 'k')
})

test('parseBinding: rejects malformed chords', () => {
  assert.equal(parseBinding(''), null)
  assert.equal(parseBinding('   '), null)
  assert.equal(parseBinding(null), null)
  assert.equal(parseBinding(42), null)
  assert.equal(parseBinding('ctrl'), null) // modifier-only string
  assert.equal(parseBinding('ctrl+'), null)
  assert.equal(parseBinding('foo+bar'), null) // unknown modifier
  assert.equal(parseBinding('ctrl+shift'), null) // no key token
})

test('gestureMatchesBinding: exact modifiers; mod binds either ctrl or meta', () => {
  assert.equal(gestureMatchesBinding('ctrl+enter', 'ctrl+enter'), true)
  assert.equal(gestureMatchesBinding('meta+enter', 'ctrl+enter'), false)
  assert.equal(gestureMatchesBinding('alt+enter', 'ctrl+enter'), false)
  assert.equal(gestureMatchesBinding('shift+ctrl+enter', 'ctrl+enter'), false)
  assert.equal(gestureMatchesBinding('ctrl+enter', 'mod+enter'), true)
  assert.equal(gestureMatchesBinding('meta+enter', 'mod+enter'), true)
  // Exactly ONE of ctrl/meta for mod: holding both fails.
  assert.equal(gestureMatchesBinding('ctrl+meta+enter', 'mod+enter'), false)
  assert.equal(gestureMatchesBinding('enter', 'mod+enter'), false)
  // Case-insensitive on both sides.
  assert.equal(gestureMatchesBinding('CTRL+ENTER', 'Ctrl+Enter'), true)
  // Unparsable binding never matches (bad chord sits in the BINDING slot).
  assert.equal(gestureMatchesBinding('enter', 'bogus+enter'), false)
  assert.equal(gestureMatchesBinding('ctrl+s', 'foo'), false)
})

test('actionForGesture: send wins ties; unknown gestures resolve to undefined', () => {
  const both = { send: ['enter'], newline: ['enter'] }
  assert.equal(actionForGesture(both, 'enter'), 'send')
  assert.equal(actionForGesture(NATIVE, 'shift+enter'), 'newline')
  assert.equal(actionForGesture(NATIVE, 'ctrl+alt+f7'), undefined)
  assert.equal(actionForGesture(NATIVE, ''), undefined)
  assert.equal(actionForGesture(NATIVE, 'enter'), 'send')
  assert.equal(actionForGesture(null, 'enter'), undefined)
})

test('zero-intervention guarantee: pristine defaults keep the engine fully hands-off', () => {
  assert.equal(isPristineDefaults(NATIVE, NATIVE), true, 'default bindings are pristine')
  // Any deviation — a preset, an added chord, an empty list — ends pass-through.
  assert.equal(isPristineDefaults(CHAT_STYLE, NATIVE), false, 'chat-style is customized')
  assert.equal(isPristineDefaults({ send: ['enter'], newline: ['shift+enter'] }, NATIVE), false, 'one chord removed')
  assert.equal(isPristineDefaults({ send: [], newline: [] }, NATIVE), false, 'cleared lists')
})

test('customized bindings intercept uniformly (no per-chord native equivalence)', () => {
  // Chat style: Ctrl+Enter → send. The engine now INTERCEPTS it and replays
  // plain Enter, so busy queue-vs-steer follows the PRIMARY setting instead of
  // the native Ctrl/Cmd+Enter opposite-behavior trait.
  assert.equal(actionForGesture(CHAT_STYLE, 'ctrl+enter'), 'send')
  assert.equal(isPristineDefaults(CHAT_STYLE, NATIVE), false)
  assert.equal(actionForGesture(CHAT_STYLE, 'enter'), 'newline')
  // Custom chords were always intercepted; unchanged semantics.
  const custom = { send: ['ctrl+s'], newline: [] }
  assert.equal(actionForGesture(custom, 'ctrl+s'), 'send')
  assert.equal(isPristineDefaults(custom, NATIVE), false)
})

test('moveGesture: moving enforces mutual exclusion', () => {
  const moved = moveGesture(NATIVE, 'enter', 'newline')
  assert.deepEqual(moved.send.sort(), ['ctrl+enter'])
  assert.deepEqual(moved.newline.sort(), ['enter', 'shift+enter'])
  const back = moveGesture(moved, 'enter', 'send')
  assert.deepEqual(back.send.sort(), ['ctrl+enter', 'enter'])
  assert.deepEqual(back.newline, ['shift+enter'])
  // Moving an unknown gesture just appends it.
  const added = moveGesture(NATIVE, 'alt+q', 'newline')
  assert.ok(added.newline.includes('alt+q'))
})

test('sanitizeBindings: hostile shapes fall back field-by-field; junk entries dropped', () => {
  assert.deepEqual(sanitizeBindings(undefined), NATIVE)
  assert.deepEqual(sanitizeBindings(null), NATIVE)
  // Missing fields mean "never configured" → defaults; explicit [] means cleared.
  assert.deepEqual(
    sanitizeBindings({}),
    { send: ['enter', 'ctrl+enter'], newline: ['shift+enter'] },
    'absent fields fall back to the shipped defaults',
  )
  assert.deepEqual(
    sanitizeBindings({ send: [], newline: [] }),
    { send: [], newline: [] },
    'explicit empty arrays are a deliberate clear and survive',
  )
  assert.deepEqual(
    sanitizeBindings({ send: 'nope' }),
    { send: ['enter', 'ctrl+enter'], newline: ['shift+enter'] },
    'non-array field falls back to default while missing sibling gets its own default',
  )
  assert.deepEqual(
    sanitizeBindings({ send: [' CTRL + ENTER ', 'bogus+chord', '', 'ctrl+enter', 42, null], newline: ['SHIFT+ENTER'] }),
    { send: ['ctrl+enter'], newline: ['shift+enter'] },
    'trim/lowercase/dedupe/parse-check all apply',
  )
  assert.deepEqual(
    sanitizeBindings({ send: ['ctrl+s'], newline: 'nope' }),
    { send: ['ctrl+s'], newline: ['shift+enter'] },
    'valid custom list survives; broken sibling falls back',
  )
})

test('sanitizeBindings: cross-action duplicates resolve toward send', () => {
  assert.deepEqual(
    sanitizeBindings({ send: ['enter'], newline: ['enter', 'shift+enter'] }),
    { send: ['enter'], newline: ['shift+enter'] },
  )
})

test('bindingsEqual & cloneBindings: structural equality, independent arrays', () => {
  assert.equal(bindingsEqual(NATIVE, { send: ['enter', 'ctrl+enter'], newline: ['shift+enter'] }), true)
  assert.equal(bindingsEqual(NATIVE, CHAT_STYLE), false)
  assert.equal(bindingsEqual({ send: [], newline: [] }, { send: [], newline: [] }), true)

  const clone = cloneBindings(NATIVE)
  clone.send.push('alt+x')
  assert.equal(NATIVE.send.length, 2, 'source untouched')
  assert.equal(bindingsEqual(clone, NATIVE), false)
})

test('prettifyBinding: human-readable labels', () => {
  assert.equal(prettifyBinding('ctrl+enter'), 'Ctrl+Enter')
  assert.equal(prettifyBinding('meta+enter'), 'Cmd+Enter')
  assert.equal(prettifyBinding('mod+k'), 'Ctrl/Cmd+K')
  assert.equal(prettifyBinding('ctrl+alt+arrowup'), 'Ctrl+Alt+↑')
  assert.equal(prettifyBinding('space'), 'Space')
  assert.equal(prettifyBinding('f4'), 'F4')
})
