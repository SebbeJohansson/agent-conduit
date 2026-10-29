// What herdr reports about an agent, as agent-conduit hands it on. Types only,
// so an app's browser code can describe herdr's agents without importing the
// socket client (agent-conduit/node) that reads them.

/**
 * herdr's lifecycle states, read off the agent's own screen (or its hooks):
 *
 * - `working`  mid-turn
 * - `blocked`  an approval or question dialog is on screen, waiting for you
 * - `idle`     at its prompt
 * - `done`     finished a turn nobody has looked at yet
 * - `unknown`  an agent is there but herdr cannot tell what it is doing
 */
export type HerdrAgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

export interface HerdrAgent {
  /** The pane hosting it, e.g. `w1:p2`; also a valid target. */
  paneId: string
  workspaceId: string
  tabId: string
  /** Its herdr name, when it was given one (`agent start` always does). */
  name?: string
  /** Which agent it is: `claude`, `opencode`, `codex`, ... */
  kind?: string
  status: HerdrAgentStatus
  /** The pane's working directory, preferring the foreground process's. */
  cwd?: string
  /** The terminal title with herdr's spinner stripped. */
  title?: string
  /**
   * The agent's own session id, when herdr was told it (its Claude Code
   * integration reports it on SessionStart). The same id Claude Code uses, so
   * a herdr pane can be matched with a session read from ~/.claude.
   */
  sessionId?: string
  /** Whether a client has the pane focused right now. */
  focused: boolean
  /**
   * The processes in the pane's foreground, e.g. the `claude` process itself.
   * Claude Code's registry is keyed by the same process ids, which matches a
   * pane to its session without herdr's Claude Code integration. Absent when
   * herdr could not say.
   */
  pids?: number[]
  /**
   * When `blocked`: whether the dialog is a recognised permission prompt
   * (allow or deny a tool), or anything else (folder trust, a question), which
   * only a person should answer. See `dialogOf`.
   */
  dialog?: HerdrDialog
  /**
   * When `blocked`: the dialog as it reads on screen, when its choices could
   * be made out. Each choice is answered by pressing its key, so a person can
   * pick any of them, not only allow or deny. See `dialogScreenOf`.
   */
  dialogScreen?: HerdrDialogScreen
}

/** A blocked agent's dialog: a tool permission prompt, or something else. */
export type HerdrDialog = 'permission' | 'other'

/** A dialog's question and its numbered choices, read off the screen. */
export interface HerdrDialogScreen {
  /** The line that asks, e.g. `Do you want to proceed?`. */
  question: string
  /** What the dialog shows above the question: the command, the file, why it asks. */
  detail?: string
  choices: HerdrDialogChoice[]
}

export interface HerdrDialogChoice {
  /** The key that picks it: its number. */
  key: string
  label: string
  /** The highlighted one, which Enter would pick. */
  selected?: boolean
}
