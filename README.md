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

## Using it from another project

```json
"dependencies": { "agent-conduit": "^0.1.0" }
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
