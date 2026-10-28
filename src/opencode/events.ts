// OpenCode's event stream, `GET /global/event`, as packets.
//
// The stream is server-sent events: frames separated by a blank line, each a
// `data: ` line holding one JSON packet,
//
//   { directory: "/home/me/project", payload: { type: "session.status", properties: {...} } }
//
// `directory` is the instance the event came from; a server can host several.

export interface OpencodePacket {
  directory: string
  payload: {
    type: string
    properties: Record<string, unknown>
  }
}

/**
 * Split an event-stream text buffer on blank lines. `blocks` are complete
 * frames; `rest` is the trailing partial frame to keep for the next chunk.
 */
export function splitSseBlocks(buffer: string): { blocks: string[], rest: string } {
  const blocks = buffer.split('\n\n')
  const rest = blocks.pop() || ''
  return { blocks, rest }
}

/** Parse one `data:` payload into a packet, or null when malformed. */
export function parseSsePacket(raw: string): OpencodePacket | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  if (!record.payload || typeof record.payload !== 'object') return null
  const payload = record.payload as Record<string, unknown>
  if (typeof payload.type !== 'string') return null
  if (!payload.properties || typeof payload.properties !== 'object') return null
  return {
    directory: typeof record.directory === 'string' ? record.directory : '',
    payload: {
      type: payload.type,
      properties: payload.properties as Record<string, unknown>,
    },
  }
}

/**
 * Parse one whole frame (`data: {...}`), or null when it is not a data frame
 * or does not hold a packet.
 */
export function parseSseBlock(block: string): OpencodePacket | null {
  const prefix = 'data: '
  return block.startsWith(prefix) ? parseSsePacket(block.slice(prefix.length)) : null
}
