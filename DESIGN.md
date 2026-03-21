# design

## architecture

opencode-bridge is a TypeScript opencode plugin that maintains a persistent
matrix sync loop and routes messages bidirectionally between matrix rooms
and opencode sessions.

unlike opencode-evolve (which delegates to python hooks via subprocess IPC),
the bridge runs entirely in TypeScript because it needs a long-lived event
loop for the matrix sync connection.

## components

- `types.ts` — shared interfaces and type definitions
- `config.ts` — JSONC configuration loading with env var support
- `format.ts` — message formatting in both directions
- `matrix.ts` — matrix client lifecycle (connect, sync, send, typing)
- `session.ts` — room-to-session mapping and opencode SDK interaction
- `index.ts` — plugin entrypoint, hooks, message routing

## message flow

### matrix -> opencode

1. matrix sync receives `m.room.message`
2. filter by bot identity, allowlist/blocklist, trigger mode
3. look up or create opencode session for the room
4. format message with sender attribution (group chats)
5. send typing indicator, prompt session, stop typing
6. check for `[NO_RESPONSE]` marker, format and send response

### opencode -> matrix

the `chat.message` hook fires after any LLM response. if the session
is mapped to a matrix room, the response is relayed there.

## plugin composition

the bridge composes with other plugins by only appending to shared state:

- system prompt: appends bridge context after other plugins
- compaction: appends to `output.context[]` rather than replacing `output.prompt`
- chat.message: fires independently alongside other observers

## context cleanup

follows the opencode-evolve pattern with configurable modes (none, compact,
new, archive) triggered by token or message count thresholds.
