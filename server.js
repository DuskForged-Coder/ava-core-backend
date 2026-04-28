const http = require("node:http");
const { HybridConversationAssistant } = require("./lib/hybrid-assistant");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const MAX_BODY_SIZE_BYTES = 1024 * 1024;

const assistant = new HybridConversationAssistant({
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "",
  ollamaModel: process.env.OLLAMA_MODEL || "llama3",
  requestTimeoutMs: process.env.REQUEST_TIMEOUT_MS || "12000",
  retrievalBudgetMs: process.env.RETRIEVAL_BUDGET_MS || "18000",
  maxAttempts: process.env.RETRIEVAL_MAX_ATTEMPTS || "8",
  confidenceThreshold: process.env.LLM_CONFIDENCE_THRESHOLD || "0.58"
});

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
      service: "AVA Core Hybrid Backend",
      backend: "Node.js",
      llmFirst: true,
      fallback: "Deterministic retrieval and response engine"
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/health") {
    sendJson(res, 200, {
      status: "ok",
      backend: "node",
      llmConfigured: Boolean(process.env.OLLAMA_BASE_URL),
      llmModel: process.env.OLLAMA_MODEL || "llama3",
      fallbackMode: "retrieval"
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/architecture") {
    sendJson(res, 200, {
      backend: "Node.js hybrid orchestrator",
      llmPrimary: Boolean(process.env.OLLAMA_BASE_URL) ? "Llama 3 via Ollama" : "Configured by client or disabled on server",
      fallback: "Rule-based retrieval engine",
      modules: [
        "LLM response monitor",
        "Failure detector",
        "Rule-based intent classifier",
        "Regex and grammar entity extractor",
        "Session memory",
        "Query rewriting engine",
        "Search-provider router",
        "Result trust scorer",
        "Web page fetcher and passage extractor",
        "Extractive summarizer",
        "Response template engine",
        "Clarification and fallback recovery manager"
      ]
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/ask") {
    try {
      const body = await readJsonBody(req);
      const result = await assistant.handleRequest({
        sessionId: body.sessionId,
        message: body.message,
        content: body.content,
        pageUrl: body.pageUrl,
        history: body.history
      });

      sendJson(res, 200, result);
    } catch (error) {
      console.error("AVA Core backend request failed:", error);
      sendJson(res, 500, {
        response:
          "I couldn’t finish verifying that just yet. If you narrow the topic or product name, I can refine the search.",
        mode: "server-guard",
        provider: "rule-based-web",
        sources: []
      });
    }
    return;
  }

  sendJson(res, 404, { error: "Route not found." });
});

server.listen(PORT, HOST, () => {
  console.log(`AVA Core Node backend listening on http://${HOST}:${PORT}`);
});

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
