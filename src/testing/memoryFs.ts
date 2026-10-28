// An in-memory `FileReader` for tests: a flat map of path to contents, with
// directories implied by the paths under them.

import type { FileReader } from '../fs.js'

export function memoryFs(files: Record<string, string>, modified: Record<string, number> = {}): FileReader & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    async listDir(path) {
      const prefix = `${path.replace(/\/+$/, '')}/`
      const names = new Set<string>()
      for (const file of Object.keys(files)) {
        if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split('/')[0]!)
      }
      return [...names]
    },
    async stat(path) {
      return path in files ? { size: files[path]!.length, modified: modified[path] ?? 0 } : null
    },
    async readText(path) {
      reads.push(path)
      return files[path] ?? ''
    },
    async readTail(path, bytes) {
      reads.push(path)
      return (files[path] ?? '').slice(-bytes)
    },
  }
}
