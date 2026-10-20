import { ChatEventParser, Utf8Decoder } from './stream.mjs'

const env = import.meta.env || {}
const isH5 = env.UNI_PLATFORM === 'h5' || (
  typeof window !== 'undefined' && typeof document !== 'undefined'
)

export const API_BASE = (env.VITE_API_BASE || (
  isH5 ? '/api' : 'http://localhost:3001/api'
)).replace(/\/+$/, '')
export const AUTH_TOKEN_KEY = 'anythingllm_authToken'

function apiError(message, status = 0) {
  const error = message instanceof Error ? message : new Error(String(message))
  error.status = Number(status) || error.status || 0
  return error
}

function responseError(body, status) {
  let message = body?.error || body?.message
  if (typeof message !== 'string') {
    if (status === 401 || status === 403) message = '身份验证失败，请使用已登录账户的访问令牌'
    else if (status) message = `请求失败（HTTP ${status}）`
    else message = '无法连接服务，请检查服务是否已启动'
  }
  return apiError(message, status)
}

function authToken() {
  let token = ''
  try {
    token = typeof uni !== 'undefined' ? uni.getStorageSync(AUTH_TOKEN_KEY) : ''
  } catch {}
  if (!token && isH5) {
    try {
      token = globalThis.localStorage?.getItem(AUTH_TOKEN_KEY) || ''
    } catch {}
  }
  return typeof token === 'string' && token ? token : env.VITE_AUTH_TOKEN || ''
}

function headers(stream = false) {
  const token = authToken()
  const result = { 'Content-Type': 'application/json', 'X-Language': 'zh-CN' }
  if (stream) result.Accept = 'text/event-stream'
  if (token) result.Authorization = `Bearer ${token}`
  try {
    result['X-Timezone'] = Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {}
  return result
}

function parseJson(text, status = 200) {
  if (text && typeof text === 'object') return text
  try {
    return JSON.parse(text)
  } catch {
    throw apiError(`服务返回了无效的 JSON 数据（HTTP ${status}）`, status)
  }
}

function workspacePath(workspaceSlug, threadSlug = null) {
  if (!workspaceSlug) throw apiError('请先选择工作区')
  let path = `/workspace/${encodeURIComponent(workspaceSlug)}`
  if (threadSlug) path += `/thread/${encodeURIComponent(threadSlug)}`
  return path
}

async function jsonRequest(path, method = 'GET') {
  if (isH5) {
    let response
    try {
      response = await fetch(`${API_BASE}${path}`, { method, headers: headers() })
    } catch (error) {
      throw apiError(error.message || '无法连接服务，请检查服务是否已启动')
    }
    const text = await response.text()
    let body
    try {
      body = parseJson(text, response.status)
    } catch (error) {
      if (!response.ok) throw responseError(null, response.status)
      throw error
    }
    if (!response.ok || body?.error || body?.success === false) {
      throw responseError(body, response.status)
    }
    return body
  }
  return new Promise((resolve, reject) => {
    uni.request({
      url: `${API_BASE}${path}`,
      method,
      header: headers(),
      success(response) {
        try {
          const body = parseJson(response.data, response.statusCode)
          if (response.statusCode < 200 || response.statusCode >= 300 ||
            body?.error || body?.success === false) {
            throw responseError(body, response.statusCode)
          }
          resolve(body)
        } catch (error) {
          reject(apiError(error, response.statusCode))
        }
      },
      fail(error) {
        reject(apiError(error.errMsg || '无法连接服务，请检查服务是否已启动'))
      },
    })
  })
}

export async function getWorkspaces() {
  const result = await jsonRequest('/workspaces')
  return Array.isArray(result.workspaces) ? result.workspaces : []
}

export async function getThreads(workspaceSlug) {
  const result = await jsonRequest(`${workspacePath(workspaceSlug)}/threads`)
  return Array.isArray(result.threads) ? result.threads : []
}

export async function createThread(workspaceSlug) {
  const result = await jsonRequest(`${workspacePath(workspaceSlug)}/thread/new`, 'POST')
  if (!result.thread) throw responseError(result, 200)
  return result.thread
}

export function normalizeHistory(history) {
  if (!Array.isArray(history)) return []
  return history.flat().filter((item) => item && (
    item.role === 'user' || item.role === 'assistant'
  )).map((item, index) => ({
    id: `${item.chatId ?? item.id ?? index}-${item.role}`,
    role: item.role,
    content: typeof item.content === 'string' ? item.content : '',
    sources: Array.isArray(item.sources) ? item.sources : [],
    ...(item.error ? { error: item.error } : {}),
  }))
}

export async function getHistory(workspaceSlug, threadSlug = null) {
  const result = await jsonRequest(`${workspacePath(workspaceSlug, threadSlug)}/chats`)
  return normalizeHistory(result.history)
}

function streamConsumer(onEvent, context) {
  const decoder = new Utf8Decoder()
  let rawText = ''
  const parser = new ChatEventParser((event) => {
    if (context.aborted()) return
    onEvent?.(event)
    if (event.type === 'abort' || event.error) {
      throw responseError(event, context.status())
    }
  })
  return {
    push(data) {
      const text = typeof data === 'string' ? data : decoder.decode(data)
      rawText += text
      parser.push(text)
    },
    finish(status, fallbackData) {
      // Most uni runtimes also return the complete response in success.data. Once
      // chunk callbacks ran it must not be parsed again or tokens are duplicated.
      if (!rawText && fallbackData !== undefined && fallbackData !== null) {
        if (typeof fallbackData === 'object' && !(fallbackData instanceof ArrayBuffer) &&
          !ArrayBuffer.isView(fallbackData)) {
          if (status < 200 || status >= 300 || fallbackData.error) {
            throw responseError(fallbackData, status)
          }
          throw apiError('服务未返回聊天事件流', status)
        }
        this.push(fallbackData)
      }
      const remaining = decoder.decode(undefined, true)
      rawText += remaining
      parser.push(remaining)
      if (status < 200 || status >= 300) {
        let body
        try { body = JSON.parse(rawText) } catch {}
        throw responseError(body, status)
      }
      parser.finish()
      if (!parser.eventCount && !context.aborted()) {
        let body
        try { body = JSON.parse(rawText) } catch {}
        if (body?.error || body?.message) throw responseError(body, status)
        throw apiError('服务未返回聊天事件流，请检查接口地址', status)
      }
    },
  }
}

async function fetchStream(url, data, onEvent, context) {
  const controller = new AbortController()
  context.setAbort(() => controller.abort())
  const response = await fetch(url, {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify(data),
    signal: controller.signal,
  })
  context.setStatus(response.status)
  if (!response.ok || !(response.headers.get('content-type') || '').includes('text/event-stream')) {
    let body
    try { body = JSON.parse(await response.text()) } catch {}
    if (!response.ok || body?.error || body?.message) throw responseError(body, response.status)
    throw apiError('服务未返回聊天事件流，请检查接口地址', response.status)
  }
  const consumer = streamConsumer(onEvent, context)
  if (!response.body?.getReader) {
    consumer.finish(response.status, await response.text())
    return
  }
  const reader = response.body.getReader()
  try {
    while (!context.aborted()) {
      const { done, value } = await reader.read()
      if (done) break
      if (!context.aborted()) consumer.push(value)
    }
    if (!context.aborted()) consumer.finish(response.status)
  } catch (error) {
    controller.abort()
    throw error
  } finally {
    reader.releaseLock()
  }
}

function uniStream(url, data, onEvent, context) {
  return new Promise((resolve, reject) => {
    let task
    let done = false
    let receivedChunks = false
    const consumer = streamConsumer(onEvent, context)
    const succeed = () => {
      if (done) return
      done = true
      resolve()
    }
    const fail = (error) => {
      if (done) return
      done = true
      if (context.aborted()) resolve()
      else reject(apiError(error instanceof Error ? error : error.errMsg || '聊天连接中断', context.status()))
    }
    task = uni.request({
      url,
      method: 'POST',
      header: headers(true),
      data: JSON.stringify(data),
      enableChunked: true,
      responseType: 'arraybuffer',
      dataType: 'text',
      timeout: 300000,
      success(response) {
        if (done || context.aborted()) return succeed()
        try {
          context.setStatus(response.statusCode)
          consumer.finish(response.statusCode, receivedChunks ? undefined : response.data)
          succeed()
        } catch (error) { fail(error) }
      },
      fail,
    })
    context.setAbort(() => {
      // Resolve before abort() because some runtimes call fail synchronously.
      succeed()
      task?.abort()
    })
    task?.onHeadersReceived?.((response) => {
      if (response.statusCode) context.setStatus(response.statusCode)
    })
    task?.onChunkReceived?.(({ data: chunk }) => {
      if (done || context.aborted()) return
      receivedChunks = true
      try {
        consumer.push(chunk)
      } catch (error) {
        fail(error)
        task.abort()
      }
    })
  })
}

/**
 * Starts one POST request. It never retries a prompt automatically.
 * Cancel resolves with { aborted: true }; server and transport errors reject an
 * Error carrying status (0 for network errors). onEvent receives raw SSE JSON.
 */
export function streamChat({ workspaceSlug, threadSlug = null, message, onEvent }) {
  let aborted = false
  let status = 0
  let stopTransport = () => {}
  let settled = false
  let resolvePromise
  let rejectPromise
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  const context = {
    aborted: () => aborted,
    status: () => status,
    setStatus: (value) => { status = value },
    setAbort(callback) {
      stopTransport = callback
      if (aborted) callback()
    },
  }
  const complete = (error) => {
    if (settled) return
    settled = true
    if (error && !aborted) rejectPromise(apiError(error, status))
    else resolvePromise({ aborted })
  }
  Promise.resolve().then(async () => {
    if (aborted) return
    if (typeof message !== 'string' || !message.trim()) throw apiError('请输入消息内容')
    const path = workspacePath(workspaceSlug, threadSlug)
    const data = { message, mode: 'chat', attachments: [], reasoningEffort: null }
    const transport = isH5 ? fetchStream : uniStream
    await transport(`${API_BASE}${path}/stream-chat`, data, onEvent, context)
  }).then(() => complete(), complete)

  return {
    promise,
    abort() {
      if (settled) return
      aborted = true
      stopTransport()
      complete()
    },
  }
}

function uploadHeaders() {
  const result = headers()
  // The browser/uni runtime must supply the multipart boundary itself.
  delete result['Content-Type']
  return result
}

function uploadResult(data, status) {
  let body
  try {
    body = parseJson(data, status)
  } catch (error) {
    if (status < 200 || status >= 300) throw responseError(null, status)
    throw error
  }
  if (status < 200 || status >= 300 || body?.success !== true || body?.error) {
    throw responseError(body, status)
  }
  if (!body.document || !(body.document.id || body.document.location)) {
    throw apiError('服务未返回已建立索引的文档信息', status)
  }
  return body
}

async function browserUpload(url, file, context) {
  let blob = file.file || file
  if (!(blob instanceof Blob)) {
    const path = file.path || file.tempFilePath
    if (!path) throw apiError('无法读取选中的文件，请重新选择')
    const controller = new AbortController()
    context.setAbort(() => controller.abort())
    const response = await fetch(path, { signal: controller.signal })
    if (!response.ok) throw apiError('无法读取选中的文件，请重新选择')
    blob = await response.blob()
  }
  if (context.aborted()) return

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    let done = false
    const finish = (error, result) => {
      if (done) return
      done = true
      if (error) reject(error)
      else resolve(result)
    }
    xhr.open('POST', url)
    xhr.timeout = 300000
    for (const [name, value] of Object.entries(uploadHeaders())) {
      xhr.setRequestHeader(name, value)
    }
    xhr.upload.onprogress = (event) => {
      if (done || context.aborted()) return
      context.progress(event.loaded, event.lengthComputable ? event.total : 0)
    }
    xhr.upload.onload = () => {
      if (!done && !context.aborted()) context.progress(file.size || blob.size, file.size || blob.size, 100)
    }
    xhr.onload = () => {
      if (done || context.aborted()) return
      context.setStatus(xhr.status)
      try { finish(null, uploadResult(xhr.responseText, xhr.status)) }
      catch (error) { finish(error) }
    }
    xhr.onerror = () => finish(apiError('文件上传连接中断，请检查网络后重试'))
    xhr.ontimeout = () => finish(apiError('文件上传或处理超时，请检查工作区资料后再重试'))
    xhr.onabort = () => finish(null)
    context.setAbort(() => {
      finish(null)
      xhr.abort()
    })
    const data = new FormData()
    data.append('originalName', file.name)
    data.append('file', blob, file.name)
    xhr.send(data)
  })
}

function uniUpload(url, file, context) {
  const filePath = file.path || file.tempFilePath
  if (!filePath) throw apiError('无法读取选中的文件，请重新选择')
  return new Promise((resolve, reject) => {
    let task
    let done = false
    const finish = (error, result) => {
      if (done) return
      done = true
      if (error) reject(error)
      else resolve(result)
    }
    task = uni.uploadFile({
      url,
      filePath,
      name: 'file',
      formData: { originalName: file.name },
      header: uploadHeaders(),
      timeout: 300000,
      success(response) {
        if (done || context.aborted()) return
        context.setStatus(response.statusCode)
        try { finish(null, uploadResult(response.data, response.statusCode)) }
        catch (error) { finish(error) }
      },
      fail(error) {
        if (context.aborted()) finish(null)
        else finish(apiError(error.errMsg || '文件上传失败，请检查网络后重试'))
      },
    })
    context.setAbort(() => {
      finish(null)
      task?.abort()
    })
    task?.onProgressUpdate?.((event) => {
      if (done || context.aborted()) return
      context.progress(event.totalBytesSent, event.totalBytesExpectedToSend, event.progress)
    })
  })
}

/**
 * Uploads one file and waits for parsing + indexing in the selected workspace.
 * Progress describes network upload only; 100 is not an indexing completion.
 * Cancel stops the client request but cannot undo work already on the server.
 */
export function uploadAndEmbed({ workspaceSlug, file, onProgress }) {
  let aborted = false
  let settled = false
  let status = 0
  let stopTransport = () => {}
  let resolvePromise
  let rejectPromise
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  const context = {
    aborted: () => aborted,
    setStatus: (value) => { status = value },
    setAbort(callback) {
      stopTransport = callback
      if (aborted) callback()
    },
    progress(sent, total, reportedProgress) {
      if (aborted || settled) return
      sent = Math.max(0, Number(sent) || 0)
      total = Math.max(0, Number(total) || 0)
      const value = Number.isFinite(reportedProgress)
        ? reportedProgress : total > 0 ? (sent / total) * 100 : 0
      onProgress?.({ progress: Math.min(100, Math.max(0, value)), sent, total })
    },
  }
  const complete = (error, result) => {
    if (settled) return
    settled = true
    if (aborted) resolvePromise({ aborted: true })
    else if (error) rejectPromise(apiError(error, status))
    else resolvePromise({ aborted: false, document: result.document,
      ...(Array.isArray(result.documents) ? { documents: result.documents } : {}) })
  }
  Promise.resolve().then(async () => {
    if (aborted) return
    const path = `${workspacePath(workspaceSlug)}/upload-and-embed`
    if (!file || typeof file.name !== 'string' || !file.name.trim()) {
      throw apiError('请选择一个有文件名的文件')
    }
    return (isH5 ? browserUpload : uniUpload)(`${API_BASE}${path}`, file, context)
  }).then((result) => complete(null, result), (error) => complete(error))

  return {
    promise,
    abort() {
      if (settled) return
      aborted = true
      stopTransport()
      complete()
    },
  }
}
