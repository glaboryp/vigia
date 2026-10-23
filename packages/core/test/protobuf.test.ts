import { describe, expect, it } from 'vitest'
import { decodeFields, decodeMessage } from '../src/protobuf.js'

const bytes = (...b: number[]) => Uint8Array.from(b)

describe('decodeMessage', () => {
  it('returns an empty map for an empty message', () => {
    expect(decodeMessage(bytes()).size).toBe(0)
  })

  it('decodes a varint field', () => {
    expect(decodeMessage(bytes(0x08, 0x96, 0x01))).toEqual(new Map([[1, [150n]]]))
  })

  it('decodes a length-delimited field', () => {
    const map = decodeMessage(bytes(0x12, 0x03, 0x61, 0x62, 0x63))
    expect(new TextDecoder().decode(map.get(2)![0] as Uint8Array)).toBe('abc')
  })

  it('accumulates repeated fields in order', () => {
    expect(decodeMessage(bytes(0x08, 0x01, 0x08, 0x02, 0x08, 0x03)).get(1)).toEqual([1n, 2n, 3n])
  })

  it('decodes the largest 64-bit varint and a multi-byte field number', () => {
    const max = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]
    const map = decodeMessage(bytes(0x08, ...max, 0xa0, 0x1f, 0x05))
    expect(map.get(1)).toEqual([18446744073709551615n])
    expect(map.get(500)).toEqual([5n])
  })

  it('skips fixed32 and fixed64 fields and keeps decoding', () => {
    const map = decodeMessage(
      bytes(0x0d, 1, 2, 3, 4, 0x11, 1, 2, 3, 4, 5, 6, 7, 8, 0x18, 0x07),
    )
    expect([...map.keys()]).toEqual([3])
    expect(map.get(3)).toEqual([7n])
  })

  it.each([
    ['a truncated varint', bytes(0x08, 0x96)],
    ['a length past the end', bytes(0x12, 0x05, 0x61)],
    ['a truncated fixed32', bytes(0x0d, 1, 2)],
    ['a truncated fixed64', bytes(0x11, 1, 2, 3, 4)],
    ['a group wire type', bytes(0x0b)],
    ['field number zero', bytes(0x00, 0x01)],
    ['an overlong varint', bytes(0x08, ...Array(10).fill(0xff), 0x01)],
  ])('throws on %s', (_n, input) => {
    expect(() => decodeMessage(input)).toThrow()
  })
})

describe('decodeFields', () => {
  it('exposes the wire type and raw bytes of fixed-width fields', () => {
    const fields = decodeFields(bytes(0x0d, 0x00, 0x00, 0x2a, 0x42, 0x10, 0x01))
    expect(fields).toEqual([
      { field: 1, wire: 5, value: bytes(0x00, 0x00, 0x2a, 0x42) },
      { field: 2, wire: 0, value: 1n },
    ])
  })
})
