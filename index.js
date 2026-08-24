/**
 * dsh-composer-keys — host half.
 *
 * The whole feature lives in the browser (`client.js`). This half exists for
 * exactly one purpose: register the `composer-keys` user-settings namespace so
 * the browser half's `ctx.settingsScope.bind({ namespace })` can read and write
 * key bindings through the standard Host settings document — the same channel
 * the native busy-Enter preference uses. apiproxy serves every registered
 * namespace to the web surface alike, so no further host wiring is needed.
 */

import Schema from '@deepseek-ai/schemastery'

export const name = 'composer-keys'

/** Plugin instance config: intentionally empty — key bindings are user preferences stored in the settings document, not deployment config. */
export const Config = Schema.object({})

/** Settings namespace owned by this plugin; mirrors the browser scope bind. */
export const COMPOSER_KEYS_SETTINGS_NAMESPACE = 'composer-keys'

/**
 * Bindings shipped when the user has never saved a preference. Deliberately
 * identical to the harness-native behavior, so installing the plugin changes
 * nothing until the user rebinds (the browser half also short-circuits to
 * pass-through while these defaults hold).
 */
export const DEFAULT_BINDINGS = Object.freeze({
  /** Gestures that submit the draft. */
  send: Object.freeze(['enter', 'ctrl+enter']),
  /** Gestures that insert a newline at the caret. */
  newline: Object.freeze(['shift+enter']),
})

/**
 * Settings document section schema. Gesture strings are lowercase
 * modifier+key chords in `ctrl+alt+shift+meta+key` order, e.g. `enter`,
 * `ctrl+enter`, `ctrl+alt+k`. The `mod` alias (matches Ctrl or Cmd) is
 * accepted on read but never produced by the recorder.
 */
export const ComposerKeysSettingsSchema = Schema.object({
  send: Schema.array(Schema.string()).default([...DEFAULT_BINDINGS.send]),
  newline: Schema.array(Schema.string()).default([...DEFAULT_BINDINGS.newline]),
})

/**
 * Register the settings namespace for as long as the Host provides the
 * settings service. Declaring the dependency via inject parks the plugin on
 * profiles without settings instead of crashing it.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin fiber context.
 */
export function apply(ctx) {
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.register(COMPOSER_KEYS_SETTINGS_NAMESPACE, ComposerKeysSettingsSchema)
  })
}
