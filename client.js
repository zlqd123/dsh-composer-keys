/**
 * dsh-composer-keys — browser half.
 *
 * Hand-written lazy-CJS bundle in the client module system's factory format
 * (the same shape packages/client/tsdown.client.ts emits): the file registers
 * a factory via window.__ModuleLoader__.load, and every side effect lives in
 * the factory closure. No build step.
 *
 * What it does
 * - Captures keydowns aimed at the chat composer textarea ([data-input-scroll])
 *   and resolves them against user-configured bindings: which chords submit
 *   ("send") and which insert a line break ("newline").
 * - Send replays one synthetic trusted=false Enter keydown so the NATIVE
 *   composer handler keeps owning the whole submission pipeline: slash-menu
 *   arbitration, repeat guard, machine-busy guards, and busy queue-vs-steer
 *   (the native「繁忙时 Enter 键行为」setting). Ctrl/Cmd+Enter-originated sends
 *   replay WITH the accelerator flag, preserving its opposite-behavior trait;
 *   every other bound chord replays as plain Enter.
 * - Newline inserts "\n" at the caret through execCommand('insertText') so the
 *   controlled React draft stays in sync (native-setter fallback provided).
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
 * stores one chord under both actions anyway).
 * @param {{send: string[], newline: string[]}} bindings
 * @param {string} gesture
 * @returns {'send' | 'newline' | undefined}
 */
function actionForGesture(bindings, gesture) {
  if (bindings == null || typeof gesture !== 'string' || gesture === '') return undefined
  if (gestureMatchesList(bindings.send, gesture)) return 'send'
  if (gestureMatchesList(bindings.newline, gesture)) return 'newline'
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
 * Move one gesture to an action: removed from both lists first, then appended
 * to the target — the mutual-exclusion invariant lives here.
 * @returns {{send: string[], newline: string[]}}
 */
function moveGesture(bindings, gesture, targetAction) {
  var send = withoutValue(Array.isArray(bindings.send) ? bindings.send : [], gesture)
  var newline = withoutValue(Array.isArray(bindings.newline) ? bindings.newline : [], gesture)
  if (targetAction === 'send') send.push(gesture)
  else newline.push(gesture)
  return { send: send, newline: newline }
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
  for (var i = newline.length - 1; i >= 0; i -= 1) {
    if (send.indexOf(newline[i]) !== -1) newline.splice(i, 1)
  }
  return { send: send, newline: newline }
}

/** Structural equality of two sanitized bindings objects. */
function bindingsEqual(a, b) {
  return listEqual(a == null ? null : a.send, b == null ? null : b.send)
    && listEqual(a == null ? null : a.newline, b == null ? null : b.newline)
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
    var runtime = safeRequire('@deepseek-ai/dsh-client-runtime/client')

    var createElement = React.createElement
    var Tooltip = primitives.Tooltip
    var createSnapshotStore = runtime.createSnapshotStore

    var NS = 'composer-keys'
    var STYLE_ATTRIBUTE = 'data-dsh-composer-keys-style'
    var PANEL_ATTRIBUTE = 'data-dsh-composer-keys-panel'

    var DEFAULTS = Object.freeze({
      send: Object.freeze(['enter', 'ctrl+enter']),
      newline: Object.freeze(['shift+enter']),
    })
    var PRESETS = [
      { id: 'native', bindings: { send: ['enter', 'ctrl+enter'], newline: ['shift+enter'] } },
      { id: 'chat', bindings: { send: ['ctrl+enter'], newline: ['enter', 'shift+enter'] } },
    ]

    var LOCALES = {
      en: {
        'row.title': 'Composer keys',
        'row.desc': 'Send & newline keys for the chat composer. Current:',
        'row.configure': 'Configure…',
        'row.summary.send': 'Send',
        'row.summary.newline': 'Newline',
        'button.label': 'Composer key bindings',
        'panel.title': 'Composer keys',
        'panel.close': 'Close',
        'action.send': 'Send',
        'action.send.desc': 'Submit the draft to the agent.',
        'action.newline': 'Newline',
        'action.newline.desc': 'Insert a line break at the caret.',
        'record.start': '+ Record keys',
        'record.waiting': 'Press a key combination… (Esc cancels)',
        'hint.empty.send': 'No send key bound — use the send button.',
        'hint.empty.newline': 'No newline key bound.',
        'preset.label': 'Presets:',
        'preset.native': 'DSH native',
        'preset.chat': 'Chat style',
        reset: 'Reset to defaults',
        'note.line1': 'While the agent is busy, queue-vs-steer follows the native “Busy Enter behavior” setting uniformly for EVERY bound send key. Only the untouched default bindings stay fully native (Ctrl/Cmd+Enter keeps its opposite-behavior trait in that pristine state).',
        'note.line2': 'This plugin only assigns which keys trigger send or newline. IME composition is never interrupted; other inputs (approval panels, rename boxes) are untouched.',
      },
      zh: {
        'row.title': '输入框按键',
        'row.desc': '自定义聊天输入框的发送与换行键位。当前:',
        'row.configure': '配置…',
        'row.summary.send': '发送',
        'row.summary.newline': '换行',
        'button.label': '输入框按键设置',
        'panel.title': '输入框按键',
        'panel.close': '关闭',
        'action.send': '发送',
        'action.send.desc': '把草稿提交给智能体。',
        'action.newline': '换行',
        'action.newline.desc': '在光标处插入换行。',
        'record.start': '+ 录制按键',
        'record.waiting': '请按下组合键…(Esc 取消)',
        'hint.empty.send': '未绑定发送键——只能通过发送按钮发送。',
        'hint.empty.newline': '未绑定换行键。',
        'preset.label': '快速预设:',
        'preset.native': 'DSH 原生',
        'preset.chat': '微信风格',
        reset: '重置为默认',
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

    function installKeyboardEngine(store) {
      var onKeyDown = function (event) {
        // Synthetic events (including OUR replayed Enter) pass through so the
        // native handler owns the pipeline and no loop can form.
        if (event.isTrusted !== true) return
        // IME composition: candidate-picking Enter must never be touched.
        if (event.isComposing === true || event.keyCode === 229) return
        var target = event.target
        if (!(target instanceof HTMLTextAreaElement)) return
        // Main chat composer only — InputBar's own stable anchor attribute.
        if (target.closest('[data-input-scroll]') == null) return
        if (target.disabled || target.readOnly) return

        var bindings = store.getSnapshot()
        var gesture = normalizeEventGesture(event)
        var action = actionForGesture(bindings, gesture)
        if (action === undefined) return
        // Pristine default state: full zero-intervention (native traits intact).
        if (isPristineDefaults(bindings, DEFAULTS)) return

        event.preventDefault()
        event.stopImmediatePropagation()
        if (action === 'newline') insertNewline(target)
        else replaySubmit(target)
      }
      window.addEventListener('keydown', onKeyDown, true)
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
     * Insert '\n' at the caret while keeping the controlled React draft in
     * sync: execCommand routes through beforeinput/input so the machine's edit
     * range math works unchanged; the fallback writes through the native value
     * setter and re-dispatches input (standard controlled-component fix).
     */
    function insertNewline(target) {
      try { target.focus() } catch (error) {}
      var handled = false
      try { handled = document.execCommand('insertText', false, '\n') } catch (error) { handled = false }
      if (handled) return
      try {
        var start = typeof target.selectionStart === 'number' ? target.selectionStart : target.value.length
        var end = typeof target.selectionEnd === 'number' ? target.selectionEnd : start
        target.setRangeText('\n', start, end, 'end')
        var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
        setter.call(target, target.value)
        target.dispatchEvent(new Event('input', { bubbles: true }))
        var caret = start + 1
        target.setSelectionRange(caret, caret)
      } catch (error) { /* give up silently: worst case the key does nothing */ }
    }

    // ── Floating panel (single React root over the document body) ───────────

    function createPanelController(store, writeBindings, t) {
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
          writeBindings: writeBindings,
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

      // Follow external changes (another surface wrote the settings document).
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
          if (event.key === 'Escape') {
            setRecording(null)
            return
          }
          var gesture = normalizeEventGesture(event)
          if (gesture === '') return // pure modifier press: keep waiting
          var next = moveGesture(props.store.getSnapshot(), gesture, recording)
          props.writeBindings(next)
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
          createActionBlock(t, 'send', snapshot, recording, setRecording, props.writeBindings, setBindings),
          createActionBlock(t, 'newline', snapshot, recording, setRecording, props.writeBindings, setBindings),
          createElement('div', { className: 'ck-foot' },
            createElement('span', { className: 'ck-presets-label' }, t('preset.label')),
            PRESETS.map(function (preset) {
              return createElement('button', {
                key: preset.id,
                type: 'button',
                className: 'ck-preset',
                onClick: function () { applyNow(preset.bindings) },
              }, t('preset.' + preset.id))
            }),
            createElement('button', {
              type: 'button',
              className: 'ck-preset',
              onClick: function () { applyNow(DEFAULTS) },
            }, t('reset'))),
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
          }, recording === action ? t('record.waiting') : t('record.start'))),
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
     * - settingsScope: durable key-binding persistence.
     */
    var CLIENT_INJECT = ['locale', 'slots', 'settingsScope']

    function apply(ctx) {
      // Dictionaries first; later surfaces bind through the locale seat.
      try {
        ctx.effect(function () { return ctx.locale.register(NS, { zh: LOCALES.zh, en: LOCALES.en }) }, 'dsh-composer-keys: dictionaries')
      } catch (error) { console.warn('[composer-keys] locale.register failed', error) }
      var t = makeTranslate(ctx)

      // Durable preference scope (same channel as the native busy-Enter row).
      var scope = null
      try {
        if (ctx.settingsScope && typeof ctx.settingsScope.bind === 'function') {
          scope = ctx.settingsScope.bind({ namespace: NS })
        }
      } catch (error) { console.warn('[composer-keys] settingsScope.bind failed', error); scope = null }

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

      // Reactive source shared by the engine, both slot entries, and the panel.
      var store = createSnapshotStore(readScope())
      if (scope !== null && typeof scope.subscribe === 'function') {
        scope.subscribe(function () {
          var next = readScope()
          if (!bindingsEqual(store.getSnapshot(), next)) store.set(next)
        })
      }

      function writeBindings(next) {
        var clean = sanitizeBindings(next)
        store.set(clean)
        if (scope !== null && typeof scope.set === 'function') {
          try { void scope.set('send', clean.send.slice()) } catch (error) { /* read-only surface: session-local only */ }
          try { void scope.set('newline', clean.newline.slice()) } catch (error) { /* read-only surface: session-local only */ }
        }
      }

      // Keyboard engine: window-capture keydown, scoped to the composer box.
      var disposeKeyboard = noop
      try { disposeKeyboard = installKeyboardEngine(store) } catch (error) { /* stay inert rather than break the page */ }

      // Panel singleton lifecycle (created lazily on first open).
      var panel = createPanelController(store, writeBindings, t)

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
