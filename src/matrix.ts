import path from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { BridgeConfig } from './types.js'
import { LOG_PREFIX } from './types.js'

function debug(msg: string) {
  console.log(`${LOG_PREFIX}: ${msg}`)
}

export interface MatrixMessage {
  roomId: string
  sender: string
  body: string
  eventId: string
  isDm: boolean
}

export type MessageHandler = (msg: MatrixMessage) => void

// minimal matrix CS API client using native fetch
export class MatrixClient {
  private baseUrl: string
  private token: string
  private syncToken: string | null = null
  private storagePath: string
  private running = false

  constructor(homeserver: string, accessToken: string, storagePath: string) {
    this.baseUrl = homeserver.replace(/\/+$/, '')
    this.token = accessToken
    this.storagePath = storagePath
    mkdirSync(storagePath, { recursive: true })
    this.loadSyncToken()
  }

  private loadSyncToken() {
    try {
      const data = JSON.parse(readFileSync(path.join(this.storagePath, 'sync.json'), 'utf-8'))
      this.syncToken = data.next_batch || null
    } catch {
      this.syncToken = null
    }
  }

  private saveSyncToken() {
    try {
      writeFileSync(
        path.join(this.storagePath, 'sync.json'),
        JSON.stringify({ next_batch: this.syncToken }) + '\n',
      )
    } catch {}
  }

  private async api(method: string, endpoint: string, body?: any): Promise<any> {
    const url = `${this.baseUrl}/_matrix/client/v3${endpoint}`
    const opts: RequestInit = {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
    }
    if (body !== undefined) opts.body = JSON.stringify(body)
    const resp = await fetch(url, opts)
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`matrix ${method} ${endpoint}: ${resp.status} ${text}`)
    }
    // some endpoints return empty body (e.g. typing)
    const text = await resp.text()
    return text ? JSON.parse(text) : {}
  }

  async getProfile(userId: string): Promise<{ displayname?: string }> {
    return this.api('GET', `/profile/${encodeURIComponent(userId)}`)
  }

  async getJoinedMembers(roomId: string): Promise<string[]> {
    const data = await this.api('GET', `/rooms/${encodeURIComponent(roomId)}/joined_members`)
    return Object.keys(data.joined || {})
  }

  async sendMessage(roomId: string, content: any) {
    const txnId = `bridge_${Date.now()}_${Math.random().toString(36).slice(2)}`
    await this.api('PUT', `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`, content)
  }

  async sendText(roomId: string, text: string) {
    await this.sendMessage(roomId, { msgtype: 'm.text', body: text })
  }

  async sendNotice(roomId: string, text: string) {
    await this.sendMessage(roomId, { msgtype: 'm.notice', body: text })
  }

  async setTyping(roomId: string, typing: boolean) {
    const body = typing ? { typing: true, timeout: 30000 } : { typing: false }
    await this.api('PUT',
      `/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(this.getUserId())}`,
      body,
    ).catch(() => {}) // best-effort
  }

  async joinRoom(roomId: string) {
    await this.api('POST', `/join/${encodeURIComponent(roomId)}`, {})
  }

  // verify access token and return the authenticated user ID
  async whoami(): Promise<string> {
    const data = await this.api('GET', '/account/whoami')
    return data.user_id
  }

  // exposed for typing endpoint which needs the user ID
  private userId = ''
  setUserId(userId: string) { this.userId = userId }
  getUserId(): string { return this.userId }

  stop() { this.running = false }

  // long-poll sync loop
  async startSync(
    config: BridgeConfig,
    onMessage: MessageHandler,
    onInvite: (roomId: string) => void,
  ) {
    this.running = true
    // use the verified userId (set via whoami) for sender filtering
    const botUserId = this.userId || config.user_id
    const timeout = config.sync_timeout_ms
    const MAX_AGE_MS = 30000

    debug('starting matrix sync')
    while (this.running) {
      try {
        const params = new URLSearchParams({ timeout: String(timeout) })
        if (this.syncToken) params.set('since', this.syncToken)
        // initial sync: use a filter to skip old messages
        if (!this.syncToken) params.set('filter', JSON.stringify({
          room: { timeline: { limit: 0 } },
        }))

        const url = `${this.baseUrl}/_matrix/client/v3/sync?${params}`
        const resp = await fetch(url, {
          headers: { 'Authorization': `Bearer ${this.token}` },
          signal: AbortSignal.timeout(timeout + 10000),
        })
        if (!resp.ok) {
          debug(`sync error: ${resp.status}`)
          await new Promise(r => setTimeout(r, 5000))
          continue
        }
        const data = await resp.json() as any
        this.syncToken = data.next_batch
        this.saveSyncToken()

        // process invites — auto-join allowed rooms
        for (const [roomId, invite] of Object.entries(data.rooms?.invite || {})) {
          onInvite(roomId)
        }

        // process room messages
        const joinedRooms = Object.keys(data.rooms?.join || {})
        if (joinedRooms.length > 0) debug(`sync: ${joinedRooms.length} room(s) with updates`)
        for (const [roomId, room] of Object.entries(data.rooms?.join || {}) as [string, any][]) {
          const events = room.timeline?.events || []
          if (events.length > 0) debug(`sync: room ${roomId} has ${events.length} event(s)`)
          for (const event of events) {
            debug(`sync: event type=${event.type} sender=${event.sender} msgtype=${event.content?.msgtype}`)
            if (event.type !== 'm.room.message') continue
            if (event.content?.msgtype !== 'm.text') continue
            if (event.sender === botUserId) {
              debug(`sync: skipping own message from ${event.sender}`)
              continue
            }
            const age = event.unsigned?.age || 0
            if (age > MAX_AGE_MS) {
              debug(`sync: skipping old message (age=${age}ms)`)
              continue
            }
            if (!isRoomAllowed(roomId, config)) {
              debug(`sync: room ${roomId} not allowed`)
              continue
            }

            const body = event.content.body || ''
            if (!body.trim()) continue

            debug(`sync: dispatching message from ${event.sender} in ${roomId}`)
            const members = await this.getJoinedMembers(roomId).catch(() => [])
            const isDm = members.length === 2
            onMessage({ roomId, sender: event.sender, body, eventId: event.event_id, isDm })
          }
        }
      } catch (e: any) {
        debug(`sync error: ${e.message}`)
        await new Promise(r => setTimeout(r, 5000))
      }
    }
    debug('matrix sync stopped')
  }
}

// check if a room passes the allowlist/blocklist filter
export function isRoomAllowed(roomId: string, config: BridgeConfig): boolean {
  if (config.room_blocklist.includes(roomId)) return false
  if (config.room_allowlist.length > 0) return config.room_allowlist.includes(roomId)
  return true
}

// get the trigger mode for a specific room
export function getTriggerMode(roomId: string, config: BridgeConfig): 'mention' | 'all' {
  return config.room_triggers[roomId] || config.default_trigger
}

// get display names of room members (excluding the bot)
export async function getRoomMembers(
  client: MatrixClient, roomId: string, botUserId: string,
): Promise<string[]> {
  try {
    const memberIds = await client.getJoinedMembers(roomId)
    const names: string[] = []
    for (const userId of memberIds) {
      if (userId === botUserId) continue
      try {
        const profile = await client.getProfile(userId)
        names.push(profile?.displayname || userId)
      } catch {
        names.push(userId)
      }
    }
    return names.sort()
  } catch {
    return []
  }
}

// get the bot's display name for mention detection
export async function getBotDisplayName(client: MatrixClient, userId: string): Promise<string> {
  try {
    const profile = await client.getProfile(userId)
    return profile?.displayname || ''
  } catch {
    return ''
  }
}
