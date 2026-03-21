# opencode-bridge

opencode plugin to bridge external chat protocols into opencode sessions.

## supported protocols

- matrix (via matrix-bot-sdk)

## features

- one-on-one and group chat support
- sender attribution in group chats
- configurable trigger mode (@mention or all messages, per-room)
- LLM opt-out for irrelevant messages (`[NO_RESPONSE]`)
- typing indicators while processing
- context cleanup (compact, rotate, archive) on token/message thresholds
- composes with opencode-evolve and other plugins

## setup

1. create a matrix bot account and obtain an access token
2. install the plugin in your opencode config
3. configure `config/bridge.jsonc` in your workspace

```jsonc
{
  "homeserver": "https://matrix.example.org",
  "user_id": "@bridge-bot:example.org",
  "access_token": "syt_..."
}
```

or set `MATRIX_ACCESS_TOKEN` environment variable.

## configuration

see `config/bridge.jsonc.example` for all options.

## development

```sh
npm install
make build
make test
```
