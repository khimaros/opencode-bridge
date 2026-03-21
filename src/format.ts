import type { BridgeConfig, Part } from './types.js'
import { NO_RESPONSE_MARKER } from './types.js'

// format an incoming matrix message for the opencode session.
// always includes sender attribution so the LLM knows who's talking.
export function formatIncomingMessage(sender: string, body: string): string {
  return `[${sender}] ${body}`
}

// check whether the bot is mentioned in the message body.
// handles both @displayname and @mxid patterns.
export function isBotMentioned(body: string, userId: string, displayName: string): boolean {
  const lower = body.toLowerCase()
  if (lower.includes(userId.toLowerCase())) return true
  if (displayName && lower.includes(displayName.toLowerCase())) return true
  // also check for localpart without the leading @
  const localpart = userId.split(':')[0]?.replace(/^@/, '')
  if (localpart && lower.includes(localpart.toLowerCase())) return true
  return false
}

// strip the bot mention from the message body so it reads naturally
export function stripBotMention(body: string, userId: string, displayName: string): string {
  const localpart = userId.split(':')[0]?.replace(/^@/, '') || ''
  // remove patterns like @botname: or @botname (with optional colon/comma after)
  for (const name of [userId, displayName, localpart]) {
    if (!name) continue
    const pattern = new RegExp(`@?${escapeRegex(name)}[,:]?\\s*`, 'gi')
    body = body.replace(pattern, '')
  }
  return body.trim()
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// check if the LLM response is a no-response signal
export function isNoResponse(text: string): boolean {
  return text.trim() === NO_RESPONSE_MARKER
}

// extract and format the outgoing response from opencode parts for matrix.
// returns null if the response is a no-response signal.
export function formatOutgoingParts(parts: Part[], config: BridgeConfig): string | null {
  const sections: string[] = []

  for (const part of parts) {
    if (part.type === 'text') {
      sections.push(part.text)
    } else if (part.type === 'tool' && config.display_tool_calls) {
      sections.push(formatToolCall(part as { type: 'tool'; tool: string; state: string }))
    } else if (part.type === 'reasoning' && config.display_reasoning) {
      sections.push(`> ${part.text}`)
    }
  }

  const text = sections.join('\n').trim()
  if (!text) return null
  if (isNoResponse(text)) return null

  if (text.length > config.max_response_length) {
    return text.slice(0, config.max_response_length) + '\n...(truncated)'
  }
  return text
}

function formatToolCall(part: { tool: string; state: string }): string {
  return `[tool: ${part.tool} (${part.state})]`
}

// generate the system prompt addendum for bridged sessions
export function formatSystemPromptAddendum(roomId: string, members: string[], isDm: boolean): string {
  const lines = [
    'this session is bridged from a matrix chat room.',
    `room: ${roomId}`,
  ]
  if (members.length > 0) {
    lines.push(`participants: ${members.join(', ')}`)
  }
  if (!isDm) {
    lines.push('')
    lines.push('messages from different users are prefixed with [username].')
    lines.push('if a message is not directed at you or does not warrant a response,')
    lines.push(`reply with exactly: ${NO_RESPONSE_MARKER}`)
  }
  return lines.join('\n')
}

// generate compaction context for bridged sessions
export function formatCompactionContext(roomId: string, members: string[]): string {
  const lines = [
    'this session is a bridged matrix chat room.',
    `room: ${roomId}`,
  ]
  if (members.length > 0) {
    lines.push(`participants: ${members.join(', ')}`)
  }
  lines.push('preserve participant names, key decisions, action items, and referenced artifacts.')
  lines.push('discard greetings, small talk, acknowledgments, and redundant information.')
  return lines.join('\n')
}
