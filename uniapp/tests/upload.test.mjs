import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'

globalThis.window = {}
globalThis.document = {}
const web = await import('../src/services/chat.js?upload=h5')
delete globalThis.window
delete globalThis.document
const native = await import('../src/services/chat.js?upload=native')
const originalFetch = globalThis.fetch
const originalXHR = globalThis.XMLHttpRequest

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalXHR) globalThis.XMLHttpRequest = originalXHR
  else delete globalThis.XMLHttpRequest
  delete globalThis.uni
  delete globalThis.localStorage
})

const tick = () => new Promise((resolve) => setImmediate(resolve))
const indexed = { success: true, error: null, document: { id: 'doc-1', location: 'custom-documents/doc-1.json' } }
const file = { name: '苹果种植资料.pdf', size: 64, path: 'wxfile://temporary-file' }
const isError = (status, text) => (error) => error.status === status && error.message.includes(text)

function mockNativeUpload() {
  let options
  let progress
  let aborted = false
  globalThis.uni = {
    getStorageSync: () => 'native-token',
    uploadFile(value) {
      options = value
      return {
        onProgressUpdate(callback) { progress = callback },
        abort() {
          aborted = true
          options.fail({ errMsg: 'uploadFile:fail abort' })
        },
      }
    },
  }
  return {
    options: () => options,
    aborted: () => aborted,
    progress: (value) => progress(value),
    finish: (statusCode = 200, body = indexed) => options.success({ statusCode, data: typeof body === 'string' ? body : JSON.stringify(body) }),
    fail: (errMsg) => options.fail({ errMsg }),
  }
}

function mockBrowserUpload() {
  let xhr
  globalThis.XMLHttpRequest = class {
    constructor() {
      xhr = this
      this.upload = {}
      this.headers = {}
    }
    open(method, url) { this.method = method; this.url = url }
    setRequestHeader(name, value) { this.headers[name] = value }
    send(data) { this.body = data }
    abort() { this.aborted = true; this.onabort?.() }
  }
  return {
    xhr: () => xhr,
    progress: (loaded, total) => xhr.upload.onprogress({ loaded, total, lengthComputable: total > 0 }),
    finish(status = 200, body = indexed) {
      xhr.status = status
      xhr.responseText = typeof body === 'string' ? body : JSON.stringify(body)
      xhr.onload()
    },
  }
}

test('mini-program upload preserves original filename, encoded workspace and authentication', async () => {
  const mock = mockNativeUpload()
  const upload = native.uploadAndEmbed({ workspaceSlug: '工作区/a', file })
  await tick()
  const options = mock.options()
  assert.equal(options.url, 'http://localhost:3001/api/workspace/%E5%B7%A5%E4%BD%9C%E5%8C%BA%2Fa/upload-and-embed')
  assert.equal(options.filePath, file.path)
  assert.equal(options.name, 'file')
  assert.deepEqual(options.formData, { originalName: file.name })
  assert.equal(options.header.Authorization, 'Bearer native-token')
  assert.equal(options.header['Content-Type'], undefined, 'runtime supplies the multipart boundary')
  assert.equal(options.timeout, 300000)
  mock.finish()
  assert.deepEqual(await upload.promise, { aborted: false, document: indexed.document })
})

test('upload progress reaching 100 does not resolve before server indexing succeeds', async () => {
  const mock = mockNativeUpload()
  const progress = []
  let settled = false
  const upload = native.uploadAndEmbed({ workspaceSlug: 'demo', file, onProgress: (value) => progress.push(value) })
  upload.promise.then(() => { settled = true })
  await tick()
  mock.progress({ progress: 50, totalBytesSent: 32, totalBytesExpectedToSend: 64 })
  mock.progress({ progress: 100, totalBytesSent: 64, totalBytesExpectedToSend: 64 })
  await tick()
  assert.deepEqual(progress, [{ progress: 50, sent: 32, total: 64 }, { progress: 100, sent: 64, total: 64 }])
  assert.equal(settled, false)
  mock.finish()
  await upload.promise
  mock.progress({ progress: 100, totalBytesSent: 64, totalBytesExpectedToSend: 64 })
  assert.equal(progress.length, 2, 'completed uploads stop delivering progress')
})

test('HTTP 200 embedding failures and missing document identifiers reject instead of claiming success', async () => {
  let mock = mockNativeUpload()
  let upload = native.uploadAndEmbed({ workspaceSlug: 'demo', file })
  await tick()
  mock.finish(200, { success: false, error: '向量化失败', document: null })
  await assert.rejects(upload.promise, isError(200, '向量化失败'))

  mock = mockNativeUpload()
  upload = native.uploadAndEmbed({ workspaceSlug: 'demo', file })
  await tick()
  mock.finish(200, { success: true, document: {} })
  await assert.rejects(upload.promise, isError(200, '文档信息'))
})

test('native upload surfaces HTTP, invalid JSON and transport errors with no retry', async () => {
  for (const [status, body, expected] of [
    [403, { error: '无权上传' }, '无权上传'],
    [500, 'Internal Server Error', 'HTTP 500'],
    [200, 'broken JSON', '无效的 JSON'],
  ]) {
    const mock = mockNativeUpload()
    const upload = native.uploadAndEmbed({ workspaceSlug: 'demo', file })
    await tick()
    mock.finish(status, body)
    await assert.rejects(upload.promise, isError(status, expected))
  }
  const mock = mockNativeUpload()
  const upload = native.uploadAndEmbed({ workspaceSlug: 'demo', file })
  await tick()
  mock.fail('uploadFile:fail timeout')
  await assert.rejects(upload.promise, isError(0, 'timeout'))
})

test('cancelling mini-program upload resolves immediately and ignores late callbacks', async () => {
  const mock = mockNativeUpload()
  const progress = []
  const upload = native.uploadAndEmbed({ workspaceSlug: 'demo', file, onProgress: (value) => progress.push(value) })
  await tick()
  upload.abort()
  assert.deepEqual(await upload.promise, { aborted: true })
  assert.equal(mock.aborted(), true)
  mock.progress({ progress: 100, totalBytesSent: 64, totalBytesExpectedToSend: 64 })
  mock.finish()
  assert.deepEqual(progress, [])
})

test('H5 sends actual file bytes with the original name as browser-generated multipart', async () => {
  const mock = mockBrowserUpload()
  const progress = []
  globalThis.localStorage = { getItem: () => 'browser-token' }
  const blob = new Blob(['实际文件内容'], { type: 'application/pdf' })
  const upload = web.uploadAndEmbed({ workspaceSlug: 'demo/a', file: { ...file, file: blob }, onProgress: (value) => progress.push(value) })
  await tick()
  const xhr = mock.xhr()
  assert.equal(xhr.method, 'POST')
  assert.equal(xhr.url, '/api/workspace/demo%2Fa/upload-and-embed')
  assert.equal(xhr.timeout, 300000)
  assert.equal(xhr.headers.Authorization, 'Bearer browser-token')
  assert.equal(xhr.headers['Content-Type'], undefined)
  assert.equal(xhr.body.get('originalName'), file.name)
  const attachment = xhr.body.get('file')
  assert.equal(attachment.name, file.name)
  assert.equal(await attachment.text(), '实际文件内容')
  mock.progress(32, 64)
  xhr.upload.onload()
  assert.equal(progress[0].progress, 50)
  assert.equal(progress.at(-1).progress, 100)
  mock.finish(200, { ...indexed, documents: [indexed.document] })
  assert.deepEqual(await upload.promise, { aborted: false, document: indexed.document, documents: [indexed.document] })
})

test('H5 can load a selected blob URL when uni does not expose the native File', async () => {
  const mock = mockBrowserUpload()
  globalThis.fetch = async (url) => {
    assert.equal(url, 'blob:chosen-file')
    return new Response(new Blob(['blob URL 内容']))
  }
  const upload = web.uploadAndEmbed({ workspaceSlug: 'demo', file: { name: '资料.txt', path: 'blob:chosen-file' } })
  await tick()
  assert.equal(await mock.xhr().body.get('file').text(), 'blob URL 内容')
  mock.finish()
  await upload.promise
})

test('H5 rejects indexing failure and timeout, and supports cancel without late progress', async () => {
  let mock = mockBrowserUpload()
  let upload = web.uploadAndEmbed({ workspaceSlug: 'demo', file: { name: '资料.txt', file: new Blob(['text']) } })
  await tick()
  mock.finish(200, { success: false, error: '解析失败' })
  await assert.rejects(upload.promise, isError(200, '解析失败'))

  mock = mockBrowserUpload()
  upload = web.uploadAndEmbed({ workspaceSlug: 'demo', file: { name: '资料.txt', file: new Blob(['text']) } })
  await tick()
  mock.xhr().ontimeout()
  await assert.rejects(upload.promise, isError(0, '超时'))

  mock = mockBrowserUpload()
  const progress = []
  upload = web.uploadAndEmbed({ workspaceSlug: 'demo', file: { name: '资料.txt', file: new Blob(['text']) }, onProgress: (value) => progress.push(value) })
  await tick()
  upload.abort()
  assert.deepEqual(await upload.promise, { aborted: true })
  assert.equal(mock.xhr().aborted, true)
  mock.progress(5, 5)
  mock.finish()
  assert.deepEqual(progress, [])
})

test('immediate cancellation sends no upload and validation errors preserve the request boundary', async () => {
  const mock = mockNativeUpload()
  const upload = native.uploadAndEmbed({ workspaceSlug: 'demo', file })
  upload.abort()
  assert.deepEqual(await upload.promise, { aborted: true })
  await tick()
  assert.equal(mock.options(), undefined)
  await assert.rejects(native.uploadAndEmbed({ workspaceSlug: '', file }).promise, /请先选择工作区/)
  await assert.rejects(native.uploadAndEmbed({ workspaceSlug: 'demo', file: { path: 'tmp' } }).promise, /文件名/)
  assert.equal(mock.options(), undefined)
})
