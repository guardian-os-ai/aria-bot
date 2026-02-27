"""
python-engine/rag.py — Hybrid RAG Pipeline

Combines BM25 keyword matching with ChromaDB vector similarity
for better retrieval quality. Returns ranked, deduplicated results.

Usage:
    retriever = HybridRetriever(vector_store)
    retriever.build_bm25_index(documents)  # one-time, call after indexing
    results = retriever.hybrid_search("emails about AWS billing", n_results=5)

BM25 adds keyword-exact matching that vector search sometimes misses
(e.g., "Swiggy" as a proper noun, specific amounts, exact dates).

Persistence:
    retriever.save_bm25(path)  # pickle corpus to disk after building
    retriever.load_bm25(path)  # restore from disk on sidecar restart
"""

import os
import pickle
import re
import sys
from typing import List, Dict, Any, Optional


class HybridRetriever:
    """
    Combines BM25 keyword scoring with vector similarity search.
    BM25 provides exact term matching, vectors provide semantic understanding.
    """

    def __init__(self, vector_store):
        self._vs = vector_store
        self._bm25 = None
        self._corpus_tokens: List[List[str]] = []
        self._corpus_docs: List[Dict[str, Any]] = []

    def build_bm25_index(self, documents: List[Dict[str, Any]]) -> int:
        """
        Build BM25 index from documents.
        Each doc should have: { doc_type, doc_id, text }
        Returns count of indexed documents.
        """
        try:
            from rank_bm25 import BM25Okapi
        except ImportError:
            print("[RAG] rank-bm25 not installed — BM25 disabled", file=sys.stderr)
            return 0

        self._corpus_tokens = []
        self._corpus_docs = []

        for doc in documents:
            text = doc.get("text", "")
            tokens = self._tokenize(text)
            if tokens:
                self._corpus_tokens.append(tokens)
                self._corpus_docs.append(doc)

        if self._corpus_tokens:
            self._bm25 = BM25Okapi(self._corpus_tokens)
            print(f"[RAG] BM25 index built: {len(self._corpus_tokens)} documents",
                  file=sys.stderr)

        return len(self._corpus_tokens)

    def save_bm25(self, path: str) -> bool:
        """
        Persist the BM25 corpus (tokens + docs) to disk using pickle.
        Call this after build_bm25_index() so the index survives sidecar restarts.

        Args:
            path: Absolute path to the .pkl file (e.g. <vectors_dir>/bm25_index.pkl)
        Returns:
            True if saved successfully, False otherwise.
        """
        if not self._bm25 or not self._corpus_tokens:
            return False
        try:
            os.makedirs(os.path.dirname(path) if os.path.dirname(path) else '.', exist_ok=True)
            with open(path, 'wb') as f:
                pickle.dump({
                    'corpus_tokens': self._corpus_tokens,
                    'corpus_docs': self._corpus_docs,
                }, f, protocol=pickle.HIGHEST_PROTOCOL)
            print(f"[RAG] BM25 index saved: {len(self._corpus_tokens)} docs → {path}", file=sys.stderr)
            return True
        except Exception as e:
            print(f"[RAG] BM25 save error: {e}", file=sys.stderr)
            return False

    def load_bm25(self, path: str) -> bool:
        """
        Restore BM25 corpus from disk. Rebuilds the BM25Okapi object in-memory
        from the pickled token corpus so search is immediately available.

        Args:
            path: Absolute path to the .pkl file
        Returns:
            True if loaded successfully, False if file missing or corrupt.
        """
        if not os.path.exists(path):
            return False
        try:
            from rank_bm25 import BM25Okapi
        except ImportError:
            print("[RAG] rank-bm25 not installed — BM25 load skipped", file=sys.stderr)
            return False
        try:
            with open(path, 'rb') as f:
                data = pickle.load(f)
            self._corpus_tokens = data.get('corpus_tokens', [])
            self._corpus_docs   = data.get('corpus_docs', [])
            if self._corpus_tokens:
                self._bm25 = BM25Okapi(self._corpus_tokens)
                print(f"[RAG] BM25 index loaded from disk: {len(self._corpus_tokens)} docs", file=sys.stderr)
                return True
            return False
        except Exception as e:
            print(f"[RAG] BM25 load error (will rebuild): {e}", file=sys.stderr)
            return False

    @staticmethod
    def _tokenize(text: str) -> List[str]:
        """Simple tokenization: lowercase, split on non-alphanumeric, filter short."""
        return [w for w in re.split(r'\W+', text.lower()) if len(w) > 1]

    def hybrid_search(
        self,
        query: str,
        n_results: int = 5,
        doc_type: Optional[str] = None,
        bm25_weight: float = 0.3,
        vector_weight: float = 0.7,
    ) -> List[Dict[str, Any]]:
        """
        Hybrid search: merges BM25 keyword scores with vector similarity scores.
        Returns deduplicated, reranked results.

        Args:
            query: Natural language search query
            n_results: Number of results to return
            doc_type: Optional filter by document type
            bm25_weight: Weight for BM25 keyword score (0-1)
            vector_weight: Weight for vector similarity score (0-1)

        Returns:
            List of result dicts with combined_score, vector_score, bm25_score
        """
        results: Dict[str, Dict[str, Any]] = {}

        # ── 1. Vector search (semantic similarity) ──
        try:
            vector_results = self._vs.query(
                query, n_results=n_results * 2, doc_type=doc_type
            )
            for i, r in enumerate(vector_results):
                doc_id = r.get("doc_id", f"v_{i}")
                # ChromaDB cosine distance → similarity (lower distance = more similar)
                similarity = max(0.0, 1.0 - r.get("distance", 1.0))
                results[doc_id] = {
                    **r,
                    "vector_score": similarity,
                    "bm25_score": 0.0,
                    "vector_rank": i,
                }
        except Exception as e:
            print(f"[RAG] Vector search error: {e}", file=sys.stderr)

        # ── 2. BM25 search (keyword matching) ──
        if self._bm25 and self._corpus_tokens:
            try:
                query_tokens = self._tokenize(query)
                if query_tokens:
                    bm25_scores = self._bm25.get_scores(query_tokens)
                    max_bm25 = max(bm25_scores) if max(bm25_scores) > 0 else 1.0

                    # Get top-N BM25 results
                    top_indices = sorted(
                        range(len(bm25_scores)),
                        key=lambda idx: bm25_scores[idx],
                        reverse=True,
                    )[:n_results * 2]

                    for idx in top_indices:
                        if bm25_scores[idx] <= 0:
                            continue

                        doc = self._corpus_docs[idx]
                        doc_id = doc.get("doc_id", f"b_{idx}")
                        normalized = bm25_scores[idx] / max_bm25

                        # Apply doc_type filter if specified
                        if doc_type and doc.get("doc_type", "") != doc_type:
                            continue

                        if doc_id in results:
                            results[doc_id]["bm25_score"] = normalized
                        else:
                            results[doc_id] = {
                                "doc_id": doc_id,
                                "text": doc.get("text", "")[:500],
                                "type": doc.get("doc_type", ""),
                                "metadata": {},
                                "distance": 1.0,
                                "vector_score": 0.0,
                                "bm25_score": normalized,
                                "vector_rank": 999,
                            }
            except Exception as e:
                print(f"[RAG] BM25 search error: {e}", file=sys.stderr)

        # ── 3. Combine scores and rerank ──
        for doc_id, r in results.items():
            r["combined_score"] = (
                vector_weight * r.get("vector_score", 0)
                + bm25_weight * r.get("bm25_score", 0)
            )

        # ── 4. Sort by combined score, return top-N ──
        ranked = sorted(
            results.values(),
            key=lambda x: x["combined_score"],
            reverse=True,
        )

        return ranked[:n_results]

    @property
    def bm25_ready(self) -> bool:
        """Check if BM25 index is built."""
        return self._bm25 is not None and len(self._corpus_tokens) > 0
