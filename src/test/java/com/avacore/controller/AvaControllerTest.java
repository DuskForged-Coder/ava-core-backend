package com.avacore.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.avacore.dto.AvaRequest;
import com.avacore.service.AvaService;
import com.avacore.service.GeminiService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.web.client.RestTemplate;

class AvaControllerTest {

    @Test
    void healthEndpointsReturnOk() {
        GeminiService geminiService = new GeminiService(
            new RestTemplate(),
            new ObjectMapper(),
            "gemini-2.5-flash",
            ""
        );
        AvaService avaService = new AvaService(geminiService);
        AvaController controller = new AvaController(avaService);

        assertEquals("ok", controller.root().get("status"));
        assertEquals("ok", controller.health().get("status"));
    }

    @Test
    void askReturnsFallbackResponseWithoutApiKey() {
        GeminiService geminiService = new GeminiService(
            new RestTemplate(),
            new ObjectMapper(),
            "gemini-2.5-flash",
            ""
        );
        AvaService avaService = new AvaService(geminiService);
        AvaController controller = new AvaController(avaService);

        String response = controller.ask(new AvaRequest("Summarize this", "Example page")).response();

        assertEquals("AVA is currently unavailable. Please try again.", response);
    }
}
