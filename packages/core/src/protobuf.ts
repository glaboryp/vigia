export type ProtoValue = bigint | Uint8Array

export interface ProtoField {
  field: number
  wire: 0 | 1 | 2 | 5
  value: ProtoValue
}

function readVarint(bytes: Uint8Array, start: number): [bigint, number] {
  let value = 0n
  for (let i = 0; i < 10; i++) {
    const byte = bytes[start + i]
    if (byte === undefined) throw new RangeError('Truncated protobuf varint')
    value |= BigInt(byte & 0x7f) << BigInt(7 * i)
    if ((byte & 0x80) === 0) return [value, start + i + 1]
  }
  throw new RangeError('Protobuf varint too long')
}

function take(bytes: Uint8Array, start: number, length: number): Uint8Array {
  if (start + length > bytes.length) throw new RangeError('Truncated protobuf field')
  return bytes.subarray(start, start + length)
}

export function decodeFields(bytes: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = []
  let pos = 0
  while (pos < bytes.length) {
    const [tag, afterTag] = readVarint(bytes, pos)
    const field = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    if (field === 0) throw new RangeError('Invalid protobuf field number 0')
    pos = afterTag
    switch (wire) {
      case 0: {
        const [value, next] = readVarint(bytes, pos)
        fields.push({ field, wire, value })
        pos = next
        break
      }
      case 2: {
        const [length, next] = readVarint(bytes, pos)
        const value = take(bytes, next, Number(length))
        fields.push({ field, wire, value })
        pos = next + value.length
        break
      }
      case 1:
      case 5: {
        const value = take(bytes, pos, wire === 1 ? 8 : 4)
        fields.push({ field, wire, value })
        pos += value.length
        break
      }
      default:
        throw new RangeError(`Unsupported protobuf wire type ${wire}`)
    }
  }
  return fields
}

export function decodeMessage(bytes: Uint8Array): Map<number, ProtoValue[]> {
  const map = new Map<number, ProtoValue[]>()
  for (const { field, wire, value } of decodeFields(bytes)) {
    if (wire !== 0 && wire !== 2) continue
    const list = map.get(field)
    if (list) list.push(value)
    else map.set(field, [value])
  }
  return map
}
