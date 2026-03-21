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

def run_node(script):
    """run a node script that imports our modules and returns JSON on stdout."""
    proc = subprocess.run(
        ["node", "--input-type=module"],
        input=script, capture_output=True, text=True,
        cwd=str(PROJECT_ROOT),
    )
    if proc.returncode != 0:
        return None, proc.stderr
    try:
        return json.loads(proc.stdout.strip()), None
    except json.JSONDecodeError:
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

# --- format: formatSystemPromptAddendum ---

result, err = run_node("""
import { formatSystemPromptAddendum } from './dist/format.js';
console.log(JSON.stringify({
  dm: formatSystemPromptAddendum('!room:ex.org', ['alice', 'bot'], true),
  group: formatSystemPromptAddendum('!room:ex.org', ['alice', 'bob', 'bot'], false),
  no_members: formatSystemPromptAddendum('!room:ex.org', [], false),
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
    check("formatSystemPromptAddendum: no members skips participants line",
          "participants" not in result["no_members"])

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

# --- summary ---

total = PASS + FAIL
print(f"\n{total} tests, {PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
