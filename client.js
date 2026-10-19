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
 * - Editing surfaces (v0.2.1): TWO faces over ONE staged state.
 *   1. The sidebar Plugins page (DSH 0.2.x): `plugins.bundle.config` (key
 *      `dsh-composer-keys`, embedded on the bundle's page) and
 *      `plugins.row.config` (key `dsh-composer-keys#composer-keys`, behind
 *      the row's Configure control) with ONE native staged form —
 *      SettingsFormModel over three chord-list text fields, the scheme
 *      strip, and the new-scheme name field; Save commits everything.
 *   2. The RESTORED floating panel (0.1.x surface) opened by the
 *      Settings→General row and the composer keyboard button: immediate
 *      writes (staged drafts are the Plugins page's business), a trusted-
 *      keydown recorder for press-to-capture binding, the scheme strip,
 *      and a bottom migration notice with a deep-link button into THIS
 *      plugin's own Plugins-page settings (`pluginNavigation.openBundle`).
 *
 * Safety properties
 * - While bindings equal the shipped defaults, recognized native gestures are
 *   passed THROUGH untouched — installing the plugin changes nothing.
 * - IME composition keydowns (isComposing / keyCode 229) are never touched.
 * - Synthetic events are ignored via isTrusted, so the replay cannot loop.
 * - Only the main composer textarea/contentEditable is affected: approval
 *   panels, rename boxes, and every other editable surface keep native keys.
 * - Page edits are staged: nothing is written until the native Save commits
 *   one atomic mutation; leaving the Plugins page drops unsaved drafts.
 * - The floating panel applies immediately (0.1.x semantics): optimistic
 *   local updates are reconciled by the scope echo, so a Host refusal shows
 *   as a snap-back rather than a lie.
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

    var createElement = React.createElement
    var Tooltip = primitives.Tooltip
    var createSnapshotStore = primitives.createSnapshotStore || safeRequire('@deepseek-ai/dsh-client-store').createSnapshotStore
      || safeRequire('@deepseek-ai/dsh-client-runtime/client').createSnapshotStore
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

    var LOCALES = {
      en: {
        'row.title': 'Composer keys',
        'row.desc': 'Send, newline & interrupt keys for the chat composer.',
        'row.summary.send': 'Send',
        'row.summary.newline': 'Newline',
        'row.summary.interrupt': 'Interrupt',
        'row.configure': 'Settings…',
        'button.label': 'Composer key bindings',
        'action.send': 'Send',
        'action.send.desc': 'Submit the draft to the agent.',
        'action.newline': 'Newline',
        'action.newline.desc': 'Insert a line break at the caret.',
        'action.interrupt': 'Interrupt',
        'action.interrupt.desc': 'Abort the open session’s running task — same as the composer stop button. Works anywhere on the page while a task runs; no key bound by default.',
        'hint.empty.send': 'No send key bound — use the send button.',
        'hint.empty.newline': 'No newline key bound.',
        'hint.empty.interrupt': 'No interrupt key bound.',
        'record.start': '+ Record keys',
        'record.waiting': 'Press a key combination… (Esc cancels)',
        'record.waiting.interrupt': 'Press a key combination… (pressing Esc binds Esc; click this button again to cancel)',
        'panel.title': 'Composer keys',
        'panel.close': 'Close',
        'panel.scheme': 'Key scheme',
        'panel.schemeNative': 'DSH native',
        'panel.schemeChat': 'Chat style',
        'panel.newSchemeLabel': 'Save current keys as scheme:',
        'panel.newSchemePlaceholder': 'Scheme name',
        'panel.newSchemeApply': 'Save scheme',
        'panel.newSchemeFull': 'Custom schemes max 3 (same name overwrites)',
        'panel.openPlugins': 'Open the Plugins page settings…',
        'panel.migrate': 'The floating panel is kept for now; the plugin configuration will eventually move entirely to the sidebar “Plugins” page.',
        'page.summary': 'Send, newline & interrupt keys for the chat composer, with built-in scheme presets.',
        'page.unavailable': 'This deployment serves no persistent key-binding storage; editing is unavailable.',
        'page.readOnly': 'Key bindings are read-only in this deployment.',
        'page.saveFailed': 'This deployment did not accept these values; they are kept for editing.',
        'page.save': 'Save',
        'page.saving': 'Saving…',
        'page.overridden': 'Overridden',
        'page.reset': 'Reset',
        'page.sendHint': 'Multiple keys are separated with commas, e.g. “enter, ctrl+enter”; the “+ Record keys” button below the field records one directly. While the agent is busy, queue-vs-steer for a bound send key follows the native “Busy Enter behavior” setting.',
        'page.newlineHint': 'Multiple keys are separated with commas, e.g. “enter, shift+enter”; the “+ Record keys” button below the field records one directly. An unbound Shift+Enter stays the native newline; once it is explicitly bound to an action THIS plugin takes it over.',
        'page.interruptHint': 'Abort the open session’s running task — same as the composer stop button; works anywhere on the page while a task runs. Empty = disabled.',
        'page.placeholder.send': 'e.g. enter, ctrl+enter',
        'page.placeholder.newline': 'e.g. shift+enter',
        'page.classic': 'Classic panel',
        'page.classicTitle': 'Open the floating panel (classic UI) — keys apply immediately there',
        'page.invalid': 'Unparsable chord (each chord carries one modifier set plus one key); saving is blocked.',
        'page.scheme': 'Key scheme',
        'page.schemeNative': 'DSH native',
        'page.schemeChat': 'Chat style',
        'page.schemeHint': 'Check a scheme: the three fields switch to that scheme as one set and take effect on Save. The scheme matching the current fields is checked automatically; none are checked when the fields are freestyle.',
        'page.newScheme': 'New scheme name',
        'page.newSchemePlaceholder': 'e.g. Night keys',
        'page.newSchemeHint': 'Enter a name and Save: the current three fields are stored as a custom scheme (max 3; the same name overwrites). Empty = save bindings only, no scheme.',
        'page.schemeFull': 'Scheme slots are full: 3 custom schemes maximum.',
        'page.note': 'Edits take effect after Save, no reload needed. IME composition is never interrupted; other inputs (approval panels, rename boxes) are untouched.',
      },
      zh: {
        'row.title': '输入框按键',
        'row.desc': '自定义聊天输入框的发送、换行与打断键位。',
        'row.summary.send': '发送',
        'row.summary.newline': '换行',
        'row.summary.interrupt': '打断',
        'row.configure': '设置…',
        'button.label': '输入框按键设置',
        'action.send': '发送',
        'action.send.desc': '把草稿提交给智能体。',
        'action.newline': '换行',
        'action.newline.desc': '在光标处插入换行。',
        'action.interrupt': '打断',
        'action.interrupt.desc': '中断当前打开会话正在运行的任务，等同于输入框的停止按钮；任务运行时在页面任意位置生效。默认无绑定。',
        'hint.empty.send': '未绑定发送键——只能通过发送按钮发送。',
        'hint.empty.newline': '未绑定换行键。',
        'hint.empty.interrupt': '未绑定打断键。',
        'record.start': '+ 录制按键',
        'record.waiting': '请按下组合键…（Esc 取消）',
        'record.waiting.interrupt': '请按下组合键…（按 Esc 即录制为打断键；再点本按钮取消）',
        'panel.title': '输入框按键',
        'panel.close': '关闭',
        'panel.scheme': '键位方案',
        'panel.schemeNative': 'DSH 原生',
        'panel.schemeChat': '微信风格',
        'panel.newSchemeLabel': '把当前键位存为方案：',
        'panel.newSchemePlaceholder': '方案名',
        'panel.newSchemeApply': '保存方案',
        'panel.newSchemeFull': '自定义方案最多 3 个（同名覆盖）',
        'panel.openPlugins': '打开插件页设置…',
        'panel.migrate': '浮动面板为过渡保留：后续版本插件配置将彻底迁移到侧边栏「插件」页。',
        'page.summary': '自定义聊天输入框的发送 / 换行 / 打断键位，及内置键位方案。',
        'page.unavailable': '本部署未提供键位偏好存储，配置暂不可用。',
        'page.readOnly': '这个部署里键位偏好是只读的。',
        'page.saveFailed': '本部署没有接受这些值，已保留供你修改。',
        'page.save': '保存',
        'page.saving': '保存中…',
        'page.overridden': '已修改',
        'page.reset': '重置',
        'page.sendHint': '多个键用逗号「,」分隔，如「enter, ctrl+enter」；点字段下方的「+ 录制」直接按键录入。智能体忙碌时发送键的排队/转向由原生「繁忙时 Enter 键行为」统一决定。',
        'page.newlineHint': '多个键用逗号「,」分隔，如「enter, shift+enter」；点字段下方的「+ 录制」直接按键录入。未显式绑定时 Shift+Enter 是原生换行；一旦显式绑定到某动作就由本插件接管。',
        'page.interruptHint': '中断当前打开会话正在运行的任务，等同于输入框的停止按钮；任务运行时在页面任意位置生效。留空 = 不启用。',
        'page.placeholder.send': '例如：enter, ctrl+enter',
        'page.placeholder.newline': '例如：shift+enter',
        'page.classic': '经典界面',
        'page.classicTitle': '打开浮动面板（经典界面）——里面的改动立即生效',
        'page.invalid': '无法识别的键位组合（每个组合是修饰键 + 一个键），保存被阻止。',
        'page.scheme': '键位方案',
        'page.schemeNative': 'DSH 原生',
        'page.schemeChat': '微信风格',
        'page.schemeHint': '勾选一个方案：三个键位字段整组切换为该方案，随「保存」一次生效；字段与某方案一致时自动勾中，都不一致时全部未选。',
        'page.newScheme': '新建方案名',
        'page.newSchemePlaceholder': '例如：夜间键位',
        'page.newSchemeHint': '填名字并点「保存」：把当前三个键位字段存为一个自定义方案（最多 3 个，同名覆盖）；留空 = 只保存键位，不建方案。',
        'page.schemeFull': '方案已满：自定义方案最多 3 个。',
        'page.note': '修改在点击「保存」后立即生效，无需刷新。中文输入法选字中的按键不会被拦截；其他输入框（审批面板、重命名框）不受影响。',
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
      // ── Floating panel (restored 0.1.x surface, immediate-write semantics) ──
      '.ck-overlay{position:fixed;inset:0;z-index:10000;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.35));display:flex;align-items:center;justify-content:center;font-family:inherit;}',
      '.ck-panel{width:min(520px,calc(100vw - 32px));max-height:min(80vh,640px);overflow:auto;background:var(--dsw-alias-bg-layer-1,#ffffff);color:var(--dsw-alias-label-primary,#1f2329);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.22);padding:16px 18px;font-size:13px;line-height:1.5;}',
      '.ck-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;}',
      '.ck-x{border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#8f959e);font-size:16px;cursor:pointer;border-radius:6px;width:24px;height:24px;line-height:1;padding:0;}',
      '.ck-x:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#1f2329);}',
      '.ck-action{margin-top:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#e5e6eb);border-radius:10px;}',
      '.ck-actionhead{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:8px;}',
      '.ck-record{flex:0 0 auto;border:1px dashed var(--dsw-alias-border-l3,#b7bcc4);background:transparent;color:var(--dsw-alias-label-secondary,#646a73);border-radius:6px;padding:3px 8px;font-size:12px;cursor:pointer;}',
      // Row-inline variant (Plugins-page scheme row): matches the BARE text
      // label's box height (19.5px at font 13/1.5) instead of the padded
      // button box (~26px) — a taller button centered against a shorter
      // label reads as "half a line too high".
      '.ck-record.ck-inline{padding:2px 8px;line-height:1;border-radius:6px;}',
      '.ck-record:hover{border-color:var(--dsw-alias-brand-primary,#3370ff);color:var(--dsw-alias-brand-primary,#3370ff);}',
      '.ck-record[data-recording="true"]{border-style:solid;border-color:var(--dsw-alias-brand-primary,#3370ff);color:var(--dsw-alias-brand-primary,#3370ff);cursor:progress;}',
      '.ck-chips{display:flex;flex-wrap:wrap;gap:6px;min-height:24px;align-items:center;}',
      '.ck-chip{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l2,#dee0e3);border-radius:6px;padding:2px 4px 2px 8px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}',
      '.ck-chipx{border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#8f959e);cursor:pointer;font-size:12px;line-height:1;padding:1px 3px;border-radius:4px;}',
      '.ck-chipx:hover{color:#d54941;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}',
      '.ck-empty{font-size:12px;color:var(--dsw-alias-label-tertiary,#8f959e);}',
      '.ck-foot{display:flex;align-items:center;flex-wrap:wrap;gap:6px 14px;margin-top:14px;}',
      '.ck-schemelabel{font-size:12px;color:var(--dsw-alias-label-secondary,#646a73);margin-right:2px;flex:none;}',
      // Scheme checkboxes — the panel mirrors the Plugins page strip: native
      // checkbox inputs, one checked at a time (the active scheme's rule).
      '.ck-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;color:var(--dsw-alias-label-primary,#1f2329);}',
      '.ck-check input{margin:0;}',
      '.ck-schemeadd{display:flex;align-items:center;gap:6px;margin-top:10px;}',
      '.ck-schemeadd input{flex:1;min-width:0;border:1px solid var(--dsw-alias-border-l2,#dee0e3);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#1f2329);padding:4px 8px;font-size:12px;font-family:inherit;outline:none;}',
      '.ck-schemeadd input:focus{border-color:var(--dsw-alias-brand-primary,#3370ff);}',
      '.ck-schemeadd input[disabled]{opacity:.5;cursor:not-allowed;}',
      '.ck-note{font-size:12px;color:var(--dsw-alias-label-tertiary,#8f959e);line-height:1.6;margin-top:14px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1,#e5e6eb);white-space:pre-line;}',
      '.ck-noteactions{display:flex;justify-content:flex-end;margin-top:10px;}',
      // Plugins-page recorder: the record button OVERLAYS each native
      // field's head row (label | … | [modified tag?][reset]) at top-right,
      // shifted left by the measured badges width so it always reads as
      // part of the label row, never the next section.
      '.ck-fieldline{position:relative;display:block;}',
      '.ck-fieldline>.ck-record{position:absolute;top:0;right:0;z-index:2;}',
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
          // Explicit binding wins: Shift+Enter bound to newline is PASSED
          // through untouched so the bound chord can never be swallowed by
          // a failed programmatic insert — the native handler owns it.
          // Rebound to send/interrupt, the matching branches above/below own
          // it instead (a custom scheme may occupy Shift+Enter); UNBOUND,
          // actionForGesture returns undefined and the key stays native.
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
     *  - any open dialog / menu / listbox keeps its native Escape-to-close
     *    behavior;
     *  - the key event is swallowed ONLY when the interrupt callback actually
     *    fired (busy gate inside the callback) — idle presses flow untouched.
     */
    function installInterruptEngine(store, onInterrupt) {
      var YIELD_SELECTOR = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="listboxpopup"]'
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
          console.info('[composer-keys] interrupt skipped: dialog/menu is open (yield)')
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

    // ── Plugins-page config (DSH 0.2.x native form) ──────────────────────────

    /**
     * One binding channel as a NATIVE staged text field: the stored string
     * list formats comma-separated, and the typed text parses back into the
     * list. parse returns undefined when any chord is unparsable — the native
     * frame then marks the field invalid and blocks Save. Empty text stages a
     * clear, which reverts the channel to its deployment default (the shipped
     * triple). parseBinding comes from the pure engine via the file scope.
     */
    /**
     * Shared chord-list parsing for BOTH the chord fields and the custom
     * scheme writer below: split on commas (full-width included), trim,
     * lowercase, validate each chord through the pure engine, dedupe in
     * order. Returns null when any chord is unparsable (the caller surfaces
     * the field-invalid state that blocks Save); an empty result is `[]`.
     */
    function parseChordTexts(text) {
      if (typeof text !== 'string') return null
      var chords = []
      var parts = text.split(/[,，]/)
      for (var i = 0; i < parts.length; i += 1) {
        var chord = parts[i].trim().toLowerCase()
        if (chord === '') continue
        if (parseBinding(chord) === null) return null
        if (chords.indexOf(chord) === -1) chords.push(chord)
      }
      return chords
    }

    function chordListField(field) {
      return {
        field: field,
        format: function (value) {
          return Array.isArray(value) ? value.join(', ') : ''
        },
        parse: function (text) {
          if (typeof text !== 'string' || text.trim() === '') return { kind: 'clear' }
          var chords = parseChordTexts(text)
          if (chords === null) return undefined
          return { kind: 'set', value: chords }
        },
      }
    }

    /**
     * Bridges the `composer-keys` configForms scope onto ONE native staged
     * form: three chord-list text fields, the new-scheme name field, and a
     * hidden `presets` writer. Reuses the SAME scope instance the keyboard
     * engine already binds, so a save's echo flows through adoptScopeView and
     * the engine updates live. All editing is staged: nothing is written
     * until the native Save issues one atomic `mutate(ops, revision)`;
     * surviving the page also drops drafts (the staged model clears with the
     * settings document echo only).
     *
     * The custom-scheme writer exploits the form's staged-op plan: every
     * field contributes one op only when its staged text differs from the
     * rendered current value, and specs emit `{kind:'set', value}` through
     * parse. `schemeName` (a volatile string) always parses back to clear —
     * it is a request channel, never stored — while the hidden `presets`
     * spec (format renders '', co-staged with '' text by the name field's
     * edit handler, so plan always includes it) reads the staged name and
     * the three staged chord texts and emits the merged scheme list in the
     * SAME mutate call. Scheme slots match the stored cap (3); an overfull
     * request parses to undefined, which natively invalidates the name
     * field and blocks Save.
     */
    function ComposerKeysPageController(scope, builtinStore, presetsStore, panelGetter) {
      this.panelGetter = typeof panelGetter === 'function' ? panelGetter : function () { return null }
      /** Widened to the form instance so the presets spec can read drafts. */
      var formRef = { form: null }

      /** Triple rebuilt from the current field texts; null when any is unparsable. */
      var tripleFromTexts = function () {
        var form = formRef.form
        if (form === null) return null
        var send = parseChordTexts(form.field('send').text)
        var newline = parseChordTexts(form.field('newline').text)
        var interrupt = parseChordTexts(form.field('interrupt').text)
        if (send === null || newline === null || interrupt === null) return null
        return { send: send, newline: newline, interrupt: interrupt }
      }
      /** Text-shape equality: fields vs a resolved scheme triple. */
      var textsEqualTriple = function (triple) {
        var form = formRef.form
        if (form === null || triple === null) return false
        return form.field('send').text === triple.send.join(', ')
          && form.field('newline').text === triple.newline.join(', ')
          && form.field('interrupt').text === triple.interrupt.join(', ')
      }

      var schemeNameSpec = {
        field: 'schemeName',
        /** Always renders empty: not a stored preference, only a request. */
        format: function () { return '' },
        parse: function (text) {
          var name = typeof text === 'string' ? text.trim() : ''
          if (name === '') return { kind: 'clear' }
          var customs = sanitizeCustomPresets(presetsStore.getSnapshot())
          for (var i = 0; i < customs.length; i += 1) {
            if (customs[i].name === name) return { kind: 'clear' }
          }
          if (customs.length >= MAX_CUSTOM_PRESETS) return undefined
          return { kind: 'clear' }
        },
      }

      var presetsSpec = {
        field: 'presets',
        /** Hidden channel: renders '' so only co-staged edits reach the plan. */
        format: function () { return '' },
        parse: function () {
          var form = formRef.form
          var name = form !== null ? form.field('schemeName').text.trim() : ''
          var current = sanitizeCustomPresets(presetsStore.getSnapshot())
          if (name === '') return { kind: 'set', value: current } // idempotent no-op
          var triple = tripleFromTexts()
          if (triple === null) return undefined // unparsable chords block Save
          var next = []
          for (var i = 0; i < current.length; i += 1) {
            if (current[i].name !== name) next.push({
              name: current[i].name,
              send: current[i].send.slice(),
              newline: current[i].newline.slice(),
              interrupt: current[i].interrupt.slice(),
            })
          }
          next.push({ name: name, send: triple.send, newline: triple.newline, interrupt: triple.interrupt })
          return { kind: 'set', value: next }
        },
      }

      var form = new primitives.SettingsFormModel(scope, [
        chordListField('send'),
        chordListField('newline'),
        chordListField('interrupt'),
        schemeNameSpec,
        presetsSpec,
      ])
      formRef.form = form
      /** One actions face, held for its lifetime (closures over this form). */
      var actions = form.actions()

      /** Staged scheme switch: stages the whole triple for id into the fields. */
      this.setScheme = function (id) {
        var triple = null
        if (id === 'native' || id === 'chat') {
          triple = resolveBuiltinTriple(id, builtinStore.getSnapshot())
        } else {
          var customs = sanitizeCustomPresets(presetsStore.getSnapshot())
          for (var i = 0; i < customs.length; i += 1) {
            if (customs[i].name === id) {
              triple = {
                send: customs[i].send.slice(),
                newline: customs[i].newline.slice(),
                interrupt: customs[i].interrupt.slice(),
              }
              break
            }
          }
        }
        if (triple === null) return // unknown id: leave drafts untouched
        var names = ['send', 'newline', 'interrupt']
        for (var j = 0; j < names.length; j += 1) {
          var desired = triple[names[j]].join(', ')
          if (form.field(names[j]).text !== desired) actions.edit(names[j], desired)
        }
      }

      /** The slot face: hooks promote to props.useKeysPage; actions become props. */
      this.inject = function () {
        // `classicPanel` (v0.2.4): a face into the floating panel — THROUGH a
        // late-bound getter, because the slots face is built here while the
        // panel controller may be installed later in apply() (and might stay
        // absent without react-dom). The button simply hides when null.
        var panel = this.panelGetter != null ? this.panelGetter() : null
        return {
          hooks: { keysPage: this.pageStore },
          edit: actions.edit,
          resetField: actions.resetField,
          save: actions.save,
          discard: actions.discard,
          setScheme: this.setScheme,
          classicPanel: panel != null ? panel.open : undefined,
        }
      }

      /** Live snapshot: the native frame state, per-field states, and the strip. */
      this.pageStore = form.bind(function () {
        var snapshot = form.shell() // available/writable/dirty/invalid/saving/failed
        snapshot.send = form.field('send')
        snapshot.newline = form.field('newline')
        snapshot.interrupt = form.field('interrupt')
        snapshot.schemeName = form.field('schemeName')

        // The scheme strip: built-ins first, then the stored custom presets.
        // Kind tells the card which dictionary label to paint (custom names
        // are user content — shown verbatim).
        var overrides = builtinStore.getSnapshot()
        var customs = sanitizeCustomPresets(presetsStore.getSnapshot())
        var schemes = [
          { id: 'native', kind: 'builtin', triple: resolveBuiltinTriple('native', overrides) },
          { id: 'chat', kind: 'builtin', triple: resolveBuiltinTriple('chat', overrides) },
        ]
        for (var i = 0; i < customs.length; i += 1) {
          schemes.push({
            id: customs[i].name,
            kind: 'custom',
            triple: {
              send: customs[i].send.slice(),
              newline: customs[i].newline.slice(),
              interrupt: customs[i].interrupt.slice(),
            },
          })
        }
        snapshot.schemes = schemes

        // Auto-match: which scheme the current field texts concretely are.
        // Custom schemes match first (the same precedence matchActiveScheme
        // settles engine-side: an explicitly saved scheme wins over an
        // identical built-in), then chat, then native.
        var active = null
        for (var j = 0; j < schemes.length; j += 1) {
          if (schemes[j].kind === 'custom' && textsEqualTriple(schemes[j].triple)) { active = schemes[j].id; break }
        }
        if (active === null && textsEqualTriple(schemes[1].triple)) active = 'chat'
        if (active === null && textsEqualTriple(schemes[0].triple)) active = 'native'
        snapshot.activeScheme = active
        return snapshot
      })

      this.dispose = function () {
        try { form.dispose() } catch (error) {}
      }
    }

    /**
     * The Plugins-page card: native SettingsForm frame + the scheme strip
     * (top, checkboxes), the three text fields, and the new-scheme name
     * field. `view: 'summary'` (the row page's package-description fallback)
     * renders the one-liner; the bundle page and the row's page both ask for
     * `view: 'page'`.
     */
    function ComposerKeysPageCard(props) {
      var t = props.t
      // In-page recorder (#2 follow-up): press-to-capture lives here too.
      // Hooks MUST come before the conditional returns below so the hook
      // order stays stable across summary/full renders.
      var recorderState = React.useState(null)
      var recording = recorderState[0]
      var setRecording = recorderState[1]
      var stagedRef = React.useRef(null)
      React.useEffect(function () {
        // Recorder effect: capture-phase interception keyed to the STAGED
        // texts (recording edits the same staged fields as typing — nothing
        // is written until the native Save commits). Escape cancels except
        // when recording the interrupt, where Esc IS the binding target.
        if (recording === null) return
        var onKeyDown = function (event) {
          event.preventDefault()
          event.stopImmediatePropagation()
          if (event.key === 'Escape' && recording !== 'interrupt') {
            setRecording(null)
            return
          }
          var gesture = normalizeEventGesture(event)
          if (gesture === '') return // pure modifier press: keep waiting
          var live = stagedRef.current
          if (live === null || live.edit === undefined) {
            setRecording(null)
            return
          }
          var names = ['send', 'newline', 'interrupt']
          var parsed = {}
          for (var i = 0; i < names.length; i += 1) {
            parsed[names[i]] = parseChordTexts(live[names[i]] || '')
          }
          // Unparsable target: recording cannot safely merge into it, so the
          // session ends silently (the field's own invalid label explains).
          if (parsed[recording] === null) {
            setRecording(null)
            return
          }
          // moveGesture: dedupe on the target and strip the gesture from the
          // other actions (same semantics as the floating panel's recorder).
          var triple = {
            send: parsed.send === null ? [] : parsed.send,
            newline: parsed.newline === null ? [] : parsed.newline,
            interrupt: parsed.interrupt === null ? [] : parsed.interrupt,
          }
          var next = moveGesture(triple, gesture, recording)
          live.edit(recording, next[recording].join(', '))
          for (var j = 0; j < names.length; j += 1) {
            var action = names[j]
            if (action === recording) continue
            if (parsed[action] === null) continue // leave unparsable text untouched
            if (listEqual(next[action], parsed[action])) continue
            live.edit(action, next[action].join(', '))
          }
          setRecording(null)
        }
        document.addEventListener('keydown', onKeyDown, true)
        return function () { document.removeEventListener('keydown', onKeyDown, true) }
      }, [recording])
      if (props.view === 'summary') return t('page.summary')
      var useKeysPage = props.useKeysPage
      if (typeof useKeysPage !== 'function') {
        return createElement('p', { style: { fontSize: 12, margin: '4px 0' } }, t('page.unavailable'))
      }
      var state = useKeysPage(function (snapshot) { return snapshot })
      var writable = state.writable === true
      var disabled = state.saving === true
      var fieldDisabled = !writable || disabled

      // Freshest staged texts + edit face for the recorder effect (reads at
      // keydown time — no stale closures across echos/re-renders).
      stagedRef.current = {
        send: state.send != null ? state.send.text : '',
        newline: state.newline != null ? state.newline.text : '',
        interrupt: state.interrupt != null ? state.interrupt.text : '',
        edit: props.edit,
      }

      /** Native Checkbox when served, styled fallback when not. */
      var checkboxLabel = function (checked, label, onChange) {
        if (primitives != null && typeof primitives.Checkbox === 'function') {
          return createElement(primitives.Checkbox, {
            checked: checked === true,
            label: label,
            disabled: fieldDisabled,
            onChange: onChange,
          })
        }
        var input = createElement('input', {
          type: 'checkbox',
          checked: checked === true,
          disabled: fieldDisabled,
          onChange: function (event) { onChange(event.target.checked) },
        })
        return createElement('label', {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 13,
            color: 'var(--dsw-alias-label-primary,#1f2329)',
            cursor: fieldDisabled ? 'default' : 'pointer',
          },
        }, input, createElement('span', null, label))
      }

      /** The scheme strip that anchors the form: one checkbox per scheme. */
      var schemeStrip = createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, margin: '0 0 6px' } },
        createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
          createElement('div', { style: { fontSize: 13, fontWeight: 600 } }, t('page.scheme')),
          typeof props.classicPanel === 'function'
            ? createElement('button', {
              type: 'button',
              className: 'ck-record ck-inline',
              'data-recording': 'false',
              title: t('page.classicTitle'),
              onClick: props.classicPanel,
            }, t('page.classic'))
            : null),
        createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px 20px' } },
          (Array.isArray(state.schemes) ? state.schemes : []).map(function (scheme) {
            var label = scheme.kind === 'native' ? t('page.schemeNative')
              : scheme.kind === 'chat' ? t('page.schemeChat')
              : scheme.id
            return createElement('span', { key: String(scheme.id), style: { display: 'contents' } },
              checkboxLabel(
                state.activeScheme === scheme.id,
                label,
                function () {
                  // Already-checked stays put: a scheme click SETS the
                  // scheme, it never disables it.
                  if (state.activeScheme === scheme.id) return
                  props.setScheme(scheme.id)
                }))
          })))

      /**
       * One chord-list field with a "＋ Record keys" button overlaid on the
       * head row (label | … | [modified tag?][reset]): the button sits in
       * FRONT of the "modified" badge, part of the label line, not the next
       * section. A post-render measurement reads the native badges' width
       * (they mount/unmount with the overridden state) and shifts the
       * button's `right` accordingly, so the two never collide.
       * Recording stages the captured chord into the SAME staged text —
       * Save commits it exactly like typed text. Disabled when the whole
       * page isn't writable or the field's staged text is unparsable
       * (nothing safe to merge into; the field's own invalid label explains).
       */
      var chordRow = function (action, hintText, placeholderText) {
        var fieldState = state[action]
        var invalidTarget = fieldState != null && fieldState.invalid === true
        var canRecord = !fieldDisabled
          && !invalidTarget
          && parseChordTexts(fieldState != null ? fieldState.text || '' : '') !== null
        var rowRef = React.useRef(null)
        // No deps: the measurement must re-run after EVERY commit (the
        // badges span mounts/unmounts as the overridden state flips).
        React.useEffect(function () {
          var wrap = rowRef.current
          if (wrap === null || typeof wrap.getBoundingClientRect !== 'function') return
          var button = null
          for (var c = wrap.children, i = 0; i < c.length; i += 1) {
            if (c[i].className === 'ck-record') { button = c[i]; break }
          }
          if (button === null) return
          var right = 0
          var top = 0
          try {
            var inputEl = wrap.querySelector('input[type="text"]')
            var headEl = inputEl != null ? inputEl.previousElementSibling : null
            // Native head children: [div.labelGroup][span.badges?]. The
            // badges span exists ONLY while the field is overridden — the
            // last-child SPAN test tells them apart without class names.
            var last = headEl != null ? headEl.lastElementChild : null
            var hasBadges = last != null && last !== headEl.firstElementChild && last.tagName === 'SPAN'
            if (hasBadges) right = Math.ceil(last.getBoundingClientRect().width) + 8
            // Vertical alignment: dock the button to the SAME line-top as the
            // badges (padding inside the native field shifts that line below
            // the wrapper's top edge by a few px — anchoring on the label row
            // rect makes the difference explicit instead of a fixed guess).
            var wrapRect = wrap.getBoundingClientRect()
            var anchorRect = (hasBadges ? last : headEl != null ? headEl.firstElementChild : null)
            if (anchorRect != null) {
              var a = anchorRect.getBoundingClientRect()
              top = Math.round(a.top - wrapRect.top)
            }
          } catch (error) { /* overlay stays at top:0/right:0 */ }
          button.style.right = right + 'px'
          button.style.top = top + 'px'
        })
        return createElement('div', { className: 'ck-fieldline', ref: rowRef },
          createElement(primitives.SettingsValueField, {
            id: 'plugin-config-composer-keys-' + action,
            label: t('action.' + action),
            hint: hintText,
            placeholder: placeholderText,
            overriddenLabel: t('page.overridden'),
            resetLabel: t('page.reset'),
            invalidLabel: t('page.invalid'),
            disabled: fieldDisabled,
            text: fieldState != null ? fieldState.text : '',
            overridden: fieldState != null && fieldState.overridden === true,
            invalid: invalidTarget,
            onEdit: function (text) { props.edit(action, text) },
            onReset: function () { props.resetField(action) },
          }),
          createElement('button', {
            type: 'button',
            className: 'ck-record',
            'data-recording': recording === action ? 'true' : 'false',
            disabled: !canRecord,
            title: invalidTarget ? t('page.invalid') : undefined,
            onClick: function () {
              setRecording(recording === action ? null : action)
            },
          }, recording === action
            ? t(action === 'interrupt' ? 'record.waiting.interrupt' : 'record.waiting')
            : t('record.start')))
      }

      return createElement(primitives.SettingsForm, {
          labels: {
            unavailable: t('page.unavailable'),
            readOnly: t('page.readOnly'),
            saveFailed: t('page.saveFailed'),
            save: t('page.save'),
            saving: t('page.saving'),
          },
          state: state,
          onSave: props.save,
          onDiscard: props.discard,
        },
        schemeStrip,
        // New-scheme name field sits right beside the scheme strip (#1): the
        // strip selects, this stores. Co-stages the hidden presets writer so
        // ONE Save both binds the fields and stores the scheme.
        createElement(primitives.SettingsValueField, {
          id: 'plugin-config-composer-keys-scheme-name',
          label: t('page.newScheme'),
          hint: t('page.newSchemeHint'),
          placeholder: t('page.newSchemePlaceholder'),
          overriddenLabel: t('page.overridden'),
          resetLabel: t('page.reset'),
          invalidLabel: t('page.schemeFull'),
          disabled: fieldDisabled,
          text: state.schemeName != null ? state.schemeName.text : '',
          overridden: state.schemeName != null && state.schemeName.overridden === true,
          invalid: state.schemeName != null && state.schemeName.invalid === true,
          onEdit: function (text) {
            props.edit('schemeName', text)
            props.edit('presets', '1') // planned whenever staged: format renders ''
          },
          onReset: function () { props.resetField('schemeName') },
        }),
        chordRow('send', t('page.sendHint'), t('page.placeholder.send')),
        chordRow('newline', t('page.newlineHint'), t('page.placeholder.newline')),
        chordRow('interrupt', t('page.interruptHint'), t('hint.empty.interrupt')),
        createElement('p', {
          style: {
            fontSize: 12,
            color: 'var(--dsw-alias-label-tertiary,#8f959e)',
            lineHeight: 1.6,
            margin: '8px 0 0',
            whiteSpace: 'pre-line',
          },
        }, t('page.schemeHint') + '\n' + t('page.note')))
    }

    // ── Floating panel (restored 0.1.x surface — immediate writes) ────────────

    /**
     * The 0.1.x floating panel REINSTATED (v0.2.1): the single React root is
     * created over the document body on demand and toggled from BOTH legacy
     * entries (Settings → General row and the composer keyboard button).
     * Semantics differ from the Plugins page on purpose:
     *  - writes apply IMMEDIATELY (no staged save, no Save button): every
     *    edit fires one optimistic local store update plus ONE persist to
     *    the settings scope; the next echo reconciles the truth (no pending
     *    gates — a rejected write snaps back when the scope echoes).
     *  - channel edits belong to the scheme in use: matchActiveScheme
     *    derives the scheme from the PRE-edit triple and the edit is written
     *    back into THAT scheme's stored triple (preset round-trips restore
     *    it intact; freestyle bindings stay live-only).
     *  - the recorder (+ Record keys) captures trusted keydowns while open;
     *    Escape BINDS Esc when recording the interrupt (cancel by clicking
     *    again) and CANCELS elsewhere.
     * Bottom edge: a migration notice line plus a deep-link button that
     * opens THIS plugin's own settings page on the sidebar Plugins page
     * (`pluginNavigation.openBundle`), falling back to plain page open.
     */
    function createPanelController(presetFaces) {
      var openState = false
      var host = null
      var root = null

      function ensureRoot() {
        if (host !== null && host.isConnected && root !== null) return
        if (host === null || !host.isConnected) {
          host = document.createElement('div')
          host.setAttribute('data-dsh-composer-keys-panel', '')
          document.body.appendChild(host)
        }
        root = reactDomClient.createRoot(host)
      }

      function render() {
        if (root === null) return
        root.render(createElement(Panel, {
          open: openState,
          t: presetFaces.t,
          store: presetFaces.store,
          presetsStore: presetFaces.presetsStore,
          builtinStore: presetFaces.builtinStore,
          writeBindings: presetFaces.writeBindings,
          writePresets: presetFaces.writePresets,
          writeBuiltinSchemes: presetFaces.writeBuiltinSchemes,
          openPlugins: presetFaces.openPlugins,
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
          } catch (error) { console.warn('[composer-keys] panel open failed', error) }
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

      // Local editing mirrors follow the stores; every edit applies at once.
      var current = useState(function () { return cloneBindings(props.store.getSnapshot()) })
      var bindings = current[0]
      var setBindings = current[1]
      var recordingState = useState(null)
      var recording = recordingState[0]
      var setRecording = recordingState[1]

      /**
       * Scheme membership as the strip reads it: built-ins first, then the
       * stored custom presets (same shape as the Plugins-page snapshot).
       */
      var customs = sanitizeCustomPresets(props.presetsStore.getSnapshot())
      var overrides = sanitizeBuiltinSchemes(props.builtinStore.getSnapshot())
      var schemes = [
        { id: 'native', kind: 'builtin', triple: resolveBuiltinTriple('native', overrides) },
        { id: 'chat', kind: 'builtin', triple: resolveBuiltinTriple('chat', overrides) },
      ]
      for (var i = 0; i < customs.length; i += 1) {
        schemes.push({
          id: customs[i].name,
          kind: 'custom',
          triple: {
            send: customs[i].send.slice(),
            newline: customs[i].newline.slice(),
            interrupt: customs[i].interrupt.slice(),
          },
        })
      }
      var activeScheme = matchActiveScheme(
        props.store.getSnapshot(),
        overrides,
        customs,
      )

      /** One immediate apply of a FULL triple, mirrors included. */
      var applyNow = function (clean) {
        props.writeBindings(clean)
        setBindings(cloneBindings(clean))
        setRecording(null)
      }

      /** Isolated scheme switch: load THAT scheme's own triple, live at once. */
      var applyScheme = function (scheme) {
        applyNow(scheme.triple)
      }

      /**
       * Channel edits (recording / chip removal) belong to the scheme in
       * use: derive that scheme from the PRE-edit live triple, commit the
       * edit, and write it back into the scheme's stored triple — a
       * recorded key survives preset round-trips ("各方案的隔离"). The
       * bindings write and the scheme write-back are two immediate
       * persists; both echoes reconcile through the adopt path.
       */
      var editBindings = function (nextTriple) {
        var clean = sanitizeBindings(nextTriple)
        // Scheme ownership is read LIVE (the closure would go stale across
        // a recording session's echos).
        var liveOverrides = sanitizeBuiltinSchemes(props.builtinStore.getSnapshot())
        var liveCustoms = sanitizeCustomPresets(props.presetsStore.getSnapshot())
        var activeNow = matchActiveScheme(
          props.store.getSnapshot(),
          liveOverrides,
          liveCustoms,
        )
        if (activeNow === 'native' || activeNow === 'chat') {
          var builtins = liveOverrides
          var updated = []
          var found = false
          for (var i2 = 0; i2 < builtins.length; i2 += 1) {
            if (builtins[i2].id !== activeNow) { updated.push(builtins[i2]); continue }
            found = true
            updated.push({ id: activeNow, send: clean.send.slice(), newline: clean.newline.slice(), interrupt: clean.interrupt.slice() })
          }
          if (!found) updated.push({ id: activeNow, send: clean.send.slice(), newline: clean.newline.slice(), interrupt: clean.interrupt.slice() })
          props.writeBuiltinSchemes(updated, clean)
        } else if (activeNow !== null && activeNow !== undefined) {
          var nextCustoms = []
          var saved = false
          for (var j = 0; j < liveCustoms.length; j += 1) {
            if (liveCustoms[j].name !== activeNow) { nextCustoms.push(liveCustoms[j]); continue }
            saved = true
            nextCustoms.push({
              name: activeNow,
              send: clean.send.slice(),
              newline: clean.newline.slice(),
              interrupt: clean.interrupt.slice(),
            })
          }
          if (saved) props.writePresets(nextCustoms, clean)
        }
        props.writeBindings(clean)
        setBindings(cloneBindings(clean))
        setRecording(null)
      }

      // Follow external changes (the Plugins page, another surface, or the
      // host echo rejecting our optimistic state) into the mirrors.
      useEffect(function () {
        var sync = function () { setBindings(cloneBindings(props.store.getSnapshot())) }
        var unsubscribe = props.store.subscribe(sync)
        return function () {
          if (typeof unsubscribe === 'function') unsubscribe()
        }
      }, [props.store])

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
        }
        document.addEventListener('keydown', onKeyDown, true)
        return function () { document.removeEventListener('keydown', onKeyDown, true) }
      }, [recording])

      // New-scheme draft: typed name + one click = immediate presets write.
      var nameState = useState('')
      var schemeNameDraft = nameState[0]
      var setSchemeNameDraft = nameState[1]
      var fullPanel = customs.length >= MAX_CUSTOM_PRESETS
      var saveScheme = function () {
        var name = typeof schemeNameDraft === 'string' ? schemeNameDraft.trim().slice(0, 32) : ''
        if (name === '') return
        var overwrite = false
        for (var k = 0; k < customs.length; k += 1) {
          if (customs[k].name === name) { overwrite = true; break }
        }
        // Full and not overwriting an existing scheme: refuse silently — the
        // input/button title already explains the 3-scheme cap.
        if (fullPanel && !overwrite) return
        var next = []
        for (var k2 = 0; k2 < customs.length; k2 += 1) {
          if (customs[k2].name !== name) next.push(customs[k2])
        }
        next.push({
          name: name,
          send: props.store.getSnapshot().send.slice(),
          newline: props.store.getSnapshot().newline.slice(),
          interrupt: props.store.getSnapshot().interrupt.slice(),
        })
        props.writePresets(sanitizeCustomPresets(next), sanitizeBindings(props.store.getSnapshot()))
        setSchemeNameDraft('')
      }

      if (props.open !== true) return null

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
          // Key scheme strip: native checkboxes, the active scheme checked.
          createElement('div', { className: 'ck-foot' },
            createElement('span', { className: 'ck-schemelabel' }, t('panel.scheme')),
            schemes.map(function (scheme) {
              var label = scheme.kind === 'native' ? t('panel.schemeNative')
                : scheme.kind === 'chat' ? t('panel.schemeChat')
                : scheme.id
              return createElement('label', { key: String(scheme.id), className: 'ck-check' },
                createElement('input', {
                  type: 'checkbox',
                  checked: activeScheme === scheme.id,
                  onChange: function () {
                    if (activeScheme === scheme.id) return
                    applyScheme(scheme)
                  },
                }),
                createElement('span', null, label))
            })),
          // Save-the-current-keys-as-new-scheme row (beside the strip).
          createElement('div', { className: 'ck-schemeadd' },
            createElement('span', { className: 'ck-schemelabel' }, t('panel.newSchemeLabel')),
            createElement('input', {
              type: 'text',
              value: schemeNameDraft,
              placeholder: t('panel.newSchemePlaceholder'),
              maxLength: 32,
              title: fullPanel ? t('panel.newSchemeFull') : undefined,
              onChange: function (event) { setSchemeNameDraft(event.target.value) },
              onKeyDown: function (event) {
                if (event.key === 'Enter') { event.preventDefault(); saveScheme() }
              },
            }),
            createElement('button', {
              type: 'button',
              className: 'ck-record',
              'data-recording': 'false',
              disabled: fullPanel && schemeNameDraft.trim() === '',
              title: fullPanel ? t('panel.newSchemeFull') : undefined,
              onClick: saveScheme,
            }, t('panel.newSchemeApply'))),
          createActionBlock(t, 'send', bindings, recording, setRecording, editBindings),
          createActionBlock(t, 'newline', bindings, recording, setRecording, editBindings),
          createActionBlock(t, 'interrupt', bindings, recording, setRecording, editBindings),
          createElement('div', { className: 'ck-note' },
            t('page.note') + '\n' + t('panel.migrate')),
          createElement('div', { className: 'ck-noteactions' },
            createElement('button', {
              type: 'button',
              className: 'ck-btn',
              onClick: function () {
                props.onClose()
                if (typeof props.openPlugins === 'function') props.openPlugins()
              },
            }, t('panel.openPlugins')))))
    }

    function createActionBlock(t, action, bindings, recording, setRecording, editBindings) {
      var list = Array.isArray(bindings[action]) ? bindings[action] : []
      var removeChip = function (gesture) {
        var next = cloneBindings(bindings)
        next[action] = list.filter(function (entry) { return entry !== gesture })
        editBindings(next)
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
     * face onto props: hooks.bindings arrives as useBindings, openPlugins as-is.
     * The configure control now JUMPS to the sidebar Plugins page (where the
     * native form lives) instead of opening a floating panel.
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
        createElement('button', { type: 'button', className: 'ck-btn', onClick: props.openPanel }, t('row.configure')))
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
     * - sessions: interrupt action targets the currently open session;
     * - layout: legacy fallback for `openPlugins` when the plugin manager's
     *   `pluginNavigation` deep-link service is absent.
     *
     * Deliberately NOT listed: configForms. A deployment without it would park
     * the whole plugin at boot (`pending: waiting for service`); it arrives
     * through an optional nested inject inside apply instead, degrading to
     * session-local bindings — the keyboard engine never depended on this.
     */
    var CLIENT_INJECT = ['locale', 'slots', 'sessions', 'layout']

    function apply(ctx) {
      // Dictionaries first; later surfaces bind through the locale seat.
      try {
        ctx.effect(function () { return ctx.locale.register(NS, { zh: LOCALES.zh, en: LOCALES.en }) }, 'dsh-composer-keys: dictionaries')
      } catch (error) { console.warn('[composer-keys] locale.register failed', error) }
      var t = makeTranslate(ctx)

      // Durable preference scope (same channel as the native busy-Enter row).
      // ≤0.1.6: settingsScope.bind({ namespace }); 0.1.7+: configForms.get(entryId).
      // Both surfaces share one scope shape (getSnapshot/set/subscribe) and
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

      // Reactive sources shared by the engine, both slot entries, and the page.
      var store = createSnapshotStore(readScope())
      var builtinStore = createSnapshotStore([])
      var presetsStore = createSnapshotStore([])

      /**
       * Adopt the settings document WITHOUT optimistic gating: every write
       * goes through the native staged Save (scope.mutate) and folds back
       * through the describe mirror, so the echo IS the truth. A rejected
       * write keeps the staged form's own failed state (the frame renders
       * saveFailed natively) — nothing to undo here.
       */
      function adoptScopeView() {
        var section = readSection()
        var hasSection = section !== undefined && section !== null && typeof section === 'object'

        var nextBindings = hasSection ? sanitizeBindings(section) : cloneBindings(DEFAULTS)
        if (!bindingsEqual(store.getSnapshot(), nextBindings)) {
          logInterruptChange(store.getSnapshot().interrupt, nextBindings.interrupt)
          store.set(nextBindings)
        }

        var nextBuiltins = hasSection ? sanitizeBuiltinSchemes(section.builtinSchemes) : []
        if (!builtinSchemesEqual(builtinStore.getSnapshot(), nextBuiltins)) {
          builtinStore.set(nextBuiltins)
        }

        var nextPresets = hasSection ? sanitizeCustomPresets(section.presets) : []
        if (!presetsEqual(presetsStore.getSnapshot(), nextPresets)) {
          presetsStore.set(nextPresets)
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
      // namespace in the configForms mirror. The Plugins-page config form is
      // installed HERE (never from the legacy branch): SettingsFormModel
      // mutates through configForms, and the describe mirror must serve the
      // namespace for writes to validate against the volatile Config.
      try {
        ctx.inject(['configForms'], function (sctx) {
          if (scope !== null) return
          try {
            if (sctx.configForms && typeof sctx.configForms.get === 'function') {
              scope = sctx.configForms.get(NS)
              attachScope()
              installPluginsPage()
            }
          } catch (error) { console.warn('[composer-keys] configForms.get failed', error) }
        })
      } catch (error) { console.warn('[composer-keys] configForms inject failed', error) }

      // ── Immediate-wire writes (the floating panel's channel, v0.2.1) ────────

      /**
       * The panel (restored 0.1.x semantics) writes IMMEDIATELY: optimistic
       * local store updates plus ONE persist per edit; the scope echo then
       * reconciles the truth (no pending gates — a rejected write snaps
       * back when adoptScopeView sees it). The Plugins page, in contrast,
       * keeps its staged native Save; both faces read the SAME stores.
       * @param {Array<{field: string, value: *}>} pairs - section fields.
       * @returns {Promise<boolean>} whether the Host accepted every write.
       */
      function persistSections(pairs) {
        if (scope === null) return Promise.resolve(true)
        try {
          if (typeof scope.mutate === 'function') {
            var ops = pairs.map(function (pair) { return { op: 'set', path: [pair.field], value: pair.value } })
            var mutation = scope.mutate(ops)
            if (mutation && typeof mutation.catch === 'function') {
              return mutation.then(function (accepted) { return accepted !== false })
            }
            return Promise.resolve(true)
          }
        } catch (error) { console.warn('[composer-keys] panel persist failed', error) }
        return Promise.resolve(false)
      }

      function writeBindingsNow(next) {
        var clean = sanitizeBindings(next)
        var previousInterrupt = store.getSnapshot().interrupt
        store.set(clean)
        logInterruptChange(previousInterrupt, clean.interrupt)
        persistSections([
          { field: 'send', value: clean.send.slice() },
          { field: 'newline', value: clean.newline.slice() },
          { field: 'interrupt', value: clean.interrupt.slice() },
        ])
      }

      function writePresetsNow(next, _bindings) {
        var clean = sanitizeCustomPresets(next)
        presetsStore.set(clean)
        persistSections([{ field: 'presets', value: clean }])
      }

      function writeBuiltinSchemesNow(next, _bindings) {
        var clean = sanitizeBuiltinSchemes(next)
        builtinStore.set(clean)
        persistSections([{ field: 'builtinSchemes', value: clean }])
      }

      /** The floating panel controller (lazily created at install time). */
      var panelController = null
      var installPanel = function () {
        if (panelController !== null) return
        if (reactDomClient == null || typeof reactDomClient.createRoot !== 'function') return
        try {
          panelController = createPanelController({
            t: t,
            store: store,
            presetsStore: presetsStore,
            builtinStore: builtinStore,
            writeBindings: writeBindingsNow,
            writePresets: writePresetsNow,
            writeBuiltinSchemes: writeBuiltinSchemesNow,
            openPlugins: openPlugins,
          })
        } catch (error) {
          console.warn('[composer-keys] panel install failed', error)
        }
      }

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

      /** One line whenever the interrupt channel's bound chords change. */
      function logInterruptChange(before, after) {
        var prev = Array.isArray(before) ? before : []
        var next = Array.isArray(after) ? after : []
        if (listEqual(prev, next)) return
        console.info('[composer-keys] interrupt channel →', next.length ? next.join(', ') : '(cleared)')
      }

      /**
       * The Plugins-page config: register `plugins.bundle.config` (embedded on
       * the bundle's page) and `plugins.row.config` (the row's Configure page)
       * with ONE shared controller — the two cards mirror the same staged
       * form, so drafts and save state stay identical wherever the user edits.
       *
       * Installed only on the configForms path. No `whileServed` gate: this
       * plugin IS the namespace owner — its client half can only be mounted
       * while the host entry (and the served volatile Config) is active.
       * Requires the DSH native form primitives; without them the plugin
       * page entry is simply absent — the keyboard engine keeps running.
       */
      var pluginsPageController = null

      function installPluginsPage() {
        if (pluginsPageController !== null) return
        try {
          if (primitives == null
            || typeof primitives.SettingsFormModel !== 'function'
            || typeof primitives.SettingsForm !== 'function'
            || typeof primitives.SettingsValueField !== 'function') return
          pluginsPageController = new ComposerKeysPageController(scope, builtinStore, presetsStore, function () { return panelController })
          ctx.effect(function () { return function () { pluginsPageController.dispose() } }, 'dsh-composer-keys: plugins-page form')

          var registerCard = function (slotName, key) {
            ctx.slots.inject(slotName, function () {
              return ctx.slots.register({
                name: slotName,
                key: key, // bundle: package name; row: `<package>#<row id from the patch>`
                locale: NS,
                inject: function () {
                  return pluginsPageController !== null ? pluginsPageController.inject() : {}
                },
              }, ComposerKeysPageCard)
            })
          }
          registerCard('plugins.bundle.config', 'dsh-composer-keys')
          registerCard('plugins.row.config', 'dsh-composer-keys#composer-keys')
        } catch (error) {
          console.warn('[composer-keys] plugins page install failed', error)
        }
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
      try { disposeKeyboard = installKeyboardEngine(store) } catch (error) { /* stay inert rather than break the page */ }
      var disposeInterrupt = noop
      try { disposeInterrupt = installInterruptEngine(store, interruptCurrentSession) } catch (error) { /* stay inert rather than break the page */ }

      /**
       * Deep link to THIS plugin's own settings page (#6). The plugin
       * manager exposes an official cross-plugin navigation face
       * (`pluginNavigation.openBundle`) that opens the sidebar Plugins page
       * focused on one package — verified against 0.2.1-rc.2 and consumed
       * the same way by shipped plugins. Optional nested inject: without
       * the service the two legacy entries degrade to a plain panel open.
       */
      var pluginNavigation = null
      try {
        ctx.inject(['pluginNavigation'], function (sctx) {
          if (pluginNavigation !== null) return
          try {
            var face = sctx.pluginNavigation
            pluginNavigation = face != null && typeof face.openBundle === 'function' ? face : null
          } catch (error) { console.warn('[composer-keys] pluginNavigation read failed', error) }
        })
      } catch (error) { console.warn('[composer-keys] pluginNavigation inject failed', error) }

      var openPlugins = function () {
        try {
          if (pluginNavigation !== null) {
            pluginNavigation.openBundle('dsh-composer-keys')
            return
          }
          try {
            ctx.layout.selectPanel('plugins')
          } catch (error) {
            console.warn('[composer-keys] cannot open the Plugins page', error)
          }
        } catch (error) {
          console.warn('[composer-keys] cannot deep-link the Plugins page', error)
          try { ctx.layout.selectPanel('plugins') } catch (inner) { /* stay quiet */ }
        }
      }

      /** Open the restored floating panel; entries fall back to a jump. */
      var openPanel = function () {
        if (panelController !== null) {
          panelController.open()
          return
        }
        openPlugins()
      }

      installPanel()

      // Entry A: Settings → General row (summary + open the floating panel).
      try {
        ctx.slots.inject('settings.general.item', function () {
          return ctx.slots.register({
            name: 'settings.general.item',
            id: 'composer-keys-row',
            order: 21,
            locale: NS,
            inject: function () {
              return { hooks: { bindings: store }, openPanel: openPanel }
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
              return { openPanel: openPanel }
            },
          }, ComposerButton)
        })
      } catch (error) { console.warn('[composer-keys] conversation.input.right inject failed', error) }

      // Styles ride the fiber like everything else.
      var styleInstall = installStyle(document)

      return function cleanup() {
        try { disposeKeyboard() } catch (error) {}
        try { disposeInterrupt() } catch (error) {}
        try {
          if (pluginsPageController !== null) pluginsPageController.dispose()
        } catch (error) {}
        try {
          if (panelController !== null) panelController.dispose()
        } catch (error) {}
        try {
          if (styleInstall.owned && styleInstall.node) styleInstall.node.remove()
        } catch (error) {}
      }
    }

    return { apply: apply, inject: CLIENT_INJECT }
  },
})
})()
