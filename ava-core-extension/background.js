const REQUEST_TIMEOUT_MS = 45000;
const OLLAMA_MODEL = "llama3";
const OLLAMA_ENDPOINTS = [
  "http://127.0.0.1:11434/api/generate",
  "http://localhost:11434/api/generate"
];
const REMOTE_FALLBACK_ENABLED = true;
const REMOTE_FALLBACK_URL = "https://ava-core-backend.onrender.com/ask";
const LOCAL_ONLY_GUIDANCE =
  "Local-first mode is enabled, but no on-device model is ready yet. Start Ollama with `ollama serve` and pull `llama3`, or use a Chrome build with on-device browser AI enabled.";

chrome.runtime.onInstalled.addListener(() => {
  console.log("AVA Core extension installed in local-first mode.");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "AVA_CORE_GENERATE") {
    return false;
  }

  handleGenerationRequest(message)
    .then(sendResponse)
    .catch((error) => {
      console.error("AVA Core runtime error:", error);
      sendResponse({
        ok: false,
        provider: "runtime-error",
        providerLabel: "Local AI",
        response: LOCAL_ONLY_GUIDANCE
      });
    });

  return true;
});

async function handleGenerationRequest(message) {
  const payload = {
    systemPrompt: sanitize(message.systemPrompt),
    prompt: sanitize(message.prompt),
    userMessage: sanitize(message.message),
    content: sanitize(message.content),
    sessionId: sanitize(message.sessionId),
    pageUrl: sanitize(message.pageUrl),
    history: Array.isArray(message.history) ? message.history : []
  };

  const ollamaReply = await tryLocalOllama(payload);
  if (ollamaReply) {
    return {
      ok: true,
      provider: "ollama",
      providerLabel: "Local Ollama",
      response: ollamaReply
    };
  }

  if (REMOTE_FALLBACK_ENABLED) {
    const remoteReply = await tryRemoteFallback(payload);
    if (remoteReply) {
      return {
        ok: true,
        provider: "node-fallback",
        providerLabel: "Hybrid Search",
        response: remoteReply
      };
    }
  }

  return {
    ok: true,
    provider: "local-guidance",
    providerLabel: "Local AI",
    response: LOCAL_ONLY_GUIDANCE
  };
}

async function tryLocalOllama(payload) {
  for (const url of OLLAMA_ENDPOINTS) {
    try {
      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          system: payload.systemPrompt,
          prompt: payload.prompt,
          stream: false
        })
      });

      if (!response.ok) {
        continue;
      }

      const data = await response.json();
      const reply = extractReply(data);
      if (isUsableModelReply(reply, payload.userMessage)) {
        return reply;
      }
    } catch (error) {
      console.warn(`AVA Core could not reach Ollama at ${url}:`, error);
    }
  }

  return "";
}

async function tryRemoteFallback(payload) {
  try {
    const response = await fetchWithTimeout(REMOTE_FALLBACK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        sessionId: payload.sessionId,
        message: payload.userMessage,
        content: payload.content,
        pageUrl: payload.pageUrl,
        history: payload.history
      })
    });

    if (!response.ok) {
      return "";
    }

    const data = await response.json();
    return extractReply(data);
  } catch (error) {
    console.warn("AVA Core remote fallback is unavailable:", error);
    return "";
  }
}

function extractReply(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const candidateKeys = ["response", "reply", "answer", "message", "result"];
  for (const key of candidateKeys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function sanitize(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function isUsableModelReply(reply, message) {
  const normalizedReply = sanitize(reply);
  if (!normalizedReply || normalizedReply.length < 24) {
    return false;
  }

  if (
    /\b(internal server error|traceback|model not found|failed to fetch|timed out|service unavailable|connection refused)\b/i.test(
      normalizedReply
    )
  ) {
    return false;
  }

  if (/<think>|<\/think>|^\s*\{[\s\S]*\}\s*$|^\s*<html/i.test(normalizedReply)) {
    return false;
  }

  const queryTokens = tokenize(message);
  if (!queryTokens.length) {
    return true;
  }

  const replyTokens = new Set(tokenize(normalizedReply));
  const overlap = queryTokens.filter((token) => replyTokens.has(token)).length;
  return overlap / queryTokens.length >= 0.12;
}

function tokenize(value) {
  return sanitize(value)
    .toLowerCase()
    .replace(/[^a-z0-9.+-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}
