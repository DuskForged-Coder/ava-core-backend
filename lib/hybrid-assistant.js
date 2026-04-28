const REQUEST_USER_AGENT =
  "AVA Core Hybrid Assistant/1.2 (+https://github.com/DuskForged-Coder/ava-core-backend)";
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSION_HISTORY = 8;
const MAX_SEARCH_RESULTS_PER_PROVIDER = 5;
const MAX_FETCHED_RESULTS_PER_ATTEMPT = 4;
const MAX_PASSAGES_PER_RESULT = 4;

const FOLLOW_UP_TOKENS = new Set([
  "it",
  "its",
  "they",
  "them",
  "that",
  "those",
  "this",
  "these",
  "he",
  "she",
  "his",
  "her",
  "their",
  "there",
  "here"
]);

const STOPWORDS = new Set([
  "a",
  "about",
  "all",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "does",
  "for",
  "from",
  "get",
  "give",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "latest",
  "me",
  "my",
  "of",
  "on",
  "or",
  "please",
  "show",
  "tell",
  "the",
  "this",
  "to",
  "up",
  "use",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "you",
  "your"
]);

const NEWS_DOMAINS = [
  "reuters.com",
  "apnews.com",
  "bbc.com",
  "wsj.com",
  "nytimes.com",
  "theverge.com",
  "techcrunch.com"
];

const LOW_TRUST_DOMAINS = [
  "reddit.com",
  "quora.com",
  "medium.com",
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "tiktok.com"
];

const OFFICIAL_DOMAIN_DICTIONARY = {
  chrome: ["developer.chrome.com", "support.google.com", "google.com"],
  docker: ["docs.docker.com", "docker.com"],
  gemini: ["ai.google.dev", "deepmind.google", "google.com"],
  github: ["docs.github.com", "github.com"],
  google: ["developers.google.com", "support.google.com", "google.com"],
  java: ["docs.oracle.com", "oracle.com"],
  llama: ["llama.com", "ai.meta.com", "meta.com"],
  next: ["nextjs.org", "vercel.com"],
  "next.js": ["nextjs.org", "vercel.com"],
  node: ["nodejs.org", "npmjs.com"],
  npm: ["docs.npmjs.com", "npmjs.com"],
  ollama: ["ollama.com"],
  openai: ["platform.openai.com", "help.openai.com", "openai.com"],
  python: ["docs.python.org", "python.org"],
  react: ["react.dev"],
  render: ["render.com"],
  spring: ["spring.io", "docs.spring.io"],
  "spring boot": ["spring.io", "docs.spring.io"],
  wikipedia: ["wikipedia.org"]
};

const INTERNAL_FAILURE_PATTERN =
  /\b(internal server error|traceback|stack trace|model not found|connection refused|failed to fetch|fetch failed|socket hang up|timed out|service unavailable|dns|econnrefused|error code)\b/i;
const LOW_CONFIDENCE_PATTERN =
  /\b(not sure|maybe|possibly|i think|i guess|cannot verify|can't verify|unable to verify|don't know|do not know)\b/i;
const UNSUPPORTED_OUTPUT_PATTERN =
  /(<think>|<\/think>|^\s*\{[\s\S]*\}\s*$|^\s*\[[\s\S]*\]\s*$|^\s*<!doctype html|^\s*<html)/i;

class SessionMemory {
  constructor() {
    this.sessions = new Map();
  }

  get(sessionId) {
    this.cleanup();

    const key = sanitize(sessionId) || "anonymous-session";
    if (!this.sessions.has(key)) {
      this.sessions.set(key, {
        history: [],
        lastTopic: "",
        lastEntities: null,
        lastIntent: "general_search",
        unresolvedSlots: [],
        lastPageUrl: "",
        updatedAt: Date.now()
      });
    }

    const session = this.sessions.get(key);
    session.updatedAt = Date.now();
    return session;
  }

  bootstrap(sessionId, history) {
    if (!Array.isArray(history) || !history.length) {
      return;
    }

    const session = this.get(sessionId);
    session.history = dedupeHistory(history).slice(-MAX_SESSION_HISTORY);

    const lastUserTurn = [...session.history].reverse().find((item) => item.role === "user");
    if (lastUserTurn?.text && !session.lastTopic) {
      session.lastTopic = deriveTopicFromText(lastUserTurn.text);
    }
  }

  update(sessionId, update) {
    const session = this.get(sessionId);

    if (update.lastTopic) {
      session.lastTopic = update.lastTopic;
    }

    if (update.lastEntities) {
      session.lastEntities = update.lastEntities;
    }

    if (update.lastIntent) {
      session.lastIntent = update.lastIntent;
    }

    if (Array.isArray(update.unresolvedSlots)) {
      session.unresolvedSlots = update.unresolvedSlots.filter(Boolean).slice(0, 4);
    }

    if (update.lastPageUrl) {
      session.lastPageUrl = update.lastPageUrl;
    }

    if (Array.isArray(update.history) && update.history.length) {
      const combinedHistory = [...session.history, ...update.history];
      session.history = dedupeHistory(combinedHistory).slice(-MAX_SESSION_HISTORY);
    }

    session.updatedAt = Date.now();
  }

  cleanup() {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.updatedAt < cutoff) {
        this.sessions.delete(sessionId);
      }
    }
  }
}

class LlmResponseMonitor {
  constructor({ confidenceThreshold }) {
    this.confidenceThreshold = confidenceThreshold;
  }

  inspect({ query, responseText, durationMs }) {
    const issues = [];
    const response = sanitize(responseText);

    if (!response) {
      issues.push("empty-response");
    }

    if (response && response.length < 24) {
      issues.push("too-short");
    }

    if (response && INTERNAL_FAILURE_PATTERN.test(response)) {
      issues.push("internal-failure-text");
    }

    if (response && UNSUPPORTED_OUTPUT_PATTERN.test(response)) {
      issues.push("unsupported-output");
    }

    const overlap = calculateTokenOverlap(tokenize(query), tokenize(response));
    let confidence = 0.52 + overlap * 0.42;

    if (LOW_CONFIDENCE_PATTERN.test(response)) {
      confidence -= 0.2;
      issues.push("uncertain-language");
    }

    if (response.length > 80) {
      confidence += 0.08;
    }

    if (durationMs > 12000) {
      confidence -= 0.08;
      issues.push("slow-response");
    }

    if (!endsWithTerminalPunctuation(response)) {
      confidence -= 0.05;
    }

    if (issues.includes("internal-failure-text") || issues.includes("unsupported-output")) {
      confidence = 0;
    }

    if (issues.includes("empty-response")) {
      confidence = 0;
    }

    return {
      confidence: clamp(confidence, 0, 1),
      issues,
      isValid: clamp(confidence, 0, 1) >= this.confidenceThreshold && !issues.includes("empty-response")
    };
  }
}

class FailureDetector {
  detect({ monitorReport, error }) {
    if (error) {
      return {
        shouldFallback: true,
        reasons: [error.name === "AbortError" ? "timeout" : "api-failure"]
      };
    }

    if (!monitorReport) {
      return {
        shouldFallback: true,
        reasons: ["monitor-missing"]
      };
    }

    const reasons = [...monitorReport.issues];
    if (monitorReport.confidence < 0.58) {
      reasons.push("confidence-below-threshold");
    }

    return {
      shouldFallback: reasons.length > 0 || !monitorReport.isValid,
      reasons
    };
  }
}

class RuleBasedIntentClassifier {
  classify(query, session) {
    const normalized = query.toLowerCase();

    if (/(latest|today|recent|breaking|this week|this month|newest)/.test(normalized)) {
      return { name: "news", needsFreshness: true, preferredSourceType: "news" };
    }

    if (/(api|sdk|docs|documentation|reference|endpoint|install|setup|error|bug|configuration|config)/.test(normalized)) {
      return { name: "product_docs", needsFreshness: true, preferredSourceType: "official" };
    }

    if (/(policy|privacy|terms|pricing|license|refund|security|compliance)/.test(normalized)) {
      return { name: "company_policy", needsFreshness: true, preferredSourceType: "official" };
    }

    if (/(compare|difference|vs\b|versus)/.test(normalized)) {
      return { name: "comparison", needsFreshness: false, preferredSourceType: "official" };
    }

    if (/(who is|what is|tell me about|history of|overview of|summary of)/.test(normalized)) {
      return { name: "encyclopedic", needsFreshness: false, preferredSourceType: "encyclopedic" };
    }

    if (/(how do i|how to|steps|guide|tutorial)/.test(normalized)) {
      return { name: "how_to", needsFreshness: true, preferredSourceType: "official" };
    }

    if (looksLikeFollowUp(normalized) && session?.lastTopic) {
      return {
        name: session.lastIntent || "general_search",
        needsFreshness: session.lastIntent === "news",
        preferredSourceType: "session-follow-up"
      };
    }

    return { name: "general_search", needsFreshness: false, preferredSourceType: "web" };
  }
}

class EntityExtractor {
  extract(query, { session, pageUrl, history }) {
    const domains = [...query.matchAll(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi)].map((match) => match[0].toLowerCase());
    const versions = [...query.matchAll(/\b\d+(?:\.\d+){1,3}\b/g)].map((match) => match[0]);
    const years = [...query.matchAll(/\b(19|20)\d{2}\b/g)].map((match) => match[0]);
    const quotedPhrases = [...query.matchAll(/"([^"]+)"/g)].map((match) => match[1].trim()).filter(Boolean);
    const capitalizedPhrases = [...query.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z0-9.+-]+){0,4})\b/g)]
      .map((match) => match[1].trim())
      .filter((value) => value.length > 2);

    const pageDomain = extractDomain(pageUrl);
    const domainHints = unique([
      ...domains,
      ...lookupOfficialDomains(query),
      ...(pageDomain ? [pageDomain] : []),
      ...(session?.lastPageUrl ? [extractDomain(session.lastPageUrl)] : [])
    ].filter(Boolean));

    let primaryTopic =
      quotedPhrases[0] ||
      capitalizedPhrases[0] ||
      deriveTopicFromText(query) ||
      session?.lastTopic ||
      deriveTopicFromHistory(history);

    if (!primaryTopic && pageDomain) {
      primaryTopic = pageDomain;
    }

    const missingSlots = [];
    if (looksLikeFollowUp(query) && !session?.lastTopic) {
      missingSlots.push("reference-topic");
    }

    if (/(api|docs|documentation|pricing|policy|privacy|install|setup)/i.test(query) && !primaryTopic && !domainHints.length) {
      missingSlots.push("product-or-company");
    }

    if (/(latest|recent|today|news)/i.test(query) && !primaryTopic) {
      missingSlots.push("news-subject");
    }

    return {
      domains,
      domainHints,
      versions,
      years,
      quotedPhrases,
      capitalizedPhrases,
      primaryTopic: sanitize(primaryTopic),
      missingSlots
    };
  }
}

class QueryRewriter {
  buildAttempts({ query, intent, entities, session, pageUrl }) {
    const resolvedQuery = resolveFollowUpQuery(query, entities, session);
    const officialDomains = unique([
      ...entities.domainHints,
      ...lookupOfficialDomains(entities.primaryTopic || resolvedQuery)
    ]);
    const newsQueries = NEWS_DOMAINS.map((domain) => `site:${domain} ${resolvedQuery}`);
    const generalExpansions = buildGeneralExpansions(resolvedQuery, intent);
    const officialQueries = officialDomains.slice(0, 3).map((domain) => `site:${domain} ${resolvedQuery}`);
    const topicFragments = decomposeTopic(resolvedQuery, entities.primaryTopic);

    const attempts = [];

    if (intent.name === "encyclopedic") {
      attempts.push({ route: "wikipedia-first", query: resolvedQuery, label: "encyclopedic-primary" });
    }

    if (intent.name === "product_docs" || intent.name === "company_policy" || intent.name === "how_to") {
      officialQueries.forEach((officialQuery) => {
        attempts.push({ route: "official-first", query: officialQuery, label: "official-domain" });
      });
      attempts.push({ route: "official-first", query: `${resolvedQuery} official documentation`, label: "official-keyword" });
    }

    if (intent.name === "news") {
      newsQueries.slice(0, 4).forEach((newsQuery) => {
        attempts.push({ route: "news-first", query: newsQuery, label: "news-domain" });
      });
      attempts.push({ route: "news-first", query: `${resolvedQuery} latest news`, label: "news-general" });
    }

    attempts.push({ route: "general-first", query: resolvedQuery, label: "general-primary" });

    generalExpansions.forEach((rewrittenQuery) => {
      attempts.push({ route: "general-first", query: rewrittenQuery, label: "general-rewrite" });
    });

    topicFragments.forEach((fragment) => {
      attempts.push({ route: "general-first", query: fragment, label: "topic-decomposition" });
    });

    if (entities.primaryTopic && intent.name !== "encyclopedic") {
      attempts.push({
        route: "wikipedia-first",
        query: entities.primaryTopic,
        label: "encyclopedic-backstop"
      });
    }

    if (pageUrl) {
      attempts.push({
        route: "official-first",
        query: `site:${extractDomain(pageUrl)} ${resolvedQuery}`,
        label: "current-page-domain"
      });
    }

    return uniqueAttempts(attempts).slice(0, 12);
  }
}

class SearchProviderRouter {
  constructor(config) {
    this.config = config;
  }

  async searchAttempt(attempt, context) {
    const results = [];

    if (attempt.route === "wikipedia-first") {
      results.push(...(await this.searchWikipedia(attempt.query)));
      results.push(...(await this.searchDuckDuckGo(attempt.query)));
      results.push(...(await this.searchBing(attempt.query)));
    } else if (attempt.route === "official-first") {
      results.push(...(await this.searchDuckDuckGo(attempt.query)));
      results.push(...(await this.searchBing(attempt.query)));
    } else if (attempt.route === "news-first") {
      results.push(...(await this.searchDuckDuckGo(attempt.query)));
      results.push(...(await this.searchBing(attempt.query)));
    } else {
      results.push(...(await this.searchDuckDuckGo(attempt.query)));
      results.push(...(await this.searchBing(attempt.query)));
      if (context.intent.name === "general_search" || context.intent.name === "comparison") {
        results.push(...(await this.searchWikipedia(attempt.query)));
      }
    }

    return dedupeResults(results);
  }

  async searchWikipedia(query) {
    const url = new URL("https://en.wikipedia.org/w/api.php");
    url.searchParams.set("action", "query");
    url.searchParams.set("list", "search");
    url.searchParams.set("format", "json");
    url.searchParams.set("srlimit", String(MAX_SEARCH_RESULTS_PER_PROVIDER));
    url.searchParams.set("srsearch", query);

    try {
      const response = await fetchWithTimeout(url.toString(), {
        headers: buildHeaders()
      }, this.config.requestTimeoutMs);

      if (!response.ok) {
        return [];
      }

      const payload = await response.json();
      const items = payload?.query?.search || [];

      return items.map((item) => ({
        provider: "wikipedia",
        sourceType: "encyclopedic",
        sourceName: "Wikipedia",
        title: sanitize(item.title),
        snippet: cleanText(item.snippet),
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/\s+/g, "_"))}`,
        wikiTitle: sanitize(item.title)
      }));
    } catch (error) {
      console.warn("Wikipedia search failed:", error.message);
      return [];
    }
  }

  async searchDuckDuckGo(query) {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    try {
      const response = await fetchWithTimeout(searchUrl, {
        headers: buildHeaders()
      }, this.config.requestTimeoutMs);

      if (!response.ok) {
        return [];
      }

      const html = await response.text();
      return parseDuckDuckGoResults(html);
    } catch (error) {
      console.warn("DuckDuckGo search failed:", error.message);
      return [];
    }
  }

  async searchBing(query) {
    const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;

    try {
      const response = await fetchWithTimeout(searchUrl, {
        headers: buildHeaders()
      }, this.config.requestTimeoutMs);

      if (!response.ok) {
        return [];
      }

      const html = await response.text();
      return parseBingResults(html);
    } catch (error) {
      console.warn("Bing search failed:", error.message);
      return [];
    }
  }
}

class ResultTrustScorer {
  scoreResult(result, context) {
    const domain = extractDomain(result.url);
    const titleAndSnippet = `${result.title || ""} ${result.snippet || ""}`.trim();
    const tokenOverlap = calculateTokenOverlap(tokenize(context.rewrittenQuery), tokenize(titleAndSnippet));
    const freshnessBoost =
      context.intent.name === "news" && /(202[4-9]|latest|today|week|month)/i.test(titleAndSnippet) ? 0.08 : 0;

    let trust = 0.42;
    if (!domain) {
      trust = 0.35;
    } else if (isOfficialDomain(domain, context.entities.domainHints)) {
      trust = 0.96;
    } else if (domain.endsWith("wikipedia.org")) {
      trust = 0.88;
    } else if (NEWS_DOMAINS.some((item) => domain.endsWith(item))) {
      trust = 0.84;
    } else if (/docs|developer|support|help/.test(domain)) {
      trust = 0.8;
    } else if (LOW_TRUST_DOMAINS.some((item) => domain.endsWith(item))) {
      trust = 0.18;
    }

    return clamp(trust * 0.68 + tokenOverlap * 0.32 + freshnessBoost, 0, 1);
  }

  rankResults(results, context) {
    return results
      .map((result) => ({
        ...result,
        score: this.scoreResult(result, context)
      }))
      .sort((left, right) => right.score - left.score);
  }

  scorePassage(passage, result, context) {
    const overlap = calculateTokenOverlap(tokenize(context.rewrittenQuery), tokenize(passage.text));
    return clamp(result.score * 0.55 + overlap * 0.45, 0, 1);
  }
}

class WebPageFetcher {
  constructor(config, scorer) {
    this.config = config;
    this.scorer = scorer;
  }

  async enrichResults(results, context) {
    const limitedResults = results.slice(0, MAX_FETCHED_RESULTS_PER_ATTEMPT);
    const enriched = await Promise.all(limitedResults.map((result) => this.fetchResult(result, context)));
    return enriched.filter(Boolean);
  }

  async fetchResult(result, context) {
    if (result.prefetchedText && result.prefetchedText.length > 280) {
      return this.buildEnrichedResult(result, result.prefetchedText, context);
    }

    if (result.wikiTitle) {
      const summary = await this.fetchWikipediaSummary(result.wikiTitle);
      if (summary) {
        return this.buildEnrichedResult(
          {
            ...result,
            title: result.title || summary.title,
            snippet: result.snippet || summary.extract
          },
          summary.extract,
          context
        );
      }
    }

    try {
      const response = await fetchWithTimeout(result.url, {
        headers: buildHeaders({
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        })
      }, this.config.requestTimeoutMs);

      if (!response.ok) {
        return this.buildEnrichedResult(result, result.snippet, context);
      }

      const html = await response.text();
      const text = extractReadableText(html) || result.snippet;
      return this.buildEnrichedResult(result, text, context);
    } catch (error) {
      return this.buildEnrichedResult(result, result.snippet, context);
    }
  }

  async fetchWikipediaSummary(title) {
    const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;

    try {
      const response = await fetchWithTimeout(summaryUrl, {
        headers: buildHeaders()
      }, this.config.requestTimeoutMs);

      if (!response.ok) {
        return null;
      }

      const payload = await response.json();
      return {
        title: sanitize(payload.title),
        extract: sanitize(payload.extract)
      };
    } catch (error) {
      return null;
    }
  }

  buildEnrichedResult(result, text, context) {
    const passages = extractPassages(text, tokenize(context.rewrittenQuery))
      .slice(0, MAX_PASSAGES_PER_RESULT)
      .map((passage) => ({
        ...passage,
        score: this.scorer.scorePassage(passage, result, context)
      }));

    return {
      ...result,
      passages
    };
  }
}

class ExtractiveSummarizer {
  summarize(enrichedResults, context) {
    const candidateFacts = [];
    const expectsDefinition = /^(what is|who is|what are|who are|tell me about)\b/i.test(context.originalQuery);

    for (const result of enrichedResults) {
      const sourceLabel = result.sourceName || extractDomain(result.url) || "Source";
      const baseSnippet = sanitize(result.snippet);

      if (baseSnippet) {
        const normalizedSnippet = normalizeSentence(baseSnippet);
        candidateFacts.push({
          text: normalizedSnippet,
          score: adjustFactScore(normalizedSnippet, result.score * 0.82, expectsDefinition),
          sourceName: sourceLabel,
          url: result.url
        });
      }

      for (const passage of result.passages || []) {
        const normalizedPassage = normalizeSentence(passage.text);
        candidateFacts.push({
          text: normalizedPassage,
          score: adjustFactScore(normalizedPassage, passage.score, expectsDefinition),
          sourceName: sourceLabel,
          url: result.url
        });
      }
    }

    const rankedFacts = dedupeFacts(candidateFacts)
      .filter((fact) => fact.text.length >= 30)
      .filter((fact) => !looksPromotionalFact(fact.text))
      .sort((left, right) => right.score - left.score);

    if (!rankedFacts.length) {
      return {
        directAnswer: "",
        supportingDetail: "",
        confidence: 0,
        isSufficient: false,
        sources: []
      };
    }

    const topFacts = rankedFacts.slice(0, 4);
    const directAnswer = topFacts[0].text;
    const supportingFacts = topFacts.slice(1, 3).map((fact) => fact.text);
    const distinctSources = unique(topFacts.map((fact) => fact.sourceName));
    const definitionLike = looksDefinitionLike(directAnswer);
    const confidence = clamp(
      topFacts[0].score * 0.72 +
        distinctSources.length * 0.08 +
        (supportingFacts.length ? 0.06 : 0) -
        (expectsDefinition && !definitionLike ? 0.18 : 0),
      0,
      1
    );
    const hasStrongSource = topFacts[0].score >= 0.7;
    const isSufficient =
      hasStrongSource &&
      (!expectsDefinition || definitionLike) &&
      (supportingFacts.length > 0 || context.intent.name === "company_policy");

    return {
      directAnswer,
      supportingDetail: supportingFacts.join(" "),
      confidence,
      isSufficient,
      sources: topFacts.map((fact) => ({
        name: fact.sourceName,
        url: fact.url
      }))
    };
  }
}

class ResponseTemplateEngine {
  render(answerPack, context) {
    const variant = stableHash(`${context.sessionId}:${context.originalQuery}`) % 3;
    const supportIntro = [
      "A bit more context:",
      "Supporting detail:",
      "What I found:"
    ][variant];
    const sourceIntro = [
      "Sources:",
      "Checked sources:",
      "Main sources:"
    ][variant];

    let response = ensureSentence(answerPack.directAnswer);
    if (answerPack.supportingDetail) {
      response += ` ${supportIntro} ${ensureSentence(answerPack.supportingDetail)}`;
    }

    const dedupedSources = uniqueByKey(answerPack.sources || [], (item) => item.url || item.name).slice(0, 3);
    if (dedupedSources.length) {
      response += ` ${sourceIntro} ${dedupedSources.map((item) => item.name).join(", ")}.`;
    }

    return {
      response,
      mode: "retrieval-fallback",
      provider: "rule-based-web",
      confidence: answerPack.confidence,
      sources: dedupedSources
    };
  }

  renderPartial(answerPack, context) {
    const partialLead = [
      "Here’s the strongest answer I could verify:",
      "This is the clearest verified answer I found:",
      "Based on the most reliable evidence I found:"
    ][stableHash(`${context.sessionId}:partial:${context.originalQuery}`) % 3];

    let response = `${partialLead} ${ensureSentence(answerPack.directAnswer)}`;
    if (answerPack.supportingDetail) {
      response += ` ${ensureSentence(answerPack.supportingDetail)}`;
    }

    const dedupedSources = uniqueByKey(answerPack.sources || [], (item) => item.url || item.name).slice(0, 3);
    if (dedupedSources.length) {
      response += ` Sources: ${dedupedSources.map((item) => item.name).join(", ")}.`;
    }

    return {
      response,
      mode: "retrieval-partial",
      provider: "rule-based-web",
      confidence: answerPack.confidence,
      sources: dedupedSources
    };
  }
}

class ClarificationAndRecoveryManager {
  getClarification({ query, intent, entities, session }) {
    if (entities.missingSlots.includes("reference-topic")) {
      return "Which topic are you referring to?";
    }

    if (entities.missingSlots.includes("news-subject")) {
      return "What topic, company, or person should I check the latest news for?";
    }

    if (entities.missingSlots.includes("product-or-company")) {
      return "Which product, API, or company should I look up?";
    }

    if (tokenize(query).length < 2 && !entities.primaryTopic && !session?.lastTopic) {
      return "What topic do you want me to look up?";
    }

    if (intent.name === "comparison" && !/\b(vs|versus|compare)\b/i.test(query) && !entities.primaryTopic) {
      return "What two things do you want me to compare?";
    }

    return "";
  }

  buildNoReliableSourceAnswer(context) {
    if (context.intent.name === "news") {
      return {
        response:
          "I couldn’t verify that from authoritative news sources yet. If you narrow it to the exact company, person, or date range, I can refine the search.",
        mode: "no-reliable-source",
        provider: "rule-based-web",
        confidence: 0,
        sources: []
      };
    }

    return {
      response:
        "I couldn’t verify that confidently from authoritative sources just now. If you give me a more specific product, company, page, or date range, I can narrow it down.",
      mode: "no-reliable-source",
      provider: "rule-based-web",
      confidence: 0,
      sources: []
    };
  }
}

class HybridConversationAssistant {
  constructor(config = {}) {
    this.config = {
      ollamaBaseUrl: sanitizeBaseUrl(config.ollamaBaseUrl),
      ollamaModel: sanitize(config.ollamaModel) || "llama3",
      requestTimeoutMs: Number.parseInt(config.requestTimeoutMs || "12000", 10),
      retrievalBudgetMs: Number.parseInt(config.retrievalBudgetMs || "18000", 10),
      maxAttempts: Number.parseInt(config.maxAttempts || "8", 10),
      confidenceThreshold: Number.parseFloat(config.confidenceThreshold || "0.58")
    };

    this.memory = new SessionMemory();
    this.monitor = new LlmResponseMonitor({
      confidenceThreshold: this.config.confidenceThreshold
    });
    this.failureDetector = new FailureDetector();
    this.intentClassifier = new RuleBasedIntentClassifier();
    this.entityExtractor = new EntityExtractor();
    this.queryRewriter = new QueryRewriter();
    this.scorer = new ResultTrustScorer();
    this.searchRouter = new SearchProviderRouter(this.config);
    this.fetcher = new WebPageFetcher(this.config, this.scorer);
    this.summarizer = new ExtractiveSummarizer();
    this.templateEngine = new ResponseTemplateEngine();
    this.recoveryManager = new ClarificationAndRecoveryManager();
  }

  async handleRequest({ sessionId, message, content, pageUrl, history }) {
    const normalizedMessage = sanitize(message);
    const rewrittenSessionId = sanitize(sessionId) || buildFallbackSessionId(pageUrl, normalizedMessage);
    const cleanPageUrl = sanitize(pageUrl);
    const cleanHistory = Array.isArray(history) ? history : [];

    this.memory.bootstrap(rewrittenSessionId, cleanHistory);

    const session = this.memory.get(rewrittenSessionId);
    const intent = this.intentClassifier.classify(normalizedMessage, session);
    const entities = this.entityExtractor.extract(normalizedMessage, {
      session,
      pageUrl: cleanPageUrl,
      history: cleanHistory
    });
    const clarification = this.recoveryManager.getClarification({
      query: normalizedMessage,
      intent,
      entities,
      session
    });

    if (clarification) {
      this.memory.update(rewrittenSessionId, {
        lastIntent: intent.name,
        lastEntities: entities,
        unresolvedSlots: entities.missingSlots,
        lastPageUrl: cleanPageUrl,
        history: [{ role: "user", text: normalizedMessage }]
      });

      return {
        response: clarification,
        mode: "clarification",
        provider: "rule-based-web",
        confidence: 1,
        sources: []
      };
    }

    const context = {
      sessionId: rewrittenSessionId,
      originalQuery: normalizedMessage,
      rewrittenQuery: resolveFollowUpQuery(normalizedMessage, entities, session),
      intent,
      entities,
      session,
      pageUrl: cleanPageUrl,
      content: sanitize(content),
      history: cleanHistory
    };

    const llmAnswer = await this.tryLlmFirst(context);
    if (!llmAnswer.shouldFallback) {
      this.memory.update(rewrittenSessionId, {
        lastTopic: entities.primaryTopic || deriveTopicFromText(context.rewrittenQuery),
        lastIntent: intent.name,
        lastEntities: entities,
        unresolvedSlots: [],
        lastPageUrl: cleanPageUrl,
        history: [
          { role: "user", text: normalizedMessage },
          { role: "assistant", text: llmAnswer.response }
        ]
      });

      return llmAnswer;
    }

    const fallbackAnswer = await this.runFallback(context);
    this.memory.update(rewrittenSessionId, {
      lastTopic: entities.primaryTopic || deriveTopicFromText(context.rewrittenQuery),
      lastIntent: intent.name,
      lastEntities: entities,
      unresolvedSlots: [],
      lastPageUrl: cleanPageUrl,
      history: [
        { role: "user", text: normalizedMessage },
        { role: "assistant", text: fallbackAnswer.response }
      ]
    });

    return fallbackAnswer;
  }

  async tryLlmFirst(context) {
    if (!this.config.ollamaBaseUrl) {
      return {
        shouldFallback: true,
        reasons: ["llm-unavailable"]
      };
    }

    const prompt = buildRuntimePrompt({
      message: context.originalQuery,
      content: context.content,
      history: context.history,
      pageUrl: context.pageUrl
    });

    const startedAt = Date.now();

    try {
      const response = await fetchWithTimeout(`${this.config.ollamaBaseUrl}/api/generate`, {
        method: "POST",
        headers: {
          ...buildHeaders(),
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.config.ollamaModel,
          system: buildLlmSystemPrompt(context),
          prompt,
          stream: false
        })
      }, this.config.requestTimeoutMs);

      if (!response.ok) {
        const errorBody = await response.text();
        const error = new Error(`LLM returned ${response.status}: ${errorBody}`);
        return {
          shouldFallback: true,
          reasons: ["api-failure"],
          error
        };
      }

      const payload = await response.json();
      const responseText = extractReply(payload);
      const monitorReport = this.monitor.inspect({
        query: context.rewrittenQuery,
        responseText,
        durationMs: Date.now() - startedAt
      });
      const failure = this.failureDetector.detect({
        monitorReport
      });

      if (failure.shouldFallback) {
        return {
          shouldFallback: true,
          reasons: failure.reasons
        };
      }

      return {
        shouldFallback: false,
        response: sanitize(responseText),
        mode: "llm-primary",
        provider: "llm",
        confidence: monitorReport.confidence,
        sources: []
      };
    } catch (error) {
      const failure = this.failureDetector.detect({ error });
      return {
        shouldFallback: true,
        reasons: failure.reasons,
        error
      };
    }
  }

  async runFallback(context) {
    const deadline = Date.now() + this.config.retrievalBudgetMs;
    const attempts = this.queryRewriter.buildAttempts({
      query: context.originalQuery,
      intent: context.intent,
      entities: context.entities,
      session: context.session,
      pageUrl: context.pageUrl
    });
    let bestCandidate = null;
    const seededResults = buildPageSeedResult(context);

    for (const attempt of attempts.slice(0, this.config.maxAttempts)) {
      if (Date.now() >= deadline) {
        break;
      }

      const attemptContext = {
        ...context,
        rewrittenQuery: attempt.query
      };

      const searchResults = await this.searchRouter.searchAttempt(attempt, attemptContext);
      const rankedResults = this.scorer.rankResults(
        dedupeResults([...seededResults, ...searchResults]),
        attemptContext
      );
      const enrichedResults = await this.fetcher.enrichResults(rankedResults, attemptContext);
      const summary = this.summarizer.summarize(enrichedResults, attemptContext);

      if (!bestCandidate || summary.confidence > bestCandidate.confidence) {
        bestCandidate = summary;
      }

      if (summary.isSufficient) {
        return this.templateEngine.render(summary, attemptContext);
      }
    }

    if (bestCandidate && bestCandidate.directAnswer && bestCandidate.confidence >= 0.44) {
      return this.templateEngine.renderPartial(bestCandidate, context);
    }

    return this.recoveryManager.buildNoReliableSourceAnswer(context);
  }
}

function buildLlmSystemPrompt(context) {
  return `
    You are AVA Core, a conversational browser assistant.
    - Answer directly first, then add brief supporting detail.
    - Prioritize the provided page content when it is relevant.
    - Stay concise and natural.
    - If the user asks about recent facts, mention that freshness matters and answer only if the context supports it.
    - Never expose internal tool or model errors.
    - If you are unsure, answer conservatively rather than inventing details.
    Current intent: ${context.intent.name}.
    Known topic: ${context.entities.primaryTopic || "N/A"}.
  `.trim();
}

function buildRuntimePrompt({ message, content, history, pageUrl }) {
  const recentHistory = Array.isArray(history)
    ? history
        .slice(-4)
        .map((item) => `${item.role === "assistant" ? "Assistant" : "User"}: ${sanitize(item.text)}`)
        .join("\n")
    : "";

  return [
    "User Question:",
    sanitize(message) || "N/A",
    "",
    "Current Page URL:",
    sanitize(pageUrl) || "N/A",
    "",
    "Recent Conversation:",
    recentHistory || "N/A",
    "",
    "Webpage Content:",
    sanitize(content) || "N/A"
  ].join("\n");
}

function looksDefinitionLike(text) {
  return /\b(is|are|was|were|refers to|describes|lets you|allows you|provides)\b/i.test(text);
}

function looksPromotionalFact(text) {
  return /\b(create account|sign up|buy now|see more apps|run \d+ cloud models|launch [a-z0-9_-]+|included free|pro solve harder tasks)\b/i.test(
    text
  );
}

function adjustFactScore(text, baseScore, expectsDefinition) {
  let score = baseScore;

  if (expectsDefinition && looksDefinitionLike(text)) {
    score += 0.16;
  }

  if (looksPromotionalFact(text)) {
    score -= 0.24;
  }

  return clamp(score, 0, 1);
}

function buildPageSeedResult(context) {
  const seedResults = [];

  if (context.content && context.content.length > 200) {
    seedResults.push({
      provider: "current-page",
      sourceType: "page-context",
      sourceName: extractDomain(context.pageUrl) || "Current page",
      title: extractDomain(context.pageUrl) || "Current page",
      snippet: context.content.slice(0, 320),
      url: context.pageUrl || "about:blank",
      prefetchedText: context.content
    });
  }

  const officialDomains = unique(context.entities.domainHints || []).slice(0, 3);
  for (const domain of officialDomains) {
    seedResults.push({
      provider: "official-seed",
      sourceType: "official",
      sourceName: domain,
      title: domain,
      snippet: context.entities.primaryTopic
        ? `Official source for ${context.entities.primaryTopic}`
        : `Official source ${domain}`,
      url: `https://${domain.replace(/^https?:\/\//, "")}/`
    });

    for (const pathUrl of buildOfficialPathSeeds(context, domain)) {
      seedResults.push({
        provider: "official-seed",
        sourceType: "official",
        sourceName: domain,
        title: `${domain} ${pathUrl.split("/").filter(Boolean).join(" ")}`.trim(),
        snippet: `Official ${context.intent.name.replace(/_/g, " ")} page for ${context.entities.primaryTopic || domain}`,
        url: pathUrl
      });
    }
  }

  return dedupeResults(seedResults);
}

function parseDuckDuckGoResults(html) {
  const titles = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({
      url: decodeSearchRedirect(match[1], "https://duckduckgo.com"),
      title: cleanText(match[2])
    }))
    .filter((item) => item.url && item.title);
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/gi)]
    .map((match) => cleanText(match[1]))
    .filter(Boolean);

  return titles.slice(0, MAX_SEARCH_RESULTS_PER_PROVIDER).map((item, index) => ({
    provider: "duckduckgo",
    sourceType: "web",
    sourceName: extractDomain(item.url) || "DuckDuckGo result",
    title: item.title,
    snippet: snippets[index] || "",
    url: item.url
  }));
}

function parseBingResults(html) {
  const blocks = [...html.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/gi)].map((match) => match[0]);
  const results = [];

  for (const block of blocks.slice(0, MAX_SEARCH_RESULTS_PER_PROVIDER)) {
    const linkMatch = block.match(/<h2><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/i);
    if (!linkMatch) {
      continue;
    }

    const snippetMatch = block.match(/<p>([\s\S]*?)<\/p>/i);
    results.push({
      provider: "bing",
      sourceType: "web",
      sourceName: extractDomain(linkMatch[1]) || "Bing result",
      title: cleanText(linkMatch[2]),
      snippet: cleanText(snippetMatch?.[1] || ""),
      url: decodeSearchRedirect(linkMatch[1], "https://www.bing.com")
    });
  }

  return results;
}

function buildHeaders(extraHeaders = {}) {
  return {
    "User-Agent": REQUEST_USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    ...extraHeaders
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractReadableText(html) {
  if (!html) {
    return "";
  }

  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const titleMatch = withoutScripts.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const paragraphText = withoutScripts
    .replace(/<\/(p|div|section|article|li|h1|h2|h3|h4|h5|h6)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");

  return cleanText(`${titleMatch?.[1] || ""}\n${paragraphText}`);
}

function extractPassages(text, queryTokens) {
  if (!text) {
    return [];
  }

  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => normalizeWhitespace(sentence))
    .filter((sentence) => sentence.length >= 30 && sentence.length <= 320);

  return sentences
    .map((sentence) => ({
      text: sentence,
      overlap: calculateTokenOverlap(queryTokens, tokenize(sentence))
    }))
    .filter((item) => item.overlap > 0.08)
    .sort((left, right) => right.overlap - left.overlap)
    .slice(0, MAX_PASSAGES_PER_RESULT);
}

function dedupeHistory(history) {
  return uniqueByKey(
    history
      .map((item) => ({
        role: item?.role === "assistant" ? "assistant" : "user",
        text: sanitize(item?.text)
      }))
      .filter((item) => item.text),
    (item) => `${item.role}:${item.text}`
  );
}

function dedupeResults(results) {
  return uniqueByKey(
    results.filter((item) => item?.url && item?.title),
    (item) => canonicalizeUrl(item.url)
  );
}

function dedupeFacts(facts) {
  return uniqueByKey(
    facts.filter((fact) => fact.text),
    (fact) => fact.text.toLowerCase()
  );
}

function resolveFollowUpQuery(query, entities, session) {
  const normalizedQuery = sanitize(query);
  if (!looksLikeFollowUp(normalizedQuery) || !session?.lastTopic) {
    return normalizedQuery;
  }

  if (entities.primaryTopic && entities.primaryTopic.toLowerCase() !== session.lastTopic.toLowerCase()) {
    return normalizedQuery;
  }

  const cleanedFollowUp = normalizedQuery
    .replace(/^(and\s+)?(what about|how about|tell me more about|go on about|continue with)\s+/i, "")
    .replace(/\b(its|their|his|her|it|they|them|that|those|this|these)\b/gi, "")
    .replace(/[?]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return `${session.lastTopic} ${cleanedFollowUp || normalizedQuery}`.trim();
}

function looksLikeFollowUp(query) {
  const normalized = sanitize(query).toLowerCase();
  if (/^(and|also|what about|how about|tell me more|go on|continue|compare it|what about its)\b/.test(normalized)) {
    return true;
  }

  const tokens = tokenize(normalized);
  return tokens.some((token) => FOLLOW_UP_TOKENS.has(token));
}

function buildGeneralExpansions(query, intent) {
  const expansions = [query];

  if (intent.name === "general_search" || intent.name === "comparison") {
    expansions.push(`${query} overview`);
  }

  if (intent.name === "product_docs" || intent.name === "how_to") {
    expansions.push(`${query} documentation`);
    expansions.push(`${query} guide`);
  }

  if (intent.name === "company_policy") {
    expansions.push(`${query} official policy`);
    expansions.push(`${query} official site`);
  }

  if (intent.name === "news") {
    expansions.push(`${query} latest update`);
  }

  return unique(expansions.filter(Boolean)).slice(0, 4);
}

function decomposeTopic(query, primaryTopic) {
  const topics = [];

  if (primaryTopic) {
    topics.push(primaryTopic);
  }

  if (/\b(and|vs|versus|,)\b/i.test(query)) {
    query
      .split(/\b(?:and|vs|versus)\b|,/i)
      .map((item) => sanitize(item))
      .filter((item) => item.length > 3)
      .forEach((item) => topics.push(item));
  }

  return unique(topics).slice(0, 3);
}

function lookupOfficialDomains(text) {
  const normalized = sanitize(text).toLowerCase();
  const matches = [];

  for (const [key, domains] of Object.entries(OFFICIAL_DOMAIN_DICTIONARY)) {
    if (normalized.includes(key)) {
      matches.push(...domains);
    }
  }

  return unique(matches);
}

function deriveTopicFromHistory(history) {
  if (!Array.isArray(history) || !history.length) {
    return "";
  }

  const lastUserTurn = [...history].reverse().find((item) => item?.role === "user" && sanitize(item?.text));
  return lastUserTurn ? deriveTopicFromText(lastUserTurn.text) : "";
}

function deriveTopicFromText(text) {
  const quoted = [...sanitize(text).matchAll(/"([^"]+)"/g)].map((match) => match[1].trim()).filter(Boolean);
  if (quoted.length) {
    return quoted[0];
  }

  const titleCasePhrase = sanitize(text)
    .match(/\b([A-Z][a-z0-9.+-]+(?:\s+[A-Z][a-z0-9.+-]+){0,3})\b/);
  if (titleCasePhrase?.[1]) {
    return titleCasePhrase[1].trim();
  }

  const tokens = tokenize(text).filter((token) => !STOPWORDS.has(token));
  return tokens.slice(0, 6).join(" ");
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

function calculateTokenOverlap(queryTokens, candidateTokens) {
  if (!queryTokens.length || !candidateTokens.length) {
    return 0;
  }

  const candidateSet = new Set(candidateTokens);
  let matches = 0;

  for (const token of queryTokens) {
    if (candidateSet.has(token)) {
      matches += 1;
    }
  }

  return matches / Math.max(queryTokens.length, 1);
}

function tokenize(text) {
  return sanitize(text)
    .toLowerCase()
    .replace(/[^a-z0-9.+-]+/g, " ")
    .split(/\s+/)
    .filter((token) => token && !STOPWORDS.has(token));
}

function extractDomain(url) {
  const value = sanitize(url);
  if (!value || value === "about:blank") {
    return "";
  }

  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch (error) {
    return "";
  }
}

function canonicalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch (error) {
    return sanitize(url);
  }
}

function isOfficialDomain(domain, hints = []) {
  return hints.some((hint) => domain === hint || domain.endsWith(`.${hint}`) || hint.endsWith(`.${domain}`));
}

function decodeSearchRedirect(url, baseUrl) {
  try {
    const parsed = new URL(url, baseUrl);
    const directTarget = parsed.searchParams.get("uddg") || parsed.searchParams.get("u");
    return directTarget ? decodeURIComponent(directTarget) : parsed.toString();
  } catch (error) {
    return sanitize(url);
  }
}

function cleanText(value) {
  const withoutTags = sanitize(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");

  return normalizeWhitespace(withoutTags);
}

function normalizeSentence(text) {
  const sentence = normalizeWhitespace(cleanText(text));
  return ensureSentence(sentence);
}

function ensureSentence(text) {
  const value = sanitize(text);
  if (!value) {
    return "";
  }

  return endsWithTerminalPunctuation(value) ? value : `${value}.`;
}

function endsWithTerminalPunctuation(text) {
  return /[.!?]"?$/.test(text.trim());
}

function normalizeWhitespace(value) {
  return sanitize(value).replace(/\s+/g, " ").trim();
}

function sanitize(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizeBaseUrl(value) {
  const trimmed = sanitize(value);
  return trimmed ? trimmed.replace(/\/+$/, "") : "";
}

function unique(values) {
  return [...new Set(values)];
}

function uniqueByKey(values, getKey) {
  const seen = new Set();
  const output = [];

  for (const value of values) {
    const key = getKey(value);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(value);
  }

  return output;
}

function uniqueAttempts(attempts) {
  return uniqueByKey(
    attempts.filter((attempt) => attempt.query && attempt.route),
    (attempt) => `${attempt.route}:${attempt.query.toLowerCase()}`
  );
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function stableHash(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function buildFallbackSessionId(pageUrl, message) {
  return `fallback-${stableHash(`${sanitize(pageUrl)}:${sanitize(message)}`)}`;
}

function buildOfficialPathSeeds(context, domain) {
  const normalizedDomain = domain.replace(/^https?:\/\//, "");
  const query = context.originalQuery.toLowerCase();
  const pathCandidates = [];

  if (/(price|pricing|plan|plans|cost)/.test(query)) {
    pathCandidates.push("/pricing", "/api/pricing", "/docs/pricing");
  }

  if (/(docs|documentation|api|sdk|install|setup|reference|endpoint)/.test(query)) {
    pathCandidates.push("/docs", "/documentation", "/api", "/api-reference");
  }

  if (/(privacy|policy|terms|security|compliance|license)/.test(query)) {
    pathCandidates.push("/privacy", "/privacy-policy", "/terms", "/security");
  }

  return unique(pathCandidates).map((path) => `https://${normalizedDomain}${path}`);
}

module.exports = {
  HybridConversationAssistant
};
