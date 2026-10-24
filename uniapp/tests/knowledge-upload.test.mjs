import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ref, computed, markRaw } from 'vue'
import { uploadKnowledgeFile } from '../src/services/knowledgeUpload.mjs'

const tick = () => new Promise((resolve) => setImmediate(resolve))
const file = { name: '规则.pdf', size: 64, path: 'wxfile://temporary' }
const processing = { document: { id: 'doc-1', status: 'processing' } }
const ready = { document: { id: 'doc-1', status: 'ready' } }

test('public upload submits approval without polling or publishing a document', async () => {
  let reads=0, published=0
  const request=uploadKnowledgeFile({api:{upload:async()=>({approvalRequired:true,change:{id:'change-1'}}),document:async()=>{reads++;return ready}},libraryId:'public',file,onDocument(){published++}})
  assert.deepEqual(await request.promise,{approvalRequired:true,change:{id:'change-1'}})
  assert.equal(reads,0)
  assert.equal(published,0)
  await assert.rejects(uploadKnowledgeFile({api:{upload:async()=>({approvalRequired:true})},libraryId:'public',file}).promise,/审批申请/)
})

test('100 percent transport progress and upload acceptance wait for actual index readiness', async () => {
  const progress = [], ids = []
  let finishUpload, finishIndex
  let indexRequested
  const indexing = new Promise((resolve) => { indexRequested = resolve })
  let settled = false
  const request = uploadKnowledgeFile({
    api: {
      upload(libraryId, original, notify) {
        assert.equal(libraryId, 'lib-1')
        assert.equal(original, file)
        notify({ progress: 100 })
        return new Promise((resolve) => { finishUpload = resolve })
      },
      document(id) {
        assert.equal(id, 'doc-1')
        return new Promise((resolve) => { finishIndex = resolve; indexRequested() })
      },
    },
    libraryId: 'lib-1', file, pollInterval: 0,
    onProgress: (event) => progress.push(event.progress),
    onDocument: (id) => ids.push(id),
  })
  request.promise.then(() => { settled = true })
  assert.deepEqual(progress, [100])
  assert.equal(settled, false)
  finishUpload(processing)
  await indexing
  assert.deepEqual(ids, ['doc-1'])
  assert.equal(settled, false)
  finishIndex(ready)
  assert.deepEqual(await request.promise, ready)
})

test('index failure retains the document id and retries the existing document without duplicate upload', async () => {
  const original = { ...file }
  let uploads = 0, retries = 0
  const api = {
    async upload() { uploads++; return processing },
    async document() { return { document: { id: 'doc-1', status: 'failed', error: '嵌入服务暂不可用' } } },
    async retryDocument(id) { assert.equal(id, 'doc-1'); retries++; return ready },
  }
  const first = uploadKnowledgeFile({ api, libraryId: 'lib', file: original, pollInterval: 0, onDocument(id) { original.documentId = id } })
  await assert.rejects(first.promise, /嵌入服务暂不可用/)
  assert.equal(original.documentId, 'doc-1')
  const retry = uploadKnowledgeFile({ api, libraryId: 'lib', file: original })
  assert.deepEqual(await retry.promise, ready)
  assert.equal(uploads, 1)
  assert.equal(retries, 1)
})

test('cancel aborts only the active transport and prevents late index publication', async () => {
  let resolveUpload, aborted = 0, observed = 0
  const pending = new Promise((resolve) => { resolveUpload = resolve })
  pending.cancel = () => { aborted++ }
  const request = uploadKnowledgeFile({ api: { upload: () => pending }, libraryId: 'lib', file, onDocument() { observed++ } })
  request.abort()
  await assert.rejects(request.promise, (error) => error.cancelled === true)
  resolveUpload(ready)
  await tick()
  assert.equal(aborted, 1)
  assert.equal(observed, 0)
})

test('unknown status, mismatched document, missing ids and index timeout never report success', async () => {
  for (const [accepted, polled, expected] of [
    [{ document: {} }, ready, /有效的资料/],
    [{ document: { id: 'doc-1', status: 'pending' } }, ready, /未知/],
    [processing, { document: { id: 'doc-2', status: 'ready' } }, /不一致/],
  ]) {
    const request = uploadKnowledgeFile({ api: { upload: async () => accepted, document: async () => polled }, libraryId: 'lib', file, pollInterval: 0 })
    await assert.rejects(request.promise, expected)
  }
  const request = uploadKnowledgeFile({ api: { upload: async () => processing }, libraryId: 'lib', file, timeout: 0 })
  await assert.rejects(request.promise, /处理仍未完成/)
})

function queueHarness(api) {
  const source = readFileSync(new URL('../src/components/ChatUpload.vue', import.meta.url), 'utf8')
    .split('<script setup>')[1].split('</script>')[0].replace(/^import .*;\r?\n/gm, '')
  const props = { api, libraryId: 'lib-1', libraryName: '资料', disabled: false, fileTypes: { extensions: ['.pdf', '.txt'], maxFileSizeBytes: 1000 } }
  const emitted = [], notices = [], watches = [], cleanups = []
  const evaluate = new Function('inject', 'computed', 'markRaw', 'onUnmounted', 'ref', 'watch', 'uploadKnowledgeFile', 'uni', 'defineProps', 'defineEmits', 'defineOptions', source + '\nreturn { files, addFiles, uploadFiles, resetQueue, readyCount, completedCount, completedNotice }')
  const queue = evaluate(() => api, computed, markRaw, (callback) => cleanups.push(callback), ref, (getter, callback) => watches.push(callback), (options) => uploadKnowledgeFile({ ...options, pollInterval: 0 }), { showToast: (value) => notices.push(value) }, () => props, () => (...event) => emitted.push(event), () => {})
  return { ...queue, props, emitted, notices, watches, cleanups }
}

test('the original queue caps at five valid files using server formats and size limits', () => {
  const h = queueHarness({})
  h.addFiles({ tempFiles: [{ ...file, name: '不支持.exe' }, { ...file, size: 1001 }, ...Array.from({ length: 6 }, (_, i) => ({ ...file, name: `规则${i}.pdf` }))] })
  assert.equal(h.files.value.length, 5)
  assert.equal(h.readyCount.value, 5)
  assert.equal(h.notices.length, 2)
})

test('five-file queue uploads sequentially, preserves failed rows and retries individual ids', async () => {
  let active = 0, maximum = 0, uploads = 0, retries = 0
  const h = queueHarness({
    async upload(libraryId, original, progress) {
      active++; maximum = Math.max(maximum, active); uploads++
      assert.equal(libraryId, 'lib-1')
      progress({ progress: 50 })
      await tick()
      active--
      return { document: { id: original.name, status: original.name === '失败.pdf' ? 'failed' : 'ready', error: '解析失败' } }
    },
    async retryDocument(id) { retries++; assert.equal(id, '失败.pdf'); return { document: { id, status: 'ready' } } },
  })
  h.addFiles({ tempFiles: [{ ...file, name: '成功.pdf' }, { ...file, name: '失败.pdf' }] })
  await h.uploadFiles()
  assert.equal(maximum, 1)
  assert.deepEqual(h.files.value.map((row) => row.status), ['success', 'error'])
  assert.equal(h.files.value[1].documentId, '失败.pdf')
  await h.uploadFiles(h.files.value[1].id)
  assert.deepEqual(h.files.value.map((row) => row.status), ['success', 'success'])
  assert.equal(uploads, 2)
  assert.equal(retries, 1)
  assert.equal(h.completedCount.value, 2)
})

test('switching library clears the original queue, aborts its request and ignores stale callbacks', async () => {
  let resolveUpload, aborted = false
  const pending = new Promise((resolve) => { resolveUpload = resolve })
  pending.cancel = () => { aborted = true }
  const h = queueHarness({ upload: () => pending })
  h.addFiles({ tempFiles: [file] })
  const uploading = h.uploadFiles()
  h.props.libraryId = 'lib-2'
  h.resetQueue()
  resolveUpload(ready)
  await uploading
  assert.equal(aborted, true)
  assert.deepEqual(h.files.value, [])
  assert.equal(h.emitted.some(([name]) => name === 'uploaded'), false)
})

test('public pending uploads are counted as awaiting approval instead of ready for questions', async () => {
  const h = queueHarness({
    async upload() { return { approvalRequired: true, change: { id: 'change-1', status: 'pending' } } },
  })
  h.addFiles({ tempFiles: [file] })
  await h.uploadFiles()
  assert.equal(h.completedCount.value, 1)
  assert.equal(h.completedNotice.value, '1 个文件等待管理员审批')
  h.files.value.push({ status: 'success', approvalRequired: false })
  assert.equal(h.completedNotice.value, '1 个文件已可用于问答，1 个文件等待管理员审批')
})
