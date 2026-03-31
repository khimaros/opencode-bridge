import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { BridgeConfig, RoomSession, Part } from './types.js'
import { LOG_PREFIX } from './types.js'

function debug(msg: string) {
  console.log(`${LOG_PREFIX}: ${msg}`)
}

function formatDatetime(date: Date, timezone = 'UTC'): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    fractionalSecondDigits: 3, hour12: false, timeZoneName: 'longOffset',
  })
  const p = Object.fromEntries(fmt.formatToParts(date).map(v => [v.type, v.value]))
  const offset = p.timeZoneName === 'GMT' ? '+00:00' : p.timeZoneName!.replace('GMT', '')
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${p.fractionalSecond}${offset}`
}

// persisted room-to-session mapping
const roomSessions = new Map<string, RoomSession>()
// reverse lookup: session ID -> room ID
const sessionToRoom = new Map<string, string>()
// per-room promise chain to serialize concurrent messages
const roomQueues = new Map<string, Promise<void>>()

// per-room flag: true once a retry notice has been sent for the current prompt
const retryNotified = new Map<string, boolean>()

function statePath(workspace: string): string {
  return path.join(workspace, 'state', 'bridge.json')
}

// all persisted bridge state in one file
interface BridgeState {
  rooms: RoomSession[]
  sync_token: string | null
  model: { providerID: string; modelID: string } | null
}

function loadState(workspace: string): BridgeState {
  try {
    return JSON.parse(readFileSync(statePath(workspace), 'utf-8'))
  } catch {
    return { rooms: [], sync_token: null, model: null }
  }
}

function persistState(workspace: string) {
  try {
    mkdirSync(path.dirname(statePath(workspace)), { recursive: true })
    const state: BridgeState = {
      rooms: Array.from(roomSessions.values()),
      sync_token: currentSyncToken,
      model: currentModel,
    }
    writeFileSync(statePath(workspace), JSON.stringify(state, null, 2) + '\n')
  } catch (e: any) {
    debug(`persist state failed: ${e.message}`)
  }
}

let currentSyncToken: string | null = null
let currentModel: { providerID: string; modelID: string } | null = null

// load all persisted state from disk
export function loadBridgeState(workspace: string) {
  const state = loadState(workspace)
  for (const entry of state.rooms) {
    roomSessions.set(entry.roomId, entry)
    sessionToRoom.set(entry.sessionId, entry.roomId)
  }
  currentSyncToken = state.sync_token
  currentModel = state.model || null
  debug(`loaded ${roomSessions.size} room mapping(s)`)
}

// model accessors — auto-persist model detected from chat.message hook
export function loadModel(): { providerID: string; modelID: string } | null {
  return currentModel
}

export function persistModel(model: { providerID: string; modelID: string }, workspace: string) {
  if (currentModel?.providerID === model.providerID && currentModel?.modelID === model.modelID) return
  currentModel = model
  persistState(workspace)
  debug(`persisted model: ${model.providerID}/${model.modelID}`)
}

// sync token accessors for the matrix client
export function getSyncToken(): string | null {
  return currentSyncToken
}

export function setSyncToken(token: string | null, workspace: string) {
  currentSyncToken = token
  persistState(workspace)
}

// get or create an opencode session for a matrix room
export async function getOrCreateSession(
  client: any, roomId: string, title: string, workspace: string,
): Promise<string> {
  const existing = roomSessions.get(roomId)
  if (existing) {
    existing.lastActivity = Date.now()
    persistState(workspace)
    return existing.sessionId
  }

  const created = await client.session.create({ body: { title } })
  if (created.error) throw new Error(`create session failed: ${JSON.stringify(created.error)}`)
  const sessionId = created.data!.id

  const entry: RoomSession = { roomId, sessionId, title, lastActivity: Date.now() }
  roomSessions.set(roomId, entry)
  sessionToRoom.set(sessionId, roomId)
  persistState(workspace)
  debug(`created session ${sessionId} for room ${roomId}`)
  return sessionId
}

// look up which room a session is mapped to (for chat.message hook)
export function getRoomForSession(sessionId: string): string | null {
  return sessionToRoom.get(sessionId) || null
}

// clear a stale room mapping (e.g. when the session was deleted externally)
export function clearRoomMapping(roomId: string, workspace: string) {
  const entry = roomSessions.get(roomId)
  if (!entry) return
  debug(`clearing stale mapping: room ${roomId} -> session ${entry.sessionId}`)
  sessionToRoom.delete(entry.sessionId)
  roomSessions.delete(roomId)
  persistState(workspace)
}

// check if a session is a bridged session
export function isBridgedSession(sessionId: string): boolean {
  return sessionToRoom.has(sessionId)
}

// look up the session entry for a room
export function getSessionForRoom(roomId: string): RoomSession | undefined {
  return roomSessions.get(roomId)
}

// list all active room-session mappings
export function listRoomSessions(): RoomSession[] {
  return Array.from(roomSessions.values())
}

// send a message to an opencode session and return the response parts.
// uses synchronous prompt() to await the LLM response.
export async function promptSession(
  client: any, sessionId: string, text: string,
  config: BridgeConfig, model?: any,
): Promise<Part[]> {
  const body: any = {
    agent: config.agent,
    parts: [{ type: 'text', text, synthetic: false }],
  }
  if (model) body.model = model

  const result = await client.session.prompt({
    path: { id: sessionId },
    body,
  })
  if (result.error) throw new Error(`prompt failed: ${JSON.stringify(result.error)}`)
  return result.data?.parts || []
}

// fetch current message count and total tokens for a session
async function sessionStats(client: any, sessionId: string): Promise<{ tokens: number; messages: number } | null> {
  const msgs = await client.session.messages({ path: { id: sessionId } })
  if (msgs.error) return null
  const data = msgs.data || []
  let tokens = 0
  for (const m of data) {
    const t = m.info?.tokens
    if (t) tokens += (t.input || 0) + (t.output || 0)
  }
  return { tokens, messages: data.length }
}

// check if cleanup should be triggered based on token/message thresholds.
// subtracts any post-cleanup baseline so compaction doesn't re-trigger immediately.
export async function shouldCleanup(
  client: any, sessionId: string, config: BridgeConfig,
): Promise<boolean> {
  if (config.cleanup === 'none') return false

  const stats = await sessionStats(client, sessionId)
  if (!stats) return false

  const baseline = roomSessions.get(getRoomForSession(sessionId) || '')?.cleanupBaseline

  if (config.cleanup_message_count !== null) {
    const effective = stats.messages - (baseline?.messages || 0)
    if (effective >= config.cleanup_message_count) {
      debug(`cleanup: message count limit (${stats.messages} - ${baseline?.messages || 0} >= ${config.cleanup_message_count})`)
      return true
    }
  }

  if (config.cleanup_tokens !== null) {
    const effective = stats.tokens - (baseline?.tokens || 0)
    if (effective >= config.cleanup_tokens) {
      debug(`cleanup: token limit (${stats.tokens} - ${baseline?.tokens || 0} >= ${config.cleanup_tokens})`)
      return true
    }
  }

  return false
}

// perform the configured cleanup action on a session.
// returns the new session ID if rotated, null otherwise.
export async function performCleanup(
  client: any, sessionId: string, roomId: string,
  config: BridgeConfig, workspace: string, model?: any,
): Promise<{ newSessionId: string | null; action: string }> {
  if (config.cleanup === 'compact') {
    if (!model) return { newSessionId: null, action: 'compact skipped (no model)' }
    const result = await client.session.summarize({
      path: { id: sessionId },
      body: { providerID: model.providerID, modelID: model.modelID },
    })
    if (result.error) {
      debug(`cleanup compact failed: ${JSON.stringify(result.error)}`)
      return { newSessionId: null, action: 'compact failed' }
    }
    // record post-compaction baseline so shouldCleanup measures growth from here
    const stats = await sessionStats(client, sessionId)
    const entry = roomSessions.get(roomId)
    if (entry && stats) {
      entry.cleanupBaseline = stats
      persistState(workspace)
      debug(`cleanup: baseline set to ${stats.tokens} tokens, ${stats.messages} messages`)
    }
    debug(`cleanup: compacted session ${sessionId}`)
    return { newSessionId: null, action: 'compacted' }
  }

  if (config.cleanup !== 'new' && config.cleanup !== 'archive') {
    return { newSessionId: null, action: 'none' }
  }

  if (config.cleanup === 'archive') {
    const update = await client.session.update({
      path: { id: sessionId },
      body: { time: { archived: Date.now() } } as any,
    })
    if (update.error) {
      debug(`cleanup archive failed: ${JSON.stringify(update.error)}`)
      return { newSessionId: null, action: 'archive failed' }
    }
  }

  // rotate: create new session
  const entry = roomSessions.get(roomId)
  const title = `${entry?.title || roomId} (${formatDatetime(new Date())})`
  const created = await client.session.create({ body: { title } })
  if (created.error) throw new Error(`create session failed: ${JSON.stringify(created.error)}`)

  const newId = created.data!.id
  // update mappings
  sessionToRoom.delete(sessionId)
  const newEntry: RoomSession = { roomId, sessionId: newId, title, lastActivity: Date.now() }
  roomSessions.set(roomId, newEntry)
  sessionToRoom.set(newId, roomId)
  persistState(workspace)
  debug(`cleanup: rotated ${sessionId} -> ${newId} (${config.cleanup})`)
  return { newSessionId: newId, action: config.cleanup }
}

// mark a room as eligible for retry notifications (call at prompt start)
export function resetRetryNotified(roomId: string) {
  retryNotified.set(roomId, false)
}

// mark a room as having been notified about a retry (returns true if this is the first call)
export function markRetryNotified(roomId: string): boolean {
  if (retryNotified.get(roomId)) return false
  retryNotified.set(roomId, true)
  return true
}

// subscribe to opencode SSE events, dispatching retry and compaction events
// for bridged sessions to the provided callbacks.
export async function startEventSubscription(
  client: any,
  onRetry: (roomId: string, message: string) => void,
  onCompacted: (roomId: string) => void,
) {
  try {
    const result = await client.event.subscribe()
    const stream = result.stream
    if (!stream) {
      debug('SSE subscription returned no stream')
      return
    }
    debug('SSE event subscription started')
    ;(async () => {
      try {
        for await (const event of stream) {
          const e = event as any
          if (e.type === 'session.status' && e.properties?.status?.type === 'retry') {
            const roomId = getRoomForSession(e.properties.sessionID)
            if (roomId && markRetryNotified(roomId)) {
              onRetry(roomId, e.properties.status.message)
            }
          } else if (e.type === 'session.compacted') {
            const roomId = getRoomForSession(e.properties?.sessionID)
            if (roomId) onCompacted(roomId)
          }
        }
      } catch (err: any) {
        debug(`SSE stream error: ${err.message}`)
      }
    })()
  } catch (err: any) {
    debug(`SSE subscription failed: ${err.message}`)
  }
}

// enqueue a task for a room, serializing with any in-flight work.
// returns the result of the task.
export function enqueueForRoom<T>(roomId: string, task: () => Promise<T>): Promise<T> {
  const prev = roomQueues.get(roomId) || Promise.resolve()
  const next = prev.then(task, task) // run even if previous failed
  roomQueues.set(roomId, next.then(() => {}, () => {}))
  return next
}
