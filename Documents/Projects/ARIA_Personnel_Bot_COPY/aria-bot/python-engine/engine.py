"""
python-engine/engine.py — ARIA Python Sidecar
Communicates with Electron via JSON over stdin/stdout.
Each request:  { "id": <int>, "type": <str>, "payload": <dict> }
Each response: { "id": <int>, "result": <any>, "error": <str|null> }

Modules:
  - priority: Deterministic priority scoring (P2-3)
  - llm: Local LLM via llama-cpp-python (P2-2)
  - vectors: ChromaDB semantic search (P2-4)
  - intents: Intent pattern matching (P4-1)
"""

import sys
import json
import traceback
import os

# Append engine dir to path for sibling imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from priority import compute_priorities
from intents import match_intent
from vectors import VectorStore

# Lazy-loaded modules (heavy imports)
_llm = None
_agent = None
_rag = None
# Singleton vector stores keyed by db_dir (avoid multiple PersistentClient instances)
_vector_stores = {}

def get_llm():
    global _llm
    if _llm is None:
        from llm import LocalLLM
        _llm = LocalLLM()
    return _llm

def get_vector_store(db_dir):
    """Get or create a singleton VectorStore for the given directory."""
    global _vector_stores
    if db_dir not in _vector_stores:
        vs = VectorStore(db_dir)
        # Prune on first access to prevent unbounded growth
        try:
            vs.prune(max_age_days=30, max_items=50000)
        except Exception:
            pass
        _vector_stores[db_dir] = vs
    return _vector_stores[db_dir]


def get_hybrid_retriever(db_dir):
    """Get or create a singleton HybridRetriever for the given directory."""
    global _rag
    if _rag is None:
        from rag import HybridRetriever
        store = get_vector_store(db_dir)
        _rag = HybridRetriever(store)
    return _rag


def handle_request(req):
    """Route a request to the appropriate handler."""
    req_type = req.get("type", "")
    payload = req.get("payload", {})

    if req_type == "ping":
        return {"status": "ok", "version": "1.0.0"}

    elif req_type == "check_imports":
        missing = []
        try:
            import chromadb  # noqa: F401
        except ImportError:
            missing.append("chromadb")
        try:
            import requests  # noqa: F401
        except ImportError:
            missing.append("requests")
        return {"ok": len(missing) == 0, "missing": missing}

    elif req_type == "priorities":
        db_path = payload.get("db_path", "")
        return compute_priorities(db_path)

    elif req_type == "intent":
        text = payload.get("text", "")
        return match_intent(text)

    elif req_type == "generate":
        try:
            llm = get_llm()
        except RuntimeError as e:
            return {"text": "", "error": str(e), "tokens_used": 0}
        return llm.generate(
            prompt=payload.get("prompt", ""),
            system=payload.get("system", ""),
            max_tokens=payload.get("max_tokens", 500),
            temperature=payload.get("temperature", 0.7),
        )

    elif req_type == "index":
        store = get_vector_store(payload.get("db_dir", ""))
        store.upsert(
            doc_type=payload.get("doc_type", ""),
            doc_id=payload.get("doc_id", ""),
            text=payload.get("text", ""),
        )
        return {"indexed": True}

    elif req_type == "batch_index":
        store = get_vector_store(payload.get("db_dir", ""))
        documents = payload.get("documents", [])
        count = store.batch_upsert(documents)
        return {"indexed": count, "total": len(documents)}

    elif req_type == "search":
        store = get_vector_store(payload.get("db_dir", ""))
        doc_type = payload.get("doc_type", None)
        results = store.query(
            text=payload.get("text", ""),
            n_results=payload.get("n_results", 5),
            doc_type=doc_type,
        )
        return {"results": results}

    elif req_type == "vector_count":
        store = get_vector_store(payload.get("db_dir", ""))
        return {"count": store.count()}

    elif req_type == "agent_chat":
        from agent import agent_chat
        result = agent_chat(
            message=payload.get("message", ""),
            conversation_history=payload.get("conversation_history", []),
            db_path=payload.get("db_path", ""),
            vector_dir=payload.get("vector_dir", ""),
        )
        return result

    elif req_type == "hybrid_search":
        retriever = get_hybrid_retriever(payload.get("db_dir", ""))
        results = retriever.hybrid_search(
            query=payload.get("text", ""),
            n_results=payload.get("n_results", 5),
            doc_type=payload.get("doc_type"),
        )
        return {"results": results}

    elif req_type == "build_bm25":
        retriever = get_hybrid_retriever(payload.get("db_dir", ""))
        documents = payload.get("documents", [])
        count = retriever.build_bm25_index(documents)
        return {"indexed": count}

    else:
        raise ValueError(f"Unknown request type: {req_type}")


def main():
    """Main loop: read JSON lines from stdin, write JSON lines to stdout."""
    # Signal ready
    ready_msg = json.dumps({"id": 0, "result": {"status": "ready"}, "error": None})
    sys.stdout.write(ready_msg + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            resp = {"id": -1, "result": None, "error": f"Invalid JSON: {e}"}
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()
            continue

        req_id = req.get("id", -1)
        req_type = req.get("type", "")
        payload = req.get("payload", {})

        # ── Streaming agent: write chunk lines then the final result ──────────
        if req_type == "agent_stream":
            try:
                from agent import agent_chat_stream
                final_result: dict = {"text": "", "tools_used": [], "model": "unknown", "iterations": 0}
                for item in agent_chat_stream(
                    message=payload.get("message", ""),
                    conversation_history=payload.get("conversation_history", []),
                    db_path=payload.get("db_path", ""),
                    vector_dir=payload.get("vector_dir", ""),
                ):
                    if isinstance(item, str):
                        # Text chunk — write immediately so Node receives it ASAP
                        sys.stdout.write(json.dumps({"id": req_id, "chunk": item}) + "\n")
                        sys.stdout.flush()
                    elif isinstance(item, dict):
                        final_result = item
                resp = {"id": req_id, "result": final_result, "error": None}
            except Exception as e:
                resp = {"id": req_id, "result": None, "error": f"{type(e).__name__}: {e}"}
                print(f"[ENGINE ERROR] {traceback.format_exc()}", file=sys.stderr)

            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()
            continue  # skip normal handler below

        # ── Normal (non-streaming) request ───────────────────────────────────
        try:
            result = handle_request(req)
            resp = {"id": req_id, "result": result, "error": None}
        except Exception as e:
            resp = {"id": req_id, "result": None, "error": f"{type(e).__name__}: {e}"}
            print(f"[ENGINE ERROR] {traceback.format_exc()}", file=sys.stderr)

        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
