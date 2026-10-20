import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { ChatEventParser, Utf8Decoder } from '../src/services/stream.mjs'

// Import both platform branches once without bringing in a DOM implementation.
globalThis.window = {}
globalThis.document = {}
const web = await import('../src/services/chat.js?test=h5')
delete globalThis.window
delete globalThis.document
const native = await import('../src/services/chat.js?test=native')
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  delete globalThis.uni
  delete globalThis.localStorage
})

const encode = (value) => new TextEncoder().encode(value)
const eventText = (value) => `data: ${JSON.stringify(value)}\r\n\r\n`
const tick = () => new Promise((resolve) => setImmediate(resolve))
const answer = { type: 'textResponseChunk', textResponse: '你好，世界🌏', close: false }
const final = { type: 'finalizeResponseStream', close: true, chatId: 12 }

test('UTF-8 and SSE preserve Chinese/emoji at every possible byte boundary', () => {
  const bytes = encode(`\uFEFF: heartbeat\r\n${eventText(answer)}${eventText(final)}`)
  for (let split = 0; split <= bytes.length; split++) {
    const events = []
    const decoder = new Utf8Decoder()
    const parser = new ChatEventParser((event) => events.push(event))
    parser.push(decoder.decode(bytes.slice(0, split)))
    parser.push(decoder.decode(bytes.slice(split)))
    parser.push(decoder.decode(undefined, true))
    parser.finish()
    parser.finish()
    assert.deepEqual(events, [answer, final], `split at ${split}`)
  }
})

test('SSE supports individual bytes, multiline data and final frame without newline', () => {
  const events = []
  const decoder = new Utf8Decoder()
  const parser = new ChatEventParser((event) => events.push(event))
  const text = 'event: message\r\ndata: {"type":"textResponse",\r\ndata: "textResponse":"中文"}\r\n\r\ndata: [DONE]\n\ndata: {"close":true}'
  for (const byte of encode(text)) parser.push(decoder.decode(new Uint8Array([byte])))
  parser.push(decoder.decode(undefined, true))
  parser.finish()
  assert.deepEqual(events, [
    { type: 'textResponse', textResponse: '中文' },
    { close: true },
  ])
})

test('SSE rejects malformed JSON instead of silently dropping content', () => {
  const parser = new ChatEventParser(() => {})
  assert.throws(() => parser.push('data: {broken}\n\n'), /无法解析/)
})

test('history maps shared chat IDs to unique stable role IDs', () => {
  assert.deepEqual(native.normalizeHistory([
    { chatId: 3, role: 'user', content: '提问' },
    { chatId: 3, role: 'assistant', content: '回答', sources: [{ title: '知识库' }] },
    { role: 'system', content: 'hidden' },
  ]), [
    { id: '3-user', role: 'user', content: '提问', sources: [] },
    { id: '3-assistant', role: 'assistant', content: '回答', sources: [{ title: '知识库' }] },
  ])
})

test('H5 streams incrementally with localStorage authentication and encoded thread path', async () => {
  let release
  let request
  globalThis.localStorage = { getItem: () => 'session-token' }
  globalThis.fetch = async (url, options) => {
    request = { url, options }
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encode(eventText(answer)))
        release = () => {
          controller.enqueue(encode(eventText(final)))
          controller.close()
        }
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } })
  }
  const events = []
  const stream = web.streamChat({ workspaceSlug: '工作区', threadSlug: 'thread/a', message: '你好', onEvent: (event) => events.push(event) })
  assert.equal(typeof stream.abort, 'function')
  await tick()
  assert.deepEqual(events, [answer], 'first chunk is visible before HTTP completion')
  release()
  assert.deepEqual(await stream.promise, { aborted: false })
  assert.deepEqual(events, [answer, final])
  assert.equal(request.url, '/api/workspace/%E5%B7%A5%E4%BD%9C%E5%8C%BA/thread/thread%2Fa/stream-chat')
  assert.equal(request.options.headers.Authorization, 'Bearer session-token')
  assert.deepEqual(JSON.parse(request.options.body), { message: '你好', mode: 'chat', attachments: [], reasoningEffort: null })
})

test('H5 surfaces HTTP JSON errors once without retrying POST', async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response(JSON.stringify({ error: '登录过期' }), { status: 401, headers: { 'content-type': 'application/json' } })
  }
  const stream = web.streamChat({ workspaceSlug: 'test', message: '你好' })
  await assert.rejects(stream.promise, (error) => error.status === 401 && error.message === '登录过期')
  assert.equal(calls, 1)
})

test('H5 rejects JSON errors returned with HTTP 200', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: '模型未配置' }), { headers: { 'content-type': 'application/json' } })
  await assert.rejects(web.streamChat({ workspaceSlug: 'test', message: '你好' }).promise,
    (error) => error.status === 200 && error.message === '模型未配置')
})

test('H5 forwards server abort events and rejects with their original error', async () => {
  const aborted = { type: 'abort', error: '模型不可用', close: true }
  globalThis.fetch = async () => new Response(eventText(aborted), { headers: { 'content-type': 'text/event-stream' } })
  const events = []
  await assert.rejects(web.streamChat({ workspaceSlug: 'test', message: '你好', onEvent: (event) => events.push(event) }).promise,
    (error) => error.status === 200 && error.message === '模型不可用')
  assert.deepEqual(events, [aborted])
})

test('H5 cancelling an active fetch resolves without surfacing a network error', async () => {
  let signal
  globalThis.fetch = (_url, options) => {
    signal = options.signal
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })
  }
  const stream = web.streamChat({ workspaceSlug: 'test', message: '你好' })
  await tick()
  stream.abort()
  assert.deepEqual(await stream.promise, { aborted: true })
  assert.equal(signal.aborted, true)
})

test('cancelling immediately sends no request', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++ }
  const stream = web.streamChat({ workspaceSlug: 'test', message: '你好' })
  stream.abort()
  await stream.promise
  assert.equal(calls, 0)
})

function mockNativeRequest({ chunked = true } = {}) {
  let options
  let chunkHandler
  let headersHandler
  let aborted = false
  globalThis.uni = {
    getStorageSync: () => 'native-token',
    request(value) {
      options = value
      return {
        abort() {
          aborted = true
          options.fail({ errMsg: 'request:fail abort' })
        },
        ...(chunked ? { onChunkReceived: (callback) => { chunkHandler = callback } } : {}),
        onHeadersReceived: (callback) => { headersHandler = callback },
      }
    },
  }
  return {
    options: () => options,
    aborted: () => aborted,
    headers: (statusCode) => headersHandler({ statusCode }),
    chunk: (data) => chunkHandler({ data }),
    finish: (statusCode, data) => options.success({ statusCode, data }),
    fail: (error) => options.fail(error),
  }
}

test('uni chunked transport decodes one-byte chunks and does not replay success.data', async () => {
  const mock = mockNativeRequest()
  const events = []
  const stream = native.streamChat({ workspaceSlug: 'test', message: '你好', onEvent: (event) => events.push(event) })
  await tick()
  mock.headers(200)
  const text = eventText(answer) + eventText(final)
  for (const byte of encode(text)) mock.chunk(new Uint8Array([byte]).buffer)
  assert.deepEqual(events, [answer, final], 'events are visible before success callback')
  mock.finish(200, encode(text).buffer)
  assert.deepEqual(await stream.promise, { aborted: false })
  assert.deepEqual(events, [answer, final], 'complete response must not replay chunks')
  assert.equal(mock.options().header.Authorization, 'Bearer native-token')
  assert.equal(mock.options().url, 'http://localhost:3001/api/workspace/test/stream-chat')
  assert.deepEqual(JSON.parse(mock.options().data), { message: '你好', mode: 'chat', attachments: [], reasoningEffort: null })
})

test('uni falls back to parsing final response on platforms without chunk callbacks', async () => {
  const mock = mockNativeRequest({ chunked: false })
  const events = []
  const stream = native.streamChat({ workspaceSlug: 'test', message: '你好', onEvent: (event) => events.push(event) })
  await tick()
  mock.finish(200, encode(`data: ${JSON.stringify(answer)}`).buffer)
  await stream.promise
  assert.deepEqual(events, [answer])
})

test('uni HTTP failure decodes server JSON and preserves status', async () => {
  const mock = mockNativeRequest()
  const stream = native.streamChat({ workspaceSlug: 'test', message: '你好' })
  await tick()
  mock.headers(403)
  mock.chunk(encode('{"error":"没有权限"}').buffer)
  mock.finish(403, encode('{"error":"没有权限"}').buffer)
  await assert.rejects(stream.promise, (error) => error.status === 403 && error.message === '没有权限')
})

test('uni detects successful HTTP JSON errors and malformed SSE', async () => {
  let mock = mockNativeRequest({ chunked: false })
  let stream = native.streamChat({ workspaceSlug: 'test', message: '你好' })
  await tick()
  mock.finish(200, '{"error":"模型未配置"}')
  await assert.rejects(stream.promise, (error) => error.status === 200 && error.message === '模型未配置')

  mock = mockNativeRequest()
  stream = native.streamChat({ workspaceSlug: 'test', message: '你好' })
  await tick()
  mock.headers(200)
  mock.chunk(encode('data: broken\n\n').buffer)
  await assert.rejects(stream.promise, (error) => error.status === 200 && /无法解析/.test(error.message))
  assert.equal(mock.aborted(), true)
})

test('uni cancellation stops callbacks and resolves without request:fail abort', async () => {
  const mock = mockNativeRequest()
  const events = []
  const stream = native.streamChat({ workspaceSlug: 'test', message: '你好', onEvent: (event) => events.push(event) })
  await tick()
  stream.abort()
  mock.chunk(encode(eventText(answer)).buffer)
  mock.finish(200, eventText(answer))
  assert.deepEqual(await stream.promise, { aborted: true })
  assert.equal(mock.aborted(), true)
  assert.deepEqual(events, [])
})

test('workspace, thread and history requests use AnythingLLM application routes', async () => {
  const calls = []
  const responses = [
    { workspaces: [{ slug: 'demo' }] },
    { threads: [{ slug: 'first', name: '对话' }] },
    { thread: { slug: 'second', name: '新对话' } },
    { history: [{ role: 'assistant', content: '已有回答', chatId: 8 }] },
  ]
  globalThis.fetch = async (url, options) => {
    calls.push([url, options.method])
    return new Response(JSON.stringify(responses.shift()), { headers: { 'content-type': 'application/json' } })
  }
  assert.deepEqual(await web.getWorkspaces(), [{ slug: 'demo' }])
  assert.deepEqual(await web.getThreads('demo'), [{ slug: 'first', name: '对话' }])
  assert.deepEqual(await web.createThread('demo'), { slug: 'second', name: '新对话' })
  assert.deepEqual(await web.getHistory('demo', 'first'), [
    { id: '8-assistant', role: 'assistant', content: '已有回答', sources: [] },
  ])
  assert.deepEqual(calls, [
    ['/api/workspaces', 'GET'],
    ['/api/workspace/demo/threads', 'GET'],
    ['/api/workspace/demo/thread/new', 'POST'],
    ['/api/workspace/demo/thread/first/chats', 'GET'],
  ])
})
