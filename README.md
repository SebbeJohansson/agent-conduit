# agent-conduit

Reads what Claude Code and OpenCode sessions are doing, for apps that show
them. Shared by [my-widget](https://github.com/SebbeJohansson/my-widget) and [openui](https://github.com/SebbeJohansson/opencode-vis).

It answers two questions:

| Question | Claude Code | OpenCode |
| --- | --- | --- |
| What is running right now, and what is it doing? | `readLiveClaudeSessions` | `watchOpencode`, `fetchOpencodeSessions` |
| Show me everything | `listClaudeProjects`, `readEntries` | (the server's own API) |

## No I/O of its own

Nothing here opens a file. The app passes in a `FileReader`, four functions
(`listDir`, `stat`, `readText`, `readTail`), because every host reads files its
own way: a Tauri webview through its fs plugin, a dev server through an HTTP
route, a Node server through `node:fs`. Node apps can use the one included:

```ts
import { listClaudeProjects } from 'agent-conduit'
import { nodeFileReader } from 'agent-conduit/node'

const projects = await listClaudeProjects(nodeFileReader, `${homedir()}/.claude`)
```

The OpenCode client takes a `fetch` the same way, because a Tauri webview has
to send its requests through tauri-plugin-http to get past CORS.

## Claude Code

`~/.claude` holds everything:

| Path | Holds |
| --- | --- |
| `sessions/<pid>.json` | one per session ever started: id, working directory, name |
| `projects/<encoded cwd>/<session id>.jsonl` | the transcript |
| `/run/user/<uid>/cc-socks/<pid>.sock` | one socket per session running right now |

`readLiveClaudeSessions` intersects the registry with the socket listing to get
exactly the live sessions, then reads the last 32 KB of each transcript for its
state. `stop_reason` on the last assistant entry decides it: `tool_use` is
busy, `end_turn` is your move. Pass the same `LiveClaudeCache` on every call so
unchanged files are not read again.

`listClaudeProjects` walks `projects/` instead and reads every transcript in
full, for a session browser.

### Permission prompts

A transcript cannot tell a tool that is running from one waiting for you to
allow it: both end on the same `tool_use` entry. A small Claude Code hook fills
that gap:

```bash
npx agent-conduit install-claude-hook     # uninstall-claude-hook to undo, claude-hook-status to check
```

Apps can offer the same as a button: `installClaudeHook`, `uninstallClaudeHook`
and `readClaudeHookStatus` are exported from `agent-conduit/node`. The status
says whether the hook is installed and whether it is this version's script, so
an app can offer an update after agent-conduit changes it.

It copies `hooks/claude-permission.sh` to `~/.claude/agent-conduit/` and
registers it in `~/.claude/settings.json`, leaving every other setting and hook
alone. On `PermissionRequest` it writes
`~/.claude/agent-conduit/permissions/<session id>.json`, and it removes that
file once the session moves on (the same tool call finishing, a new prompt,
the turn ending). `readLiveClaudeSessions` then sets `permission` on the
session, and only while nothing has been written to the transcript since the
prompt opened, so a marker a hook failed to remove cannot linger. It is plain
`sh`, because it runs on every tool call.

## Resuming

`resumeCommand('claude' | 'opencode', { sessionId, directory })` gives the
shell command that picks a session up again in a terminal, for example
`cd /home/me/proj && claude --resume <id>`.

## OpenCode

Talks to a running `opencode serve` (port 4096 by default). `watchOpencode`
reads a snapshot of every directory's sessions, statuses, permissions and
questions, then follows `GET /global/event`, and reconnects when the server goes
away. A subagent's work and prompts count towards the root session that started
it.

| Activity | Means |
| --- | --- |
| `approval` | a permission or a question is waiting on you |
| `working` | the session or one of its subagents is running |
| `idle` | nothing is running |

## herdr

[herdr](https://herdr.dev) owns the terminals agents run in, so through it an
app can do what reading files cannot: see a dialog on screen (`blocked`), and
type into the session as you would. From `agent-conduit/node`, over herdr's
unix socket (`~/.config/herdr/herdr.sock` by default):

| Function | Does |
| --- | --- |
| `watchHerdr` / `listHerdrAgents` | every agent in a pane: kind, status, cwd, and the session id herdr's Claude Code integration reports |
| `promptHerdrAgent` | types a prompt and presses Enter; refused (`agent_blocked`) while a dialog is open |
| `sendHerdrKeys` | presses keys, e.g. `esc`, to answer a dialog |
| `readHerdrAgent` | the pane's recent output |
| `startHerdrAgent` | starts an agent in a new, unfocused herdr workspace |

The types (`HerdrAgent`, `HerdrAgentStatus`) are in the main entry too, for
browser code that shows what a server read.

## Using it from another project

```json
"dependencies": { "agent-conduit": "^0.4.0" }
```

### Running against this checkout

my-widget and openui read `AGENT_CONDUIT_DIR` from their `.env`, which git ignores.
When it is set, their `nuxt.config.ts` points `agent-conduit` at that checkout's
`dist/` instead of the installed package, so local changes show up without a
release, while CI and fresh clones keep using npm:

```bash
echo 'AGENT_CONDUIT_DIR=../agent-conduit' >> ../my-widget/.env
yarn dev   # here: rebuilds dist/ on save
```

### Releasing

```bash
npm version minor   # or patch
npm publish         # builds through the prepare script
git push --follow-tags
```

Then bump the version in each app's `package.json`.

## Development

```bash
yarn install
yarn check   # typecheck and tests
```
