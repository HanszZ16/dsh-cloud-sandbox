# dsh-cloud-rag-kb

Knowledge base plugin shipped in the dsh-cloud sandbox image and installed for users as `link:/usr/local/lib/dsh-cloud/plugins/rag-kb`. It is a fork of [`@puwenhui/dsh-rag-kb`](https://github.com/Puwenhui-Me/dsh-rag-kb) 0.3.1 (commit `cecb7f9`, MIT), rewritten as plain ESM so the image needs no build step.

| File | Contents |
|---|---|
| `index.js` | Host face: `knowledge_search`, `knowledge_status`, `knowledge_manage`, the system prompt section, the panel routes `api/dshCloudKb/documents` (GET list, DELETE), `api/dshCloudKb/upload` (POST), and `api/dshCloudKb/reindex`, and the `knowledgeDir` watcher |
| `store.js` | node:sqlite index at `~/.dsh/rag-kb/index.db`; opens and upgrades indexes the upstream plugin built |
| `indexer.js` | Text extraction, upstream's chunking, and one transformers.js model for embeddings (plus an optional reranker) |
| `client.js` | Right-sidebar **Knowledge base** tab (upload, drag and drop, list, delete, re-index, progress) and the Settings → Plugins tab, in Chinese and English |
| `dsh-cloud.json` | Links `~/.dsh/rag-kb/hf-cache/Xenova/bge-small-zh-v1.5` to the image's copy of the model |

Changes from upstream:

- Uploads from the panel are saved to `knowledgeDir` (`~/knowledge`) and indexed; files put there any other way are indexed too, and deleting one there removes its document.
- Source files are read through dsh's filesystem service (`ctx.fs`), with relative paths resolved against the Session's working directory.
- One embedding model per process, serving queries and indexing (upstream loaded two); documents are indexed one at a time.
- `modelHost`, `modelCacheDir`, `rerankerModel`, and `maxFileBytes` are configuration fields.
- Dependencies are declared and pinned, including `@deepseek-ai/dsh-home-paths`.
- `reindex` re-reads and re-embeds every document (upstream only marked them pending); `remove` deletes one exact match instead of every name containing the text; the `describe` action, which stored nothing, is gone.
- Replacing a document's chunks also deletes their keyword-index rows.
- `searchMode` (default `explicit`): the agent calls `knowledge_search` only when the user asks it to look in the knowledge base; `proactive` restores searching first whenever a question may concern its documents. Upstream told the agent to search the knowledge base first for every 搜一下/查一下 request.

Bump `version` in `package.json` when changing this directory; provision re-links the plugin for users whose profile carries an older version.
