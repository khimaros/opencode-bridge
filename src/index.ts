import type { Plugin } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin'
import { createOpencodeClient } from '@opencode-ai/sdk'
import { loadConfig, validateConfig, WORKSPACE } from './config.js'
import {
  MatrixClient, getRoomMembers, getBotDisplayName, getTriggerMode, isRoomAllowed,
} from './matrix.js'
import {
  loadBridgeState, getSyncToken, setSyncToken,
  getOrCreateSession, getRoomForSession, listRoomSessions,
  isBridgedSession, promptSession, shouldCleanup, performCleanup,
  enqueueForRoom, clearRoomMapping, loadModel, persistModel,
} from './session.js'
import {
  formatIncomingMessage, formatOutgoingParts, formatSystemPromptAddendum,
  formatCompactionContext, isBotMentioned, stripBotMention,
} from './format.js'
import { LOG_PREFIX } from './types.js'

function debug(msg: string) {
  console.log(`${LOG_PREFIX}: ${msg}`)
}

const CONFIG = loadConfig(WORKSPACE)

export const BridgePlugin: Plugin = async ({ serverUrl }) => {
  debug(`bridge initialized`)
  debug(`workspace: ${WORKSPACE}`)
  debug(`homeserver: ${CONFIG.homeserver}`)

  const errors = validateConfig(CONFIG)
  if (errors.length > 0) {
    debug(`config errors: ${errors.join(', ')}`)
    debug('bridge disabled — fix config and restart')
    return {}
  }

  // workspace-scoped opencode client (same pattern as opencode-evolve)
  const baseUrl = new URL(serverUrl.toString())
  if (baseUrl.port === '0') baseUrl.port = '4096'
  const client = createOpencodeClient({ baseUrl: baseUrl.toString(), directory: WORKSPACE })

  loadBridgeState(WORKSPACE)

  let lastModel: any = CONFIG.model || loadModel()
  if (lastModel) debug(`model: ${lastModel.providerID}/${lastModel.modelID}`)
  else debug('no model configured — will use opencode default')
  const matrixClient = new MatrixClient(
    CONFIG.homeserver, CONFIG.access_token,
    () => getSyncToken(), (token) => setSyncToken(token, WORKSPACE),
  )
  let botDisplayName = ''
  let botUserId = CONFIG.user_id

  // verify the actual authenticated user ID to ensure sender filtering works
  try {
    botUserId = await matrixClient.whoami()
    if (botUserId !== CONFIG.user_id) {
      debug(`whoami returned ${botUserId}, config has ${CONFIG.user_id} — using whoami result`)
    }
    matrixClient.setUserId(botUserId)
    botDisplayName = await getBotDisplayName(matrixClient, botUserId)
    debug(`bot: ${botUserId} (${botDisplayName || 'no display name'})`)
  } catch (e: any) {
    debug(`matrix auth check failed: ${e.message}`)
    debug('bridge disabled — check access_token')
    return {}
  }

  // handle incoming matrix messages
  async function handleMatrixMessage(
    roomId: string, sender: string, body: string, isDm: boolean,
  ) {
    debug(`handling message in ${roomId} from ${sender} isDm=${isDm}`)
    const triggerMode = getTriggerMode(roomId, CONFIG)

    // in mention mode for non-DM rooms, only respond when mentioned
    if (!isDm && triggerMode === 'mention') {
      if (!isBotMentioned(body, botUserId, botDisplayName)) {
        debug(`skipping: not mentioned (trigger=mention)`)
        return
      }
      body = stripBotMention(body, botUserId, botDisplayName)
    }

    if (!body.trim()) return

    // extract localpart from mxid (e.g. @alice:example.org -> alice)
    const localpart = sender.replace(/^@/, '').replace(/:.*$/, '')
    const text = formatIncomingMessage(localpart, body)
    debug(`formatted message: ${text.slice(0, 100)}`)

    await matrixClient.setTyping(roomId, true)
    // refresh typing indicator every 25s (matrix expires at 30s)
    const typingInterval = setInterval(() => matrixClient.setTyping(roomId, true), 25000)
    try {
      let sessionId = await getOrCreateSession(client, roomId, `matrix: ${roomId}`, WORKSPACE)
      debug(`session: ${sessionId}`)

      // validate session exists before prompting — promptAsync can hang on deleted sessions
      let sessionValid = true
      try {
        const msgs = await client.session.messages({ path: { id: sessionId }, query: { limit: 1 } })
        if (msgs.error) sessionValid = false
      } catch {
        sessionValid = false
      }
      if (!sessionValid) {
        debug(`session ${sessionId} is stale, creating fresh session`)
        clearRoomMapping(roomId, WORKSPACE)
        sessionId = await getOrCreateSession(client, roomId, `matrix: ${roomId}`, WORKSPACE)
        debug(`new session: ${sessionId}`)
      }

      debug(`prompting session ${sessionId}`)
      const parts = await promptSession(client, sessionId, text, CONFIG, lastModel)
      debug(`got ${parts.length} response part(s)`)
      const response = formatOutgoingParts(parts, CONFIG)

      if (response) {
        debug(`sending response to matrix (${response.length} chars)`)
        await matrixClient.sendText(roomId, response)
      } else {
        debug(`no response to send (null/NO_RESPONSE)`)
      }

      // check cleanup after each prompt
      if (await shouldCleanup(client, sessionId, CONFIG)) {
        const { action } = await performCleanup(
          client, sessionId, roomId, CONFIG, WORKSPACE, lastModel,
        )
        debug(`cleanup: ${action}`)
      }
    } catch (e: any) {
      debug(`message handling failed for room ${roomId}: ${e.message}`)
      await matrixClient.sendNotice(roomId, `[bridge error: ${e.message}]`).catch(() => {})
    } finally {
      clearInterval(typingInterval)
      await matrixClient.setTyping(roomId, false)
    }
  }

  // start matrix sync in the background (non-blocking)
  matrixClient.startSync(CONFIG, (msg) => {
    enqueueForRoom(msg.roomId, () =>
      handleMatrixMessage(msg.roomId, msg.sender, msg.body, msg.isDm)
    )
  }, async (roomId) => {
    if (isRoomAllowed(roomId, CONFIG)) {
      debug(`auto-joining room ${roomId}`)
      await matrixClient.joinRoom(roomId).catch((e: any) =>
        debug(`auto-join failed for ${roomId}: ${e.message}`)
      )
    }
  })

  // persist an outbound message to session history without triggering the LLM
  async function persistOutbound(sessionId: string, message: string) {
    const wrapped = `<system-reminder>\n<assistant-sent-message>${message}</assistant-sent-message>\n</system-reminder>`
    await client.session.prompt({
      path: { id: sessionId },
      body: {
        noReply: true,
        agent: CONFIG.agent,
        parts: [{ type: 'text', text: wrapped, synthetic: true }],
      },
    })
  }

  const homeserverDomain = matrixClient.getHomeserverDomain()
  debug(`homeserver domain: ${homeserverDomain}`)

  const bridgeTools = {
    bridge_send: tool({
      description: 'send a message to a bridged matrix room by room ID',
      args: {
        room_id: tool.schema.string().describe('matrix room ID'),
        message: tool.schema.string().describe('message text to send'),
      },
      async execute({ room_id, message }) {
        const sessionId = await getOrCreateSession(client, room_id, `matrix: ${room_id}`, WORKSPACE)
        await persistOutbound(sessionId, message)
        await matrixClient.sendText(room_id, message)
        return `sent to ${room_id}`
      },
    }),

    bridge_send_direct: tool({
      description: 'send a direct message to a matrix user by username (e.g. "xuananh")',
      args: {
        username: tool.schema.string().describe('matrix username (without @ or :server)'),
        message: tool.schema.string().describe('message text to send'),
      },
      async execute({ username, message }) {
        const userId = `@${username}:${homeserverDomain}`
        const roomId = await matrixClient.findOrCreateDmRoom(userId)
        const sessionId = await getOrCreateSession(client, roomId, `matrix: ${roomId}`, WORKSPACE)
        await persistOutbound(sessionId, message)
        await matrixClient.sendText(roomId, message)
        return `sent DM to ${username}`
      },
    }),

    bridge_rooms: tool({
      description: 'list active bridged matrix rooms with members and DM status',
      args: {},
      async execute() {
        const rooms = listRoomSessions()
        const directRooms = await matrixClient.getDirectRooms()
        const result = await Promise.all(rooms.map(async (r) => {
          const members = await getRoomMembers(matrixClient, r.roomId, botUserId)
          return {
            roomId: r.roomId,
            sessionId: r.sessionId,
            title: r.title,
            isDm: directRooms.has(r.roomId),
            members,
          }
        }))
        return JSON.stringify(result)
      },
    }),
  }

  debug(`registering ${Object.keys(bridgeTools).length} tool(s): ${Object.keys(bridgeTools).join(', ')}`)

  return {
    tool: bridgeTools,

    // track model from assistant responses for bridged sessions
    'chat.message': async (input, output) => {
      try {
        if (input.model) {
          persistModel(input.model, WORKSPACE)
          if (!CONFIG.model) lastModel = input.model
        }
      } catch (e: any) {
        debug(`chat.message hook failed: ${e.message}`)
      }
    },

    // append bridge context to system prompt for bridged sessions
    'experimental.chat.system.transform': async (input, output) => {
      try {
        debug(`system.transform: session=${input.sessionID} bridged=${isBridgedSession(input.sessionID || '')} system_parts=${output.system.length} system_len=${output.system.join('').length}`)
        if (!input.sessionID || !isBridgedSession(input.sessionID)) return
        const roomId = getRoomForSession(input.sessionID)!
        let members: string[] = []
        try {
          members = await getRoomMembers(matrixClient, roomId, botUserId)
        } catch {}
        const isDm = members.length === 1 // getRoomMembers excludes bot, so 1 = DM
        const addendum = formatSystemPromptAddendum(roomId, members, isDm, CONFIG)
        output.system.push(addendum)
      } catch (e: any) {
        debug(`system.transform failed: ${e.message}`)
      }
    },

    // append participant context for compaction of bridged sessions
    'experimental.session.compacting': async (input, output) => {
      try {
        if (!isBridgedSession(input.sessionID)) return
        const roomId = getRoomForSession(input.sessionID)!
        let members: string[] = []
        try {
          members = await getRoomMembers(matrixClient, roomId, botUserId)
        } catch {}
        const context = formatCompactionContext(roomId, members)
        output.context.push(context)
      } catch (e: any) {
        debug(`compacting hook failed: ${e.message}`)
      }
    },
  }
}

export default BridgePlugin
