package com.avacore.service;

import org.springframework.stereotype.Service;

@Service
public class AvaService {

    private final GeminiService geminiService;

    public AvaService(GeminiService geminiService) {
        this.geminiService = geminiService;
    }

    public String generateResponse(String message, String content) {
        return geminiService.generateResponse(message, content);
    }
}
