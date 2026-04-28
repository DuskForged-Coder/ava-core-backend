# AVA Core

AVA Core now uses a local-first architecture.

| Component | Previous | Current |
| --- | --- | --- |
| Backend | Java / Spring Boot | Node.js fallback backend |
| AI Engine | Gemini API | Browser AI first, Ollama second |
| Data Flow | Extension -> Java -> Gemini | Extension -> Browser AI / local Ollama |
| Cost | API credits + hosted AI | $0 for local execution |
| Privacy | Data sent to Google | Page data stays local by default |

## Local runtime

The extension now follows this order:

1. Browser AI if the current Chrome build exposes an on-device language model.
2. Local Ollama at `http://127.0.0.1:11434` or `http://localhost:11434`.
3. A friendly local-only guidance response if no on-device model is available.

Remote fallback is disabled by default inside `ava-core-extension/background.js` so page content is not sent off-device.

## Run the Node backend

```bash
npm start
```

The backend exposes:

- `GET /health`
- `GET /architecture`
- `POST /ask`

If you want the backend to proxy to Ollama, set:

```bash
export OLLAMA_BASE_URL=http://127.0.0.1:11434
export OLLAMA_MODEL=llama3
npm start
```

## Deploy

Render is configured through `render.yaml` and `Dockerfile`. After pushing `main`, Render should rebuild the Node backend automatically on the existing `ava-core-backend` service.

## Legacy code

The Spring Boot + Gemini implementation is still in the repo for reference, but it is no longer the primary architecture.
