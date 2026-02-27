"""
python-engine/llm.py — Local LLM via llama-cpp-python (P2-2)

Loads a GGUF model (Phi-3 Mini or Mistral 7B) on first call.
Keeps model resident in memory — no reload between requests.

Install: pip install llama-cpp-python
Model:   Downloaded automatically to %APPDATA%/aria-bot/models/ on first use.
"""

import os
import sys
import json
import urllib.request
from typing import Optional, Dict, Any


# Default model: Phi-3 Mini 4K Instruct Q4 (~2.2 GB)
DEFAULT_MODEL_URL = (
    "https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf"
    "/resolve/main/Phi-3-mini-4k-instruct-q4.gguf"
)
DEFAULT_MODEL_NAME = "Phi-3-mini-4k-instruct-q4.gguf"

# Persona used for all conversation responses
ARIA_PERSONA = (
    "You're ARIA — a sharp, observant assistant who's been working closely with "
    "this person for months. You know their habits, finances, email patterns. "
    "You speak like a knowledgeable friend — direct, clear, occasionally dry. "
    "You don't hedge. You don't over-explain. You answer what was asked, then stop."
)

EXTRACTION_SYSTEM = "Return only a valid JSON object. No explanation, no markdown, no preamble."


def _models_dir() -> str:
    appdata = os.environ.get("APPDATA") or os.path.expanduser("~")
    d = os.path.join(appdata, "aria-bot", "models")
    os.makedirs(d, exist_ok=True)
    return d


def _download_model(url: str, dest: str) -> None:
    """Stream-download model with progress to stderr."""
    print(f"[LLM] Downloading model to {dest} ...", file=sys.stderr)
    try:
        with urllib.request.urlopen(url) as response:
            total = int(response.headers.get("Content-Length", 0))
            downloaded = 0
            chunk = 1024 * 1024  # 1 MB
            with open(dest, "wb") as f:
                while True:
                    data = response.read(chunk)
                    if not data:
                        break
                    f.write(data)
                    downloaded += len(data)
                    if total:
                        pct = int(downloaded / total * 100)
                        print(f"\r[LLM] {pct}% ({downloaded // (1024*1024)}MB / {total // (1024*1024)}MB)",
                              end="", file=sys.stderr)
        print("\n[LLM] Download complete.", file=sys.stderr)
    except Exception as e:
        if os.path.exists(dest):
            os.remove(dest)
        raise RuntimeError(f"Model download failed: {e}")


class LocalLLM:
    """
    Wraps llama-cpp-python Llama instance.
    Model is loaded once and kept in memory.
    """

    def __init__(
        self,
        model_name: str = DEFAULT_MODEL_NAME,
        model_url: str = DEFAULT_MODEL_URL,
        n_ctx: int = 4096,
        n_threads: int = 4,
    ):
        model_path = os.path.join(_models_dir(), model_name)
        if not os.path.exists(model_path):
            _download_model(model_url, model_path)

        try:
            from llama_cpp import Llama
        except ImportError:
            raise RuntimeError(
                "llama-cpp-python is not installed. "
                "Run: pip install llama-cpp-python"
            )

        print(f"[LLM] Loading {model_name} ...", file=sys.stderr)
        self._llm = Llama(
            model_path=model_path,
            n_ctx=n_ctx,
            n_threads=n_threads,
            verbose=False,
        )
        print("[LLM] Model ready.", file=sys.stderr)

    def generate(
        self,
        prompt: str,
        system: str = "",
        max_tokens: int = 500,
        temperature: float = 0.7,
        stop: Optional[list] = None,
    ) -> Dict[str, Any]:
        """
        Generate a completion.

        Args:
            prompt:      User message / input
            system:      System prompt (defaults to ARIA_PERSONA)
            max_tokens:  Max tokens in response
            temperature: 0.0 = deterministic, 1.0 = creative
            stop:        List of stop sequences

        Returns:
            { "text": str, "tokens_used": int }
        """
        sys_prompt = system or ARIA_PERSONA
        # Build messages list
        messages = [
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": prompt},
        ]

        result = self._llm.create_chat_completion(
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature,
            stop=stop or [],
        )

        text = result["choices"][0]["message"]["content"].strip()
        tokens_used = result.get("usage", {}).get("total_tokens", 0)
        return {"text": text, "tokens_used": tokens_used}

    def extract(self, prompt: str, max_tokens: int = 300) -> Dict[str, Any]:
        """
        Structured extraction call (low temperature, JSON-only system prompt).
        """
        return self.generate(
            prompt=prompt,
            system=EXTRACTION_SYSTEM,
            max_tokens=max_tokens,
            temperature=0.1,
        )
