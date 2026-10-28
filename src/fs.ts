// The file reads this package needs, supplied by whoever uses it.
//
// Nothing here opens a file itself. A Tauri webview reads through its fs
// plugin, a dev server through an HTTP route, a Node server through `node:fs`,
// and each of them limits what may be read in its own way. So the app hands in
// these four operations and everything above them is one implementation that
// runs unchanged in any of those hosts. `agent-tap/node` has a ready-made one
// for Node.

export interface FileStamp {
  size: number
  /** Epoch milliseconds of the last write, or 0 when the host does not report one. */
  modified: number
}

export interface FileReader {
  /** Names of the entries in a directory. A missing directory reads as empty. */
  listDir: (path: string) => Promise<string[]>
  /** Size and mtime, or null when the file is gone. */
  stat: (path: string) => Promise<FileStamp | null>
  /** A whole file as text, or an empty string when it is gone. */
  readText: (path: string) => Promise<string>
  /**
   * The last `bytes` of a file, decoded as UTF-8. The window can land
   * mid-character or mid-line; the readers here skip a partial first line.
   */
  readTail: (path: string, bytes: number) => Promise<string>
}

/**
 * Join with the separator `base` is already using.
 *
 * A UNC path (`\\wsl.localhost\Ubuntu\...`) and a Windows drive path both take
 * backslashes; everything else takes slashes. Deciding from `base` rather than
 * from the host means one function serves both, including a Windows host
 * reaching into WSL.
 */
export function joinPath(base: string, ...parts: string[]): string {
  const sep = base.includes('\\') && !base.startsWith('/') ? '\\' : '/'
  return [base.replace(/[\\/]+$/, ''), ...parts].join(sep)
}
