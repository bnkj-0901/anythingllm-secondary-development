// Small streaming helpers shared by fetch and uni.request. No browser APIs are required.
export class Utf8Decoder {
  constructor() {
    this.pending = new Uint8Array(0)
  }

  decode(input = new Uint8Array(0), final = false) {
    const incoming = input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    const bytes = new Uint8Array(this.pending.length + incoming.length)
    bytes.set(this.pending)
    bytes.set(incoming, this.pending.length)
    let text = ''
    let index = 0
    while (index < bytes.length) {
      const first = bytes[index]
      if (first < 0x80) {
        text += String.fromCharCode(first)
        index++
        continue
      }
      const size = first >= 0xc2 && first <= 0xdf ? 2
        : first >= 0xe0 && first <= 0xef ? 3
          : first >= 0xf0 && first <= 0xf4 ? 4 : 0
      if (!size) {
        text += '\ufffd'
        index++
        continue
      }
      if (index + size > bytes.length && !final) break
      let code = first & (0x7f >> size)
      let valid = index + size <= bytes.length
      for (let offset = 1; valid && offset < size; offset++) {
        const next = bytes[index + offset]
        if ((next & 0xc0) !== 0x80) valid = false
        else code = (code << 6) | (next & 0x3f)
      }
      if (!valid || (size === 3 && code < 0x800) ||
        (size === 4 && code < 0x10000) ||
        (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) {
        text += '\ufffd'
        index++
        continue
      }
      text += String.fromCodePoint(code)
      index += size
    }
    this.pending = bytes.slice(index)
    return text
  }
}

export class ChatEventParser {
  constructor(onEvent) {
    this.onEvent = onEvent
    this.line = ''
    this.data = []
    this.afterCR = false
    this.started = false
    this.finished = false
    this.eventCount = 0
  }

  push(text) {
    if (this.finished || !text) return
    if (!this.started) {
      this.started = true
      text = text.replace(/^\uFEFF/, '')
    }
    for (const character of text) {
      if (character === '\n' && this.afterCR) {
        this.afterCR = false
        continue
      }
      this.afterCR = character === '\r'
      if (character === '\n' || character === '\r') {
        this.consumeLine(this.line)
        this.line = ''
      } else {
        this.line += character
      }
    }
  }

  consumeLine(line) {
    if (!line) return this.dispatch()
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    if (field !== 'data') return
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    this.data.push(value)
  }

  dispatch() {
    if (!this.data.length) return
    const data = this.data.join('\n')
    this.data = []
    if (!data.trim() || data.trim() === '[DONE]') return
    let event
    try {
      event = JSON.parse(data)
    } catch {
      throw new Error('服务返回了无法解析的聊天数据')
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new Error('服务返回了无效的聊天事件')
    }
    this.eventCount++
    this.onEvent(event)
  }

  finish() {
    if (this.finished) return
    this.finished = true
    if (this.line) this.consumeLine(this.line)
    this.line = ''
    this.dispatch()
  }
}
