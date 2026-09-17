import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const section = source.slice(source.indexOf('    /** Whether an element is the main chat composer input. */'), source.indexOf('    // ── Floating panel'))
function setup(editor) {
  const listeners = []
  let domEdits = 0
  const window = {addEventListener: (_, fn) => listeners.push(fn), removeEventListener() {}}
  class HTMLTextAreaElement {}
  const target = {__lexicalEditor: editor, focus() {}, closest: () => ({}), contentEditable: 'true'}
  const api = new Function('window', 'document', 'HTMLTextAreaElement', 'normalizeEventGesture', 'actionForGesture', 'isPristineDefaults', 'DEFAULTS', 'console', `${section}; return {insertNewline, installKeyboardEngine, isComposerInput}`)(
    window, {execCommand() {domEdits++; return true}}, HTMLTextAreaElement,
    () => 'enter', () => 'newline', () => false, {}, {warn() {}},
  )
  return {api, target, listeners, domEdits: () => domEdits}
}

test('uses registered command identity, not a string or newly created object', () => {
  const command = {type: 'INSERT_LINE_BREAK_COMMAND'}
  const s = setup({_commands: new Map([[command, []]]), dispatchCommand(key, payload) {
    assert.equal(key, command)
    assert.equal(payload, false)
    return true
  }})
  assert.equal(s.api.insertNewline(s.target), true)
  assert.equal(s.domEdits(), 0)
})

for (const [label, editor] of [
  ['missing registry', {}],
  ['unknown command', {_commands: new Map([[{}, []]])}],
  ['no range selection', {_commands: new Map([[{type: 'INSERT_LINE_BREAK_COMMAND'}, []]]), dispatchCommand: () => false}],
  ['throwing dispatch', {_commands: new Map([[{type: 'INSERT_LINE_BREAK_COMMAND'}, []]]), dispatchCommand() {throw new Error('unavailable')}}],
]) {
  test(`${label}: no unsafe DOM fallback and no accidental submit`, () => {
    const s = setup(editor)
    assert.equal(s.api.insertNewline(s.target), false)
    assert.equal(s.domEdits(), 0)
    s.api.installKeyboardEngine({getSnapshot: () => ({})})
    let prevented = false
    let stopped = false
    s.listeners[0]({isTrusted: true, target: s.target,
      preventDefault() {prevented = true}, stopImmediatePropagation() {stopped = true}})
    assert.equal(prevented, true)
    assert.equal(stopped, true)
  })
}

test('synthetic and composing events remain untouched', () => {
  const s = setup({})
  s.api.installKeyboardEngine({getSnapshot() {throw new Error('must not run')}})
  for (const flags of [{isTrusted: false}, {isTrusted: true, isComposing: true}, {isTrusted: true, keyCode: 229}]) {
    s.listeners[0]({...flags, target: s.target, preventDefault() {throw new Error('must not intercept')}})
  }
  assert.equal(s.api.isComposerInput(null), false)
  assert.equal(s.api.isComposerInput({}), false)
})
