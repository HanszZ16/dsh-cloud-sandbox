/**
 * Document pipeline: text extraction (PDF, DOCX, Markdown, plain text),
 * heading-aware chunking, and embeddings from one feature-extraction model.
 *
 * chunkText is @puwenhui/dsh-rag-kb 0.3.1's, unchanged apart from types.
 */

import { extname } from 'node:path'

/** Extensions the pipeline reads, lower-case with the dot. */
export const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.md', '.txt', '.csv', '.json', '.log']

/** About 400 tokens (≈600 Chinese characters) per chunk, 10% overlap. */
const CHUNK_TOKENS = 400
const OVERLAP_RATIO = 0.1
/**
 * `##`–`######` lines start a section and always start a new chunk. A single
 * `#` does not: shell, nginx, and SQL comments start with one.
 */
const HEADING_RE = /^#{2,6} /

/**
 * Extract the text of one document.
 * @param {string} name file name; its extension selects the parser
 * @param {Uint8Array} bytes the whole file
 * @returns {Promise<string>}
 */
export async function extractText(name, bytes) {
  const ext = extname(name).toLowerCase()
  if (ext === '.pdf') {
    const { extractText: pdfText, getDocumentProxy } = await import('unpdf')
    const pdf = await getDocumentProxy(new Uint8Array(bytes))
    return (await pdfText(pdf, { mergePages: true })).text
  }
  if (ext === '.docx') {
    const mammoth = await import('mammoth')
    return (await mammoth.extractRawText({ buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) })).value
  }
  if (SUPPORTED_EXTENSIONS.includes(ext)) return new TextDecoder().decode(bytes)
  throw new Error(`unsupported file type ${ext || '(none)'}; supported: ${SUPPORTED_EXTENSIONS.join(' ')}`)
}

/** 标题感知切块：节标题强制断块（一节 = 一块）+ 空行分段 + 过长滑窗兜底 */
export function chunkText(text) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (normalized === '') return []
  // 按标题（## 开头行）和空行分段
  const paragraphs = normalized.split(/\n(?=#{2,6} )|\n\n+/).map(p => p.trim()).filter(p => p !== '')
  const chunks = []
  let current = ''
  let sectionHeading = ''  // 最近一次节标题，供超长段滑窗切分时补回上下文
  const maxChars = CHUNK_TOKENS * 1.5  // 中文 token≈1.5 字符
  const overlap = Math.floor(maxChars * OVERLAP_RATIO)
  for (const para of paragraphs) {
    const isHeading = HEADING_RE.test(para)
    if (isHeading) sectionHeading = para.split('\n')[0].trim()
    // 遇节标题强制断块：让每节独立成块，引用溯源可精确到节；
    // 此处不带重叠，避免上一节内容混入下一节的检索结果
    if (isHeading && current !== '') {
      chunks.push(current)
      current = ''
    }
    // 超长段（无结构长文 / 长命令序列）：滑窗切分。
    // 门槛取 1.2 倍而非 2 倍——超过此长度的段直接成块会撑爆 embedding 上限被截断
    if (para.length > maxChars * 1.2) {
      const prefix = current
      current = ''
      // 前文很短（如「节标题 + 来源行」）时并入首块，避免留下没有正文的空壳块
      const mergePrefix = prefix !== '' && prefix.length <= maxChars * 0.6
      if (prefix !== '' && !mergePrefix) chunks.push(prefix)
      for (let i = 0; i < para.length;) {
        let end = Math.min(i + maxChars, para.length)
        // 尽量在换行处收尾：命令/配置从中间截断会同时毁掉前后两块的可读性
        if (end < para.length) {
          const nl = para.lastIndexOf('\n', end)
          if (nl > i + maxChars * 0.5) end = nl + 1
        }
        const piece = para.slice(i, end)
        const isFirst = i === 0
        i = end
        chunks.push(
          isFirst
            ? (mergePrefix ? `${prefix}\n\n${piece}` : piece)
            : (sectionHeading !== '' ? `${sectionHeading}\n\n${piece}` : piece),
        )
      }
      // 重置为节标题而非空串：紧随其后的普通段落累积时才不会丢掉出处
      current = sectionHeading
      continue
    }
    // 软下限 + 硬上限：当前块过短时（如仅「节标题 + 来源行」）宁可略微超长也不单独成块，
    // 否则会留下没有正文的空壳块；但合并后超过硬上限就必须断开
    const merged = current + '\n' + para
    if (current !== '' && merged.length > maxChars
      && (current.length >= maxChars * 0.5 || merged.length > maxChars * 1.2)) {
      chunks.push(current)
      // 能走到这里说明当前块已达软下限，可以安全携带重叠
      const tail = overlap > 0 ? current.slice(-overlap) : ''
      // 续块补回节标题：长节会被切成多块，带标题才能让每块都看得出出处
      current = sectionHeading !== '' ? `${sectionHeading}\n\n${tail}` : tail
    }
    current = current === '' ? para : current + '\n' + para
  }
  if (current !== '') chunks.push(current)
  return chunks.filter(c => c.trim().length >= 10)  // 过滤过短碎片
}

/**
 * Embeddings and optional reranking with transformers.js on the CPU. One
 * pipeline serves both queries and indexing, loaded on first use and kept for
 * the process; a reranker is loaded only when one is asked for.
 */
export class Models {
  /** @param {{ modelHost: string, cacheDir: string }} source where models are downloaded from and cached */
  constructor(source) {
    this.source = source
    this.loaded = new Map()
  }

  async pipeline(task, model) {
    const key = `${task}:${model}`
    let loading = this.loaded.get(key)
    if (loading === undefined) {
      loading = (async () => {
        const transformers = await import('@huggingface/transformers')
        // transformers.js reads these when it resolves a model; the cache holds
        // the image's copy, so the default model is never downloaded.
        transformers.env.remoteHost = this.source.modelHost
        transformers.env.cacheDir = this.source.cacheDir
        return transformers.pipeline(task, model, { device: 'cpu' })
      })()
      this.loaded.set(key, loading)
      // A failed load (e.g. no network) is retried by the next call.
      loading.catch(() => this.loaded.delete(key))
    }
    return loading
  }

  /**
   * Embed texts in batches; vectors are CLS-pooled and normalized.
   * @param {string} model
   * @param {string[]} texts
   * @param {number} batchSize
   * @param {(done: number, total: number) => void} [onProgress]
   * @returns {Promise<Float32Array[]>}
   */
  async embed(model, texts, batchSize, onProgress) {
    const extractor = await this.pipeline('feature-extraction', model)
    const vectors = []
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize)
      const out = await extractor(batch, { pooling: 'cls', normalize: true })
      const dim = out.data.length / batch.length
      for (let j = 0; j < batch.length; j++) vectors.push(new Float32Array(out.data.slice(j * dim, (j + 1) * dim)))
      onProgress?.(vectors.length, texts.length)
    }
    return vectors
  }

  /**
   * Order candidates by a cross-encoder's relevance to the query.
   * @template {{ text: string }} T
   * @param {string} model
   * @param {string} query
   * @param {T[]} candidates
   * @returns {Promise<Array<T & { rerankScore: number }>>}
   */
  async rerank(model, query, candidates) {
    const classifier = await this.pipeline('text-classification', model)
    const scores = await classifier(candidates.map(c => ({ text: query, text_pair: c.text })))
    return candidates
      .map((c, i) => ({ ...c, rerankScore: scores[i].score }))
      .sort((a, b) => b.rerankScore - a.rerankScore)
  }
}
