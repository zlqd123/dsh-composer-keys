/**
 * dsh-composer-keys — browser half.
 *
 * Hand-written lazy-CJS bundle in the client module system's factory format
 * (the same shape packages/client/tsdown.client.ts emits): the file registers
 * a factory via window.__ModuleLoader__.load, and every side effect lives in
 * the factory closure. No build step.
 *
 * What it does
 * - Captures keydowns aimed at the chat composer input ([data-input-scroll])
 *   and resolves them against user-configured bindings: which chords submit
 *   ("send") and which insert a line break ("newline").
 * - Send replays one synthetic trusted=false Enter keydown so the NATIVE
 *   composer handler keeps owning the whole submission pipeline: slash-menu
 *   arbitration, repeat guard, machine-busy guards, and busy queue-vs-steer
 *   (the native「繁忙时 Enter 键行为」setting). All customized send bindings
 *   replay as plain Enter; pristine defaults pass through unchanged.
 * - Newline dispatches the existing Lexical line-break command object so draft,
 *   selection and undo history stay in sync. Legacy textareas use native editing.
 * - Bindings persist in the Host user-settings document under the
 *   `composer-keys` namespace (registered by the host half), exactly like the
 *   native busy-Enter preference.
 * - Two UI entries into ONE floating panel: a Settings→General row and a small
 *   keyboard button at the right end of the composer tool row.
 *
 * Safety properties
 * - While bindings equal the shipped defaults, recognized native gestures are
 *   passed THROUGH untouched — installing the plugin changes nothing.
 * - IME composition keydowns (isComposing / keyCode 229) are never touched.
 * - Synthetic events are ignored via isTrusted, so the replay cannot loop.
 * - Only the main composer textarea is affected: approval panels, rename
 *   boxes, and every other editable surface keep their native keys.
 */

;(function () {
'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// Pure gesture engine — no DOM access, exercised directly by test/engine.test.mjs
// through the __COMPOSER_KEYS_TEST_HOOKS__ export below.
// ─────────────────────────────────────────────────────────────────────────────

/** Keys that are pure modifiers: pressing them alone never forms a gesture. */
var MODIFIER_KEYS = ['control', 'alt', 'shift', 'meta', 'capslock']

/**
 * Normalize a keyboard event into a canonical gesture string:
 * modifiers in ctrl+alt+shift+meta order, then the lowercase key token
 * (' ' becomes 'space'). Returns '' for pure-modifier presses.
 * @param {{key?: string, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean, metaKey?: boolean}} e
 * @returns {string} e.g. 'enter', 'ctrl+enter', 'shift+a', 'space'.
 */
function normalizeEventGesture(e) {
  var keyToken = eventKeyToken(e && e.key)
  if (keyToken === '' || MODIFIER_KEYS.indexOf(keyToken) !== -1) return ''
  var parts = []
  if (e.ctrlKey === true) parts.push('ctrl')
  if (e.altKey === true) parts.push('alt')
  if (e.shiftKey === true) parts.push('shift')
  if (e.metaKey === true) parts.push('meta')
  parts.push(keyToken)
  return parts.join('+')
}

/** Lowercase key token of e.key (' ' → 'space'). */
function eventKeyToken(key) {
  if (typeof key !== 'string' || key.length === 0) return ''
  if (key === ' ') return 'space'
  return key.toLowerCase()
}

/** Modifier shorthand tokens that may never serve as the key of a chord. */
var BINDING_MODIFIER_TOKENS = ['ctrl', 'control', 'alt', 'shift', 'meta', 'cmd', 'command', 'mod', 'accel', 'capslock']

/**
 * Parse one stored binding string into a matcher spec.
 * Modifiers appear in any order (aliases accepted); the one remaining segment
 * is the key. 'mod' matches Ctrl OR Cmd.
 * @param {string} binding - e.g. 'ctrl+enter', 'enter+ctrl', 'mod+k'.
 * @returns {{ctrl: boolean, alt: boolean, shift: boolean, meta: boolean, mod: boolean, key: string} | null}
 */
function parseBinding(binding) {
  if (typeof binding !== 'string') return null
  var parts = binding.trim().toLowerCase().split('+')
  var spec = { ctrl: false, alt: false, shift: false, meta: false, mod: false, key: '' }
  for (var i = 0; i < parts.length; i += 1) {
    var part = parts[i]
    switch (part) {
      case '': return null // empty segment ('ctrl+', 'a++b')
      case 'ctrl': case 'control': spec.ctrl = true; break
      case 'alt': spec.alt = true; break
      case 'shift': spec.shift = true; break
      case 'meta': case 'cmd': case 'command': spec.meta = true; break
      case 'mod': case 'accel': spec.mod = true; break
      default:
        if (spec.key !== '') return null // a chord has exactly one key segment
        if (BINDING_MODIFIER_TOKENS.indexOf(part) !== -1) return null // modifier posing as key
        spec.key = part
    }
  }
  if (spec.key === '') return null // modifiers only, no key at all
  return spec
}

/**
 * Whether one gesture string satisfies one binding spec
 * (exact modifier match; 'mod' binds to exactly one of ctrl/meta).
 * The gesture is lowercased defensively: the engine always feeds canonical
 * output of normalizeEventGesture, but direct callers may pass raw events.
 */
function gestureMatchesSpec(gesture, spec) {
  if (spec === null) return false
  var parts = String(gesture).toLowerCase().split('+')
  var key = parts[parts.length - 1]
  if (key !== spec.key) return false
  var hasCtrl = parts.indexOf('ctrl') !== -1
  var hasAlt = parts.indexOf('alt') !== -1
  var hasShift = parts.indexOf('shift') !== -1
  var hasMeta = parts.indexOf('meta') !== -1
  if (spec.mod) {
    // Exactly ONE of ctrl/meta must be present…
    if (hasCtrl === hasMeta) return false
    // …and explicit extra requirements still bind ('mod+ctrl' demands ctrl).
    if (spec.ctrl && !hasCtrl) return false
    if (spec.meta && !hasMeta) return false
  } else if (spec.ctrl !== hasCtrl || spec.meta !== hasMeta) {
    return false
  }
  return spec.alt === hasAlt && spec.shift === hasShift
}

/** Whether the gesture hits any binding string of the list. */
function gestureMatchesList(list, gesture) {
  if (!Array.isArray(list)) return false
  for (var i = 0; i < list.length; i += 1) {
    if (gestureMatchesBinding(gesture, list[i])) return true
  }
  return false
}

/**
 * Whether one canonical gesture satisfies one stored chord.
 * Parameter order reads as a sentence: gesture X matches binding Y.
 */
function gestureMatchesBinding(gesture, binding) {
  return gestureMatchesSpec(gesture, parseBinding(binding))
}

/**
 * Resolve a gesture against the bindings. Send wins ties (the sanitizer never
 * stores one chord under both actions anyway); interrupt is lowest priority.
 * @param {{send: string[], newline: string[], interrupt: string[]}} bindings
 * @param {string} gesture
 * @returns {'send' | 'newline' | 'interrupt' | undefined}
 */
function actionForGesture(bindings, gesture) {
  if (bindings == null || typeof gesture !== 'string' || gesture === '') return undefined
  if (gestureMatchesList(bindings.send, gesture)) return 'send'
  if (gestureMatchesList(bindings.newline, gesture)) return 'newline'
  if (gestureMatchesList(bindings.interrupt, gesture)) return 'interrupt'
  return undefined
}

/**
 * Zero-intervention gate: the engine acts ONLY while bindings differ from the
 * shipped defaults. Pristine bindings pass EVERY event through untouched, so
 * the native Ctrl/Cmd+Enter opposite-behavior trait survives untouched too.
 * Once the user customizes anything, ALL bound gestures — Enter and
 * Ctrl/Cmd+Enter included — are intercepted and replayed as one plain Enter:
 * busy queue-vs-steer then follows the primary「繁忙时 Enter 键行为」setting
 * uniformly, with no per-chord exceptions.
 * @param {{send: string[], newline: string[]}} bindings - sanitized snapshot.
 * @param {{send: string[], newline: string[]}} defaults - shipped defaults.
 * @returns {boolean} true when the engine must stay fully hands-off.
 */
function isPristineDefaults(bindings, defaults) {
  return bindingsEqual(bindings, defaults)
}

/**
 * Move one gesture to an action: removed from all three lists first, then
 * appended to the target — the mutual-exclusion invariant lives here.
 * @returns {{send: string[], newline: string[], interrupt: string[]}}
 */
function moveGesture(bindings, gesture, targetAction) {
  var send = withoutValue(Array.isArray(bindings.send) ? bindings.send : [], gesture)
  var newline = withoutValue(Array.isArray(bindings.newline) ? bindings.newline : [], gesture)
  var interrupt = withoutValue(Array.isArray(bindings.interrupt) ? bindings.interrupt : [], gesture)
  if (targetAction === 'send') send.push(gesture)
  else if (targetAction === 'interrupt') interrupt.push(gesture)
  else newline.push(gesture)
  return { send: send, newline: newline, interrupt: interrupt }
}

/** Remove one value from a copy of the list. */
function withoutValue(list, value) {
  var out = []
  for (var i = 0; i < list.length; i += 1) {
    if (list[i] !== value) out.push(list[i])
  }
  return out
}

/**
 * Sanitize an arbitrary stored section into strict bindings: unknown shapes
 * fall back field-by-field to defaults, entries are trimmed/lowercased,
 * deduplicated, unparsable chords dropped (they could never match), and
 * cross-action duplicates resolved toward send.
 */
function sanitizeBindings(raw) {
  function clean(value, fallback) {
    // Missing field = never configured → fall back to the shipped default.
    // Explicit empty array = the user deliberately cleared the action.
    if (value === undefined || value === null || !Array.isArray(value)) return fallback.slice()
    var out = []
    for (var i = 0; i < value.length; i += 1) {
      var entry = value[i]
      if (typeof entry !== 'string') continue
      var trimmed = entry.trim().toLowerCase()
      if (trimmed === '') continue
      if (parseBinding(trimmed) === null) continue
      if (out.indexOf(trimmed) !== -1) continue
      out.push(trimmed)
    }
    return out
  }
  var send = clean(raw != null ? raw.send : undefined, ['enter', 'ctrl+enter'])
  var newline = clean(raw != null ? raw.newline : undefined, ['shift+enter'])
  var interrupt = clean(raw != null ? raw.interrupt : undefined, [])
  for (var i = newline.length - 1; i >= 0; i -= 1) {
    if (send.indexOf(newline[i]) !== -1) newline.splice(i, 1)
  }
  // Interrupt is the lowest-priority action: a chord already owned by send or
  // newline can never double as interrupt.
  for (var j = interrupt.length - 1; j >= 0; j -= 1) {
    if (send.indexOf(interrupt[j]) !== -1 || newline.indexOf(interrupt[j]) !== -1) interrupt.splice(j, 1)
  }
  return { send: send, newline: newline, interrupt: interrupt }
}

/** Missing/null interrupt lists compare as empty (legacy sections tolerate). */
function interruptList(bindings) {
  return bindings != null && Array.isArray(bindings.interrupt) ? bindings.interrupt : []
}

/** Structural equality of two sanitized bindings objects. */
function bindingsEqual(a, b) {
  return listEqual(a == null ? null : a.send, b == null ? null : b.send)
    && listEqual(a == null ? null : a.newline, b == null ? null : b.newline)
    && listEqual(interruptList(a), interruptList(b))
}

function listEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (var i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Shallow clone with fresh arrays. */
function cloneBindings(bindings) {
  return {
    send: Array.isArray(bindings && bindings.send) ? bindings.send.slice() : [],
    newline: Array.isArray(bindings && bindings.newline) ? bindings.newline.slice() : [],
    interrupt: Array.isArray(bindings && bindings.interrupt) ? bindings.interrupt.slice() : [],
  }
}

/** Human label for one stored chord, e.g. 'ctrl+enter' → 'Ctrl+Enter'. */
function prettifyBinding(binding) {
  return String(binding)
    .split('+')
    .map(function (part) {
      switch (part) {
        case 'ctrl': return 'Ctrl'
        case 'meta': case 'cmd': case 'command': return 'Cmd'
        case 'mod': case 'accel': return 'Ctrl/Cmd'
        case 'alt': return 'Alt'
        case 'shift': return 'Shift'
        case 'enter': return 'Enter'
        case 'space': return 'Space'
        case 'escape': return 'Esc'
        case 'arrowup': return '↑'
        case 'arrowdown': return '↓'
        case 'arrowleft': return '←'
        case 'arrowright': return '→'
        default: return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)
      }
    })
    .join('+')
}

/**
 * Shipped defaults — identical to the harness-native behavior, so installing
 * the plugin changes nothing until the user rebinds. Declared in the pure
 * section (not inside the browser factory) so the scheme helpers below and
 * the test hooks can see them; the factory closes over them lexically.
 */
var DEFAULTS = Object.freeze({
  send: Object.freeze(['enter', 'ctrl+enter']),
  newline: Object.freeze(['shift+enter']),
  interrupt: Object.freeze([]),
})

/** Built-in scheme templates (id doubles as the preset chip key). */
var PRESETS = [
  { id: 'native', bindings: { send: ['enter', 'ctrl+enter'], newline: ['shift+enter'], interrupt: [] } },
  { id: 'chat', bindings: { send: ['ctrl+enter'], newline: ['enter', 'shift+enter'], interrupt: [] } },
]

/** Maximum custom presets a user may store alongside the two built-ins. */
var MAX_CUSTOM_PRESETS = 3

/**
 * Normalize a raw custom-preset list read from the settings document: keep at
 * most MAX_CUSTOM_PRESETS well-formed entries, trim names (dropping blank
 * ones, first-wins on duplicates), and sanitize every entry's three binding
 * lists through sanitizeBindings. Anything that is not an array collapses to [].
 * @param {*} raw - the raw `presets` section value.
 * @returns {Array<{name: string, send: string[], newline: string[], interrupt: string[]}>}
 */
function sanitizeCustomPresets(raw) {
  if (!Array.isArray(raw)) return []
  var out = []
  for (var i = 0; i < raw.length && out.length < MAX_CUSTOM_PRESETS; i += 1) {
    var item = raw[i]
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    var name = typeof item.name === 'string' ? item.name.trim().slice(0, 32) : ''
    if (name === '') continue
    var duplicate = false
    for (var j = 0; j < out.length; j += 1) {
      if (out[j].name === name) { duplicate = true; break }
    }
    if (duplicate) continue
    var bindings = sanitizeBindings(item)
    out.push({
      name: name,
      send: bindings.send.slice(),
      newline: bindings.newline.slice(),
      interrupt: bindings.interrupt.slice(),
    })
  }
  return out
}

/**
 * Structural equality for sanitized custom-preset lists — used both to adopt
 * an unchanged scope view and to confirm that an echo matches a pending write.
 * @param {Array} a - first list.
 * @param {Array} b - second list.
 * @returns {boolean} whether both lists describe the same presets in order.
 */
function presetsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (var i = 0; i < a.length; i += 1) {
    if (a[i].name !== b[i].name) return false
    if (!bindingsEqual(a[i], b[i])) return false
  }
  return true
}

/**
 * Normalize the persisted built-in scheme overrides read from the settings
 * document: only the two reserved ids (`native`, `chat`) survive — one entry
 * each, first occurrence wins — and every entry's triple is re-sanitized
 * through sanitizeBindings. Anything that is not an array collapses to [].
 * @param {*} raw - the raw `builtinSchemes` section value.
 * @returns {Array<{id: string, send: string[], newline: string[], interrupt: string[]}>}
 */
function sanitizeBuiltinSchemes(raw) {
  if (!Array.isArray(raw)) return []
  var out = []
  for (var i = 0; i < raw.length; i += 1) {
    var item = raw[i]
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    var id = typeof item.id === 'string' ? item.id : ''
    if (id !== 'native' && id !== 'chat') continue
    var seen = false
    for (var j = 0; j < out.length; j += 1) {
      if (out[j].id === id) { seen = true; break }
    }
    if (seen) continue
    var triple = sanitizeBindings(item)
    out.push({
      id: id,
      send: triple.send.slice(),
      newline: triple.newline.slice(),
      interrupt: triple.interrupt.slice(),
    })
  }
  return out
}

/**
 * Resolve a built-in scheme's FULL binding triple: the user's persisted
 * override for that id when present, otherwise the shipped template. Schemes
 * are isolated — applying one loads exactly ITS triple (all three channels),
 * never a value inherited from whichever scheme ran before.
 * @param {string} id - 'native' | 'chat'.
 * @param {Array} overrides - sanitized builtinSchemes list (or garbage).
 * @returns {{send: string[], newline: string[], interrupt: string[]}} an independent copy.
 */
function resolveBuiltinTriple(id, overrides) {
  var list = Array.isArray(overrides) ? overrides : []
  for (var i = 0; i < list.length; i += 1) {
    if (list[i] != null && list[i].id === id) {
      return {
        send: list[i].send.slice(),
        newline: list[i].newline.slice(),
        interrupt: list[i].interrupt.slice(),
      }
    }
  }
  for (var j = 0; j < PRESETS.length; j += 1) {
    if (PRESETS[j].id === id) {
      var template = PRESETS[j].bindings
      return {
        send: template.send.slice(),
        newline: template.newline.slice(),
        interrupt: template.interrupt.slice(),
      }
    }
  }
  return cloneBindings(DEFAULTS)
}

/**
 * Identify which scheme the given triple belongs to: custom presets are
 * checked first (an explicitly saved scheme wins over an identical
 * built-in), then `chat`, then `native` — each compared against its
 * OVERRIDE-resolved triple so a scheme with recorded keys still matches.
 * Used BEFORE an edit commits so channel edits write back into the scheme
 * the user is actually editing ("各方案的隔离": the edit belongs to the
 * active scheme, and preset round-trips then restore it intact).
 * @param {{send: string[], newline: string[], interrupt: string[]}|null} triple - candidate bindings.
 * @param {Array} builtinOverrides - sanitized builtinSchemes list.
 * @param {Array} customPresets - sanitized custom presets list.
 * @returns {string|null} 'native' | 'chat' | a custom preset's name, or null (freestyle).
 */
function matchActiveScheme(triple, builtinOverrides, customPresets) {
  if (triple == null) return null
  var customs = Array.isArray(customPresets) ? customPresets : []
  for (var i = 0; i < customs.length; i += 1) {
    if (bindingsEqual(customs[i], triple)) return customs[i].name
  }
  if (bindingsEqual(resolveBuiltinTriple('chat', builtinOverrides), triple)) return 'chat'
  if (bindingsEqual(resolveBuiltinTriple('native', builtinOverrides), triple)) return 'native'
  return null
}

/**
 * Pick the session an interrupt should target, mirroring the OFFICIAL
 * current-session resolution (uiSession `publishMain`): the tracked current
 * session wins while the main view retains it; otherwise whichever session
 * the main view retains; then the tracked current (startup timing gap), the
 * legacy list `current` field (older generations), and finally — when exactly
 * one session is open — that session. The raw list snapshot has NO `current`
 * field on 0.1.7 (reading it yielded `undefined` → interrupt never fired).
 * @param {*} listSnapshot - `sessions.list` snapshot (byId rows / legacy current).
 * @param {string|undefined} uiCurrentKey - `uiSession.current.value.key`, if available.
 * @returns {string|null} the target session id, or null when nothing is open.
 */
function resolveCurrentSessionId(listSnapshot, uiCurrentKey) {
  var byId = listSnapshot != null && typeof listSnapshot.byId === 'object' && listSnapshot.byId !== null
    ? listSnapshot.byId
    : null
  var current = typeof uiCurrentKey === 'string' && uiCurrentKey !== '' ? uiCurrentKey : null

  var rowHasMainView = function (row) {
    return row != null && row.retainedBy != null && (row.retainedBy.mainView || 0) > 0
  }

  // Official rule: the current session while the main view retains it.
  if (current !== null && byId != null && rowHasMainView(byId[current])) return current
  // Otherwise whichever session the main view retains (rows carry their own id).
  if (byId != null) {
    for (var key in byId) {
      var candidate = byId[key]
      if (rowHasMainView(candidate)) {
        return typeof candidate.id === 'string' && candidate.id !== '' ? candidate.id : key
      }
    }
  }
  // No main-view signal yet (startup timing): trust the tracked current.
  if (current !== null) return current
  // A legacy list `current` field, if some generation exposes one.
  if (listSnapshot != null && typeof listSnapshot.current === 'string' && listSnapshot.current !== '') return listSnapshot.current
  // Last resort: exactly one open session IS the target.
  if (byId != null) {
    var only = null
    var count = 0
    for (var single in byId) { only = single; count += 1 }
    if (count === 1 && only !== null) {
      var sole = byId[only]
      return sole != null && typeof sole.id === 'string' && sole.id !== '' ? sole.id : only
    }
  }
  return null
}

/**
 * Structural equality for sanitized built-in scheme lists (gate confirmation
 * + store adoption, mirroring presetsEqual).
 * @param {Array} a - first list.
 * @param {Array} b - second list.
 * @returns {boolean} whether both lists hold the same schemes in order.
 */
function builtinSchemesEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (var i = 0; i < a.length; i += 1) {
    if (a[i].id !== b[i].id) return false
    if (!bindingsEqual(a[i], b[i])) return false
  }
  return true
}

/** Test hooks extracted by test/engine.test.mjs (plain consts, browser-harmless). */
var __COMPOSER_KEYS_TEST_HOOKS__ = {
  MODIFIER_KEYS: MODIFIER_KEYS,
  BINDING_MODIFIER_TOKENS: BINDING_MODIFIER_TOKENS,
  normalizeEventGesture: normalizeEventGesture,
  parseBinding: parseBinding,
  gestureMatchesBinding: gestureMatchesBinding,
  gestureMatchesList: gestureMatchesList,
  actionForGesture: actionForGesture,
  isPristineDefaults: isPristineDefaults,
  moveGesture: moveGesture,
  sanitizeBindings: sanitizeBindings,
  sanitizeCustomPresets: sanitizeCustomPresets,
  sanitizeBuiltinSchemes: sanitizeBuiltinSchemes,
  resolveBuiltinTriple: resolveBuiltinTriple,
  matchActiveScheme: matchActiveScheme,
  resolveCurrentSessionId: resolveCurrentSessionId,
  builtinSchemesEqual: builtinSchemesEqual,
  presetsEqual: presetsEqual,
  MAX_CUSTOM_PRESETS: MAX_CUSTOM_PRESETS,
  bindingsEqual: bindingsEqual,
  cloneBindings: cloneBindings,
  prettifyBinding: prettifyBinding,
}

// Expose the pure engine for tests and console debugging (name is unique enough).
try {
  ;(typeof globalThis !== 'undefined' ? globalThis : this).__COMPOSER_KEYS_TEST_HOOKS__ = __COMPOSER_KEYS_TEST_HOOKS__
} catch (error) { /* exotic environment: tests read the file instead */ }

// ─────────────────────────────────────────────────────────────────────────────
// Browser self-mount
// ─────────────────────────────────────────────────────────────────────────────

if (typeof window === 'undefined' || !window.__ModuleLoader__) return

window.__ModuleLoader__.load({
  id: 'dsh-composer-keys',
  factory: function (require) {
    /**
     * Platform requires resolved against the module graph's uniform base.
     * A missing optional bundle degrades to {} (call sites feature-detect)
     * instead of killing the page; the failure is logged once for diagnosis.
     */
    function safeRequire(spec) {
      try {
        return require(spec)
      } catch (error) {
        console.warn('[composer-keys] optional require failed:', spec)
        return {}
      }
    }
    var React = safeRequire('react')
    var reactDomClient = safeRequire('react-dom/client')
    var primitives = safeRequire('@deepseek-ai/dsh-client-ui-primitives')
    // DSH 0.1.5+ moved createSnapshotStore to @deepseek-ai/dsh-client-store;
    // older versions keep it in @deepseek-ai/dsh-client-runtime/client.
    var clientStore = safeRequire('@deepseek-ai/dsh-client-store')
    var runtime = safeRequire('@deepseek-ai/dsh-client-runtime/client')

    var createElement = React.createElement
    var Tooltip = primitives.Tooltip
    var createSnapshotStore = clientStore.createSnapshotStore || runtime.createSnapshotStore
    if (typeof createSnapshotStore !== 'function') {
      // Polyfill: simple snapshot store matching the runtime API surface
      // used by this plugin (getSnapshot / set / subscribe).
      createSnapshotStore = function (init) {
        var value = init
        var listeners = []
        var api = {
          getSnapshot: function () { return value },
          set: function (next) {
            value = next
            for (var i = 0; i < listeners.length; i += 1) {
              try { listeners[i]() } catch (e) {}
            }
          },
          subscribe: function (fn) {
            listeners.push(fn)
            return function () {
              for (var i = listeners.length - 1; i >= 0; i -= 1) {
                if (listeners[i] === fn) { listeners.splice(i, 1); return }
              }
            }
          },
        }
        return api
      }
    }

    var NS = 'composer-keys'
    var STYLE_ATTRIBUTE = 'data-dsh-composer-keys-style'
    var PANEL_ATTRIBUTE = 'data-dsh-composer-keys-panel'

    var LOCALES = {
      en: {
        'row.title': 'Composer keys',
        'row.desc': 'Send & newline keys for the chat composer. Current:',
        'row.configure': 'Configure…',
        'row.summary.send': 'Send',
        'row.summary.newline': 'Newline',
        'row.summary.interrupt': 'Interrupt',
        'button.label': 'Composer key bindings',
        'panel.title': 'Composer keys',
        'panel.close': 'Close',
        'action.send': 'Send',
        'action.send.desc': 'Submit the draft to the agent.',
        'action.newline': 'Newline',
        'action.newline.desc': 'Insert a line break at the caret.',
        'action.interrupt': 'Interrupt',
        'action.interrupt.desc': 'Abort the open session’s running task — same as the composer stop button. Works anywhere on the page while a task is running; no key bound by default.',
        'record.start': '+ Record keys',
        'record.waiting': 'Press a key combination… (Esc cancels)',
        'record.waiting.interrupt': 'Press a key combination… (pressing Esc binds Esc; click this button again to cancel)',
        'hint.empty.send': 'No send key bound — use the send button.',
        'hint.empty.newline': 'No newline key bound.',
        'hint.empty.interrupt': 'No interrupt key bound.',
        'preset.label': 'Presets:',
        'preset.native': 'DSH native',
        'preset.chat': 'Chat style',
        'preset.add': '+ Add custom preset',
        'preset.custom': 'Custom',
        'preset.delete': 'Delete preset',
        'preset.full': 'Up to 3 custom presets',
        'note.line1': 'While the agent is busy, queue-vs-steer follows the native “Busy Enter behavior” setting uniformly for EVERY bound send key. Only the untouched default bindings stay fully native (Ctrl/Cmd+Enter keeps its opposite-behavior trait in that pristine state).',
        'note.line2': 'This plugin only assigns which keys trigger send or newline. IME composition is never interrupted; other inputs (approval panels, rename boxes) are untouched.',
      },
      zh: {
        'row.title': '输入框按键',
        'row.desc': '自定义聊天输入框的发送与换行键位。当前:',
        'row.configure': '配置…',
        'row.summary.send': '发送',
        'row.summary.newline': '换行',
        'row.summary.interrupt': '打断',
        'button.label': '输入框按键设置',
        'panel.title': '输入框按键',
        'panel.close': '关闭',
        'action.send': '发送',
        'action.send.desc': '把草稿提交给智能体。',
        'action.newline': '换行',
        'action.newline.desc': '在光标处插入换行。',
        'action.interrupt': '打断',
        'action.interrupt.desc': '中断当前打开会话正在运行的任务，等同于输入框的停止按钮；任务运行时在页面任意位置生效。默认无绑定。',
        'record.start': '+ 录制按键',
        'record.waiting': '请按下组合键…(Esc 取消)',
        'record.waiting.interrupt': '请按下组合键…（按 Esc 即录制为打断键；再点本按钮取消）',
        'hint.empty.send': '未绑定发送键——只能通过发送按钮发送。',
        'hint.empty.newline': '未绑定换行键。',
        'hint.empty.interrupt': '未绑定打断键。',
        'preset.label': '快速预设:',
        'preset.native': 'DSH 原生',
        'preset.chat': '微信风格',
        'preset.add': '+ 添加自定义预设',
        'preset.custom': '自定义',
        'preset.delete': '删除预设',
        'preset.full': '最多保存 3 个自定义预设',
        'note.line1': '智能体忙碌时，发送是排队还是转向统一由 DSH 原生设置「繁忙时 Enter 键行为」决定——对所有已绑定的发送键一视同仁。仅当键位保持出厂默认时插件完全不介入（此时 Ctrl/Cmd+Enter 保留原生“另一行为”特性）。',
        'note.line2': '本插件只分配哪个键触发发送或换行。中文输入法选字中的 Enter 不会被拦截；审批面板等其他输入框不受影响。',
      },
    }

    var CSS = [
      '.ck-row{display:flex;align-items:center;gap:12px;padding:10px 0;}',
      '.ck-rowtext{flex:1;min-width:0;}',
      '.ck-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329);}',
      '.ck-desc{margin-top:2px;font-size:12px;color:var(--dsw-alias-label-secondary,#646a73);overflow:hidden;text-overflow:ellipsis;}',
      '.ck-btn{flex:0 0 auto;border:1px solid var(--dsw-alias-border-l2,#dee0e3);background:transparent;color:var(--dsw-alias-label-primary,#1f2329);border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;}',
      '.ck-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));}',
      '.ck-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#8f959e);border-radius:6px;cursor:pointer;padding:0;}',
      '.ck-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#1f2329);}',
      '.ck-overlay{position:fixed;inset:0;z-index:10000;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.35));display:flex;align-items:center;justify-content:center;font-family:inherit;}',
      '.ck-panel{width:min(520px,calc(100vw - 32px));max-height:min(80vh,640px);overflow:auto;background:var(--dsw-alias-bg-layer-1,#ffffff);color:var(--dsw-alias-label-primary,#1f2329);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.22);padding:16px 18px;font-size:13px;line-height:1.5;}',
      '.ck-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;}',
      '.ck-x{border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#8f959e);font-size:16px;cursor:pointer;border-radius:6px;width:24px;height:24px;line-height:1;padding:0;}',
      '.ck-x:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#1f2329);}',
      '.ck-action{margin-top:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#e5e6eb);border-radius:10px;}',
      '.ck-actionhead{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:8px;}',
      '.ck-record{flex:0 0 auto;border:1px dashed var(--dsw-alias-border-l3,#b7bcc4);background:transparent;color:var(--dsw-alias-label-secondary,#646a73);border-radius:6px;padding:3px 8px;font-size:12px;cursor:pointer;}',
      '.ck-record:hover{border-color:var(--dsw-alias-brand-primary,#3370ff);color:var(--dsw-alias-brand-primary,#3370ff);}',
      '.ck-record[data-recording="true"]{border-style:solid;border-color:var(--dsw-alias-brand-primary,#3370ff);color:var(--dsw-alias-brand-primary,#3370ff);cursor:progress;}',
      '.ck-chips{display:flex;flex-wrap:wrap;gap:6px;min-height:24px;align-items:center;}',
      '.ck-chip{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l2,#dee0e3);border-radius:6px;padding:2px 4px 2px 8px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}',
      '.ck-chipx{border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#8f959e);cursor:pointer;font-size:12px;line-height:1;padding:1px 3px;border-radius:4px;}',
      '.ck-chipx:hover{color:#d54941;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}',
      '.ck-empty{font-size:12px;color:var(--dsw-alias-label-tertiary,#8f959e);}',
      '.ck-foot{display:flex;align-items:center;justify-content:flex-start;gap:6px;margin-top:14px;flex-wrap:wrap;}',
      '.ck-presets-label{font-size:12px;color:var(--dsw-alias-label-secondary,#646a73);margin-right:2px;}',
      '.ck-preset{border:1px solid var(--dsw-alias-border-l2,#dee0e3);background:transparent;color:var(--dsw-alias-label-primary,#1f2329);border-radius:999px;padding:2px 10px;font-size:12px;cursor:pointer;}',
      '.ck-preset:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));}',
      '.ck-preset[disabled]{opacity:.5;cursor:not-allowed;}',
      '.ck-preset[disabled]:hover{background:transparent;}',
      '.ck-preset-del{margin-left:6px;padding:0 3px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#8f959e);font-size:12px;line-height:1;cursor:pointer;border-radius:4px;}',
      '.ck-preset-del:hover{color:var(--dsw-alias-label-primary,#1f2329);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.08));}',
      '.ck-note{font-size:12px;color:var(--dsw-alias-label-tertiary,#8f959e);line-height:1.6;margin-top:14px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1,#e5e6eb);white-space:pre-line;}',
    ].join('\n')

    /** Install the stylesheet once per document; idempotent across reloads. */
    function installStyle(doc) {
      try {
        var existing = doc.querySelector('style[' + STYLE_ATTRIBUTE + ']')
        if (existing !== null) return { node: existing, owned: false }
        var style = doc.createElement('style')
        style.setAttribute(STYLE_ATTRIBUTE, '')
        style.textContent = CSS
        ;(doc.head || doc.documentElement).appendChild(style)
        return { node: style, owned: style.parentElement !== null }
      } catch (error) {
        return { node: null, owned: false }
      }
    }

    function noop() {}

    /** Translate bound to our namespace, falling back to the zh dictionary. */
    function makeTranslate(ctx) {
      try {
        if (ctx.locale && typeof ctx.locale.bind === 'function') {
          var bound = ctx.locale.bind(NS)
          return function (key) {
            var out = bound(key)
            if (typeof out === 'string' && out !== key) return out
            return LOCALES.zh[key] !== undefined ? LOCALES.zh[key] : key
          }
        }
      } catch (error) { /* fall through */ }
      return function (key) { return LOCALES.zh[key] !== undefined ? LOCALES.zh[key] : key }
    }

    // ── Keyboard engine ──────────────────────────────────────────────────────

    /** Whether an element sits in the main chat composer input. */
    function isComposerInput(target) {
      if (!target || typeof target.closest !== 'function') return false
      if (target.closest('[data-input-scroll]') == null) return false
      // DSH ≤0.1.4: HTMLTextAreaElement; DSH ≥0.1.5: Lexical contentEditable div.
      if (target instanceof HTMLTextAreaElement) return true
      // Climb: a caret inside a child span makes event.target that span, whose
      // own contentEditable reads 'inherit' — isContentEditable propagates.
      var node = target
      while (node != null) {
        if (node.isContentEditable === true) return true
        if (node.getAttribute && node.getAttribute('data-composer-input') === 'true') return true
        node = node.parentElement
      }
      return false
    }

    function installKeyboardEngine(store) {
      var onKeyDown = function (event) {
        // Synthetic events (including OUR replayed Enter) pass through so the
        // native handler owns the pipeline and no loop can form.
        if (event.isTrusted !== true) return
        // IME composition: candidate-picking Enter must never be touched.
        if (event.isComposing === true || event.keyCode === 229) return
        var target = event.target
        if (!isComposerInput(target)) return
        if (target.disabled || target.readOnly) return

        var bindings = store.getSnapshot()
        var gesture = normalizeEventGesture(event)
        var action = actionForGesture(bindings, gesture)
        if (action === undefined) return
        // Interrupt chords are owned by the page-wide engine below.
        if (action === 'interrupt') return
        // Pristine default state: full zero-intervention (native traits intact).
        if (isPristineDefaults(bindings, DEFAULTS)) return

        if (action === 'newline') {
          // Shift+Enter is the composer's native newline chord (DSH treats it
          // as an unconditional line break): pass it through untouched so the
          // DEFAULT chord can never be swallowed by a failed programmatic
          // insert, in pristine or customized states alike.
          if (gesture === 'shift+enter') return
          // Custom chord (e.g. Enter-as-newline): never fall through — the
          // native Enter would SEND a draft the user only meant to edit.
          event.preventDefault()
          event.stopImmediatePropagation()
          if (!insertNewline(target)) {
            console.warn('[composer-keys] unable to insert newline in this editor')
          }
        } else {
          event.preventDefault()
          event.stopImmediatePropagation()
          replaySubmit(target)
        }
      }
      window.addEventListener('keydown', onKeyDown, true)
      return function () {
        window.removeEventListener('keydown', onKeyDown, true)
      }
    }

    /**
     * Page-wide interrupt engine. Unlike the composer-scoped engine this one
     * deliberately listens EVERYWHERE (the stop button must be reachable no
     * matter where focus sits), with three yield rules:
     *  - IME composition Esc (cancel candidates) is never touched;
     *  - any open dialog / menu / listbox / our own panel keeps its native
     *    Escape-to-close behavior;
     *  - the key event is swallowed ONLY when the interrupt callback actually
     *    fired (busy gate inside the callback) — idle presses flow untouched.
     */
    function installInterruptEngine(store, onInterrupt) {
      var YIELD_SELECTOR = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="listboxpopup"],[data-dsh-composer-keys-panel]'
      var onKeyDown = function (event) {
        if (event.isTrusted !== true) return
        if (event.isComposing === true || event.keyCode === 229) return
        // Ours only — match the interrupt chord FIRST so every other keypress
        // stays invisible (a bound interrupt also implies non-pristine, which
        // made the old pristine short-circuit redundant here).
        var bindings = store.getSnapshot()
        var gesture = normalizeEventGesture(event)
        if (!gestureMatchesList(bindings.interrupt, gesture)) return
        var target = event.target
        if (target instanceof Element && target.closest(YIELD_SELECTOR) !== null) {
          console.info('[composer-keys] interrupt skipped: dialog/menu/panel is open (yield)')
          return
        }
        var outcome = onInterrupt()
        if (outcome !== true) {
          // The callback explains itself (idle gate, data source, resolver…)
          // instead of failing silently.
          console.info('[composer-keys] interrupt skipped:', outcome)
          return
        }
        console.info('[composer-keys] interrupt fired')
        event.preventDefault()
        event.stopImmediatePropagation()
      }
      window.addEventListener('keydown', onKeyDown, true)
      // Registration proof: if this line never appears after a reload, the
      // engine did not install (or the browser still runs a stale bundle).
      console.info(
        '[composer-keys] page-wide interrupt engine installed; store interrupt chord(s) at boot:',
        JSON.stringify(store.getSnapshot().interrupt),
      )
      return function () {
        window.removeEventListener('keydown', onKeyDown, true)
      }
    }

    /**
     * Replay one synthetic plain-Enter keydown so the NATIVE onKeyDown performs
     * the submission (arbitration, empty-draft guard, busy queue-vs-steer all
     * preserved). The accelerator flag is NEVER set: every bound send chord —
     * Ctrl/Cmd+Enter included — follows the PRIMARY busy behavior uniformly.
     * The native "Ctrl/Cmd+Enter uses the other behavior" trait exists only in
     * the pristine-default pass-through state. Shift is never set: the native
     * handler treats Shift+Enter as an unconditional newline.
     */
    function replaySubmit(target) {
      var synthetic = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
        composed: true,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      })
      target.dispatchEvent(synthetic)
    }

    /**
     * Insert '\n' at the caret while keeping the controlled React/Lexical draft
     * in sync. Returns true on success, false on failure — the caller decides
     * whether to prevent the browser default.
     */
    function insertNewline(target) {
      try { target.focus() } catch (error) {}

      // DSH ≥0.1.5: Lexical commands are identity-keyed OBJECTS, not names.
      // Use the registered object from THIS editor (even a second imported
      // Lexical copy would create a different identity). The vendored build
      // retains the command's type label. Keep this private-API bridge guarded:
      // if it changes, fail closed instead of editing DOM behind Lexical's back.
      // __lexicalEditor lives on the contentEditable ROOT; with the caret in a
      // child span, event.target is that span — so climb to the root first.
      var node = target
      var editor = null
      while (node != null) {
        if (node.__lexicalEditor) { editor = node.__lexicalEditor; break }
        node = node.parentElement
      }
      if (editor) {
        try {
          var command = null
          if (editor._commands && typeof editor._commands.forEach === 'function') {
            editor._commands.forEach(function (_, key) {
              if (key && key.type === 'INSERT_LINE_BREAK_COMMAND') command = key
            })
          }
          if (command !== null && typeof editor.dispatchCommand === 'function'
            && editor.dispatchCommand(command, false) === true) {
            return true
          }
        } catch (error) { /* fall through */ }
      }

      // Replay a synthetic Shift+Enter through the same untrusted-event
      // pipeline the (working) send replay uses: the composer's own keydown
      // handler resolves it to its native newline branch, and this plugin's
      // capture listener ignores untrusted events, so no loop can form.
      try {
        target.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, composed: true,
          shiftKey: true, ctrlKey: false, metaKey: false, altKey: false,
        }))
        return true
      } catch (error) { /* fall through */ }

      // Legacy textarea / plain contentEditable only. execCommand's return
      // value is NOT evidence of an edit reaching a Lexical state transaction.
      var handled = false
      try { handled = document.execCommand('insertText', false, '\n') } catch (error) {}
      if (handled) return true

      // Textarea value-setter fallback (DSH ≤0.1.4).
      if (target instanceof HTMLTextAreaElement) {
        try {
          var start = typeof target.selectionStart === 'number' ? target.selectionStart : target.value.length
          var end = typeof target.selectionEnd === 'number' ? target.selectionEnd : start
          target.setRangeText('\n', start, end, 'end')
          var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
          setter.call(target, target.value)
          target.dispatchEvent(new Event('input', { bubbles: true }))
          var caret = start + 1
          target.setSelectionRange(caret, caret)
          return true
        } catch (error) { /* give up silently */ }
      }

      return false
    }

    // ── Floating panel (single React root over the document body) ───────────

    function createPanelController(store, presetStore, builtinStore, writeBindings, writePresets, writeBuiltinSchemes, t) {
      var host = null
      var root = null
      var openState = false

      function ensureRoot() {
        if (host !== null && host.isConnected && root !== null) return
        if (host === null || !host.isConnected) {
          host = document.createElement('div')
          host.setAttribute(PANEL_ATTRIBUTE, '')
          document.body.appendChild(host)
        }
        root = reactDomClient.createRoot(host)
      }

      function render() {
        if (root === null) return
        root.render(createElement(Panel, {
          open: openState,
          store: store,
          presetStore: presetStore,
          builtinStore: builtinStore,
          writeBindings: writeBindings,
          writePresets: writePresets,
          writeBuiltinSchemes: writeBuiltinSchemes,
          t: t,
          onClose: function () {
            openState = false
            render()
          },
        }))
      }

      return {
        open: function () {
          try {
            ensureRoot()
            openState = true
            render()
          } catch (error) { /* panel is a convenience; never break the page */ }
        },
        dispose: function () {
          openState = false
          if (root !== null) {
            try { root.unmount() } catch (error) {}
            root = null
          }
          if (host !== null) {
            try { host.remove() } catch (error) {}
            host = null
          }
        },
      }
    }

    function Panel(props) {
      var t = props.t
      var useState = React.useState
      var useEffect = React.useEffect
      // Local editing view mirrors the store; every edit applies immediately.
      var current = useState(function () { return cloneBindings(props.store.getSnapshot()) })
      var bindings = current[0]
      var setBindings = current[1]
      var recordingState = useState(null)
      var recording = recordingState[0]
      var setRecording = recordingState[1]
      // Saved custom presets mirror their store; every edit applies immediately.
      var presetsState = useState(function () { return sanitizeCustomPresets(props.presetStore.getSnapshot()) })
      var presets = presetsState[0]
      var setPresets = presetsState[1]

      /**
       * Channel edits (recording / chip removal) belong to the scheme in use:
       * derive that scheme from the PRE-edit live triple, commit the edit, and
       * write it back into the scheme's stored triple — so a recorded key
       * survives preset round-trips, while each scheme keeps its own values
       * isolated ("打断随预设切换 + 各方案隔离"). Freestyle bindings (matching
       * no scheme) stay live-only until a preset is clicked.
       */
      var editBindings = function (nextTriple) {
        var clean = sanitizeBindings(nextTriple)
        var active = matchActiveScheme(
          props.store.getSnapshot(),
          props.builtinStore.getSnapshot(),
          props.presetStore.getSnapshot(),
        )
        props.writeBindings(clean)
        if (active === 'native' || active === 'chat') {
          var schemes = props.builtinStore.getSnapshot()
          var updated = []
          var found = false
          for (var i = 0; i < schemes.length; i += 1) {
            if (schemes[i].id !== active) { updated.push(schemes[i]); continue }
            found = true
            updated.push({ id: active, send: clean.send.slice(), newline: clean.newline.slice(), interrupt: clean.interrupt.slice() })
          }
          if (!found) updated.push({ id: active, send: clean.send.slice(), newline: clean.newline.slice(), interrupt: clean.interrupt.slice() })
          props.writeBuiltinSchemes(updated)
        } else if (active !== null && active !== undefined) {
          var customs = props.presetStore.getSnapshot()
          var nextCustoms = []
          var saved = false
          for (var j = 0; j < customs.length; j += 1) {
            if (customs[j].name !== active) { nextCustoms.push(customs[j]); continue }
            saved = true
            nextCustoms.push({
              name: active,
              send: clean.send.slice(),
              newline: clean.newline.slice(),
              interrupt: clean.interrupt.slice(),
            })
          }
          if (saved) props.writePresets(nextCustoms)
        }
      }

      // Follow external changes (another surface wrote the settings document).
      useEffect(function () {
        var sync = function () { setBindings(cloneBindings(props.store.getSnapshot())) }
        var unsubscribe = props.store.subscribe(sync)
        return function () {
          if (typeof unsubscribe === 'function') unsubscribe()
        }
      }, [props.store])

      useEffect(function () {
        var sync = function () { setPresets(sanitizeCustomPresets(props.presetStore.getSnapshot())) }
        var unsubscribe = props.presetStore.subscribe(sync)
        return function () {
          if (typeof unsubscribe === 'function') unsubscribe()
        }
      }, [props.presetStore])

      // Recorder: capture-phase interception while active.
      useEffect(function () {
        if (recording === null) return
        var onKeyDown = function (event) {
          event.preventDefault()
          event.stopImmediatePropagation()
          if (event.key === 'Escape' && recording !== 'interrupt') {
            setRecording(null)
            return
          }
          // Interrupt recording: Escape is the flagship binding target, so it
          // REGISTERS instead of canceling (cancel by clicking the button again).
          var gesture = normalizeEventGesture(event)
          if (gesture === '') return // pure modifier press: keep waiting
          var next = moveGesture(props.store.getSnapshot(), gesture, recording)
          editBindings(next)
          setBindings(cloneBindings(next))
          setRecording(null)
        }
        document.addEventListener('keydown', onKeyDown, true)
        return function () { document.removeEventListener('keydown', onKeyDown, true) }
      }, [recording, props.writeBindings])

      if (props.open !== true) return null
      var snapshot = props.store.getSnapshot()

      var applyNow = function (nextBindings) {
        props.writeBindings(nextBindings)
        setBindings(cloneBindings(nextBindings))
        setRecording(null)
      }

      // Capture the CURRENT bindings as a named custom preset (≤ 3 saved).
      var addPreset = function () {
        if (presets.length >= MAX_CUSTOM_PRESETS) return
        var base = t('preset.custom')
        var names = presets.map(function (entry) { return entry.name })
        var suffix = 1
        while (names.indexOf(base + ' ' + suffix) !== -1) suffix += 1
        var created = {
          name: base + ' ' + suffix,
          send: bindings.send.slice(),
          newline: bindings.newline.slice(),
          interrupt: bindings.interrupt.slice(),
        }
        var next = presets.concat([created])
        props.writePresets(next)
        setPresets(next)
      }

      var dropPreset = function (name) {
        var next = presets.filter(function (entry) { return entry.name !== name })
        props.writePresets(next)
        setPresets(next)
      }

      return createElement('div', {
        className: 'ck-overlay',
        onMouseDown: function (event) {
          if (event.target === event.currentTarget) props.onClose()
        },
      },
        createElement('div', { className: 'ck-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('panel.title') },
          createElement('div', { className: 'ck-head' },
            createElement('div', { className: 'ck-title' }, t('panel.title')),
            createElement('button', { type: 'button', className: 'ck-x', 'aria-label': t('panel.close'), onClick: props.onClose }, '×')),
          createActionBlock(t, 'send', snapshot, recording, setRecording, editBindings, setBindings),
          createActionBlock(t, 'newline', snapshot, recording, setRecording, editBindings, setBindings),
          createActionBlock(t, 'interrupt', snapshot, recording, setRecording, editBindings, setBindings),
          createElement('div', { className: 'ck-foot' },
            createElement('span', { className: 'ck-presets-label' }, t('preset.label')),
            PRESETS.map(function (preset) {
              return createElement('button', {
                key: preset.id,
                type: 'button',
                className: 'ck-preset',
                onClick: function () {
                  // Isolated scheme switch: load THIS scheme's full triple
                  // (its own send/newline/interrupt override when persisted).
                  applyNow(resolveBuiltinTriple(preset.id, props.builtinStore.getSnapshot()))
                },
              }, t('preset.' + preset.id))
            }),
            presets.map(function (preset, index) {
              return createElement('button', {
                key: 'custom-' + index,
                type: 'button',
                className: 'ck-preset ck-preset-custom',
                onClick: function () {
                  // Isolated scheme switch: a custom preset loads its OWN
                  // captured triple — interrupt follows the preset too, and
                  // no value is inherited from the previously active scheme.
                  applyNow({
                    send: preset.send.slice(),
                    newline: preset.newline.slice(),
                    interrupt: preset.interrupt.slice(),
                  })
                },
              },
                preset.name,
                createElement('span', {
                  className: 'ck-preset-del',
                  role: 'button',
                  tabIndex: 0,
                  'aria-label': t('preset.delete') + ': ' + preset.name,
                  onClick: function (event) {
                    event.stopPropagation()
                    dropPreset(preset.name)
                  },
                  onKeyDown: function (event) {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      event.stopPropagation()
                      dropPreset(preset.name)
                    }
                  },
                }, '×'))
            }),
            createElement('button', {
              type: 'button',
              className: 'ck-preset ck-preset-add',
              disabled: presets.length >= MAX_CUSTOM_PRESETS,
              title: presets.length >= MAX_CUSTOM_PRESETS ? t('preset.full') : undefined,
              onClick: addPreset,
            }, t('preset.add'))),
          createElement('div', { className: 'ck-note' }, t('note.line1') + '\n' + t('note.line2'))))
    }

    function createActionBlock(t, action, bindings, recording, setRecording, writeBindings, setBindings) {
      var list = Array.isArray(bindings[action]) ? bindings[action] : []
      var removeChip = function (gesture) {
        var next = cloneBindings(bindings)
        next[action] = list.filter(function (entry) { return entry !== gesture })
        writeBindings(next)
        setBindings(cloneBindings(next))
      }
      var toggleRecord = function () { setRecording(recording === action ? null : action) }
      return createElement('div', { className: 'ck-action', key: action },
        createElement('div', { className: 'ck-actionhead' },
          createElement('div', {},
            createElement('div', { className: 'ck-title' }, t('action.' + action)),
            createElement('div', { className: 'ck-desc' }, t('action.' + action + '.desc'))),
          createElement('button', {
            type: 'button',
            className: 'ck-record',
            'data-recording': recording === action ? 'true' : 'false',
            onClick: toggleRecord,
          }, recording === action ? t(action === 'interrupt' ? 'record.waiting.interrupt' : 'record.waiting') : t('record.start'))),
        createElement('div', { className: 'ck-chips' },
          list.map(function (gesture) {
            return createElement('span', { key: gesture, className: 'ck-chip' },
              prettifyBinding(gesture),
              createElement('button', {
                type: 'button',
                className: 'ck-chipx',
                'aria-label': '×',
                onClick: function () { removeChip(gesture) },
              }, '×'))
          }),
          list.length === 0
            ? createElement('span', { className: 'ck-empty' }, t('hint.empty.' + action))
            : null))
    }

    // ── Slot components ──────────────────────────────────────────────────────

    /**
     * Settings → General row. The slots runtime flattens the registered inject
     * face onto props: hooks.bindings arrives as useBindings, configure as-is.
     */
    function SettingsRow(props) {
      var t = props.t
      var summary = ''
      try {
        var useBindings = props.useBindings
        var bindings = typeof useBindings === 'function' ? useBindings(function (value) { return value }) : null
        if (bindings) {
          summary = ' ' + t('row.summary.send') + ': '
            + (bindings.send.length > 0 ? bindings.send.map(prettifyBinding).join(' · ') : '—')
            + ' · ' + t('row.summary.newline') + ': '
            + (bindings.newline.length > 0 ? bindings.newline.map(prettifyBinding).join(' · ') : '—')
          if (Array.isArray(bindings.interrupt) && bindings.interrupt.length > 0) {
            summary += ' · ' + t('row.summary.interrupt') + ': ' + bindings.interrupt.map(prettifyBinding).join(' · ')
          }
        }
      } catch (error) { /* summary is decorative */ }
      return createElement('div', { className: 'ck-row' },
        createElement('div', { className: 'ck-rowtext' },
          createElement('div', { className: 'ck-title' }, t('row.title')),
          createElement('div', { className: 'ck-desc' }, t('row.desc') + summary)),
        createElement('button', { type: 'button', className: 'ck-btn', onClick: props.configure }, t('row.configure')))
    }

    /** Small keyboard icon at the right end of the composer tool row. */
    function ComposerButton(props) {
      var t = props.t
      var button = createElement('button', {
        type: 'button',
        className: 'ck-iconbtn',
        'aria-label': t('button.label'),
        title: t('button.label'),
        onMouseDown: function (event) { event.preventDefault() }, // keep focus in the textarea
        onClick: function () {
          if (typeof props.openPanel === 'function') props.openPanel()
        },
      },
        createElement('svg', { viewBox: '0 0 16 16', width: 15, height: 15, 'aria-hidden': true },
          createElement('rect', { x: 1.5, y: 3.5, width: 13, height: 9, rx: 1.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
          createElement('rect', { x: 4, y: 10, width: 8, height: 1, rx: 0.5, fill: 'currentColor' }),
          [3, 5.75, 8.5, 11.25].map(function (x) {
            return createElement('rect', { key: 'k' + x, x: x, y: 5.5, width: 1.5, height: 1.5, rx: 0.4, fill: 'currentColor' })
          }),
          [4.25, 7, 9.75].map(function (x) {
            return createElement('rect', { key: 'k' + x, x: x, y: 7.75, width: 1.5, height: 1.5, rx: 0.4, fill: 'currentColor' })
          })))
      if (typeof Tooltip === 'function') {
        return createElement(Tooltip, { label: t('button.label'), side: 'top', delayMs: 500 }, button)
      }
      return button
    }

    // ── apply(ctx): the plugin fiber body ───────────────────────────────────

    /**
     * Required client services (vendored cordis refuses property access
     * without declaration — `cannot get property X without inject`):
     * - locale: dictionary registration (`ctx.locale.register`);
     * - slots: Settings row + composer button registration;
     * - sessions: interrupt action targets the currently open session.
     *
     * Deliberately NOT listed: the settings surface. DSH ≤0.1.6 called it
     * `settingsScope`, 0.1.7 renamed it to `configForms` — listing either
     * parks the whole plugin at boot (`pending: waiting for service: ...`).
     * Both are instead taken through optional nested injects inside apply,
     * so a deployment with neither degrades to session-local bindings while
     * the keyboard engine keeps running.
     */
    var CLIENT_INJECT = ['locale', 'slots', 'sessions']

    function apply(ctx) {
      // Dictionaries first; later surfaces bind through the locale seat.
      try {
        ctx.effect(function () { return ctx.locale.register(NS, { zh: LOCALES.zh, en: LOCALES.en }) }, 'dsh-composer-keys: dictionaries')
      } catch (error) { console.warn('[composer-keys] locale.register failed', error) }
      var t = makeTranslate(ctx)

      // Durable preference scope (same channel as the native busy-Enter row).
      // ≤0.1.6: settingsScope.bind({ namespace }); 0.1.7: configForms.get(entryId).
      // Both surfaces share one scope shape (getSnapshot/set/subscribe), and
      // both arrive through optional nested injects so neither can park apply.
      var scope = null

      function readScope() {
        try {
          var section = scope !== null && typeof scope.getSnapshot === 'function'
            ? scope.getSnapshot().value
            : undefined
          return section ? sanitizeBindings(section) : cloneBindings(DEFAULTS)
        } catch (error) {
          return cloneBindings(DEFAULTS)
        }
      }

      /** Raw settings section: undefined while no scope or namespace unserved. */
      function readSection() {
        try {
          return scope !== null && typeof scope.getSnapshot === 'function'
            ? scope.getSnapshot().value
            : undefined
        } catch (error) { return undefined }
      }

      // Reactive sources shared by the engine, both slot entries, and the panel.
      var store = createSnapshotStore(readScope())
      var presetStore = createSnapshotStore(sanitizeCustomPresets((readSection() || {}).presets))
      var builtinStore = createSnapshotStore(sanitizeBuiltinSchemes((readSection() || {}).builtinSchemes))

      /**
       * Write gates. While a local write is unconfirmed, any scope view that
       * CONTRADICTS it — a partial echo of an in-flight write, a stale
       * projection served before the Host applied the override, or the
       * recovery view of a rejected write — must not clobber the optimistic
       * state (that is the "preset snaps back to native" bug). A matching
       * echo confirms and clears the gate; a rejected write clears it and
       * immediately re-adopts the Host's truth.
       */
      var pendingBindings = null
      var pendingPresets = null
      var pendingBuiltins = null

      function adoptScopeView() {
        var section = readSection()
        var hasSection = section !== undefined && section !== null && typeof section === 'object'

        var nextBindings = hasSection ? sanitizeBindings(section) : cloneBindings(DEFAULTS)
        if (pendingBindings !== null) {
          if (hasSection && bindingsEqual(nextBindings, pendingBindings)) pendingBindings = null
        } else if (!bindingsEqual(store.getSnapshot(), nextBindings)) {
          logInterruptChange(store.getSnapshot().interrupt, nextBindings.interrupt)
          store.set(nextBindings)
        }

        var nextPresets = hasSection ? sanitizeCustomPresets(section.presets) : []
        if (pendingPresets !== null) {
          if (presetsEqual(nextPresets, pendingPresets)) pendingPresets = null
        } else if (!presetsEqual(presetStore.getSnapshot(), nextPresets)) {
          presetStore.set(nextPresets)
        }

        var nextBuiltins = hasSection ? sanitizeBuiltinSchemes(section.builtinSchemes) : []
        if (pendingBuiltins !== null) {
          if (builtinSchemesEqual(nextBuiltins, pendingBuiltins)) pendingBuiltins = null
        } else if (!builtinSchemesEqual(builtinStore.getSnapshot(), nextBuiltins)) {
          builtinStore.set(nextBuiltins)
        }
      }

      /** Subscribe a freshly-bound scope and adopt whatever it already holds. */
      function attachScope() {
        if (scope === null || typeof scope.subscribe !== 'function') return
        scope.subscribe(adoptScopeView)
        adoptScopeView()
      }
      attachScope()

      // Legacy surface (≤0.1.6).
      try {
        ctx.inject(['settingsScope'], function (sctx) {
          if (scope !== null) return
          try {
            if (sctx.settingsScope && typeof sctx.settingsScope.bind === 'function') {
              scope = sctx.settingsScope.bind({ namespace: NS })
              attachScope()
            }
          } catch (error) { console.warn('[composer-keys] settingsScope.bind failed', error) }
        })
      } catch (error) { console.warn('[composer-keys] settingsScope inject failed', error) }

      // 0.1.7 surface: host entry id `composer-keys` doubles as its settings
      // namespace in the configForms mirror.
      try {
        ctx.inject(['configForms'], function (sctx) {
          if (scope !== null) return
          try {
            if (sctx.configForms && typeof sctx.configForms.get === 'function') {
              scope = sctx.configForms.get(NS)
              attachScope()
            }
          } catch (error) { console.warn('[composer-keys] configForms.get failed', error) }
        })
      } catch (error) { console.warn('[composer-keys] configForms inject failed', error) }

      // Merged live session status (host baseline + api-session/status events).
      // The interrupt busy gate reads it; optional nested inject, so a
      // deployment without uiSession only loses the live layer and falls back
      // to the baseline row — never the plugin itself.
      var uiSessionService = null
      try {
        ctx.inject(['uiSession'], function (sctx) {
          if (uiSessionService !== null) return
          try {
            if (sctx.uiSession != null) uiSessionService = sctx.uiSession
          } catch (error) { console.warn('[composer-keys] uiSession bind failed', error) }
        })
      } catch (error) { console.warn('[composer-keys] uiSession inject failed', error) }

      /**
       * Persist section fields through ONE atomic mutation when the surface
       * offers it (0.1.7 ConfigFormController.mutate — a single revision, a
       * single echo, no partial-view flicker) and per-field sets otherwise.
       * @param {Array<{field: string, value: *}>} pairs - section fields.
       * @returns {Promise<boolean>} whether the Host accepted every write.
       */
      function persistSections(pairs) {
        if (scope === null) return Promise.resolve(true)
        try {
          if (typeof scope.mutate === 'function') {
            var ops = pairs.map(function (pair) { return { op: 'set', path: [pair.field], value: pair.value } })
            var mutation = scope.mutate(ops)
            return mutation && typeof mutation.then === 'function' ? mutation : Promise.resolve(true)
          }
          if (typeof scope.set !== 'function') return Promise.resolve(false)
          var attempts = pairs.map(function (pair) {
            try {
              var attempt = scope.set(pair.field, pair.value)
              return attempt && typeof attempt.then === 'function' ? attempt : true
            } catch (error) { return false }
          })
          return Promise.all(attempts).then(function (flags) {
            return flags.every(function (flag) { return flag !== false })
          })
        } catch (error) {
          return Promise.resolve(false)
        }
      }

      /** One line whenever the interrupt channel's bound chords change. */
      function logInterruptChange(before, after) {
        var prev = Array.isArray(before) ? before : []
        var next = Array.isArray(after) ? after : []
        if (listEqual(prev, next)) return
        console.info('[composer-keys] interrupt channel →', next.length ? next.join(', ') : '(cleared)')
      }

      function writeBindings(next) {
        var clean = sanitizeBindings(next)
        var previousInterrupt = store.getSnapshot().interrupt
        store.set(clean)
        logInterruptChange(previousInterrupt, clean.interrupt)
        if (scope === null || (typeof scope.mutate !== 'function' && typeof scope.set !== 'function')) return
        pendingBindings = clean
        persistSections([
          { field: 'send', value: clean.send.slice() },
          { field: 'newline', value: clean.newline.slice() },
          { field: 'interrupt', value: clean.interrupt.slice() },
        ]).then(function (accepted) {
          if (accepted === false) {
            console.warn('[composer-keys] Host rejected the key-binding write — keeping the session-local state')
            if (pendingBindings === clean) { pendingBindings = null; adoptScopeView() }
          }
        }, function () {
          if (pendingBindings === clean) { pendingBindings = null; adoptScopeView() }
        })
      }

      function writePresets(next) {
        var clean = sanitizeCustomPresets(next)
        presetStore.set(clean)
        if (scope === null || (typeof scope.mutate !== 'function' && typeof scope.set !== 'function')) return
        pendingPresets = clean
        persistSections([{ field: 'presets', value: clean }]).then(function (accepted) {
          if (accepted === false) {
            console.warn('[composer-keys] Host rejected the preset write — keeping the session-local state')
            if (pendingPresets === clean) { pendingPresets = null; adoptScopeView() }
          }
        }, function () {
          if (pendingPresets === clean) { pendingPresets = null; adoptScopeView() }
        })
      }

      /**
       * Persist the built-in scheme overrides (the three-channel triples the
       * user edited while a builtin scheme was active). Same single-field,
       * gated pattern as writePresets.
       * @param {Array} next - the sanitized builtinSchemes list.
       */
      function writeBuiltinSchemes(next) {
        var clean = sanitizeBuiltinSchemes(next)
        builtinStore.set(clean)
        if (scope === null || (typeof scope.mutate !== 'function' && typeof scope.set !== 'function')) return
        pendingBuiltins = clean
        persistSections([{ field: 'builtinSchemes', value: clean }]).then(function (accepted) {
          if (accepted === false) {
            console.warn('[composer-keys] Host rejected the scheme write — keeping the session-local state')
            if (pendingBuiltins === clean) { pendingBuiltins = null; adoptScopeView() }
          }
        }, function () {
          if (pendingBuiltins === clean) { pendingBuiltins = null; adoptScopeView() }
        })
      }

      /**
       * Interrupt action: resolve the CURRENTLY OPEN session through the
       * sessions runtime and invoke the same cancel face the native stop
       * button uses, so subagent address routing and error display behave
       * identically. Returns true only when a cancel was actually dispatched;
       * otherwise a short reason code the engine logs — a dead key press must
       * explain itself instead of failing silently.
       * @returns {true|string} dispatch verdict or the skip reason.
       */
      function interruptCurrentSession() {
        try {
          var sessions = ctx.sessions
          if (sessions == null || sessions.list == null || typeof sessions.list.getSnapshot !== 'function') return 'sessions-unavailable'
          var snapshot = sessions.list.getSnapshot()
          // 0.1.7's list snapshot has NO `current` field — resolve the target
          // the way the official UI does: uiSession.current (tracked) plus
          // main-view retention, with legacy/single-session fallbacks.
          var uiCurrentKey
          try {
            uiCurrentKey = uiSessionService != null && uiSessionService.current != null && uiSessionService.current.value != null
              ? uiSessionService.current.value.key
              : undefined
          } catch (error) { uiCurrentKey = undefined }
          var id = resolveCurrentSessionId(snapshot, uiCurrentKey)
          if (id === null) {
            var openCount = snapshot != null && snapshot.byId != null && typeof snapshot.byId === 'object'
              ? Object.keys(snapshot.byId).length
              : 0
            return 'no-current-session (open: ' + String(openCount) + ')'
          }
          // Busy gate: an idle press stays hands-off (native Esc semantics win).
          // DATA SOURCE MATTERS: the raw list row only carries the HOST
          // BASELINE of `running`; live start/stop transitions arrive as
          // status events into uiSession.sessionStatus (the merged view the
          // official UI reads). Reading the baseline alone left the gate
          // closed while a task was actually running — interrupt then never
          // fired. Prefer the merged entry; fall back to the baseline row.
          var summary = snapshot.byId != null ? snapshot.byId[id] : undefined
          var running = undefined
          try {
            if (uiSessionService != null && uiSessionService.sessionStatus != null
              && typeof uiSessionService.sessionStatus.getSnapshot === 'function') {
              var status = uiSessionService.sessionStatus.getSnapshot()
              var entry = status != null && typeof status.get === 'function' ? status.get(id) : undefined
              if (entry != null && typeof entry.running === 'boolean') running = entry.running
            }
          } catch (error) { /* fall through to the baseline row */ }
          if (running === undefined) running = summary != null ? summary.running : undefined
          if (running !== true) return 'not-running (idle presses stay hands-off by design)'
          var conversation = undefined
          if (typeof sessions.scope === 'function') {
            var scoped = sessions.scope(id)
            if (scoped !== undefined && scoped !== null && typeof scoped.get === 'function') {
              conversation = scoped.get('conversation')
            }
          }
          if ((conversation == null || typeof conversation.cancel !== 'function') && typeof sessions.binding === 'function') {
            var binding = sessions.binding(id)
            if (binding != null) conversation = binding.session
          }
          if (conversation == null || typeof conversation.cancel !== 'function') return 'conversation-unavailable'
          var outcome = conversation.cancel()
          if (outcome != null && typeof outcome.then === 'function') {
            outcome.catch(function (error) {
              console.warn('[composer-keys] interrupt cancel failed', error)
            })
          }
          return true
        } catch (error) {
          return 'error: ' + (error != null && error.message ? error.message : String(error))
        }
      }

      // Keyboard engine: window-capture keydown, scoped to the composer box.
      var disposeKeyboard = noop
      try { disposeKeyboard = installKeyboardEngine(store, interruptCurrentSession) } catch (error) { /* stay inert rather than break the page */ }
      var disposeInterrupt = noop
      try { disposeInterrupt = installInterruptEngine(store, interruptCurrentSession) } catch (error) { /* stay inert rather than break the page */ }

      // Panel singleton lifecycle (created lazily on first open).
      var panel = createPanelController(store, presetStore, builtinStore, writeBindings, writePresets, writeBuiltinSchemes, t)

      // Entry A: Settings → General row.
      try {
        ctx.slots.inject('settings.general.item', function () {
          return ctx.slots.register({
            name: 'settings.general.item',
            id: 'composer-keys-row',
            order: 21,
            locale: NS,
            inject: function () {
              return { hooks: { bindings: store }, configure: function () { panel.open() } }
            },
          }, SettingsRow)
        })
      } catch (error) { console.warn('[composer-keys] settings.general.item inject failed', error) }

      // Entry B: small keyboard button at the right end of the composer tool row.
      try {
        ctx.slots.inject('conversation.input.right', function () {
          return ctx.slots.register({
            name: 'conversation.input.right',
            id: 'composer-keys-button',
            locale: NS,
            inject: function () {
              return { openPanel: function () { panel.open() } }
            },
          }, ComposerButton)
        })
      } catch (error) { console.warn('[composer-keys] conversation.input.right inject failed', error) }

      // Styles ride the fiber like everything else.
      var styleInstall = installStyle(document)

      return function cleanup() {
        try { disposeKeyboard() } catch (error) {}
        try { disposeInterrupt() } catch (error) {}
        try { panel.dispose() } catch (error) {}
        try {
          if (styleInstall.owned && styleInstall.node) styleInstall.node.remove()
        } catch (error) {}
      }
    }

    return { apply: apply, inject: CLIENT_INJECT }
  },
})
})()
