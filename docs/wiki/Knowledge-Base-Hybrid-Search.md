# Knowledge Base Hybrid Search

Knowledge-base search finds notes **by meaning as well as by words**. It keeps the full-text index (SQLite FTS5: BM25, stemming, synonyms) and adds semantic search over chunk embeddings stored **inside the same SQLite database** with [sqlite-vec](https://github.com/asg017/sqlite-vec). No vector server runs. The two rankings are fused, and exact names, IDs and card numbers always rank first.

It is the default everywhere you search the knowledge base: the **Knowledge base** page, the MCP `search` tool, chat bots' `search` tool, and `GET /api/docs/search`.

## How a search runs

1. **Keyword**: the FTS5 index ranks notes by BM25.
2. **Semantic**: the query is embedded, and sqlite-vec returns the nearest chunks. Chunks roll up to their note, and a note keeps its best chunk.
3. **Fusion**: Reciprocal Rank Fusion, `score = Σ 1 / (60 + rank)`. A note found by both rankers beats one found by only one.
4. **Exact matches first**: some query tokens look like a card number (`#900816`, `900816`), an identifier (`sqlite-vec`, `kb_embed_provider`, `obj719092`, `sweepStaleWorkingSessions`), a quoted phrase, or a proper name (`Dana Ruiz`). Every note that literally contains such a token goes in a tier above all fused results. A token in the file name counts double.

Modes (`mode=` on the API, `mode` on the MCP tool):

| mode | what it does |
|---|---|
| `hybrid` (default) | keyword + semantic, fused, exact matches first |
| `keyword` | the full-text ranking only (grep fallback). This is the same retrieval cards use at spawn. |
| `semantic` | nearest chunks only |

If semantic search is unavailable (switched off, no API key, sqlite-vec missing, or not embedded yet), `hybrid` falls back to keyword. The response says so: `mode_used: "keyword"` plus `semantic.reason`.

Each hit returns `path`, `snippet`, `score`, `match` (`exact` / `both` / `keyword` / `semantic`) and, for semantic hits, `heading`, `line` and `similarity`.

## Chunking

Notes are split at their headings. Each chunk carries its heading trail (`Title > Section > Subsection`), and the trail is prepended to the text that gets embedded. Long sections are cut into windows of about 1,200 characters with 200 characters of overlap, on paragraph, sentence or word boundaries. Tiny sections are merged into the next one. Code fences never split. The stored row keeps the file path, heading trail and start line.

## Embedding providers (Settings → Knowledge search)

| provider | notes |
|---|---|
| **Local** (default) | `Xenova/all-MiniLM-L6-v2` (384-dim, about 23 MB), run in-process via transformers.js / onnxruntime. The Docker image bakes the model into `/app/models`, so a fresh install embeds **offline** and never calls a paid API. Inference is capped at 2 CPU threads (`CC_EMBED_THREADS`). |
| **OpenAI-compatible** | any `POST {base}/embeddings` endpoint: OpenAI, LiteLLM, Ollama `/v1`, and others |
| **Voyage** | `voyage-3.5-lite` by default, with `input_type` query/document |
| **Off** | keyword only |

API keys are chosen by **secret name** (Settings → Secrets). No route ever returns the value. If an API provider's key is missing, no call is made.

Changing the provider, model or dimension changes the vector space, which starts a re-embed of the whole knowledge base. While the re-embed runs, vectors from the old model are ignored.

## Keeping the index current

- **Every write path** calls `noteKbWrite(path)`: the Knowledge base editor and MCP `write_doc` (`PUT /api/docs/file`), chat-bot `write_doc` / `file_answer`, document import, chat/call imports, KB setup, wiki compile and lint. A single background queue embeds the file. A write never waits on embedding.
- **Backfill job.** It walks the whole knowledge base and shows its progress on the **Jobs** page (Knowledge index panel: progress, counts, Re-index / Stop). It can resume: a file whose content hash and model already match is skipped. A run that was `running` when the server restarted is marked `interrupted`, and the next run picks up the rest.
- **Reconcile pass** every 15 minutes, on the host instance only and never on a scratch server. It catches edits made outside the server (Obsidian, git pulls) using mtime/size first and then the content hash, and it prunes deleted notes.

## Never embedded

- `.env*` files, credential-store notes (`credentials.md`, `secrets.md`, `api-keys.md`, `passwords.md`, `*.env.md`), and `secrets/`, `credentials/`, `.ssh/`, `.aws/` folders.
- System folders: `.obsidian`, `_system`, `_import`, `.git`, `node_modules`, dot-folders, and generated `index.md` menus.
- Credential-shaped values inside any note. They are replaced with `[REDACTED:<kind>]` **before** the text is embedded or stored (same redactor as KB setup).

## Scoping

The workspace is a wall, the same rule as the keyword path. Both rankers are filtered by realpath containment (`filterToWorkspaceScope`) before fusion. The caller's read roots and an agent key's workspace list are applied **before** the limit, so a hidden note can neither take a slot nor leak a snippet. A chat bot only searches its own knowledge folders and granted workspaces.

## Related by similarity

Each note page lists its nearest notes (`GET /api/docs/related?path=`). The list uses the mean of the note's chunk vectors and the same scoping rules.

## Measuring it

`app/server/src/scripts/kb-search-eval.ts` compares keyword, hybrid and semantic recall@5 on a **copy** of a vault, with your own query set. It also reports backfill time and DB growth. It uses a throwaway DB and the local model.

```bash
cd app && npx tsx server/src/scripts/kb-search-eval.ts --root /path/to/vault-copy --queries queries.json --out report.md
```

## Deploying

This feature adds npm dependencies (`sqlite-vec`, `@huggingface/transformers`) and a Dockerfile step, so it needs an image **rebuild**. A `both` deploy does not install them. Without the rebuild, the server still boots and search stays keyword-only, with the reason shown in Settings and in the API.

Code: `app/server/src/services/kb-semantic/` (chunk, fusion, providers, store, indexer, search, service), `routes/admin-kb-search.ts`, `db/schema/kb-embeddings.ts`.
