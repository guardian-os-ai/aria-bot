"""
python-engine/vectors.py — ChromaDB Vector Store (P2-4)

Local persistent semantic search over all user data.
Stores embeddings in %APPDATA%/aria-bot/vectors/ (or supplied db_dir).

Documents: { id, text, metadata }
Metadata always includes: type (email|calendar|note|transaction|reminder|subscription), doc_id (str)

Features:
  - Automatic chunking for long documents (>1500 chars)
  - Batch upsert for efficient bulk indexing
  - Type-filtered queries
"""

import os
from typing import List, Dict, Any, Optional


class VectorStore:
    """
    Thin wrapper around ChromaDB.
    Lazy-initialised: importing this file does NOT load chromadb unless
    a VectorStore instance is created and used.
    """

    COLLECTION_NAME = "aria_docs"
    MAX_CHUNK_SIZE = 1500  # chars per chunk
    CHUNK_OVERLAP = 200    # overlap between chunks

    def __init__(self, db_dir: str = ""):
        if not db_dir:
            appdata = os.environ.get("APPDATA") or os.path.expanduser("~")
            db_dir = os.path.join(appdata, "aria-bot", "vectors")

        os.makedirs(db_dir, exist_ok=True)
        self._db_dir = db_dir
        self._client = None
        self._collection = None

    def _ensure(self):
        """Lazy-load chromadb on first use. Uses nomic-embed-text via Ollama if available."""
        if self._collection is not None:
            return
        try:
            import chromadb
            from chromadb import EmbeddingFunction, Documents, Embeddings

            # ── Phase D: nomic-embed-text via Ollama ─────────────────────
            class NomicOllamaEF(EmbeddingFunction):
                """Calls Ollama /api/embed with nomic-embed-text model."""
                OLLAMA_EMBED_URL = "http://localhost:11434/api/embed"
                MODEL = "nomic-embed-text"
                _available: Optional[bool] = None  # cached check

                def name(self) -> str:
                    return "NomicOllamaEmbeddings"

                def _check_available(self) -> bool:
                    if NomicOllamaEF._available is not None:
                        return NomicOllamaEF._available
                    try:
                        import requests as _req
                        tags = _req.get("http://localhost:11434/api/tags", timeout=2).json()
                        models = [m.get("name", "") for m in tags.get("models", [])]
                        NomicOllamaEF._available = any("nomic-embed-text" in m for m in models)
                    except Exception:
                        NomicOllamaEF._available = False
                    if NomicOllamaEF._available:
                        print("[VectorStore] Using nomic-embed-text for embeddings", flush=True)
                    else:
                        print("[VectorStore] nomic-embed-text not found — falling back to default embeddings", flush=True)
                    return NomicOllamaEF._available

                def __call__(self, input: Documents) -> Embeddings:
                    if not self._check_available():
                        # Fallback: use ChromaDB default (ONNX all-MiniLM-L6-v2)
                        try:
                            from chromadb.utils import embedding_functions
                            default_ef = embedding_functions.DefaultEmbeddingFunction()
                            return default_ef(input)
                        except Exception:
                            raise RuntimeError("No embedding function available")
                    try:
                        import requests as _req
                        resp = _req.post(
                            self.OLLAMA_EMBED_URL,
                            json={"model": self.MODEL, "input": list(input)},
                            timeout=30,
                        )
                        resp.raise_for_status()
                        data = resp.json()
                        # Ollama returns {"embeddings": [[...], ...]}
                        return data.get("embeddings", [])
                    except Exception as e:
                        print(f"[VectorStore] nomic embed error: {e} — falling back", flush=True)
                        NomicOllamaEF._available = False
                        from chromadb.utils import embedding_functions
                        default_ef = embedding_functions.DefaultEmbeddingFunction()
                        return default_ef(input)

            self._client = chromadb.PersistentClient(path=self._db_dir)
            try:
                self._collection = self._client.get_or_create_collection(
                    name=self.COLLECTION_NAME,
                    metadata={"hnsw:space": "cosine"},
                    embedding_function=NomicOllamaEF(),
                )
            except (ValueError, Exception) as _ef_err:
                # Persisted collection has a different embedding function recorded.
                # Recreate it so ARIA can index without crashing.
                print(
                    f"[VectorStore] Collection embedding mismatch ({_ef_err}) — "
                    "deleting stale collection and rebuilding.",
                    flush=True,
                )
                try:
                    self._client.delete_collection(self.COLLECTION_NAME)
                except Exception:
                    pass
                self._collection = self._client.create_collection(
                    name=self.COLLECTION_NAME,
                    metadata={"hnsw:space": "cosine"},
                    embedding_function=NomicOllamaEF(),
                )
        except ImportError:
            raise RuntimeError(
                "chromadb is not installed. Run: pip install chromadb"
            )

    def _chunk_text(self, text: str) -> List[str]:
        """Split long text into overlapping chunks for better retrieval."""
        if len(text) <= self.MAX_CHUNK_SIZE:
            return [text]

        chunks = []
        start = 0
        while start < len(text):
            end = start + self.MAX_CHUNK_SIZE
            chunk = text[start:end]

            # Try to break at sentence boundary
            if end < len(text):
                last_period = chunk.rfind('. ')
                last_newline = chunk.rfind('\n')
                break_at = max(last_period, last_newline)
                if break_at > self.MAX_CHUNK_SIZE * 0.5:
                    chunk = chunk[:break_at + 1]
                    end = start + break_at + 1

            chunks.append(chunk.strip())
            start = end - self.CHUNK_OVERLAP  # overlap for context continuity
            if start < 0:
                start = 0

        return [c for c in chunks if c]

    def upsert(self, doc_type: str, doc_id: str, text: str, extra_meta: Optional[Dict] = None) -> None:
        """
        Insert or update a document in the vector store.
        Long documents are automatically chunked.
        """
        text = str(text) if text is not None else ""
        doc_id = str(doc_id) if doc_id is not None else ""
        doc_type = str(doc_type) if doc_type is not None else "doc"

        import unicodedata
        text = unicodedata.normalize('NFKD', text)
        if not text.strip() or not doc_id:
            return

        self._ensure()

        chunks = self._chunk_text(text)

        for i, chunk in enumerate(chunks):
            chunk_id = f"{doc_id}" if len(chunks) == 1 else f"{doc_id}__chunk{i}"
            meta = {"type": doc_type, "doc_id": doc_id, "chunk_index": str(i), "total_chunks": str(len(chunks))}
            if extra_meta:
                for k, v in extra_meta.items():
                    meta[k] = str(v) if v is not None else ""

            try:
                self._collection.upsert(
                    ids=[chunk_id],
                    documents=[chunk[:2000]],
                    metadatas=[meta],
                )
            except (TypeError, Exception) as e:
                import sys
                print(f"[VectorStore] Error in upsert: {e}, doc_id={repr(doc_id)}", file=sys.stderr)

    def batch_upsert(self, documents: List[Dict[str, Any]]) -> int:
        """
        Bulk index multiple documents efficiently.
        Each doc: { doc_type, doc_id, text, extra_meta? }
        Returns count of successfully indexed documents.
        """
        if not documents:
            return 0

        self._ensure()
        indexed = 0

        # Process in batches of 50 for ChromaDB efficiency
        batch_ids = []
        batch_docs = []
        batch_metas = []

        import unicodedata

        for doc in documents:
            text = str(doc.get("text", "")) if doc.get("text") else ""
            text = unicodedata.normalize('NFKD', text)
            doc_id = str(doc.get("doc_id", ""))
            doc_type = str(doc.get("doc_type", "doc"))

            if not text.strip() or not doc_id:
                continue

            chunks = self._chunk_text(text)
            for i, chunk in enumerate(chunks):
                chunk_id = f"{doc_id}" if len(chunks) == 1 else f"{doc_id}__chunk{i}"
                meta = {"type": doc_type, "doc_id": doc_id, "chunk_index": str(i), "total_chunks": str(len(chunks))}
                extra = doc.get("extra_meta")
                if extra and isinstance(extra, dict):
                    for k, v in extra.items():
                        meta[k] = str(v) if v is not None else ""

                batch_ids.append(chunk_id)
                batch_docs.append(chunk[:2000])
                batch_metas.append(meta)

                # Flush every 50 items
                if len(batch_ids) >= 50:
                    try:
                        self._collection.upsert(
                            ids=batch_ids,
                            documents=batch_docs,
                            metadatas=batch_metas,
                        )
                        indexed += len(batch_ids)
                    except Exception as e:
                        import sys
                        print(f"[VectorStore] Batch error: {e}", file=sys.stderr)
                    batch_ids, batch_docs, batch_metas = [], [], []

        # Flush remaining
        if batch_ids:
            try:
                self._collection.upsert(
                    ids=batch_ids,
                    documents=batch_docs,
                    metadatas=batch_metas,
                )
                indexed += len(batch_ids)
            except Exception as e:
                import sys
                print(f"[VectorStore] Final batch error: {e}", file=sys.stderr)

        return indexed

    def query(self, text: str, n_results: int = 5, doc_type: Optional[str] = None) -> List[Dict[str, Any]]:
        """
        Semantic search with optional type filtering.
        Returns de-duplicated results (collapses chunks from same document).
        """
        if not text or not text.strip():
            return []
        text = str(text)
        self._ensure()

        where = {"type": doc_type} if doc_type else None
        try:
            count = self._collection.count()
            if count == 0:
                return []
            results = self._collection.query(
                query_texts=[text],
                n_results=min(n_results * 2, max(1, count)),  # fetch extra to handle chunk dedup
                where=where,
                include=["documents", "metadatas", "distances"],
            )
        except Exception:
            return []

        output = []
        seen_doc_ids = set()
        if results and results.get("ids"):
            ids = results["ids"][0]
            docs = results["documents"][0]
            metas = results["metadatas"][0]
            dists = results["distances"][0]
            for i, chunk_id in enumerate(ids):
                doc_id = metas[i].get("doc_id", chunk_id)
                # De-duplicate: only return best chunk per document
                if doc_id in seen_doc_ids:
                    continue
                seen_doc_ids.add(doc_id)
                output.append({
                    "doc_id": doc_id,
                    "type": metas[i].get("type", ""),
                    "text": docs[i][:500],
                    "distance": dists[i],
                    "metadata": metas[i],
                })
                if len(output) >= n_results:
                    break
        return output

    def count(self) -> int:
        """Return total number of indexed documents/chunks."""
        try:
            self._ensure()
            return self._collection.count()
        except Exception:
            return 0

    def prune(self, max_age_days: int = 30, max_items: int = 50000) -> int:
        """
        Remove oldest entries to keep collection within limits.
        Deletes the oldest (lexicographically lowest) IDs beyond max_items.
        Runs at startup to prevent unbounded growth over months.
        Returns the number of entries deleted.
        """
        import sys
        try:
            self._ensure()
            count = self._collection.count()
            if count <= max_items:
                return 0
            # Fetch all IDs (no documents, just metadata) and sort
            result = self._collection.get(include=[])
            all_ids = sorted(result.get('ids', []))
            excess = len(all_ids) - max_items
            if excess <= 0:
                return 0
            to_delete = all_ids[:excess]
            # ChromaDB delete accepts at most 5461 IDs at a time
            batch_size = 5000
            deleted = 0
            for start_idx in range(0, len(to_delete), batch_size):
                batch = to_delete[start_idx:start_idx + batch_size]
                self._collection.delete(ids=batch)
                deleted += len(batch)
            print(f"[VectorStore] Pruned {deleted} oldest entries (was {count}, limit {max_items})",
                  file=sys.stderr)
            return deleted
        except Exception as e:
            import sys as _sys
            print(f"[VectorStore] Prune error: {e}", file=_sys.stderr)
            return 0

    def delete(self, doc_id: str) -> None:
        """Remove a document (and all its chunks) from the index."""
        try:
            self._ensure()
            # Delete exact ID
            self._collection.delete(ids=[doc_id])
            # Also delete any chunks
            for i in range(20):  # max 20 chunks per doc
                try:
                    self._collection.delete(ids=[f"{doc_id}__chunk{i}"])
                except Exception:
                    break
        except Exception:
            pass
