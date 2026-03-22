export interface BridgeConfig {
  homeserver: string
  user_id: string
  access_token: string
  room_allowlist: string[]
  room_blocklist: string[]
  default_trigger: 'mention' | 'all'
  room_triggers: Record<string, 'mention' | 'all'>
  display_tool_calls: boolean
  display_reasoning: boolean
  max_response_length: number
  agent: string
  sync_timeout_ms: number
  cleanup: 'none' | 'compact' | 'new' | 'archive'
  cleanup_tokens: number | null
  cleanup_message_count: number | null
  model: { providerID: string; modelID: string } | null
}

export const DEFAULTS: BridgeConfig = {
  homeserver: '',
  user_id: '',
  access_token: '',
  room_allowlist: [],
  room_blocklist: [],
  default_trigger: 'mention',
  room_triggers: {},
  display_tool_calls: false,
  display_reasoning: false,
  max_response_length: 4000,
  agent: 'per',
  sync_timeout_ms: 30000,
  cleanup: 'none',
  cleanup_tokens: null,
  cleanup_message_count: null,
  model: null,
}

export const NO_RESPONSE_MARKER = '[NO_RESPONSE]'

export const LOG_PREFIX = '[bridge]'

// persisted room-to-session mapping
export interface RoomSession {
  roomId: string
  sessionId: string
  title: string
  lastActivity: number
}

// message part types from opencode
export interface TextPart {
  type: 'text'
  text: string
  synthetic?: boolean
}

export interface ToolPart {
  type: 'tool'
  tool: string
  state: string
}

export interface ReasoningPart {
  type: 'reasoning'
  text: string
}

export type Part = TextPart | ToolPart | ReasoningPart | { type: string; [key: string]: any }
