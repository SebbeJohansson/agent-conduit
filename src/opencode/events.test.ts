import { describe, expect, it } from 'vitest'
import { parseSseBlock, parseSsePacket, splitSseBlocks } from './events.js'

describe('splitSseBlocks', () => {
  it('keeps the trailing partial frame', () => {
    expect(splitSseBlocks('data: a\n\ndata: b\n\ndata: c')).toEqual({ blocks: ['data: a', 'data: b'], rest: 'data: c' })
  })
})

describe('parseSsePacket', () => {
  it('parses a packet', () => {
    expect(parseSsePacket('{"directory":"/p","payload":{"type":"x","properties":{"a":1}}}'))
      .toEqual({ directory: '/p', payload: { type: 'x', properties: { a: 1 } } })
  })

  it('rejects malformed input', () => {
    expect(parseSsePacket('nope')).toBeNull()
    expect(parseSsePacket('{"payload":{"type":"x"}}')).toBeNull()
  })
})

describe('parseSseBlock', () => {
  it('only accepts data frames', () => {
    expect(parseSseBlock(': keepalive')).toBeNull()
    expect(parseSseBlock('data: {"payload":{"type":"x","properties":{}}}')?.payload.type).toBe('x')
  })
})
