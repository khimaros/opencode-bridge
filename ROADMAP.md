# roadmap

## in progress

## done

- [x] store bot username (localpart) in bridge state JSON
- [x] send each assistant text part as a separate matrix message (not just the last)
- [x] permission request forwarding to matrix with per-user allowlist
- [x] strip system-reminder tags from outgoing messages to matrix
- [x] types and config module with tests
- [x] message formatting module with tests
- [x] persist model to state/bridge.json when not explicitly configured
- [x] configurable system prompt for bridged sessions with formatting guidance default
- [x] notify user on LLM retry (once per prompt) via SSE session.status events
- [x] notify user when compaction is running
- [x] add integration tests for session.ts (mocked opencode client)
- [x] add integration tests for matrix.ts (mocked matrix sync)
- [x] add end-to-end test for full message flow
- [x] env var overrides for bridge config (BRIDGE_* prefix)
- [x] fix cleanup triggering repeatedly after compaction (baseline tracking)
- [x] stop sending cleanup notices to room (log only)
- [x] matrix client module
- [x] session management module
- [x] plugin entrypoint wiring everything together
