// A `FileReader` over `node:fs`, for apps that run on a Node server.
//
// Kept out of the main entry so a browser bundle never sees a `node:` import.

import { open, readdir, readFile, stat } from 'node:fs/promises'
import type { FileReader } from './fs.js'

export const nodeFileReader: FileReader = {
  async listDir(path) {
    return readdir(path).catch(() => [])
  },

  async stat(path) {
    const info = await stat(path).catch(() => null)
    return info?.isFile() ? { size: info.size, modified: info.mtimeMs } : null
  },

  async readText(path) {
    return readFile(path, 'utf8').catch(() => '')
  },

  async readTail(path, bytes) {
    const handle = await open(path, 'r').catch(() => null)
    if (!handle) {
      return ''
    }
    try {
      const { size } = await handle.stat()
      const length = Math.min(bytes, size)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, size - length)
      return buffer.toString('utf8')
    }
    finally {
      await handle.close()
    }
  },
}
