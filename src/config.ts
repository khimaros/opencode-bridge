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

export function loadConfig(workspace: string): BridgeConfig {
  const configPath = path.join(workspace, 'config', 'bridge.jsonc')
  try {
    const raw = readFileSync(configPath, 'utf-8')
    const json = stripJsoncComments(raw)
    const parsed = { ...DEFAULTS, ...JSON.parse(json) }
    // allow access token from env var
    if (!parsed.access_token) {
      parsed.access_token = process.env.MATRIX_ACCESS_TOKEN || ''
    }
    // normalize model: accept "provider/model" string or { providerID, modelID } object
    if (typeof parsed.model === 'string' && parsed.model.includes('/')) {
      const [providerID, ...rest] = parsed.model.split('/')
      parsed.model = { providerID, modelID: rest.join('/') }
    }
    return parsed
  } catch (e: any) {
    console.error(`${LOG_PREFIX}: no config found at ${configPath}, using defaults: ${e.message}`)
    return { ...DEFAULTS }
  }
}

export function validateConfig(config: BridgeConfig): string[] {
  const errors: string[] = []
  if (!config.homeserver) errors.push('homeserver is required')
  if (!config.user_id) errors.push('user_id is required')
  if (!config.access_token) errors.push('access_token is required (config or MATRIX_ACCESS_TOKEN env)')
  return errors
}
