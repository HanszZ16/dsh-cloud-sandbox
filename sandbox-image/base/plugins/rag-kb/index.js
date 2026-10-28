/**
 * Knowledge base plugin, host face: the model tools (knowledge_search,
 * knowledge_status, knowledge_manage), the system prompt section, and the
 * authenticated routes behind the Knowledge base side panel (./client.js).
 *
 * Forked from @puwenhui/dsh-rag-kb 0.3.1 (MIT) for dsh-cloud; see README.md
 * for what changed. Written as plain ESM so the image ships it without a
 * build step.
 *
 * Every source file is read through dsh's filesystem service (ctx.fs), with
 * the Session's working directory for relative paths. Uploads are written to
 * `knowledgeDir`, which is also watched: files put there in other ways (the
 * Files panel, the agent, a terminal) are indexed, and removing one removes
 * its document. Indexing runs one document at a time.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, watch } from 'node:fs'
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join, resolve, sep } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { chunkText, extractText, Models, SUPPORTED_EXTENSIONS } from './indexer.js'
import { KbStore } from './store.js'

export const name = 'rag-kb'
export const inject = ['tools', 'systemPrompt', 'fs']

/** Browser routes, document-relative under the dsh mount as `api/dshCloudKb/...`. */
const DOCUMENTS_PATH = '/api/dshCloudKb/documents'
const UPLOAD_PATH = '/api/dshCloudKb/upload'
const REINDEX_PATH = '/api/dshCloudKb/reindex'
/** Upload names longer than this (UTF-8 bytes) are refused; ext4 allows 255. */
const MAX_NAME_BYTES = 200

export const Config = z.object({
  description: z.string().default('').description('What the knowledge base holds; the agent reads it before searching.'),
  searchMode: z.union(['explicit', 'proactive']).default('explicit').description('explicit: search only when the user asks to look in the knowledge base. proactive: also search first when a question may concern its documents.'),
  topK: z.number().step(1).min(1).max(50).default(5).description('Chunks returned per search.'),
  minScore: z.number().min(0).max(1).default(0.3).description('Lowest vector similarity a chunk needs to be returned.'),
  enableReranker: z.boolean().default(false).description('Rerank hits with a cross-encoder; downloads rerankerModel at first use.'),
  rerankTopN: z.number().step(1).min(1).max(20).default(3).description('Chunks kept after reranking.'),
  knowledgeDir: z.string().default('~/knowledge').description('Directory uploads are saved to; files in it are indexed automatically.'),
  embeddingModel: z.string().default('Xenova/bge-small-zh-v1.5').description('transformers.js feature-extraction model.'),
  rerankerModel: z.string().default('Xenova/bge-reranker-base').description('transformers.js text-classification model used for reranking.'),
  modelHost: z.string().default('https://huggingface.co/').description('Where models are downloaded from (a Hugging Face mirror such as https://hf-mirror.com/).'),
  modelCacheDir: z.string().default('').description('Model cache directory; empty uses rag-kb/hf-cache under the dsh home.'),
  batchSize: z.number().step(1).min(1).max(128).default(32).description('Chunks embedded per inference batch.'),
  maxFileBytes: z.number().step(1).min(1).default(50 * 1024 * 1024).description('Largest document read or uploaded, in bytes.'),
})

// The settings panel lists volatile fields only, and the published schemastery has no .volatile().
for (const child of Object.values(Config.dict ?? {})) child.meta.volatile = true

/**
 * Loaded models per download source. They outlive a configuration reload,
 * which re-applies this plugin, so the model is loaded once per process.
 */
const modelsBySource = new Map()

const expandHome = (path) => (path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(path))
const supported = (fileName) => SUPPORTED_EXTENSIONS.includes(extname(fileName).toLowerCase()) && !fileName.startsWith('.')

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Why an upload name is refused, or undefined when it can be used as a file name in knowledgeDir. */
function nameProblem(fileName) {
  if (!fileName || fileName !== basename(fileName) || fileName.includes('\\') || fileName.startsWith('.')) return 'invalid-name'
  // oxlint-disable-next-line no-control-regex -- control characters are what is being refused
  if (/[\u0000-\u001f\u007f]/.test(fileName) || Buffer.byteLength(fileName) > MAX_NAME_BYTES) return 'invalid-name'
  if (!supported(fileName)) return 'unsupported-type'
  return undefined
}

export function apply(ctx, config = {}) {
  // Volatile settings arrive as references the settings service updates in
  // place, so every use reads the current value: search settings apply to the
  // next search. knowledgeDir and the model source are read once here, and
  // apply at the next start.
  const read = (key) => {
    const value = config[key]
    return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  }
  const cfg = new Proxy({}, { get: (_, key) => read(key) })
  const knowledgeDir = expandHome(cfg.knowledgeDir)
  const source = { modelHost: cfg.modelHost.endsWith('/') ? cfg.modelHost : `${cfg.modelHost}/`, cacheDir: cfg.modelCacheDir ? expandHome(cfg.modelCacheDir) : dshHomePath('rag-kb', 'hf-cache') }
  const sourceKey = `${source.modelHost}|${source.cacheDir}`
  if (!modelsBySource.has(sourceKey)) modelsBySource.set(sourceKey, new Models(source))
  const models = modelsBySource.get(sourceKey)
  const store = new KbStore(dshHomePath('rag-kb', 'index.db'))
  const inKnowledgeDir = (path) => path !== '' && resolve(path).startsWith(knowledgeDir + sep)

  // ── Indexing queue: one document at a time bounds memory and CPU ──
  let queue = Promise.resolve()
  let closed = false
  /** Queued or running jobs by document id, with chunk progress once embedding starts. */
  const jobs = new Map()

  /** Run `job` after the jobs queued before it; resolves with its result. */
  function enqueue(docId, docName, job) {
    if (!jobs.has(docId)) jobs.set(docId, { name: docName, done: 0, total: 0, running: false, pending: 0 })
    jobs.get(docId).pending++
    const run = queue.then(async () => {
      if (closed) return { ok: false, message: 'plugin reloaded; try again' }
      jobs.get(docId).running = true
      return job((done, total) => Object.assign(jobs.get(docId), { done, total }))
    }).finally(() => {
      const entry = jobs.get(docId)
      if (--entry.pending === 0) jobs.delete(docId)
      else Object.assign(entry, { running: false, done: 0, total: 0 })
    })
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Index one document's bytes, replacing its earlier chunks. Unchanged
   * content is skipped unless `force` is set.
   */
  async function indexBytes({ docId, name: docName, source: kind, path, bytes, force }, onProgress) {
    const hash = KbStore.hashContent(bytes)
    const previous = store.getDoc(docId)
    if (!force && previous?.status === 'ready' && previous.content_hash === hash) {
      return { ok: true, skipped: true, message: `${docName} is already indexed (unchanged)` }
    }
    store.upsertDoc({ docId, name: docName, source: kind, path, bytes: bytes.byteLength, contentHash: hash, status: 'indexing' })
    try {
      // Saved conversation text is Markdown; files are parsed by their extension.
      const pieces = chunkText(await extractText(kind === 'save' ? 'saved.md' : docName, bytes))
      if (pieces.length === 0) throw new Error('no text found in the document')
      const vectors = await models.embed(cfg.embeddingModel, pieces, cfg.batchSize, onProgress)
      store.replaceChunks(docId, pieces.map((text, seq) => ({ seq, text, embedding: vectors[seq] })))
      store.setDocStatus(docId, 'ready', pieces.length)
      return { ok: true, message: `${docName} indexed: ${pieces.length} chunks` }
    } catch (e) {
      const message = String(e?.message ?? e)
      store.setDocStatus(docId, 'failed', 0, message)
      return { ok: false, message: `${docName} could not be indexed: ${message}` }
    }
  }

  /** Read a regular file through ctx.fs and queue it for indexing. */
  async function indexFile(target, kind, { force = false, signal } = {}) {
    const path = ctx.fs.processPath(target)
    const docName = basename(path)
    const docId = KbStore.docIdFromPath(path)
    return enqueue(docId, docName, async (onProgress) => {
      let bytes
      try {
        bytes = await ctx.fs.readBytes(target, signal, cfg.maxFileBytes)
      } catch (e) {
        const message = e?.code === 'FS_TOO_LARGE' ? `larger than ${cfg.maxFileBytes} bytes` : String(e?.message ?? e)
        if (store.getDoc(docId)) store.setDocStatus(docId, 'failed', 0, message)
        return { ok: false, message: `${docName} could not be read: ${message}` }
      }
      return indexBytes({ docId, name: docName, source: kind, path, bytes, force }, onProgress)
    })
  }

  /** Index a file path the way dsh's own tools resolve it. */
  async function indexPath(path, kind, options = {}) {
    const target = await ctx.fs.resolve(path, { ...options.cwd === undefined ? {} : { cwd: options.cwd }, signal: options.signal })
    const info = await ctx.fs.stat(target, options.signal)
    if (info === undefined) return [{ ok: false, message: `not found: ${target.displayPath}` }]
    if (info.type === 'file') return [await indexFile(target, kind, options)]
    if (info.type !== 'directory') return [{ ok: false, message: `not a file or directory: ${target.displayPath}` }]
    const entries = (await ctx.fs.listDir(target, options.signal)).filter(e => e.type === 'file' && supported(e.name))
    return Promise.all(entries.map(e => indexFile(e.target, kind, options)))
  }

  /** Delete a document, and its file when it lives in knowledgeDir. */
  async function removeDoc(doc) {
    store.deleteDoc(doc.doc_id)
    if (inKnowledgeDir(doc.path)) await rm(doc.path, { force: true })
  }

  /** Re-index every document: files are read again, saved text is re-embedded. */
  function reindexAll() {
    const docs = store.listDocs()
    for (const doc of docs) {
      if (doc.path !== '') {
        void indexPath(doc.path, doc.source, { force: true }).then(([result]) => {
          if (!result.ok && store.getDoc(doc.doc_id)) store.setDocStatus(doc.doc_id, 'failed', 0, result.message)
        }, (e) => store.setDocStatus(doc.doc_id, 'failed', 0, String(e?.message ?? e)))
        continue
      }
      const texts = store.chunkTexts(doc.doc_id)
      if (texts.length === 0) continue
      void enqueue(doc.doc_id, doc.name, async (onProgress) => {
        store.setDocStatus(doc.doc_id, 'indexing', doc.chunk_count)
        try {
          const vectors = await models.embed(cfg.embeddingModel, texts, cfg.batchSize, onProgress)
          store.replaceChunks(doc.doc_id, texts.map((text, seq) => ({ seq, text, embedding: vectors[seq] })))
          store.setDocStatus(doc.doc_id, 'ready', texts.length)
        } catch (e) {
          store.setDocStatus(doc.doc_id, 'failed', 0, String(e?.message ?? e))
        }
      })
    }
    return docs.length
  }

  /** Index text saved from a conversation; its content hash is its identity. */
  function saveText(title, text) {
    const content = `# ${title}\n\n${text}`
    const docId = KbStore.hashContent(content)
    return enqueue(docId, title, async (onProgress) => {
      if (store.getDoc(docId)?.status === 'ready') return { ok: true, message: `"${title}" is already in the knowledge base` }
      return indexBytes({ docId, name: title, source: 'save', path: '', bytes: new TextEncoder().encode(content), force: true }, onProgress)
    })
  }

  async function search(query, topK) {
    const [queryVec] = await models.embed(cfg.embeddingModel, [query], 1)
    const k = topK ?? cfg.topK
    let hits = store.hybridSearch(queryVec, query, cfg.enableReranker ? k * 3 : k, cfg.minScore).map(h => {
      const docName = store.getDoc(h.docId)?.name ?? h.docId
      return {
        doc: docName, seq: h.seq, score: Number(h.score.toFixed(3)), via: h.via,
        text: store.chunkText(h.docId, h.seq), citation: `${docName} 第${h.seq + 1}段`,
      }
    })
    let count = k
    if (cfg.enableReranker && hits.length > 0) {
      try {
        hits = (await models.rerank(cfg.rerankerModel, query, hits)).map(h => ({ ...h, rerankScore: Number(h.rerankScore.toFixed(4)) }))
        count = cfg.rerankTopN
      } catch (e) {
        ctx.logger?.warn?.(`rag-kb: reranking failed, returning hybrid search results: ${e?.message ?? e}`)
      }
    }
    return hits.slice(0, count).map(h => ({ ...h, text: h.text.slice(0, 800) }))
  }

  // ── knowledgeDir: created, scanned at start, and watched ──
  mkdirSync(knowledgeDir, { recursive: true })
  void (async () => {
    const names = new Set((await readdir(knowledgeDir)).filter(supported))
    for (const doc of store.listDocs()) {
      if (inKnowledgeDir(doc.path) && !names.has(basename(doc.path))) store.deleteDoc(doc.doc_id)
    }
    // Files added while dsh was not running; unchanged ones are skipped without embedding.
    await Promise.all([...names].map(f => indexPath(join(knowledgeDir, f), 'upload')))
  })().catch(e => ctx.logger?.warn?.(`rag-kb: scanning ${knowledgeDir} failed: ${e?.message ?? e}`))

  const timers = new Map()
  let watcher
  try {
    watcher = watch(knowledgeDir, { persistent: false }, (_event, fileName) => {
      if (fileName === null || !supported(String(fileName))) return
      const path = join(knowledgeDir, String(fileName))
      clearTimeout(timers.get(path))
      // Wait for writes to settle before reading the file.
      timers.set(path, setTimeout(() => {
        timers.delete(path)
        void indexPath(path, 'upload').then(([result]) => {
          if (result.message.startsWith('not found')) {
            const doc = store.getDoc(KbStore.docIdFromPath(path))
            if (doc) store.deleteDoc(doc.doc_id)
          }
        }).catch(e => ctx.logger?.warn?.(`rag-kb: indexing ${path} failed: ${e?.message ?? e}`))
      }, 2000))
    })
  } catch (e) {
    ctx.logger?.warn?.(`rag-kb: watching ${knowledgeDir} failed: ${e?.message ?? e}`)
  }

  ctx.effect(() => () => {
    closed = true
    watcher?.close()
    for (const timer of timers.values()) clearTimeout(timer)
    void queue.finally(() => store.close())
  }, 'rag-kb: index')

  // ── Panel routes (owner-only through dsh's connection) ──
  const documentsView = () => {
    const rows = store.listDocs().map(d => {
      const job = jobs.get(d.doc_id)
      return {
        id: d.doc_id, name: d.name, source: d.source, bytes: d.bytes, chunks: d.chunk_count,
        status: job ? (job.running ? 'indexing' : 'queued') : d.status, error: d.error, updatedAt: d.updated_at,
        ...job?.running && job.total > 0 ? { progress: { done: job.done, total: job.total } } : {},
        removable: true, inKnowledgeDir: inKnowledgeDir(d.path),
      }
    })
    const known = new Set(rows.map(r => r.id))
    for (const [id, job] of jobs) {
      if (!known.has(id)) rows.unshift({ id, name: job.name, source: 'upload', bytes: 0, chunks: 0, status: job.running ? 'indexing' : 'queued', error: '', updatedAt: '', removable: false })
    }
    return {
      documents: rows,
      usedBytes: rows.reduce((sum, r) => sum + r.bytes, 0),
      maxFileBytes: cfg.maxFileBytes,
      extensions: SUPPORTED_EXTENSIONS,
    }
  }

  /**
   * Answer a refused upload after reading its body (up to maxFileBytes): dsh
   * closes the connection under an unread streaming body, and a proxy still
   * sending it then sees a reset instead of this response.
   */
  async function refuse(request, status, body) {
    let size = 0
    for await (const chunk of request.body ?? []) {
      size += chunk.byteLength
      if (size > cfg.maxFileBytes) break
    }
    return json(status, body)
  }

  async function upload(request) {
    const fileName = new URL(request.url).searchParams.get('name') ?? ''
    const problem = nameProblem(fileName)
    if (problem) return refuse(request, 400, { code: problem, message: `cannot store "${fileName}"` })
    const declared = Number(request.headers.get('content-length') ?? Number.NaN)
    if (declared > cfg.maxFileBytes) return json(413, { code: 'too-large', limit: cfg.maxFileBytes })
    await mkdir(knowledgeDir, { recursive: true })
    const partial = join(knowledgeDir, `.upload-${randomUUID()}.part`)
    const file = await open(partial, 'wx')
    let size = 0
    try {
      for await (const chunk of request.body ?? []) {
        size += chunk.byteLength
        if (size > cfg.maxFileBytes) {
          await file.close()
          await rm(partial, { force: true })
          return json(413, { code: 'too-large', limit: cfg.maxFileBytes })
        }
        await file.write(chunk)
      }
      await file.close()
    } catch (e) {
      await file.close().catch(() => undefined)
      await rm(partial, { force: true })
      throw e
    }
    const path = join(knowledgeDir, fileName)
    await rename(partial, path)
    const docId = KbStore.docIdFromPath(path)
    void indexPath(path, 'upload').catch(e => ctx.logger?.warn?.(`rag-kb: indexing ${path} failed: ${e?.message ?? e}`))
    return json(202, { id: docId, name: fileName, bytes: size })
  }

  ctx.inject(['connection'], (web) => {
    web.effect(() => web.connection.fetch.register({
      path: DOCUMENTS_PATH,
      methods: ['GET', 'DELETE'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method === 'GET') return json(200, documentsView())
        const doc = store.getDoc(new URL(request.url).searchParams.get('id') ?? '')
        if (!doc) return json(404, { code: 'not-found' })
        await removeDoc(doc)
        return json(200, { ok: true })
      },
    }), 'rag-kb: documents route')
    web.effect(() => web.connection.fetch.register({
      path: UPLOAD_PATH,
      methods: ['POST'],
      requestBody: 'streaming',
      fetch: upload,
    }), 'rag-kb: upload route')
    web.effect(() => web.connection.fetch.register({
      path: REINDEX_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => json(202, { queued: reindexAll() }),
    }), 'rag-kb: reindex route')
  })

  // ── Model tools ──
  const params = (properties, required = []) => ({ type: 'object', properties, ...required.length ? { required } : {} })
  const output = { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
  const sessionCwd = async (exec) => exec?.agent === undefined ? undefined : ctx.get('workingDirectory')?.ensure(exec.agent, exec.signal)

  ctx.effect(() => {
    const disposers = [
      ctx.tools.register({
        name: 'knowledge_search',
        description: (cfg.searchMode === 'explicit'
          ? '在用户的本地知识库中混合检索（语义向量 + 关键词）。只在用户明确要求查知识库时调用（例如「在知识库里查…」「根据我的文档…」）；普通提问、「搜一下」「查一下」不要调用。'
          : '在用户的本地知识库中混合检索（语义向量 + 关键词）。问题可能涉及知识库里的文档时先检索。')
          + '返回最相关的知识块，每条带 citation 引用标注。query 支持自然语言和精确关键词（错误码/型号/人名等）。',
        parameters: params({
          query: { type: 'string', description: '检索问题（自然语言或精确关键词）' },
          top_k: { type: 'number', description: `返回条数（默认 ${cfg.topK}）` },
        }, ['query']),
        output,
        async execute(args) {
          const results = await search(args.query, args.top_k)
          return { ok: true, count: results.length, results }
        },
      }),
      ctx.tools.register({
        name: 'knowledge_status',
        description: '查看知识库状态：已索引文档列表（名称/大小/块数/状态）、配置参数、知识库描述。',
        parameters: params({}),
        output,
        async execute() {
          return {
            ok: true,
            description: cfg.description, topK: cfg.topK, minScore: cfg.minScore, knowledgeDir,
            documents: documentsView().documents.map(d => ({ name: d.name, source: d.source, bytes: d.bytes, chunks: d.chunks, status: d.status, ...d.error ? { error: d.error } : {} })),
          }
        },
      }),
      ctx.tools.register({
        name: 'knowledge_manage',
        description: '知识库管理操作（用户在对话中用自然语言请求时调用）。支持：save（把对话中的内容直接保存入库，给 title + text）、add（索引本地文件路径或目录）、remove（按文档名删除）、reindex（重建全部索引）。用户说「存到知识库」「把这个记下来」时用 save。',
        parameters: params({
          action: { type: 'string', enum: ['save', 'add', 'remove', 'reindex'], description: 'save | add | remove | reindex' },
          path: { type: 'string', description: 'add：本地文件或目录路径' },
          title: { type: 'string', description: 'save：文档标题（会成为知识库里的文档名）' },
          text: { type: 'string', description: 'save：要保存的文本内容（直接从对话中提取，无需先写文件）' },
          name: { type: 'string', description: 'remove：要删除的文档名' },
        }, ['action']),
        output,
        async execute(args, exec) {
          if (args.action === 'save') {
            if (!args.text) return { ok: false, error: 'save needs text' }
            const title = args.title || `对话保存 ${new Date().toISOString().slice(0, 16)}`
            return saveText(title, args.text)
          }
          if (args.action === 'add') {
            if (!args.path) return { ok: false, error: 'add needs path' }
            const results = await indexPath(args.path, 'agent', { cwd: await sessionCwd(exec), signal: exec?.signal })
            return results.length === 1 ? results[0] : { ok: results.every(r => r.ok), message: `indexed ${results.length} files`, detail: results.map(r => r.message) }
          }
          if (args.action === 'remove') {
            if (!args.name) return { ok: false, error: 'remove needs name' }
            const docs = store.listDocs()
            const exact = docs.filter(d => d.name === args.name)
            const matches = exact.length > 0 ? exact : docs.filter(d => d.name.includes(args.name))
            if (matches.length === 0) return { ok: false, error: `no document named "${args.name}"` }
            if (matches.length > 1) return { ok: false, error: 'several documents match; give one exact name', candidates: matches.map(d => d.name) }
            await removeDoc(matches[0])
            return { ok: true, message: `removed ${matches[0].name}` }
          }
          if (args.action === 'reindex') return { ok: true, message: `re-indexing ${reindexAll()} documents in the background` }
          return { ok: false, error: `unknown action ${args.action} (save, add, remove, reindex)` }
        },
      }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'rag-kb: tools')

  ctx.systemPrompt.section({
    name: 'tool:rag-kb',
    order: 2350,
    interpolate: false,
    text: () => [
      'You have a local knowledge base accessible via these tools:',
      '- knowledge_search: hybrid search (semantic + keyword) over the user\'s documents',
      '- knowledge_status: list documents and config',
      '- knowledge_manage: save/add/remove/reindex documents',
      cfg.searchMode === 'explicit'
        ? 'Call knowledge_search only when the user explicitly asks you to look in the knowledge base or their own saved documents (for example 在知识库里查…, 根据知识库…, 我的文档里…). For every other question, including requests such as 搜一下/查一下/搜索, do not call it: answer directly, or use web search when the question needs current or external information.'
        : 'When a question may concern the documents in the knowledge base, call knowledge_search before answering. Use web search only when the knowledge base has no relevant results and the topic is clearly not about the user\'s documents. Do not search both at once.',
      cfg.description !== '' ? `KB description: ${cfg.description}` : '',
      `Currently ${store.listDocs().filter(d => d.status === 'ready').length} document(s) indexed.`,
      `Files in ${knowledgeDir} (where the user's uploads are saved) are indexed automatically; deleting one there removes it from the knowledge base.`,
      'CITATION STYLE (footnote format): In the body of your answer, mark sources with superscript numbers like ¹ ² ³ (Unicode superscripts). At the END, add a "参考来源" section. IMPORTANT: MERGE citations from the same document into ONE entry — e.g. if citing 文档A 第1段/第2段/第3段, list as "1. 文档A 第1-3段" (not 3 separate lines). Only list each document once with all its paragraph numbers combined. Keep the answer body clean.',
      'When the user says "save this to the knowledge base" (保存到知识库/记下来), extract the valuable content from the conversation and call knowledge_manage with action="save", providing a concise title and the text.',
      'For file/directory indexing use action="add" with a path.',
    ].filter(Boolean).join('\n'),
  })
}
