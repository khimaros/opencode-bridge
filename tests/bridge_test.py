#!/usr/bin/env python3
"""end-to-end tests for opencode-bridge modules."""

import json, os, shutil, subprocess, sys, tempfile
from pathlib import Path

PASS = FAIL = 0
PROJECT_ROOT = Path(__file__).resolve().parent.parent

def check(desc, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
    else:
        FAIL += 1
        print(f"FAIL: {desc}")
        if detail:
            print(f"  {detail}")

def run_node(script, env_override=None):
    """run a node script that imports our modules and returns JSON on stdout."""
    env = None
    if env_override:
        env = {**os.environ, **env_override}
    proc = subprocess.run(
        ["node", "--input-type=module"],
        input=script, capture_output=True, text=True,
        cwd=str(PROJECT_ROOT), env=env,
    )
    if proc.returncode != 0:
        return None, proc.stderr
    # parse last non-empty line as JSON (debug output may precede it)
    lines = [l for l in proc.stdout.strip().split('\n') if l.strip()]
    for line in reversed(lines):
        try:
            return json.loads(line), None
        except json.JSONDecodeError:
            continue
    return None, f"invalid json: {proc.stdout}"

# --- config: stripJsoncComments ---

result, err = run_node("""
import { stripJsoncComments } from './dist/config.js';
const cases = [
  { input: '{"a": 1} // comment', expected: '{"a": 1} ' },
  { input: '{"a": 1}', expected: '{"a": 1}' },
  { input: '// full line\\n{"a": 1}', expected: '\\n{"a": 1}' },
  // crucially: // inside strings must be preserved
  { input: '{"url": "https://example.org"}', expected: '{"url": "https://example.org"}' },
  { input: '{"a": "b" /* block */}', expected: '{"a": "b" }' },
];
const results = cases.map(c => ({
  ok: stripJsoncComments(c.input) === c.expected,
  input: c.input,
  got: stripJsoncComments(c.input),
  expected: c.expected,
}));
console.log(JSON.stringify(results));
""")
if err:
    check("stripJsoncComments (build required)", False, err.strip())
else:
    for r in (result or []):
        check(f"stripJsoncComments: {r['input'][:30]}", r["ok"],
              f"got: {r['got']!r}, expected: {r['expected']!r}")

# --- config: validateConfig ---

result, err = run_node("""
import { validateConfig } from './dist/config.js';
import { DEFAULTS } from './dist/types.js';
const empty = validateConfig(DEFAULTS);
const valid = validateConfig({
  ...DEFAULTS,
  homeserver: 'https://matrix.example.org',
  user_id: '@bot:example.org',
  access_token: 'syt_abc',
});
console.log(JSON.stringify({ empty, valid }));
""")
if err:
    check("validateConfig (build required)", False, err.strip())
else:
    check("validateConfig: empty config has 3 errors",
          len(result["empty"]) == 3, f"got: {result['empty']}")
    check("validateConfig: valid config has 0 errors",
          len(result["valid"]) == 0, f"got: {result['valid']}")

# --- config: loadConfig with temp workspace ---

tmp = tempfile.mkdtemp()
try:
    os.makedirs(os.path.join(tmp, "config"))
    config_content = """{
  // test config
  "homeserver": "https://test.matrix.org",
  "user_id": "@testbot:test.matrix.org",
  "access_token": "test_token_123",
  "default_trigger": "all",
  "room_allowlist": ["!room1:test.matrix.org"],
  "cleanup": "compact",
  "cleanup_tokens": 50000
}"""
    with open(os.path.join(tmp, "config", "bridge.jsonc"), "w") as f:
        f.write(config_content)

    result, err = run_node(f"""
import {{ loadConfig }} from './dist/config.js';
const config = loadConfig({json.dumps(tmp)});
console.log(JSON.stringify(config));
""")
    if err:
        check("loadConfig (build required)", False, err.strip())
    else:
        check("loadConfig: homeserver parsed", result["homeserver"] == "https://test.matrix.org")
        check("loadConfig: user_id parsed", result["user_id"] == "@testbot:test.matrix.org")
        check("loadConfig: access_token parsed", result["access_token"] == "test_token_123")
        check("loadConfig: default_trigger override", result["default_trigger"] == "all")
        check("loadConfig: room_allowlist parsed", result["room_allowlist"] == ["!room1:test.matrix.org"])
        check("loadConfig: cleanup parsed", result["cleanup"] == "compact")
        check("loadConfig: cleanup_tokens parsed", result["cleanup_tokens"] == 50000)
        check("loadConfig: defaults preserved", result["max_response_length"] == 4000)
        check("loadConfig: display_tool_calls default", result["display_tool_calls"] == False)
finally:
    shutil.rmtree(tmp)

# --- config: loadConfig with missing workspace ---

result, err = run_node("""
import { loadConfig } from './dist/config.js';
import { DEFAULTS } from './dist/types.js';
const config = loadConfig('/nonexistent/path');
console.log(JSON.stringify({ matches_defaults: JSON.stringify(config) === JSON.stringify(DEFAULTS) }));
""")
if err:
    check("loadConfig missing (build required)", False, err.strip())
else:
    check("loadConfig: missing workspace returns defaults", result["matches_defaults"])

# --- format: formatIncomingMessage ---

result, err = run_node("""
import { formatIncomingMessage } from './dist/format.js';
console.log(JSON.stringify({
  basic: formatIncomingMessage('alice', 'hello world'),
  empty_sender: formatIncomingMessage('', 'test'),
}));
""")
if err:
    check("formatIncomingMessage (build required)", False, err.strip())
else:
    check("formatIncomingMessage: has attribution", result["basic"] == "[alice] hello world")
    check("formatIncomingMessage: empty sender", result["empty_sender"] == "[] test")

# --- format: isBotMentioned ---

result, err = run_node("""
import { isBotMentioned } from './dist/format.js';
const uid = '@mybot:example.org';
const display = 'MyBot';
console.log(JSON.stringify({
  full_id: isBotMentioned('hey @mybot:example.org help', uid, display),
  display_name: isBotMentioned('hey MyBot help', uid, display),
  localpart: isBotMentioned('hey mybot help', uid, display),
  case_insensitive: isBotMentioned('hey MYBOT help', uid, display),
  not_mentioned: isBotMentioned('hey everyone', uid, display),
  empty_body: isBotMentioned('', uid, display),
}));
""")
if err:
    check("isBotMentioned (build required)", False, err.strip())
else:
    check("isBotMentioned: full mxid", result["full_id"])
    check("isBotMentioned: display name", result["display_name"])
    check("isBotMentioned: localpart", result["localpart"])
    check("isBotMentioned: case insensitive", result["case_insensitive"])
    check("isBotMentioned: not mentioned", not result["not_mentioned"])
    check("isBotMentioned: empty body", not result["empty_body"])

# --- format: stripBotMention ---

result, err = run_node("""
import { stripBotMention } from './dist/format.js';
const uid = '@mybot:example.org';
const display = 'MyBot';
console.log(JSON.stringify({
  full_id: stripBotMention('@mybot:example.org: what is 2+2', uid, display),
  display_colon: stripBotMention('MyBot: what is 2+2', uid, display),
  localpart: stripBotMention('mybot what is 2+2', uid, display),
  no_mention: stripBotMention('what is 2+2', uid, display),
}));
""")
if err:
    check("stripBotMention (build required)", False, err.strip())
else:
    check("stripBotMention: full mxid removed", result["full_id"] == "what is 2+2")
    check("stripBotMention: display name removed", result["display_colon"] == "what is 2+2")
    check("stripBotMention: localpart removed", result["localpart"] == "what is 2+2")
    check("stripBotMention: no mention unchanged", result["no_mention"] == "what is 2+2")

# --- format: isNoResponse ---

result, err = run_node("""
import { isNoResponse } from './dist/format.js';
console.log(JSON.stringify({
  exact: isNoResponse('[NO_RESPONSE]'),
  with_whitespace: isNoResponse('  [NO_RESPONSE]  '),
  not_no_response: isNoResponse('hello world'),
  empty: isNoResponse(''),
  partial: isNoResponse('[NO_RESPONSE] but more text'),
}));
""")
if err:
    check("isNoResponse (build required)", False, err.strip())
else:
    check("isNoResponse: exact match", result["exact"])
    check("isNoResponse: with whitespace", result["with_whitespace"])
    check("isNoResponse: not no-response", not result["not_no_response"])
    check("isNoResponse: empty string", not result["empty"])
    check("isNoResponse: partial match", not result["partial"])

# --- format: formatOutgoingParts ---

result, err = run_node("""
import { formatOutgoingParts } from './dist/format.js';
import { DEFAULTS } from './dist/types.js';
const config = { ...DEFAULTS };
const configWithTools = { ...DEFAULTS, display_tool_calls: true };
const configWithReasoning = { ...DEFAULTS, display_reasoning: true };
const configShort = { ...DEFAULTS, max_response_length: 20 };

console.log(JSON.stringify({
  text_only: formatOutgoingParts([{ type: 'text', text: 'hello' }], config),
  no_response: formatOutgoingParts([{ type: 'text', text: '[NO_RESPONSE]' }], config),
  empty_parts: formatOutgoingParts([], config),
  tool_hidden: formatOutgoingParts([
    { type: 'text', text: 'result' },
    { type: 'tool', tool: 'bash', state: 'completed' },
  ], config),
  tool_shown: formatOutgoingParts([
    { type: 'text', text: 'result' },
    { type: 'tool', tool: 'bash', state: 'completed' },
  ], configWithTools),
  reasoning_hidden: formatOutgoingParts([
    { type: 'reasoning', text: 'thinking...' },
    { type: 'text', text: 'answer' },
  ], config),
  reasoning_shown: formatOutgoingParts([
    { type: 'reasoning', text: 'thinking...' },
    { type: 'text', text: 'answer' },
  ], configWithReasoning),
  truncated: formatOutgoingParts([{ type: 'text', text: 'a'.repeat(50) }], configShort),
  system_reminder_stripped: formatOutgoingParts([
    { type: 'text', text: 'hello <system-reminder>secret stuff</system-reminder> world' },
  ], config),
  system_reminder_only: formatOutgoingParts([
    { type: 'text', text: '<system-reminder>secret stuff</system-reminder>' },
  ], config),
  system_reminder_multiline: formatOutgoingParts([
    { type: 'text', text: '<system-reminder>\\nline1\\nline2\\n</system-reminder>' },
  ], config),
  system_reminder_multiple: formatOutgoingParts([
    { type: 'text', text: '<system-reminder>a</system-reminder> mid <system-reminder>b</system-reminder>' },
  ], config),
}));
""")
if err:
    check("formatOutgoingParts (build required)", False, err.strip())
else:
    check("formatOutgoingParts: text only", result["text_only"] == "hello")
    check("formatOutgoingParts: no-response returns null", result["no_response"] is None)
    check("formatOutgoingParts: empty returns null", result["empty_parts"] is None)
    check("formatOutgoingParts: tool hidden by default",
          "tool" not in (result["tool_hidden"] or "").lower() and result["tool_hidden"] == "result")
    check("formatOutgoingParts: tool shown when enabled",
          "bash" in (result["tool_shown"] or ""))
    check("formatOutgoingParts: reasoning hidden by default",
          "thinking" not in (result["reasoning_hidden"] or "") and result["reasoning_hidden"] == "answer")
    check("formatOutgoingParts: reasoning shown when enabled",
          "thinking" in (result["reasoning_shown"] or ""))
    check("formatOutgoingParts: truncated",
          result["truncated"] is not None and result["truncated"].endswith("...(truncated)"))
    check("formatOutgoingParts: system-reminder stripped",
          result["system_reminder_stripped"] == "hello  world",
          f"got: {result['system_reminder_stripped']!r}")
    check("formatOutgoingParts: system-reminder only returns null",
          result["system_reminder_only"] is None,
          f"got: {result['system_reminder_only']!r}")
    check("formatOutgoingParts: multiline system-reminder stripped",
          result["system_reminder_multiline"] is None,
          f"got: {result['system_reminder_multiline']!r}")
    check("formatOutgoingParts: multiple system-reminders stripped",
          result["system_reminder_multiple"] == "mid",
          f"got: {result['system_reminder_multiple']!r}")

# --- format: formatSystemPromptAddendum ---

result, err = run_node("""
import { formatSystemPromptAddendum } from './dist/format.js';
import { DEFAULTS } from './dist/types.js';
const config = { ...DEFAULTS };
const customConfig = { ...DEFAULTS, system_prompt: 'you are a helpful bot. reply with [NO_RESPONSE] if unsure.' };
console.log(JSON.stringify({
  dm: formatSystemPromptAddendum('!room:ex.org', ['alice', 'bot'], true, config),
  group: formatSystemPromptAddendum('!room:ex.org', ['alice', 'bob', 'bot'], false, config),
  no_members: formatSystemPromptAddendum('!room:ex.org', [], false, config),
  custom_group: formatSystemPromptAddendum('!room:ex.org', ['alice'], false, customConfig),
  custom_dm: formatSystemPromptAddendum('!room:ex.org', ['alice'], true, customConfig),
}));
""")
if err:
    check("formatSystemPromptAddendum (build required)", False, err.strip())
else:
    check("formatSystemPromptAddendum: DM has room id", "!room:ex.org" in result["dm"])
    check("formatSystemPromptAddendum: DM has no NO_RESPONSE instruction",
          "NO_RESPONSE" not in result["dm"])
    check("formatSystemPromptAddendum: group has participants",
          "alice" in result["group"] and "bob" in result["group"])
    check("formatSystemPromptAddendum: group has NO_RESPONSE instruction",
          "NO_RESPONSE" in result["group"])
    check("formatSystemPromptAddendum: group has attribution note",
          "[username]" in result["group"])
    check("formatSystemPromptAddendum: group has formatting guidance",
          "plain text" in result["group"].lower() or "formatting" in result["group"].lower())
    check("formatSystemPromptAddendum: group has brevity instruction",
          "short" in result["group"].lower() or "concise" in result["group"].lower())
    check("formatSystemPromptAddendum: no members skips participants line",
          "participants" not in result["no_members"])
    check("formatSystemPromptAddendum: custom prompt used for group",
          "helpful bot" in result["custom_group"])
    check("formatSystemPromptAddendum: custom prompt skipped for DM",
          "helpful bot" not in result["custom_dm"])

# --- format: formatCompactionContext ---

result, err = run_node("""
import { formatCompactionContext } from './dist/format.js';
console.log(JSON.stringify({
  with_members: formatCompactionContext('!room:ex.org', ['alice', 'bob']),
  no_members: formatCompactionContext('!room:ex.org', []),
}));
""")
if err:
    check("formatCompactionContext (build required)", False, err.strip())
else:
    check("formatCompactionContext: has room id", "!room:ex.org" in result["with_members"])
    check("formatCompactionContext: has members", "alice" in result["with_members"])
    check("formatCompactionContext: has preserve instruction", "preserve" in result["with_members"].lower())
    check("formatCompactionContext: no members", "participants" not in result["no_members"])

# --- config: validateConfig allows missing model ---

result, err = run_node("""
import { validateConfig } from './dist/config.js';
import { DEFAULTS } from './dist/types.js';
const noModel = validateConfig({
  ...DEFAULTS,
  homeserver: 'https://matrix.example.org',
  user_id: '@bot:example.org',
  access_token: 'syt_abc',
  model: null,
});
console.log(JSON.stringify({ noModel }));
""")
if err:
    check("validateConfig model optional (build required)", False, err.strip())
else:
    check("validateConfig: missing model is not an error",
          len(result["noModel"]) == 0, f"got: {result['noModel']}")

# --- config: env vars override config values ---

tmp = tempfile.mkdtemp()
try:
    os.makedirs(os.path.join(tmp, "config"))
    config_content = """{
  "homeserver": "https://config.matrix.org",
  "user_id": "@config-bot:matrix.org",
  "access_token": "config_token",
  "model": "anthropic/claude-sonnet-4-5",
  "agent": "config-agent"
}"""
    with open(os.path.join(tmp, "config", "bridge.jsonc"), "w") as f:
        f.write(config_content)

    result, err = run_node(f"""
import {{ loadConfig }} from './dist/config.js';
const config = loadConfig({json.dumps(tmp)});
console.log(JSON.stringify(config));
""", env_override={
        "BRIDGE_HOMESERVER": "https://env.matrix.org",
        "BRIDGE_USER_ID": "@env-bot:matrix.org",
        "BRIDGE_ACCESS_TOKEN": "env_token",
        "BRIDGE_MODEL": "openai/gpt-4o",
        "BRIDGE_AGENT": "env-agent",
    })
    if err:
        check("env override (build required)", False, err.strip())
    else:
        check("env override: homeserver", result["homeserver"] == "https://env.matrix.org",
              f"got: {result['homeserver']}")
        check("env override: user_id", result["user_id"] == "@env-bot:matrix.org",
              f"got: {result['user_id']}")
        check("env override: access_token", result["access_token"] == "env_token",
              f"got: {result['access_token']}")
        check("env override: model normalized",
              result["model"] == {"providerID": "openai", "modelID": "gpt-4o"},
              f"got: {result['model']}")
        check("env override: agent", result["agent"] == "env-agent",
              f"got: {result['agent']}")
finally:
    shutil.rmtree(tmp)

# --- config: env vars work without config file ---

result, err = run_node("""
import { loadConfig } from './dist/config.js';
const config = loadConfig('/nonexistent/path');
console.log(JSON.stringify(config));
""", env_override={
    "BRIDGE_HOMESERVER": "https://env-only.matrix.org",
    "BRIDGE_USER_ID": "@env-only:matrix.org",
    "BRIDGE_ACCESS_TOKEN": "env_only_token",
})
if err:
    check("env without config (build required)", False, err.strip())
else:
    check("env without config: homeserver", result["homeserver"] == "https://env-only.matrix.org",
          f"got: {result['homeserver']}")
    check("env without config: user_id", result["user_id"] == "@env-only:matrix.org",
          f"got: {result['user_id']}")
    check("env without config: access_token", result["access_token"] == "env_only_token",
          f"got: {result['access_token']}")
    check("env without config: defaults preserved", result["max_response_length"] == 4000)

# --- config: env vars for cleanup and trigger ---

tmp = tempfile.mkdtemp()
try:
    os.makedirs(os.path.join(tmp, "config"))
    with open(os.path.join(tmp, "config", "bridge.jsonc"), "w") as f:
        f.write('{"homeserver":"h","user_id":"u","access_token":"a"}')

    result, err = run_node(f"""
import {{ loadConfig }} from './dist/config.js';
const config = loadConfig({json.dumps(tmp)});
console.log(JSON.stringify(config));
""", env_override={
        "BRIDGE_DEFAULT_TRIGGER": "all",
        "BRIDGE_CLEANUP": "compact",
    })
    if err:
        check("env trigger/cleanup (build required)", False, err.strip())
    else:
        check("env override: default_trigger", result["default_trigger"] == "all",
              f"got: {result['default_trigger']}")
        check("env override: cleanup", result["cleanup"] == "compact",
              f"got: {result['cleanup']}")
finally:
    shutil.rmtree(tmp)

# --- session: model persistence ---

tmp = tempfile.mkdtemp()
try:
    result, err = run_node(f"""
import {{ loadBridgeState, loadModel, persistModel }} from './dist/session.js';
loadBridgeState({json.dumps(tmp)});

// initially no model
const before = loadModel();

// persist a model
persistModel({{ providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }}, {json.dumps(tmp)});
const after = loadModel();

// persist same model again (should be a no-op, no error)
persistModel({{ providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }}, {json.dumps(tmp)});
const afterSame = loadModel();

// persist different model
persistModel({{ providerID: 'openai', modelID: 'gpt-4o' }}, {json.dumps(tmp)});
const afterDiff = loadModel();

console.log(JSON.stringify({{ before, after, afterSame, afterDiff }}));
""")
    if err:
        check("model persistence (build required)", False, err.strip())
    else:
        check("loadModel: initially null", result["before"] is None)
        check("persistModel: stores model",
              result["after"] == {"providerID": "anthropic", "modelID": "claude-sonnet-4-5"})
        check("persistModel: idempotent",
              result["afterSame"] == {"providerID": "anthropic", "modelID": "claude-sonnet-4-5"})
        check("persistModel: updates on change",
              result["afterDiff"] == {"providerID": "openai", "modelID": "gpt-4o"})

    # verify state file on disk has model
    state_file = os.path.join(tmp, "state", "bridge.json")
    if os.path.exists(state_file):
        with open(state_file) as f:
            state = json.load(f)
        check("state file: has model field",
              state.get("model") == {"providerID": "openai", "modelID": "gpt-4o"},
              f"got: {state.get('model')}")
    else:
        check("state file: exists", False, "state/bridge.json not found")
finally:
    shutil.rmtree(tmp)

# --- session: model loaded from state on startup ---

tmp = tempfile.mkdtemp()
try:
    os.makedirs(os.path.join(tmp, "state"))
    state = {
        "rooms": [],
        "sync_token": None,
        "model": {"providerID": "anthropic", "modelID": "claude-sonnet-4-5"},
    }
    with open(os.path.join(tmp, "state", "bridge.json"), "w") as f:
        json.dump(state, f)

    result, err = run_node(f"""
import {{ loadBridgeState, loadModel }} from './dist/session.js';
loadBridgeState({json.dumps(tmp)});
const model = loadModel();
console.log(JSON.stringify({{ model }}));
""")
    if err:
        check("model from state on startup (build required)", False, err.strip())
    else:
        check("loadModel: loads from persisted state",
              result["model"] == {"providerID": "anthropic", "modelID": "claude-sonnet-4-5"},
              f"got: {result['model']}")
finally:
    shutil.rmtree(tmp)

# --- session: shouldCleanup respects baseline after compaction ---

result, err = run_node("""
import { shouldCleanup, performCleanup } from './dist/session.js';

// mock client returning messages with token counts
function mockClient(messages) {
  return {
    session: {
      messages: async () => ({ data: messages, error: null }),
      summarize: async () => ({ data: {}, error: null }),
    },
  };
}

function makeMsgs(count, tokensEach) {
  return Array.from({ length: count }, (_, i) => ({
    info: { tokens: { input: tokensEach, output: 0 } },
  }));
}

// scenario: tokens exceed threshold -> should trigger
const client1 = mockClient(makeMsgs(10, 6000));
const r1 = await shouldCleanup(client1, 'sess1', {
  cleanup: 'compact', cleanup_tokens: 50000, cleanup_message_count: null,
});

// scenario: after compaction, post-summary tokens still above threshold
// simulate: performCleanup sets baseline, then shouldCleanup rechecks
// first, set up a room mapping so performCleanup can store baseline
import { getOrCreateSession, loadBridgeState } from './dist/session.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const tmp = mkdtempSync(join(tmpdir(), 'bridge-test-'));
loadBridgeState(tmp);

const mockClient2 = {
  session: {
    create: async () => ({ data: { id: 'sess2' }, error: null }),
    messages: async () => ({ data: makeMsgs(2, 15000), error: null }),
    summarize: async () => ({ data: {}, error: null }),
  },
};
const sessId = await getOrCreateSession(mockClient2, '!room:test', 'test', tmp);

// trigger cleanup with tokens at 60000 (above 50000 threshold)
const clientAbove = {
  session: {
    messages: async () => ({ data: makeMsgs(10, 6000), error: null }),
    summarize: async () => ({ data: {}, error: null }),
  },
};
const beforeCleanup = await shouldCleanup(clientAbove, sessId, {
  cleanup: 'compact', cleanup_tokens: 50000, cleanup_message_count: null,
});

// perform the cleanup (should record baseline)
await performCleanup(clientAbove, sessId, '!room:test', {
  cleanup: 'compact', cleanup_tokens: 50000, cleanup_message_count: null,
}, tmp, { providerID: 'test', modelID: 'test' });

// after compaction, session still has 30000 tokens (summary)
// this is below the original threshold but above 0
const clientPostCompact = {
  session: {
    messages: async () => ({ data: makeMsgs(2, 15000), error: null }),
    summarize: async () => ({ data: {}, error: null }),
  },
};
const afterCleanup = await shouldCleanup(clientPostCompact, sessId, {
  cleanup: 'compact', cleanup_tokens: 50000, cleanup_message_count: null,
});

// now add enough tokens past baseline to exceed threshold again
// baseline was 60000, so need 60000 + 50000 = 110000
const clientGrown = {
  session: {
    messages: async () => ({ data: makeMsgs(20, 5500), error: null }),
    summarize: async () => ({ data: {}, error: null }),
  },
};
const afterGrowth = await shouldCleanup(clientGrown, sessId, {
  cleanup: 'compact', cleanup_tokens: 50000, cleanup_message_count: null,
});

console.log(JSON.stringify({
  triggers_above_threshold: r1,
  triggers_before_cleanup: beforeCleanup,
  suppressed_after_cleanup: afterCleanup,
  triggers_after_growth: afterGrowth,
}));
""")
if err:
    check("shouldCleanup baseline (build required)", False, err.strip())
else:
    check("shouldCleanup: triggers above threshold", result["triggers_above_threshold"])
    check("shouldCleanup: triggers before cleanup", result["triggers_before_cleanup"])
    check("shouldCleanup: suppressed after compaction",
          not result["suppressed_after_cleanup"],
          f"got: {result['suppressed_after_cleanup']}")
    check("shouldCleanup: triggers after growth past baseline",
          result["triggers_after_growth"])

# --- session: shouldCleanup message count baseline ---

result, err = run_node("""
import { shouldCleanup, performCleanup, getOrCreateSession, loadBridgeState } from './dist/session.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'bridge-test-'));
loadBridgeState(tmp);

function makeMsgs(count) {
  return Array.from({ length: count }, () => ({ info: { tokens: { input: 100, output: 100 } } }));
}

const mockClient = {
  session: {
    create: async () => ({ data: { id: 'sess-mc' }, error: null }),
    messages: async () => ({ data: makeMsgs(20), error: null }),
    summarize: async () => ({ data: {}, error: null }),
  },
};
const sessId = await getOrCreateSession(mockClient, '!mc-room:test', 'test', tmp);

// 20 messages >= 15 threshold -> should trigger
const before = await shouldCleanup(mockClient, sessId, {
  cleanup: 'compact', cleanup_tokens: null, cleanup_message_count: 15,
});

// compact sets baseline
await performCleanup(mockClient, sessId, '!mc-room:test', {
  cleanup: 'compact', cleanup_tokens: null, cleanup_message_count: 15,
}, tmp, { providerID: 'test', modelID: 'test' });

// post-compaction: still 20 messages (summary) but below baseline + threshold
const postCompact = {
  session: {
    messages: async () => ({ data: makeMsgs(5), error: null }),
    summarize: async () => ({ data: {}, error: null }),
  },
};
const after = await shouldCleanup(postCompact, sessId, {
  cleanup: 'compact', cleanup_tokens: null, cleanup_message_count: 15,
});

console.log(JSON.stringify({ before, after }));
""")
if err:
    check("shouldCleanup message baseline (build required)", False, err.strip())
else:
    check("shouldCleanup msg: triggers before cleanup", result["before"])
    check("shouldCleanup msg: suppressed after cleanup",
          not result["after"], f"got: {result['after']}")

# --- summary ---

total = PASS + FAIL
print(f"\n{total} tests, {PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
