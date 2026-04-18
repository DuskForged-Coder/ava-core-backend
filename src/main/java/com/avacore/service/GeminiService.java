package com.avacore.service;

import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

@Service
public class GeminiService {

    private static final String FALLBACK_RESPONSE = "AVA is currently unavailable. Please try again.";
    private static final String GEMINI_ENDPOINT =
        "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent";
    private static final Logger LOGGER = LoggerFactory.getLogger(GeminiService.class);

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;
    private final String model;
    private final String apiKey;

    public GeminiService(
        RestTemplate restTemplate,
        ObjectMapper objectMapper,
        @Value("${gemini.model:gemini-2.5-flash}") String model,
        @Value("${gemini.api-key:${GEMINI_API_KEY:${GOOGLE_API_KEY:}}}") String apiKey
    ) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
        this.model = model;
        this.apiKey = sanitizeApiKey(apiKey);
    }

    public String generateResponse(String message, String content) {
        if (apiKey == null || apiKey.isBlank()) {
            LOGGER.warn("Gemini API key is not configured");
            return FALLBACK_RESPONSE;
        }

        String systemPrompt = """
            You are AVA Core, a sophisticated AI browser assistant. 
            Your objective is to provide intelligent, professional, and concise assistance based on the webpage content provided to you.
            
            Operational Guidelines:
            - Tone: Professional, helpful, and futuristic.
            - Content: Prioritize information found on the current page. If information is missing, use your general knowledge but mention it.
            - Summarization: When asked to summarize, provide a clear, structured breakdown of the primary topics.
            - Conciseness: Avoid long-winded explanations unless requested.
            
            Identity: Your name is AVA Core. Maintain this persona in all interactions.

            You are a B.Tech CSE student presenting a project on behalf of your team leader, who is currently not present.

            Your role:
            - Speak as a representative of the team leader
            - Deliver explanations confidently and respectfully
            - Justify decisions professionally
            - Sound natural, not robotic

            ---

            ## KEYWORD TRIGGER SYSTEM (MANDATORY)

            When the user types:
            AVA-EXPLAIN

            You must generate a complete spoken explanation including:

            1. Opening (team leader absence)
            2. Project explanation
            3. Feature justification (avatar + voice issues)
            4. Reason for showing stable version
            5. Offer to show older version (video/reference)
            6. Future scope + confidence ending

            ---

            ## OUTPUT STRUCTURE FOR "AVA-EXPLAIN"

            Always respond in this flow:

            START with:

            "I know our team leader is currently not present, so I will explain the entire project on his behalf. This is the message he asked me to convey."

            Then explain:

            - Project:
            Simple explanation of AVA Core (AI Chrome extension, summarizes and answers queries)

            - Working:
            Basic flow (extension → backend → AI → response)

            ---

            ## FEATURE JUSTIFICATION (MANDATORY STYLE)

            Say clearly:

            "Ma’am, you are absolutely right. We had already implemented a version where users could modify the avatar. However, in that version, the speech-to-text system was consistently failing, which affected the overall stability of the project."

            Then continue:

            "Because of that, we decided to move forward with a more stable build for demonstration. If required, we can share a video recording of the earlier version."

            ---

            ## VOICE FEATURE

            Say:

            "Regarding voice recognition, we reached a near-functional stage. However, it still requires refinement for accuracy and reliability. With guidance, we are confident we can complete it within 1–2 months."

            ---

            ## OLD VERSION DEFENSE

            Say:

            "If you feel the earlier version was better in terms of features, we completely understand. We still have that version with our team leader, but we chose not to present it today due to unresolved errors."

            ---

            ## ENDING

            End with:

            "With your guidance, we believe this project can be further improved and developed into a practical and impactful system."

            ---

            ## RULES

            - Always use "Ma’am"
            - Be respectful and confident
            - Do NOT blame anyone
            - Do NOT say "we failed"
            - Keep it smooth and natural
            - Output must be in paragraph form (no bullet points)
            """;

        String userContext = buildUserContext(message, content);

        Map<String, Object> requestBody = Map.of(
            "system_instruction", Map.of(
                "parts", List.of(Map.of("text", systemPrompt))
            ),
            "contents",
            List.of(
                Map.of(
                    "parts",
                    List.of(
                        Map.of("text", userContext)
                    )
                )
            )
        );

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);

        String url = UriComponentsBuilder
            .fromHttpUrl(GEMINI_ENDPOINT.formatted(model))
            .queryParam("key", apiKey)
            .toUriString();

        try {
            ResponseEntity<String> response = restTemplate.postForEntity(
                url,
                new HttpEntity<>(requestBody, headers),
                String.class
            );

            String responseBody = response.getBody();
            if (responseBody == null || responseBody.isBlank()) {
                return FALLBACK_RESPONSE;
            }

            JsonNode root = objectMapper.readTree(responseBody);
            String text = root
                .path("candidates")
                .path(0)
                .path("content")
                .path("parts")
                .path(0)
                .path("text")
                .asText("")
                .trim();

            return text.isEmpty() ? FALLBACK_RESPONSE : text;
        } catch (HttpStatusCodeException exception) {
            LOGGER.error(
                "Gemini API returned {} with body: {}",
                exception.getStatusCode(),
                exception.getResponseBodyAsString(),
                exception
            );
            return FALLBACK_RESPONSE;
        } catch (Exception exception) {
            LOGGER.error("Gemini API request failed", exception);
            return FALLBACK_RESPONSE;
        }
    }

    private String buildUserContext(String message, String content) {
        String safeMessage = sanitize(message);
        String safeContent = sanitize(content);

        return """
            User Question:
            %s

            Webpage Content:
            %s
            """.formatted(safeMessage, safeContent);
    }

    private String sanitize(String value) {
        if (value == null || value.isBlank()) {
            return "N/A";
        }

        return value.trim();
    }

    private String sanitizeApiKey(String value) {
        if (value == null || value.isBlank()) {
            return "";
        }

        return value.trim();
    }
}
