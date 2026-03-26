import { readFileSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import type { BridgeConfig } from './types.js'
import { DEFAULTS, LOG_PREFIX } from './types.js'

export const WORKSPACE = process.env.OPENCODE_BRIDGE_WORKSPACE
  || process.env.OPENCODE_SIDECAR_WORKSPACE
  || path.join(homedir(), 'workspace')

// strip JSONC comments while preserving strings.
// walks the input character-by-character to avoid stripping // inside "...".
export function stripJsoncComments(raw: string): string {
  let result = ''
  let i = 0
  while (i < raw.length) {
    // quoted string — copy through verbatim
    if (raw[i] === '"') {
      let j = i + 1
      while (j < raw.length && raw[j] !== '"') {
        if (raw[j] === '\\') j++ // skip escaped char
        j++
      }
      result += raw.slice(i, j + 1)
      i = j + 1
      continue
    }
    // line comment
    if (raw[i] === '/' && raw[i + 1] === '/') {
      while (i < raw.length && raw[i] !== '\n') i++
      continue
    }
    // block comment
    if (raw[i] === '/' && raw[i + 1] === '*') {
      i += 2
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++
      i += 2 // skip */
      continue
    }
    result += raw[i]
    i++
  }
  return result
}

// coerce env string to match the type of the existing config value
function coerceEnv(val: string, existing: any): any {
  if (existing === null || typeof existing === 'string') return val === 'null' ? null : val
  if (typeof existing === 'number') return val === 'null' ? null : Number(val)
  if (typeof existing === 'boolean') return val === 'true'
  return val
}

// apply BRIDGE_<FIELD> env vars to config (e.g. BRIDGE_HOMESERVER -> homeserver)
function applyEnvOverrides(config: any) {
  for (const field of Object.keys(DEFAULTS)) {
    const val = process.env[`BRIDGE_${field.toUpperCase()}`]
    if (val !== undefined) config[field] = coerceEnv(val, DEFAULTS[field as keyof BridgeConfig])
  }
}

// normalize model: accept "provider/model" string or { providerID, modelID } object
function normalizeModel(config: any) {
  if (typeof config.model === 'string' && config.model.includes('/')) {
    const [providerID, ...rest] = config.model.split('/')
    config.model = { providerID, modelID: rest.join('/') }
  }
}

export function loadConfig(workspace: string): BridgeConfig {
  const configPath = path.join(workspace, 'config', 'bridge.jsonc')
  let parsed: any
  try {
    const raw = readFileSync(configPath, 'utf-8')
    const json = stripJsoncComments(raw)
    parsed = { ...DEFAULTS, ...JSON.parse(json) }
  } catch (e: any) {
    console.error(`${LOG_PREFIX}: no config found at ${configPath}, using defaults: ${e.message}`)
    parsed = { ...DEFAULTS }
  }
  applyEnvOverrides(parsed)
  normalizeModel(parsed)
  return parsed
}

export function validateConfig(config: BridgeConfig): string[] {
  const errors: string[] = []
  if (!config.homeserver) errors.push('homeserver is required')
  if (!config.user_id) errors.push('user_id is required')
  if (!config.access_token) errors.push('access_token is required (config or env)')
  return errors
}
