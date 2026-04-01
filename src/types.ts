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
  send_intermediate_text: boolean
  max_response_length: number
  agent: string
  sync_timeout_ms: number
  cleanup: 'none' | 'compact' | 'new' | 'archive'
  cleanup_tokens: number | null
  cleanup_message_count: number | null
  model: { providerID: string; modelID: string } | null
  system_prompt: string
}

export const NO_RESPONSE_MARKER = '[NO_RESPONSE]'

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
  send_intermediate_text: false,
  max_response_length: 4000,
  agent: 'per',
  sync_timeout_ms: 30000,
  cleanup: 'none',
  cleanup_tokens: null,
  cleanup_message_count: null,
  model: null,
  system_prompt: [
    'messages from different users are prefixed with [username].',
    'if a message is not directed at you or does not warrant a response,',
    `reply with exactly: ${NO_RESPONSE_MARKER}`,
    'keep responses short and concise.',
    'prefer plain text or minimal formatting, as not all matrix clients render markdown.',
  ].join('\n'),
}

export const LOG_PREFIX = '[bridge]'

// persisted room-to-session mapping
export interface RoomSession {
  roomId: string
  sessionId: string
  title: string
  lastActivity: number
  cleanupBaseline?: { tokens: number; messages: number }
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
