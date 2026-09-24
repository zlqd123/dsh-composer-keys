/**
 * dsh-composer-keys — host half.
 *
 * Settings-namespace wiring across DSH generations:
 * - ≤0.1.6: `settings.register(namespace, schema)` declared the namespace.
 * - 0.1.7:  every settings namespace is DERIVED from a plugin entry's
 *   volatile Config fields (`settings.describe` → `volatileForm`, keyed by
 *   the cordis patch entry id — which this bundle sets to `composer-keys`,
 *   the same id the browser half binds through `ctx.configForms.get`).
 *   `settings.register` no longer exists; a field must carry the volatile
 *   meta flag or the whole namespace is skipped by describe and its writes
 *   are refused ("Config field is not volatile").
 *
 * Both generations are wired from one apply(): the register call is
 * feature-detected, the volatile Config is what 0.1.7 reads. Without a
 * settings service at all the optional nested inject never fires and the
 * browser half degrades to session-local bindings — the keyboard engine
 * never depended on this half.
 */

import Schema from '@deepseek-ai/schemastery'

export const name = 'composer-keys'

/** Settings namespace shared with the browser half; equals the patch entry id. */
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
  /** Gestures that abort the open session's running task. Empty by default. */
  interrupt: Object.freeze([]),
})

/**
 * Mark a field volatile: a per-user preference carried by the Host
 * user-settings document, editable without remounting the entry. 0.1.7's
 * bundled schemastery ships `.volatile()` (which itself is
 * `extra('volatile', true)`); the 3.18.x copy this package pins exposes the
 * same meta flag through `.extra()`. Feature-detect so either copy works.
 * @param {import('@deepseek-ai/schemastery').Schema} schema - field schema.
 * @returns {import('@deepseek-ai/schemastery').Schema} the volatile-marked copy.
 */
function volatileField(schema) {
  try {
    if (typeof schema.volatile === 'function') return schema.volatile()
    if (typeof schema.extra === 'function') return schema.extra('volatile', true)
  } catch (error) { /* fall through to the plain field */ }
  return schema
}

/**
 * One saved custom preset: a display name plus the three binding lists it
 * applies. Shared by the 0.1.7 Config and the legacy registration schema so
 * both generations validate the same stored section.
 */
export const CustomPresetSchema = Schema.object({
  name: Schema.string(),
  send: Schema.array(Schema.string()),
  newline: Schema.array(Schema.string()),
  interrupt: Schema.array(Schema.string()),
})

/**
 * Persisted override for one built-in scheme (DSH 原生 / 微信风格): the
 * three-channel triple the user edited while that scheme was active. An
 * absent entry falls back to the shipped template, so schemes stay isolated
 * and switchable without losing recorded keys.
 */
export const BuiltinSchemeSchema = Schema.object({
  id: Schema.string(),
  send: Schema.array(Schema.string()),
  newline: Schema.array(Schema.string()),
  interrupt: Schema.array(Schema.string()),
})

/**
 * Plugin instance config — and, on 0.1.7, the served shape of namespace
 * `composer-keys`. Every field is volatile: key bindings are user
 * preferences, not deployment config. Declaring them here is what makes
 * `settings.describe` include this entry at all (entries whose schema has
 * no volatile field are skipped) and what lets the browser half's
 * `configForms.set` writes validate against the schema.
 */
export const Config = Schema.object({
  send: volatileField(Schema.array(Schema.string()).default([...DEFAULT_BINDINGS.send])),
  newline: volatileField(Schema.array(Schema.string()).default([...DEFAULT_BINDINGS.newline])),
  interrupt: volatileField(Schema.array(Schema.string()).default([...DEFAULT_BINDINGS.interrupt])),
  presets: volatileField(Schema.array(CustomPresetSchema).default([])),
  builtinSchemes: volatileField(Schema.array(BuiltinSchemeSchema).default([])),
})

/**
 * Settings document section schema for ≤0.1.6 registration. Gesture strings
 * are lowercase modifier+key chords in `ctrl+alt+shift+meta+key` order, e.g.
 * `enter`, `ctrl+enter`, `ctrl+alt+k`. The `mod` alias (matches Ctrl or Cmd)
 * is accepted on read but never produced by the recorder.
 */
export const ComposerKeysSettingsSchema = Schema.object({
  send: Schema.array(Schema.string()).default([...DEFAULT_BINDINGS.send]),
  newline: Schema.array(Schema.string()).default([...DEFAULT_BINDINGS.newline]),
  interrupt: Schema.array(Schema.string()).default([...DEFAULT_BINDINGS.interrupt]),
  presets: Schema.array(CustomPresetSchema).default([]),
  builtinSchemes: Schema.array(BuiltinSchemeSchema).default([]),
})

/**
 * Wire the settings surface when a Host provides one. Declaring the
 * dependency via a nested inject parks only this callback on profiles
 * without settings instead of crashing the plugin — and, unlike listing a
 * settings service in the client inject array, never parks the browser half.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin fiber context.
 */
export function apply(ctx) {
  try {
    ctx.inject(['settings'], (child) => {
      // ≤0.1.6: explicit namespace registration (method absent on 0.1.7).
      if (child.settings && typeof child.settings.register === 'function') {
        child.settings.register(COMPOSER_KEYS_SETTINGS_NAMESPACE, ComposerKeysSettingsSchema)
      }
      // 0.1.7: key bindings ship their own panel — suppress the
      // auto-generated settings page for this entry.
      if (child.settings && typeof child.settings.configure === 'function') {
        child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
      }
    })
  } catch (error) { /* settings absent: session-local bindings */ }
}
