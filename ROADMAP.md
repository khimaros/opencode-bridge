# roadmap

## in progress

- [x] persist model to state/bridge.json when not explicitly configured
- [x] env var overrides for bridge config (BRIDGE_* prefix)
- [x] fix cleanup triggering repeatedly after compaction (baseline tracking)
- [x] stop sending cleanup notices to room (log only)
- [ ] add integration tests for session.ts (mocked opencode client)
- [ ] add integration tests for matrix.ts (mocked matrix sync)
- [ ] add end-to-end test for full message flow

## done

- [x] types and config module with tests
- [x] message formatting module with tests
- [x] matrix client module
- [x] session management module
- [x] plugin entrypoint wiring everything together
