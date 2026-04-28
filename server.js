const http = require("node:http");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.REQUEST_TIMEOUT_MS || "45000", 10);
const MAX_BODY_SIZE_BYTES = 1024 * 1024;
const OLLAMA_BASE_URL = sanitizeBaseUrl(process.env.OLLAMA_BASE_URL || "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3";
const FALLBACK_RESPONSE =
  process.env.REMOTE_FALLBACK_RESPONSE ||
  "AVA Core fallback backend is online, but local-first mode is preferred. Start Ollama locally or use browser AI for private responses.";
const SYSTEM_PROMPT = `
  You are AVA Core, a futuristic browser assistant.
  - Be concise, professional, and helpful.
  - Prioritize the provided page content and selected text.
  - If the answer is not fully supported by the page, say you are inferring.
  - Keep answers practical and easy to scan.
  - If the user says "AVA-EXPLAIN", explain the project confidently on behalf of the team leader, mention that the leader is absent, describe the flow as extension to local AI to response, explain that a more stable build is being shown because earlier avatar and voice features were unreliable, offer to show the earlier version via video, mention voice recognition is close but still needs refinement, and close respectfully with future scope. Use "Ma'am" in that explanation.
`.trim();

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (!req.url) {
    sendJson(res, 400, { error: "Missing request URL." });
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && requestUrl.pathname === "/") {
    sendJson(res, 200, {
      service: "AVA Core Node Backend",
      mode: OLLAMA_BASE_URL ? "ollama-proxy" : "local-first-fallback",
      ollamaConfigured: Boolean(OLLAMA_BASE_URL),
      privacy: "Local-first. Remote inference is disabled unless an Ollama endpoint is configured."
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/health") {
    sendJson(res, 200, {
      status: "ok",
      runtime: OLLAMA_BASE_URL ? "ollama" : "fallback",
      model: OLLAMA_MODEL
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/architecture") {
    sendJson(res, 200, {
      backend: "Node.js",
      aiEngine: OLLAMA_BASE_URL ? `Llama 3 via ${OLLAMA_BASE_URL}` : "No remote AI configured",
      dataFlow: OLLAMA_BASE_URL
        ? "Extension -> Node.js -> Ollama"
        : "Extension -> Browser AI / local Ollama",
      cost: "$0 local execution when using browser AI or local Ollama",
      privacy: "Page data stays local by default"
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/ask") {
    try {
      const body = await readJsonBody(req);
      const message = sanitize(body.message) || "N/A";
      const content = sanitize(body.content) || "N/A";
      const prompt = buildRuntimePrompt(message, content);
      const responseText = await generateResponse(prompt);

      sendJson(res, 200, {
        response: responseText || FALLBACK_RESPONSE,
        provider: OLLAMA_BASE_URL ? "ollama" : "fallback",
        model: OLLAMA_MODEL
      });
    } catch (error) {
      console.error("AVA Core backend request failed:", error);
      sendJson(res, 500, {
        response: FALLBACK_RESPONSE,
        error: error.message || "Internal server error"
      });
    }
    return;
  }

  sendJson(res, 404, { error: "Route not found." });
});

server.listen(PORT, HOST, () => {
  console.log(`AVA Core Node backend listening on http://${HOST}:${PORT}`);
});

async function generateResponse(prompt) {
  if (!OLLAMA_BASE_URL) {
    return FALLBACK_RESPONSE;
  }

  const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      system: SYSTEM_PROMPT,
      prompt,
      stream: false
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Ollama request failed with ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  return extractReply(data) || FALLBACK_RESPONSE;
}

function buildRuntimePrompt(message, content) {
  return [
    "User Question:",
    message,
    "",
    "Webpage Content:",
    content
  ].join("\n");
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

function sanitize(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function sanitizeBaseUrl(value) {
  const trimmed = sanitize(value);
  if (!trimmed) {
    return "";
  }

  return trimmed.replace(/\/+$/, "");
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;

      if (size > MAX_BODY_SIZE_BYTES) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }

      body += chunk.toString("utf8");
    });

    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("Request body must be valid JSON."));
      }
    });

    req.on("error", reject);
  });
}
