/**
 * Knowledge base index in node:sqlite: documents, chunks with their embedding
 * vectors, and an FTS5 trigram index over chunk text. Search loads every ready
 * vector into memory once per write (cosine over normalized vectors) and merges
 * it with the keyword hits.
 *
 * The file format continues @puwenhui/dsh-rag-kb's (same application id), so an
 * index built by the upstream plugin opens here and is upgraded in place.
 */

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** PRAGMA application_id of the index file ('RAGB'). */
const APP_ID = 0x52414742
/** 2: upstream 0.3.x. 3: documents.path. */
const SCHEMA_VERSION = 3

export class KbStore {
  /** @param {string} dbPath */
  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.vectors = []
    this.vectorRows = []
    this.loaded = false
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;')
    const appId = this.db.prepare('PRAGMA application_id').get().application_id
    if (appId !== 0 && appId !== APP_ID) throw new Error(`rag-kb: ${dbPath} belongs to another application`)
    const version = this.db.prepare('PRAGMA user_version').get().user_version
    if (version > SCHEMA_VERSION) throw new Error(`rag-kb: ${dbPath} has schema ${version}; this plugin supports up to ${SCHEMA_VERSION}`)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents(
        doc_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'upload',
        bytes INTEGER NOT NULL DEFAULT 0,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS chunks(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB NOT NULL,
        FOREIGN KEY(doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(text, tokenize='trigram');
    `)
    const columns = new Set(this.db.prepare('PRAGMA table_info(documents)').all().map(c => c.name))
    // Upstream 0.2 indexes lack content_hash; every index before schema 3 lacks path.
    if (!columns.has('content_hash')) this.db.exec("ALTER TABLE documents ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''")
    if (!columns.has('path')) this.db.exec("ALTER TABLE documents ADD COLUMN path TEXT NOT NULL DEFAULT ''")
    // A document left 'indexing' by a stopped process never finishes.
    this.db.prepare("UPDATE documents SET status='failed', error=? WHERE status IN ('indexing', 'pending')").run('interrupted')
    this.db.exec(`PRAGMA application_id = ${APP_ID}; PRAGMA user_version = ${SCHEMA_VERSION};`)
  }

  /**
   * Document id of a source file: the same path keeps its id when its content
   * changes, so re-indexing replaces the old chunks. Lower-cased like upstream,
   * which keeps ids of existing indexes stable.
   * @param {string} filePath
   */
  static docIdFromPath(filePath) {
    return createHash('sha256').update(resolve(filePath).toLowerCase()).digest('hex').slice(0, 16)
  }

  /** @param {Uint8Array | string} content */
  static hashContent(content) {
    return createHash('sha256').update(content).digest('hex').slice(0, 16)
  }

  /**
   * Create or update a document row; `path` is '' for text saved from a conversation.
   * @param {{ docId: string, name: string, source: string, path: string, bytes: number, contentHash: string, status: string }} doc
   */
  upsertDoc({ docId, name, source, path, bytes, contentHash, status }) {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO documents(doc_id, content_hash, name, source, path, bytes, chunk_count, status, error, created_at, updated_at)
      VALUES(?,?,?,?,?,?,0,?,'',?,?)
      ON CONFLICT(doc_id) DO UPDATE SET content_hash=excluded.content_hash, name=excluded.name, path=excluded.path,
        bytes=excluded.bytes, status=excluded.status, error='', updated_at=excluded.updated_at
    `).run(docId, contentHash, name, source, path, bytes, status, now, now)
    this.loaded = false
  }

  setDocStatus(docId, status, chunkCount, error = '') {
    this.db.prepare('UPDATE documents SET status=?, chunk_count=?, error=?, updated_at=? WHERE doc_id=?')
      .run(status, chunkCount, error, new Date().toISOString(), docId)
    this.loaded = false
  }

  deleteDoc(docId) {
    this.db.exec('BEGIN')
    try {
      this.deleteChunks(docId)
      this.db.prepare('DELETE FROM documents WHERE doc_id=?').run(docId)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    this.loaded = false
  }

  /** Delete a document's chunks and their FTS rows (keyed by chunk id); runs inside the caller's transaction. */
  deleteChunks(docId) {
    const ftsDel = this.db.prepare('DELETE FROM chunk_fts WHERE rowid=?')
    for (const { id } of this.db.prepare('SELECT id FROM chunks WHERE doc_id=?').all(docId)) ftsDel.run(id)
    this.db.prepare('DELETE FROM chunks WHERE doc_id=?').run(docId)
  }

  /** @returns {Array<Record<string, any>>} newest first */
  listDocs() {
    return this.db.prepare('SELECT * FROM documents ORDER BY updated_at DESC').all()
  }

  getDoc(docId) {
    return this.db.prepare('SELECT * FROM documents WHERE doc_id=?').get(docId)
  }

  /** Replace a document's chunks, vectors, and FTS rows in one transaction. */
  replaceChunks(docId, chunks) {
    this.db.exec('BEGIN')
    try {
      this.deleteChunks(docId)
      const insert = this.db.prepare('INSERT INTO chunks(doc_id, seq, text, embedding) VALUES(?,?,?,?)')
      const ftsIns = this.db.prepare('INSERT INTO chunk_fts(rowid, text) VALUES(?,?)')
      for (const c of chunks) {
        const blob = new Uint8Array(c.embedding.buffer, c.embedding.byteOffset, c.embedding.byteLength)
        const { lastInsertRowid } = insert.run(docId, c.seq, c.text, blob)
        ftsIns.run(Number(lastInsertRowid), c.text)
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    this.loaded = false
  }

  /** Chunk texts of a document in order (re-embedding text saved from a conversation). */
  chunkTexts(docId) {
    return this.db.prepare('SELECT text FROM chunks WHERE doc_id=? ORDER BY seq').all(docId).map(r => r.text)
  }

  chunkText(docId, seq) {
    return this.db.prepare('SELECT text FROM chunks WHERE doc_id=? AND seq=?').get(docId, seq)?.text ?? ''
  }

  ensureLoaded() {
    if (this.loaded) return
    this.vectors = []
    this.vectorRows = []
    const rows = this.db.prepare("SELECT c.doc_id, c.seq, c.embedding FROM chunks c JOIN documents d ON d.doc_id=c.doc_id WHERE d.status='ready'").all()
    for (const row of rows) {
      const bytes = row.embedding
      this.vectors.push(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4))
      this.vectorRows.push({ docId: row.doc_id, seq: row.seq })
    }
    this.loaded = true
  }

  /**
   * Hybrid search: cosine similarity over all ready vectors plus FTS5 phrase
   * hits; a chunk found both ways gets 0.3 × its keyword score added.
   * @returns {Array<{ docId: string, seq: number, score: number, via: 'vector' | 'keyword' | 'both' }>}
   */
  hybridSearch(queryVec, queryText, topK, minScore) {
    this.ensureLoaded()
    const merged = new Map()
    for (let i = 0; i < this.vectors.length; i++) {
      const v = this.vectors[i]
      let dot = 0
      for (let j = 0; j < queryVec.length; j++) dot += queryVec[j] * v[j]
      if (dot >= minScore) {
        const { docId, seq } = this.vectorRows[i]
        merged.set(`${docId}:${seq}`, { docId, seq, score: dot, via: 'vector' })
      }
    }
    // trigram matching needs 3+ characters; long queries are cut to keep FTS fast.
    const phrase = queryText.replace(/["'*()\-:]/g, ' ').trim().slice(0, 50)
    if (phrase.length >= 3) {
      const ready = this.db.prepare(`
        SELECT c.doc_id, c.seq, bm25(chunk_fts) AS rank FROM chunk_fts f
        JOIN chunks c ON c.id = f.rowid JOIN documents d ON d.doc_id = c.doc_id
        WHERE chunk_fts MATCH ? AND d.status = 'ready' ORDER BY rank LIMIT ?
      `).all(`"${phrase}"`, topK * 2)
      for (const row of ready) {
        const key = `${row.doc_id}:${row.seq}`
        const score = 1 / (1 + Math.abs(row.rank))
        const hit = merged.get(key)
        if (hit) {
          hit.score += score * 0.3
          hit.via = 'both'
        } else {
          merged.set(key, { docId: row.doc_id, seq: row.seq, score, via: 'keyword' })
        }
      }
    }
    return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, topK)
  }

  close() {
    this.db.close()
  }
}
