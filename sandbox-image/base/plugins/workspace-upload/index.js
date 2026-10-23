/**
 * Workspace upload plugin, host face: the authenticated routes behind the
 * Files panel's upload button (./client.js).
 *
 * Files are written under the Session's working directory, read from the
 * Session header on this side: the browser names the Session and a path
 * relative to that directory, never an absolute path. A path whose resolved
 * parent leaves the working directory (through `..` or a symbolic link) is
 * refused. Each file is streamed to a hidden partial file beside its target
 * and moved into place only once it is complete, so an interrupted upload
 * leaves nothing behind. Written as plain ESM so the image ships it without a
 * build step.
 */

import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'

export const name = 'workspace-upload'

/** Browser routes, document-relative under the dsh mount as `api/dshCloudFiles/...`. */
const CHECK_PATH = '/api/dshCloudFiles/check'
const UPLOAD_PATH = '/api/dshCloudFiles/upload'
/** Longest path segment in UTF-8 bytes; ext4 allows 255, and the partial file's prefix needs room. */
const MAX_SEGMENT_BYTES = 200
/** Most paths one check names. */
const MAX_CHECK_PATHS = 10000
/** Renamed copies tried before giving up: `name (1).ext` … `name (999).ext`. */
const MAX_COPIES = 999

/** Default for the `maxFileBytes` config field: the largest file uploaded, in bytes. */
const DEFAULT_MAX_FILE_BYTES = 200 * 1024 * 1024

class UploadError extends Error {
  constructor(status, code, detail = {}) {
    super(code)
    this.status = status
    this.code = code
    this.detail = detail
  }
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** The segments of a relative upload path, or an `invalid-path` error. */
function segmentsOf(path) {
  const segments = typeof path === 'string' ? path.split('/') : []
  const valid = segments.length > 0 && segments.every(s =>
    s !== '' && s !== '.' && s !== '..' && !s.includes('\\')
    // oxlint-disable-next-line no-control-regex -- control characters are what is being refused
    && !/[\u0000-\u001f\u007f]/.test(s) && Buffer.byteLength(s) <= MAX_SEGMENT_BYTES)
  if (!valid) throw new UploadError(400, 'invalid-path', { path })
  return segments
}

/** `name (n).ext` for a renamed copy; dotfiles and names without an extension get the suffix at the end. */
function copyName(fileName, n) {
  const ext = extname(fileName)
  const stem = ext === '' || ext === fileName ? fileName : fileName.slice(0, -ext.length)
  return ext === '' || ext === fileName ? `${fileName} (${n})` : `${stem} (${n})${ext}`
}

/** Why a path in a non-'none', non-'file' probe state cannot receive an upload. */
const REFUSAL = { directory: 'is-directory', other: 'not-file', blocked: 'not-directory', outside: 'outside-workspace' }

const errno = (e) => (e && typeof e === 'object' ? e.code : undefined)

export function apply(ctx, config = {}) {
  // The package has no dependencies of its own (it is linked from the image), so the config is checked here.
  const maxFileBytes = config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new Error(`workspace-upload: maxFileBytes must be a positive integer, got ${JSON.stringify(config.maxFileBytes)}`)
  }

  /** The Session's working directory, resolved through symbolic links. */
  async function rootOf(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new UploadError(400, 'invalid-session')
    const header = ctx.get('sessions')?.get(sessionId)?.header
      ?? (await ctx.get('sessionPersistence')?.stat(sessionId))?.header
    if (header === undefined) throw new UploadError(404, 'session-not-found')
    if (!header.cwd) throw new UploadError(409, 'no-workspace')
    try {
      return await realpath(header.cwd)
    } catch (e) {
      if (errno(e) === 'ENOENT') throw new UploadError(404, 'workspace-not-found')
      throw e
    }
  }

  const inside = (root, path) => path === root || path.startsWith(root + sep)

  /**
   * What is at `segments` under `root` now: 'none', 'file' (or a symbolic
   * link), 'directory', 'other', 'blocked' (an ancestor is not a directory),
   * or 'outside' (an ancestor links out of the workspace).
   */
  async function probe(root, segments) {
    let current = root
    for (let i = 0; i < segments.length; i++) {
      current = join(current, segments[i])
      let info
      try {
        info = await lstat(current)
      } catch (e) {
        if (errno(e) === 'ENOENT') return 'none'
        if (errno(e) === 'ENOTDIR') return 'blocked'
        throw e
      }
      if (i < segments.length - 1) {
        if (info.isSymbolicLink()) {
          // Followed only while it stays in the workspace.
          const resolved = await realpath(current).catch(() => undefined)
          if (resolved === undefined) return 'blocked'
          if (!inside(root, resolved)) return 'outside'
          continue
        }
        if (!info.isDirectory()) return 'blocked'
        continue
      }
      if (info.isDirectory()) return 'directory'
      return info.isFile() || info.isSymbolicLink() ? 'file' : 'other'
    }
    return 'none'
  }

  /** The directory a file at `segments` goes into, created as needed and confirmed to be inside `root`. */
  async function parentOf(root, segments) {
    const parent = join(root, ...segments.slice(0, -1))
    try {
      await mkdir(parent, { recursive: true })
    } catch (e) {
      if (errno(e) === 'EEXIST' || errno(e) === 'ENOTDIR') throw new UploadError(409, 'not-directory')
      throw e
    }
    const resolved = await realpath(parent)
    if (!inside(root, resolved)) throw new UploadError(403, 'outside-workspace')
    return resolved
  }

  /**
   * Answer a refused upload after reading its body (up to maxFileBytes): dsh
   * closes the connection under an unread streaming body, and a proxy still
   * sending it then sees a reset instead of this response.
   */
  async function refuse(request, error) {
    let size = 0
    for await (const chunk of request.body ?? []) {
      size += chunk.byteLength
      if (size > maxFileBytes) break
    }
    return json(error.status, { code: error.code, ...error.detail })
  }

  async function check(request) {
    let body
    try {
      body = await request.json()
    } catch (e) {
      return json(400, { code: 'invalid-request', message: String(e?.message ?? e) })
    }
    const paths = Array.isArray(body?.paths) ? body.paths : []
    if (paths.length > MAX_CHECK_PATHS) return json(400, { code: 'too-many-paths', limit: MAX_CHECK_PATHS })
    try {
      const root = await rootOf(body?.session)
      const existing = []
      const blocked = []
      for (const path of paths) {
        let state
        try {
          state = await probe(root, segmentsOf(path))
        } catch (e) {
          if (!(e instanceof UploadError)) throw e
          blocked.push({ path, code: e.code })
          continue
        }
        if (state === 'file') existing.push(path)
        else if (state !== 'none') blocked.push({ path, code: REFUSAL[state] })
      }
      return json(200, { root, maxFileBytes, existing, blocked })
    } catch (e) {
      if (e instanceof UploadError) return json(e.status, { code: e.code, ...e.detail })
      throw e
    }
  }

  /** Move a complete partial file to `target`, or to a renamed copy beside it; returns the final name. */
  async function place(partial, parent, fileName, conflict) {
    const target = join(parent, fileName)
    if (conflict === 'overwrite') {
      const existing = await lstat(target).catch(() => undefined)
      if (existing?.isDirectory()) throw new UploadError(409, 'is-directory')
      await rename(partial, target)
      return fileName
    }
    // A hard link fails instead of replacing, so a file created meanwhile is never overwritten.
    for (let n = 0; n <= (conflict === 'rename' ? MAX_COPIES : 0); n++) {
      const candidate = n === 0 ? fileName : copyName(fileName, n)
      try {
        await link(partial, join(parent, candidate))
        await rm(partial, { force: true })
        return candidate
      } catch (e) {
        if (errno(e) !== 'EEXIST') throw e
      }
    }
    throw new UploadError(409, conflict === 'rename' ? 'too-many-copies' : 'exists')
  }

  async function upload(request) {
    const query = new URL(request.url).searchParams
    const path = query.get('path') ?? ''
    const conflict = query.get('conflict') ?? 'fail'
    let root
    let segments
    let parent
    try {
      if (!['fail', 'overwrite', 'rename'].includes(conflict)) throw new UploadError(400, 'invalid-conflict')
      segments = segmentsOf(path)
      root = await rootOf(query.get('session'))
      const declared = Number(request.headers.get('content-length') ?? Number.NaN)
      if (declared > maxFileBytes) return json(413, { code: 'too-large', limit: maxFileBytes })
      const state = await probe(root, segments)
      if (state === 'outside') throw new UploadError(403, 'outside-workspace')
      if (state === 'blocked') throw new UploadError(409, 'not-directory')
      if (state === 'directory' || state === 'other') throw new UploadError(409, REFUSAL[state])
      if (state === 'file' && conflict === 'fail') throw new UploadError(409, 'exists', { path })
      parent = await parentOf(root, segments)
    } catch (e) {
      if (e instanceof UploadError) return refuse(request, e)
      throw e
    }
    const partial = join(parent, `.dsh-upload-${randomUUID()}.part`)
    const file = await open(partial, 'wx')
    let size = 0
    try {
      for await (const chunk of request.body ?? []) {
        size += chunk.byteLength
        if (size > maxFileBytes) {
          await file.close()
          await rm(partial, { force: true })
          return json(413, { code: 'too-large', limit: maxFileBytes })
        }
        await file.write(chunk)
      }
      await file.close()
    } catch (e) {
      await file.close().catch(() => undefined)
      await rm(partial, { force: true })
      throw e
    }
    try {
      const placed = await place(partial, parent, segments.at(-1), conflict)
      return json(201, { path: [...segments.slice(0, -1), placed].join('/'), bytes: size })
    } catch (e) {
      await rm(partial, { force: true })
      if (e instanceof UploadError) return json(e.status, { code: e.code, ...e.detail })
      throw e
    }
  }

  ctx.inject(['connection'], (web) => {
    web.effect(() => web.connection.fetch.register({
      path: CHECK_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: check,
    }), 'workspace-upload: check route')
    web.effect(() => web.connection.fetch.register({
      path: UPLOAD_PATH,
      methods: ['POST'],
      requestBody: 'streaming',
      fetch: upload,
    }), 'workspace-upload: upload route')
  })
}
