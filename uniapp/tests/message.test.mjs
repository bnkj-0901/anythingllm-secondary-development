import test from 'node:test'
import assert from 'node:assert/strict'
import { inlineNodes, normalizeSources, parseMessageContent } from '../src/utils/messageContent.js'

function textOf(nodes) {
  return nodes.map((node) => node.text || textOf(node.children || [])).join('')
}

test('model HTML and unsafe links stay text instead of executable rich-text nodes', () => {
  const input = '<img src=x onerror=alert(1)> [打开](javascript:alert) **重点**'
  const nodes = inlineNodes(input)
  assert(textOf(nodes).includes('<img src=x onerror=alert(1)>'))
  assert(textOf(nodes).includes('打开'))
  assert(textOf(nodes).includes('重点'))
  const inspect = (items) => items.forEach((node) => {
    assert(!['script', 'img', 'iframe', 'a'].includes(node.name))
    assert(!node.attrs?.href && !node.attrs?.src && !node.attrs?.onclick)
    inspect(node.children || [])
  })
  inspect(nodes)
})

test('an unfinished streaming code block preserves code without interpreting its contents', () => {
  const blocks = parseMessageContent('回答：\n\n```html\n<script>alert("你好")</script>')
  const code = blocks.find((block) => block.type === 'code')
  assert.equal(code.content, '<script>alert("你好")</script>')
  assert.equal(code.language, 'html')
})

test('common Markdown retains headings, list items and Chinese inline text', () => {
  const blocks = parseMessageContent('## 关键结论\n\n1. **第一点**\n2. 使用 `代码`\n\n> 引用内容')
  assert(blocks.some((block) => block.type === 'heading' && textOf(block.nodes) === '关键结论'))
  const list = blocks.find((block) => block.type === 'list')
  assert.deepEqual(list.items.map((item) => textOf(item.nodes)), ['第一点', '使用 代码'])
  assert(blocks.some((block) => block.type === 'quote' && textOf(block.nodes) === '引用内容'))
})

test('retrieval sources tolerate absent fields and keep long excerpts bounded', () => {
  const sources = normalizeSources([null, { metadata: { title: '知识库文档', text: '文'.repeat(2000) } }, {}])
  assert.equal(sources.length, 2)
  assert.equal(sources[0].title, '知识库文档')
  assert.equal(sources[0].summary.length, 1600)
  assert.equal(sources[0].truncated, true)
  assert(sources[1].title.length > 0)
  assert.equal(sources[1].summary, '')
})

test("history sources preserve citation numbers after earlier documents are removed", () => {
  const sources = normalizeSources([
    { title: "剩余来源", text: "当前可读的原文", citationNumber: 2 },
  ]);
  assert.equal(sources[0].citationNumber, 2);
  assert.equal(normalizeSources([{ title: "旧来源" }])[0].citationNumber, 1);
});
