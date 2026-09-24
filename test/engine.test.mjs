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
  sanitizeCustomPresets,
  sanitizeBuiltinSchemes,
  resolveBuiltinTriple,
  matchActiveScheme,
  resolveCurrentSessionId,
  builtinSchemesEqual,
  presetsEqual,
  MAX_CUSTOM_PRESETS,
  bindingsEqual,
  cloneBindings,
  prettifyBinding,
} = hooks

const NATIVE = { send: ['enter', 'ctrl+enter'], newline: ['shift+enter'], interrupt: [] }
const CHAT_STYLE = { send: ['ctrl+enter'], newline: ['enter', 'shift+enter'], interrupt: [] }

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

test('actionForGesture: send wins ties; interrupt lowest; unknown → undefined', () => {
  const both = { send: ['enter'], newline: ['enter'], interrupt: [] }
  assert.equal(actionForGesture(both, 'enter'), 'send')
  assert.equal(actionForGesture(NATIVE, 'shift+enter'), 'newline')
  assert.equal(actionForGesture(NATIVE, 'ctrl+alt+f7'), undefined)
  assert.equal(actionForGesture(NATIVE, ''), undefined)
  assert.equal(actionForGesture(NATIVE, 'enter'), 'send')
  assert.equal(actionForGesture(null, 'enter'), undefined)
  const withInterrupt = { send: [], newline: [], interrupt: ['escape', 'ctrl+break'] }
  assert.equal(actionForGesture(withInterrupt, 'escape'), 'interrupt')
})

test('zero-intervention guarantee: pristine defaults keep the engine fully hands-off', () => {
  assert.equal(isPristineDefaults(NATIVE, NATIVE), true, 'default bindings are pristine')
  // Any deviation — a preset, an added chord, an empty list — ends pass-through.
  assert.equal(isPristineDefaults(CHAT_STYLE, NATIVE), false, 'chat-style is customized')
  assert.equal(isPristineDefaults({ send: ['enter'], newline: ['shift+enter'], interrupt: [] }, NATIVE), false, 'one chord removed')
  assert.equal(isPristineDefaults({ send: [], newline: [], interrupt: [] }, NATIVE), false, 'cleared lists')
  // Binding ONLY an interrupt key is also a customization (engine arms for it).
  assert.equal(
    isPristineDefaults({ send: ['enter', 'ctrl+enter'], newline: ['shift+enter'], interrupt: ['escape'] }, NATIVE),
    false,
    'interrupt binding alone ends pass-through',
  )
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

test('moveGesture: moving enforces mutual exclusion across all three actions', () => {
  const moved = moveGesture(NATIVE, 'enter', 'newline')
  assert.deepEqual(moved.send.sort(), ['ctrl+enter'])
  assert.deepEqual(moved.newline.sort(), ['enter', 'shift+enter'])
  const back = moveGesture(moved, 'enter', 'send')
  assert.deepEqual(back.send.sort(), ['ctrl+enter', 'enter'])
  assert.deepEqual(back.newline, ['shift+enter'])
  // Moving an unknown gesture just appends it.
  const added = moveGesture(NATIVE, 'alt+q', 'newline')
  assert.ok(added.newline.includes('alt+q'))
  // Interrupt is a first-class target: moving there clears other owners.
  const toInterrupt = moveGesture(CHAT_STYLE, 'ctrl+enter', 'interrupt')
  assert.equal(toInterrupt.send.includes('ctrl+enter'), false)
  assert.deepEqual(toInterrupt.interrupt, ['ctrl+enter'])
})

test('sanitizeBindings: hostile shapes fall back field-by-field; junk entries dropped', () => {
  assert.deepEqual(sanitizeBindings(undefined), NATIVE)
  assert.deepEqual(sanitizeBindings(null), NATIVE)
  // Missing fields mean "never configured" → defaults; explicit [] means cleared.
  assert.deepEqual(
    sanitizeBindings({}),
    { send: ['enter', 'ctrl+enter'], newline: ['shift+enter'], interrupt: [] },
    'absent fields fall back to the shipped defaults',
  )
  assert.deepEqual(
    sanitizeBindings({ send: [], newline: [], interrupt: [] }),
    { send: [], newline: [], interrupt: [] },
    'explicit empty arrays are a deliberate clear and survive',
  )
  assert.deepEqual(
    sanitizeBindings({ send: 'nope' }),
    { send: ['enter', 'ctrl+enter'], newline: ['shift+enter'], interrupt: [] },
    'non-array field falls back to default while missing sibling gets its own default',
  )
  assert.deepEqual(
    sanitizeBindings({ send: [' CTRL + ENTER ', 'bogus+chord', '', 'ctrl+enter', 42, null], newline: ['SHIFT+ENTER'] }),
    { send: ['ctrl+enter'], newline: ['shift+enter'], interrupt: [] },
    'trim/lowercase/dedupe/parse-check all apply',
  )
  assert.deepEqual(
    sanitizeBindings({ send: ['ctrl+s'], newline: 'nope' }),
    { send: ['ctrl+s'], newline: ['shift+enter'], interrupt: [] },
    'valid custom list survives; broken sibling falls back',
  )
  assert.deepEqual(
    sanitizeBindings({ interrupt: [' ESCAPE ', 'escape', 'mod+m'] }),
    { send: ['enter', 'ctrl+enter'], newline: ['shift+enter'], interrupt: ['escape', 'mod+m'] },
    'interrupt list sanitizes on its own terms',
  )
})

test('sanitizeBindings: cross-action duplicates resolve toward send, then newline', () => {
  assert.deepEqual(
    sanitizeBindings({ send: ['enter'], newline: ['enter', 'shift+enter'] }),
    { send: ['enter'], newline: ['shift+enter'], interrupt: [] },
  )
  // Interrupt is lowest priority: a chord owned above can never double as it.
  assert.deepEqual(
    sanitizeBindings({ send: ['enter'], newline: ['shift+enter'], interrupt: ['enter', 'escape'] }),
    { send: ['enter'], newline: ['shift+enter'], interrupt: ['escape'] },
  )
})

test('bindingsEqual & cloneBindings: structural equality, independent arrays', () => {
  assert.equal(bindingsEqual(NATIVE, { send: ['enter', 'ctrl+enter'], newline: ['shift+enter'] }), true)
  assert.equal(bindingsEqual(NATIVE, CHAT_STYLE), false)
  assert.equal(bindingsEqual({ send: [], newline: [] }, { send: [], newline: [] }), true)
  // Legacy sections without an interrupt key compare as empty.
  assert.equal(
    bindingsEqual({ send: ['enter'], newline: ['shift+enter'] }, { send: ['enter'], newline: ['shift+enter'], interrupt: [] }),
    true,
  )
  assert.equal(
    bindingsEqual({ send: ['enter'], newline: ['shift+enter'], interrupt: ['escape'] }, { send: ['enter'], newline: ['shift+enter'], interrupt: [] }),
    false,
  )

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
  assert.equal(prettifyBinding('escape'), 'Esc')
})

test('shift+enter rebound to send resolves as send (newline pass-through never claims it)', () => {
  // A user who wants Shift+Enter to SUBMIT moves the gesture out of newline
  // into send (the panel's moveGesture enforces mutual exclusion). Action
  // resolution runs before the engine's newline-branch pass-through guard, so
  // the guard can never swallow this binding: send wins and the engine takes
  // its intercept branch → replaySubmit.
  const bindings = { send: ['enter', 'ctrl+enter', 'shift+enter'], newline: [], interrupt: [] }
  assert.equal(actionForGesture(bindings, 'shift+enter'), 'send')
  assert.equal(gestureMatchesList(bindings.newline, 'shift+enter'), false, 'moved out of newline')
  assert.equal(isPristineDefaults(bindings, NATIVE), false, 'customized → engine intercepts')
})

test('shift+enter left in newline resolves as newline (engine passes the default chord through)', () => {
  assert.equal(actionForGesture(NATIVE, 'shift+enter'), 'newline')
  assert.equal(actionForGesture(CHAT_STYLE, 'shift+enter'), 'newline')
  assert.equal(isPristineDefaults(NATIVE, NATIVE), true, 'pristine → engine fully hands-off')
})

test('sanitizeCustomPresets: caps at three, drops malformed entries, trims and dedupes names', () => {
  const mk = (name, overrides) => ({
    name,
    send: ['ctrl+enter'],
    newline: ['enter'],
    interrupt: [],
    ...overrides,
  })

  // Not-an-array shapes collapse to an empty list.
  assert.deepEqual(sanitizeCustomPresets(undefined), [])
  assert.deepEqual(sanitizeCustomPresets('junk'), [])
  assert.deepEqual(sanitizeCustomPresets({ name: 'x' }), [])

  // Malformed entries (non-object, object without a usable name) are dropped.
  assert.deepEqual(sanitizeCustomPresets([null, 42, ['nested'], { send: [] }, { name: '   ' }]), [])

  // The third extra preset is the cap; a fourth never lands.
  const capped = sanitizeCustomPresets([mk('one'), mk('two'), mk('three'), mk('four')])
  assert.equal(capped.length, MAX_CUSTOM_PRESETS)
  assert.deepEqual(capped.map((entry) => entry.name), ['one', 'two', 'three'])

  // Names are trimmed; duplicates after trimming keep the FIRST occurrence.
  const deduped = sanitizeCustomPresets([mk('  工作台  '), mk('工作台'), mk('第二')])
  assert.deepEqual(deduped.map((entry) => entry.name), ['工作台', '第二'])

  // Each preset's bindings are sanitized like ordinary bindings: non-string
  // junk is dropped, non-array fields fall back to the shipped defaults.
  const sanitized = sanitizeCustomPresets([
    mk('mixed', { send: ['enter', 42, null], newline: 'not-an-array', interrupt: ['ctrl+alt+k'] }),
  ])[0]
  assert.deepEqual(sanitized.send, ['enter'])
  assert.deepEqual(sanitized.newline, ['shift+enter'], 'non-array falls back to the shipped default')
  assert.deepEqual(sanitized.interrupt, ['ctrl+alt+k'])
})

test('presetsEqual: structural comparison for write-gate confirmation', () => {
  const mk = (name, overrides) => ({ name, send: ['ctrl+enter'], newline: ['enter'], interrupt: [], ...overrides })
  const a = sanitizeCustomPresets([mk('one')])
  const same = sanitizeCustomPresets([mk('one')])
  const changed = sanitizeCustomPresets([mk('one', { send: ['shift+enter'] })])
  const other = sanitizeCustomPresets([mk('two')])

  assert.equal(presetsEqual(a, same), true)
  assert.equal(presetsEqual(a, []), false, 'length mismatch')
  assert.equal(presetsEqual(a, other), false, 'name mismatch')
  assert.equal(presetsEqual(a, changed), false, 'bindings mismatch')
  assert.equal(presetsEqual(undefined, []), false)
})

test('sanitizeBuiltinSchemes: only reserved ids survive, one entry each, triples sanitized', () => {
  assert.deepEqual(sanitizeBuiltinSchemes(undefined), [])
  assert.deepEqual(sanitizeBuiltinSchemes('junk'), [])
  assert.deepEqual(sanitizeBuiltinSchemes([{ name: 'no-id' }, { id: 'evil' }]), [], 'unknown ids dropped')

  const cleaned = sanitizeBuiltinSchemes([
    { id: 'native', send: ['enter', 42], newline: 'nope', interrupt: [' ESCAPE '] },
    { id: 'native', send: ['ctrl+s'], newline: [], interrupt: [] },
    { id: 'chat', send: ['ctrl+enter'], newline: ['enter'], interrupt: ['escape'] },
  ])
  assert.deepEqual(cleaned.map((scheme) => scheme.id), ['native', 'chat'], 'first id wins, order kept')
  assert.deepEqual(cleaned[0].send, ['enter'], 'junk entry dropped inside triple')
  assert.deepEqual(cleaned[0].newline, ['shift+enter'], 'non-array falls back to the shipped default')
  assert.deepEqual(cleaned[0].interrupt, ['escape'], 'trim/lowercase applies')
})

test('resolveBuiltinTriple: override wins wholesale, else the shipped template (isolated triple)', () => {
  const override = sanitizeBuiltinSchemes([
    { id: 'native', send: ['enter'], newline: ['shift+enter'], interrupt: ['escape'] },
  ])

  // Override replaces ALL THREE channels — never a value from another scheme.
  const resolved = resolveBuiltinTriple('native', override)
  assert.deepEqual(resolved, { send: ['enter'], newline: ['shift+enter'], interrupt: ['escape'] })

  // Without an override the shipped template applies.
  assert.deepEqual(resolveBuiltinTriple('native', []), NATIVE)
  assert.deepEqual(resolveBuiltinTriple('chat', []), CHAT_STYLE)
  assert.deepEqual(resolveBuiltinTriple('chat', override), CHAT_STYLE, 'other scheme untouched')

  // Garbage ids and garbage lists fall back safely.
  assert.deepEqual(resolveBuiltinTriple('unknown', override), NATIVE)
  assert.deepEqual(resolveBuiltinTriple('native', 'junk'), NATIVE)

  // The result is an independent copy.
  resolved.send.push('alt+x')
  assert.equal(override[0].send.includes('alt+x'), false)
})

test('matchActiveScheme: identifies the scheme a triple belongs to (customs first, overrides honored)', () => {
  const empty = []
  // Shipped templates match out of the box.
  assert.equal(matchActiveScheme(NATIVE, empty, []), 'native')
  assert.equal(matchActiveScheme(CHAT_STYLE, empty, []), 'chat')

  // A recorded key still resolves via the persisted override — this keeps the
  // edit→write-back chain alive across consecutive edits.
  const nativeWithEsc = { send: ['enter', 'ctrl+enter'], newline: ['shift+enter'], interrupt: ['escape'] }
  const overrides = sanitizeBuiltinSchemes([
    { id: 'native', send: ['enter', 'ctrl+enter'], newline: ['shift+enter'], interrupt: ['escape'] },
  ])
  assert.equal(matchActiveScheme(nativeWithEsc, overrides, []), 'native', 'override-resolved match')
  assert.equal(matchActiveScheme(nativeWithEsc, empty, []), null, 'without the override it is freestyle')

  // An explicitly saved custom scheme wins over an identical builtin.
  const custom = sanitizeCustomPresets([{ name: 'mine', ...NATIVE }])
  assert.equal(matchActiveScheme(NATIVE, empty, custom), 'mine')

  // Freestyle bindings match nothing.
  assert.equal(matchActiveScheme({ send: ['ctrl+q'], newline: [], interrupt: [] }, empty, []), null)
  assert.equal(matchActiveScheme(null, empty, []), null)
})

test('builtinSchemesEqual: id-aware structural comparison for the write gate', () => {
  const a = sanitizeBuiltinSchemes([{ id: 'native', send: ['enter'], newline: [], interrupt: [] }])
  const same = sanitizeBuiltinSchemes([{ id: 'native', send: ['enter'], newline: [], interrupt: [] }])
  const otherId = sanitizeBuiltinSchemes([{ id: 'chat', send: ['enter'], newline: [], interrupt: [] }])
  const otherTriple = sanitizeBuiltinSchemes([{ id: 'native', send: ['ctrl+enter'], newline: [], interrupt: [] }])

  assert.equal(builtinSchemesEqual(a, same), true)
  assert.equal(builtinSchemesEqual(a, []), false, 'length mismatch')
  assert.equal(builtinSchemesEqual(a, otherId), false, 'id mismatch')
  assert.equal(builtinSchemesEqual(a, otherTriple), false, 'triple mismatch')
  assert.equal(builtinSchemesEqual(undefined, []), false)
})

test('resolveCurrentSessionId: official current-session resolution with every fallback', () => {
  // Regression: 0.1.7's list snapshot has NO `current` field — the old
  // `snapshot.current` read was always undefined, so interrupt never got a
  // target ("interrupt skipped: no-current-session"). Resolution now mirrors
  // uiSession.publishMain: tracked current + main-view retention, then
  // legacy/single-session fallbacks.
  const row = (id, mainView) => ({ id, retainedBy: { mainView } })

  // Current retained by the main view → current (official rule).
  const both = { byId: { a: row('a', 1), b: row('b', 0) } }
  assert.equal(resolveCurrentSessionId(both, 'a'), 'a')
  // Current NOT retained while another row is → the main-view row wins.
  assert.equal(resolveCurrentSessionId(both, 'b'), 'a')

  // No main-view signal yet (startup timing): trust the tracked current.
  assert.equal(resolveCurrentSessionId({ byId: { a: row('a', 0) } }, 'a'), 'a')
  assert.equal(resolveCurrentSessionId(undefined, 'a'), 'a', 'no snapshot at all')

  // Legacy field, then exactly-one-open-session, then no target.
  assert.equal(resolveCurrentSessionId({ current: 'legacy-9' }, undefined), 'legacy-9')
  assert.equal(resolveCurrentSessionId({ byId: { only: row('only', 0) } }, undefined), 'only')
  assert.equal(
    resolveCurrentSessionId({ byId: { a: row('a', 0), b: row('b', 0) } }, undefined),
    null,
    'multiple open sessions with no signal resolve to no target',
  )

  // Hostile shapes never throw; the row's own id is preferred over its key.
  assert.equal(resolveCurrentSessionId(null, undefined), null)
  assert.equal(resolveCurrentSessionId({ byId: 'junk' }, ''), null)
  assert.equal(resolveCurrentSessionId({ byId: { k: { id: 'real-id', retainedBy: { mainView: 2 } } } }, undefined), 'real-id')
})
