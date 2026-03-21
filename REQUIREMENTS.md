# requirements

## core

- bridge external chat protocols into opencode sessions
- support one-on-one (DM) conversations
- support group chats with multiple participants
- bidirectional message flow: chat protocol -> opencode, opencode -> chat protocol
- handle context management and compaction for long conversations
- compose cleanly with other opencode plugins (e.g. opencode-evolve)

## matrix protocol

- connect to matrix homeserver as a bot user
- listen for messages in configured rooms
- map matrix rooms to opencode sessions (1:1)
- forward messages with sender attribution in group chats
- relay opencode responses back to matrix rooms
- configurable trigger mode: @mention only or all messages (per-room)
- LLM opt-out via `[NO_RESPONSE]` marker
- typing indicators while awaiting LLM response
- room allowlist/blocklist filtering
- auto-join on invite (respecting allowlist)

## context management

- configurable cleanup modes: none, compact, new session, archive
- trigger on token count or message count thresholds
- custom compaction prompt preserving participant context
- notify room when cleanup occurs

## configuration

- JSONC config file with sensible defaults
- access token via config or environment variable
- per-room trigger mode overrides
