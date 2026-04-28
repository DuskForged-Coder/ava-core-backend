# AVA Core

AVA Core now runs as a hybrid conversational assistant.

| Layer | Current behavior |
| --- | --- |
| Primary answer engine | Browser AI first in the extension, then Ollama-based LLM where available |
| Fallback engine | Deterministic retrieval-and-response backend |
| Backend | Node.js hybrid orchestrator |
| Retrieval sources | Wikipedia, DuckDuckGo, Bing, official docs, official sites, reputable news sites |
| Failure routing | Timeout, API failure, empty response, malformed output, low confidence, unsupported output, or guard failure trigger fallback |

## Hybrid flow

1. The extension tries browser-local AI first.
2. If browser AI is unavailable or the reply looks weak, it tries local Ollama.
3. If the local LLM path still does not produce a usable answer, it calls the hybrid Node backend.
4. The backend tries its own LLM path first when `OLLAMA_BASE_URL` is configured.
5. If that LLM path fails quality checks, the backend switches to the deterministic retrieval engine without exposing the failure to the user.

## Fallback modules

The backend includes:

- LLM response monitor
- Failure detector
- Rule-based intent classifier
- Regex and grammar entity extractor
- Session memory
- Query rewriting engine
- Search-provider router
- Result trust scorer
- Web page fetcher and passage extractor
- Extractive summarizer
- Response template engine
- Clarification and fallback recovery manager

## Run locally

```bash
npm start
```

To enable server-side Ollama for the LLM-first backend path:

```bash
export OLLAMA_BASE_URL=http://127.0.0.1:11434
export OLLAMA_MODEL=llama3
npm start
```

Optional tuning:

```bash
export REQUEST_TIMEOUT_MS=12000
export RETRIEVAL_BUDGET_MS=18000
export RETRIEVAL_MAX_ATTEMPTS=8
export LLM_CONFIDENCE_THRESHOLD=0.58
```

## API surface

- `GET /health`
- `GET /architecture`
- `POST /ask`

Example request:

```json
{
  "sessionId": "ava-example-session",
  "message": "What is Ollama and why would I use it?",
  "content": "Current page text goes here",
  "pageUrl": "https://ollama.com/",
  "history": [
    { "role": "user", "text": "Tell me about local AI tools" }
  ]
}
```

## Notes

- The extension now sends session context to the backend fallback path so follow-up questions can stay coherent.
- The backend never exposes raw LLM failure messages to the user.
- The Spring Boot + Gemini code remains in the repo for reference, but it is no longer the primary serving path.
