package com.avacore.config;

import java.time.Duration;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.web.client.RestTemplateBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.client.RestTemplate;

@Configuration
public class HttpClientConfig {

    @Bean
    public RestTemplate restTemplate(
        RestTemplateBuilder builder,
        @Value("${gemini.connect-timeout:5s}") Duration connectTimeout,
        @Value("${gemini.read-timeout:90s}") Duration readTimeout
    ) {
        return builder
            .setConnectTimeout(connectTimeout)
            .setReadTimeout(readTimeout)
            .build();
    }
}
