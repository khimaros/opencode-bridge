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
// when send_intermediate_text is enabled, each assistant text part becomes a
// separate message; non-text parts attach to the nearest text message.
// when disabled (default), all parts are joined into a single message.
export function formatOutgoingParts(parts: Part[], config: BridgeConfig): string[] {
  const messages: string[] = []
  let prefix: string[] = [] // non-text parts before the first text

  function appendNonText(line: string) {
    if (config.send_intermediate_text && messages.length > 0) {
      messages[messages.length - 1] += '\n' + line
    } else {
      prefix.push(line)
    }
  }

  for (const part of parts) {
    if (part.type === 'text') {
      const cleaned = stripSystemReminders(part.text)
      if (!cleaned || isNoResponse(cleaned)) continue
      if (config.send_intermediate_text && prefix.length > 0) {
        messages.push([...prefix, cleaned].join('\n').trim())
        prefix = []
      } else if (config.send_intermediate_text) {
        messages.push(cleaned)
      } else {
        prefix.push(cleaned)
      }
    } else if (part.type === 'tool' && config.display_tool_calls) {
      appendNonText(formatToolCall(part as { type: 'tool'; tool: string; state: string }))
    } else if (part.type === 'reasoning' && config.display_reasoning) {
      appendNonText(`> ${part.text}`)
    }
  }

  // flush remaining sections
  const tail = prefix.join('\n').trim()
  if (tail) messages.push(tail)

  return messages.map(msg => {
    if (msg.length > config.max_response_length) {
      return msg.slice(0, config.max_response_length) + '\n...(truncated)'
    }
    return msg
  })
}

// remove <system-reminder> blocks injected by the LLM harness
function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

function formatToolCall(part: { tool: string; state: string }): string {
  return `[tool: ${part.tool} (${part.state})]`
}

// generate the system prompt addendum for bridged sessions
export function formatSystemPromptAddendum(roomId: string, members: string[], isDm: boolean, config: BridgeConfig): string {
  const lines = [
    'this session is bridged from a matrix chat room.',
    `room: ${roomId}`,
  ]
  if (members.length > 0) {
    lines.push(`participants: ${members.join(', ')}`)
  }
  lines.push('messages wrapped in <assistant-sent-message> MUST be treated as messages that YOU SENT TO THE USER from another session. ALWAYS treat them as YOUR OWN PRIOR MESSAGES and resume the conversation as though that were your most recently sent message.')
  if (!isDm && config.system_prompt) {
    lines.push('')
    lines.push(config.system_prompt)
  }
  return lines.join('\n')
}

// check if a matrix message is a permission reply (allow/deny)
export function parsePermissionReply(body: string): 'once' | 'always' | 'reject' | null {
  const lower = body.trim().toLowerCase()
  if (lower === 'allow') return 'once'
  if (lower === 'allow always') return 'always'
  if (lower === 'deny') return 'reject'
  return null
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
