package com.avacore.controller;

import com.avacore.dto.AvaRequest;
import com.avacore.dto.AvaResponse;
import com.avacore.service.AvaService;
import java.util.Map;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
@CrossOrigin(origins = "*")
public class AvaController {

    private final AvaService avaService;

    public AvaController(AvaService avaService) {
        this.avaService = avaService;
    }

    @GetMapping("/")
    public Map<String, String> root() {
        return Map.of("status", "ok", "service", "AVA Core Backend");
    }

    @GetMapping("/health")
    public Map<String, String> health() {
        return Map.of("status", "ok");
    }

    @PostMapping("/ask")
    public AvaResponse ask(@RequestBody(required = false) AvaRequest request) {
        String message = request == null ? "" : request.message();
        String content = request == null ? "" : request.content();
        return new AvaResponse(avaService.generateResponse(message, content));
    }
}
