(function initAvaCore() {
  const ROOT_ID = "ava-core-root";
  const UI_VERSION = "jarvis-anime-3d-v2-voice-render";
  const BACKEND_URL = "https://ava-core-backend.onrender.com/ask";
  const REQUEST_TIMEOUT_MS = 10000;
  const LOADING_MESSAGE = "AVA is thinking...";
  const EMPTY_RESPONSE_MESSAGE = "No response received.";
  const SERVER_ERROR_MESSAGE = "Server unavailable. Please try again.";
  const TIMEOUT_ERROR_MESSAGE = "Request timed out. Please try again.";

  const existingRoot = document.getElementById(ROOT_ID);
  if (existingRoot) {
    if (existingRoot.dataset.uiVersion === UI_VERSION) {
      existingRoot.classList.add("ava-core-open");
      const panel = existingRoot.querySelector(".ava-core-panel");
      const input = existingRoot.querySelector(".ava-core-input");
      const avatarButton = existingRoot.querySelector(".ava-core-avatar-button");
      panel?.setAttribute("aria-hidden", "false");
      avatarButton?.setAttribute("aria-expanded", "true");
      input?.focus({ preventScroll: true });
      return;
    }

    existingRoot.__avaCoreDestroy?.();
    existingRoot.remove();
  }

  class Avatar3DSystem {
    constructor(stage, root) {
      this.stage = stage;
      this.root = root;
      this.canvas = stage?.querySelector(".ava-core-avatar-canvas") || null;
      this.fallback = stage?.querySelector(".ava-core-avatar-fallback") || null;
      this.destroyed = false;
      this.targetTalkLevel = 0;
      this.talkLevel = 0;
      this.rafId = 0;
      this.scene = null;
      this.camera = null;
      this.renderer = null;
      this.pivot = null;
      this.model = null;
      this.mixer = null;
      this.clock = null;
      this.modelBaseY = 0;
      this.modelBaseRotationY = 0;
      this.entranceProgress = 0;
      this.onResize = () => this.resize();
      this.resizeObserver = null;
    }

    async init() {
      if (!this.stage || !this.canvas || !window.WebGLRenderingContext) {
        this.fail();
        return;
      }

      try {
        const [THREE, { GLTFLoader }] = await Promise.all([
          import(chrome.runtime.getURL("assets/three.module.js")),
          import(chrome.runtime.getURL("assets/GLTFLoader.js"))
        ]);

        if (this.destroyed) {
          return;
        }

        this.THREE = THREE;
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
        this.camera.position.set(0, 0.34, 3.95);
        this.camera.lookAt(0, 0.12, 0);

        this.renderer = new THREE.WebGLRenderer({
          canvas: this.canvas,
          alpha: true,
          antialias: true,
          powerPreference: "high-performance"
        });
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
        if ("outputColorSpace" in this.renderer && THREE.SRGBColorSpace) {
          this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        } else if ("outputEncoding" in this.renderer && THREE.sRGBEncoding) {
          this.renderer.outputEncoding = THREE.sRGBEncoding;
        }

        const ambientLight = new THREE.AmbientLight(0xffffff, 2.2);
        const directionalLight = new THREE.DirectionalLight(0x8ddcff, 2.8);
        directionalLight.position.set(2.4, 3.6, 5.2);

        this.scene.add(ambientLight);
        this.scene.add(directionalLight);

        this.pivot = new THREE.Group();
        this.scene.add(this.pivot);

        const loader = new GLTFLoader();
        const modelUrl = chrome.runtime.getURL("assets/avatar.glb");
        const gltf = await new Promise((resolve, reject) => {
          loader.load(modelUrl, resolve, undefined, reject);
        });

        if (this.destroyed) {
          return;
        }

        const model = gltf.scene || gltf.scenes?.[0];
        if (!model) {
          throw new Error("Model scene missing");
        }

        this.prepareModel(model);
        this.pivot.add(model);
        this.model = model;

        if (Array.isArray(gltf.animations) && gltf.animations.length) {
          this.mixer = new THREE.AnimationMixer(model);
          gltf.animations.forEach((clip) => {
            this.mixer.clipAction(clip).play();
          });
        }

        this.clock = new THREE.Clock();
        this.stage.classList.add("ava-core-stage-ready");
        this.stage.classList.remove("ava-core-stage-fallback");
        this.resize();

        if ("ResizeObserver" in window) {
          this.resizeObserver = new ResizeObserver(() => this.resize());
          this.resizeObserver.observe(this.stage);
        } else {
          window.addEventListener("resize", this.onResize, { passive: true });
        }

        this.animate();
      } catch (error) {
        console.error("AVA Core 3D avatar failed to load:", error);
        this.fail();
      }
    }

    prepareModel(model) {
      const THREE = this.THREE;
      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();

      box.getSize(size);
      box.getCenter(center);
      model.position.sub(center);

      const maxDimension = Math.max(size.x, size.y, size.z) || 1;
      const scale = 2.35 / maxDimension;
      model.scale.setScalar(scale);

      box.setFromObject(model);
      box.getSize(size);
      box.getCenter(center);

      model.position.x -= center.x;
      model.position.y -= center.y;
      model.position.z -= center.z;
      model.position.y -= size.y * 0.39;
      model.rotation.y = 0;

      model.traverse((child) => {
        if (child.isMesh) {
          child.frustumCulled = false;
        }
      });

      this.modelBaseY = model.position.y;
      this.modelBaseRotationY = model.rotation.y;
    }

    resize() {
      if (!this.renderer || !this.camera || !this.canvas) {
        return;
      }

      const rect = this.canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width || 250));
      const height = Math.max(1, Math.round(rect.height || 250));

      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.camera.lookAt(0, 0.12, 0);
    }

    animate() {
      if (this.destroyed || !this.renderer || !this.scene || !this.camera || !this.pivot) {
        return;
      }

      if (!document.body.contains(this.root)) {
        this.destroy();
        return;
      }

      this.rafId = window.requestAnimationFrame(() => this.animate());

      const delta = Math.min(this.clock?.getDelta() || 0.016, 0.033);
      const elapsed = this.clock?.elapsedTime || 0;

      if (this.mixer) {
        this.mixer.update(delta);
      }

      this.talkLevel += (this.targetTalkLevel - this.talkLevel) * 0.08;
      this.entranceProgress += (1 - this.entranceProgress) * 0.045;

      const idleSway = Math.sin(elapsed * 0.78) * 0.15;
      const talkSway = Math.sin(elapsed * 6.4) * 0.08 * this.talkLevel;
      const bob = Math.sin(elapsed * (1.15 + this.talkLevel * 2.8)) * (0.04 + this.talkLevel * 0.05);
      const pulse =
        1 +
        this.talkLevel * 0.06 +
        Math.sin(elapsed * (2.2 + this.talkLevel * 6.2)) * (0.01 + this.talkLevel * 0.014);
      const entranceLift = (1 - this.entranceProgress) * 0.26;
      const entranceDepth = (1 - this.entranceProgress) * -0.55;

      this.pivot.rotation.y = idleSway + talkSway;
      this.pivot.rotation.x = -0.05 + Math.sin(elapsed * 0.52) * 0.025;
      this.pivot.position.y = bob - entranceLift;
      this.pivot.position.z = entranceDepth;
      this.pivot.scale.setScalar(pulse * (0.92 + this.entranceProgress * 0.08));

      if (this.model) {
        this.model.rotation.y =
          this.modelBaseRotationY +
          Math.sin(elapsed * (0.8 + this.talkLevel * 3.6)) * (0.025 + this.talkLevel * 0.045);
        this.model.position.y =
          this.modelBaseY +
          Math.sin(elapsed * (1.05 + this.talkLevel * 4.2)) * (0.022 + this.talkLevel * 0.03);
      }

      this.renderer.render(this.scene, this.camera);
    }

    setTalking(isTalking) {
      this.targetTalkLevel = isTalking ? 1 : 0;
      this.stage?.classList.toggle("ava-core-stage-talking", isTalking);
    }

    fail() {
      this.stage?.classList.add("ava-core-stage-fallback");
      this.stage?.classList.remove("ava-core-stage-ready");
      if (this.canvas) {
        this.canvas.style.opacity = "0";
      }
      if (this.fallback) {
        this.fallback.hidden = false;
      }
    }

    destroy() {
      if (this.destroyed) {
        return;
      }

      this.destroyed = true;
      window.cancelAnimationFrame(this.rafId);
      this.resizeObserver?.disconnect();
      window.removeEventListener("resize", this.onResize);

      if (this.renderer) {
        this.renderer.dispose();
        this.renderer.forceContextLoss?.();
      }
    }
  }

  class AvaCoreAssistant {
    constructor() {
      this.root = null;
      this.panel = null;
      this.avatarButton = null;
      this.avatarStage = null;
      this.avatar3D = null;
      this.messages = null;
      this.emptyState = null;
      this.input = null;
      this.sendButton = null;
      this.micButton = null;
      this.closeButton = null;
      this.statusValue = null;
      this.quickActions = [];
      this.isLoading = false;
      this.isListening = false;
      this.isSpeaking = false;
      this.recognition = null;
      this.recognitionSupported = false;
      this.recognitionPrefix = "";
      this.recognizedText = "";
      this.speechSynthesis = window.speechSynthesis || null;
      this.speechVoice = null;
      this.typingTimeout = null;
      this.onVoicesChanged = () => this.pickSpeechVoice();
      this.onDocumentKeydown = (event) => {
        if (event.key === "Escape" && this.root?.classList.contains("ava-core-open")) {
          this.closePanel();
        }
      };
    }

    init() {
      this.render();
      this.cacheElements();
      this.setupVoice();
      this.bindEvents();
      this.seedConversation();
      this.initialize3DAvatar();
    }

    render() {
      const avatarUrl = chrome.runtime.getURL("assets/avatar.png");

      this.root = document.createElement("div");
      this.root.id = ROOT_ID;
      this.root.dataset.uiVersion = UI_VERSION;
      this.root.className = "ava-core-root";
      this.root.innerHTML = `
        <div class="ava-core-shell">
          <section class="ava-core-panel" aria-hidden="true">
            <div class="ava-core-panel-aura"></div>
            <header class="ava-core-panel-header">
              <div class="ava-core-panel-identity">
                <div class="ava-core-panel-avatar-frame">
                  <span class="ava-core-panel-avatar-ring"></span>
                  <img class="ava-core-panel-avatar-image" src="${avatarUrl}" alt="AVA Core avatar" />
                  <span class="ava-core-panel-avatar-shine"></span>
                </div>
                <div class="ava-core-panel-titles">
                  <div class="ava-core-title-row">
                    <h2 class="ava-core-title">AVA Core</h2>
                    <span class="ava-core-status-pill">
                      <span class="ava-core-status-dot"></span>
                      <span class="ava-core-status-text">Online</span>
                    </span>
                  </div>
                  <p class="ava-core-subtitle">Futuristic guidance with page-aware intelligence.</p>
                </div>
              </div>
              <button class="ava-core-close" type="button" aria-label="Close assistant">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M7.47 6.41a.75.75 0 0 0-1.06 1.06L10.94 12l-4.53 4.53a.75.75 0 1 0 1.06 1.06L12 13.06l4.53 4.53a.75.75 0 1 0 1.06-1.06L13.06 12l4.53-4.53a.75.75 0 0 0-1.06-1.06L12 10.94 7.47 6.41Z"
                    fill="currentColor"
                  />
                </svg>
              </button>
            </header>

            <div class="ava-core-quick-actions">
              <button class="ava-core-chip" type="button" data-quick-action="summarize">Summarize Page</button>
              <button class="ava-core-chip" type="button" data-quick-action="selection">Use Selection</button>
            </div>

            <section class="ava-core-avatar-stage ava-core-stage-fallback" aria-label="AVA 3D avatar">
              <div class="ava-core-avatar-card">
                <div class="ava-core-avatar-grid"></div>
                <div class="ava-core-avatar-canvas-wrap">
                  <canvas class="ava-core-avatar-canvas" width="280" height="280" aria-hidden="true"></canvas>
                  <img class="ava-core-avatar-fallback" src="${avatarUrl}" alt="AVA Core avatar fallback" />
                </div>
              </div>
            </section>

            <div class="ava-core-messages-wrap">
              <div class="ava-core-messages" aria-live="polite" aria-label="Conversation"></div>
              <div class="ava-core-empty-state">
                <div class="ava-core-empty-state-ring"></div>
                <p class="ava-core-empty-title">Ask AVA anything about this page</p>
                <p class="ava-core-empty-copy">Summarize content, explain selected text, or chat with contextual awareness.</p>
              </div>
            </div>

            <footer class="ava-core-composer">
              <div class="ava-core-input-shell">
                <button
                  class="ava-core-icon-button ava-core-mic"
                  type="button"
                  aria-label="Start voice input"
                  aria-pressed="false"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M12 15.5A3.5 3.5 0 0 0 15.5 12V7A3.5 3.5 0 0 0 8.5 7v5a3.5 3.5 0 0 0 3.5 3.5Zm5.25-3.5a.75.75 0 0 1 1.5 0 6.76 6.76 0 0 1-6 6.71V21a.75.75 0 0 1-1.5 0v-2.29a6.76 6.76 0 0 1-6-6.71.75.75 0 0 1 1.5 0 5.25 5.25 0 0 0 10.5 0Z"
                      fill="currentColor"
                    />
                  </svg>
                </button>
                <input
                  class="ava-core-input"
                  type="text"
                  placeholder="Message AVA Core..."
                  aria-label="Message AVA Core"
                />
                <button class="ava-core-icon-button ava-core-send" type="button" aria-label="Send message">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M20.55 3.45a1.5 1.5 0 0 0-1.56-.33L4.64 8.67a1.5 1.5 0 0 0 .08 2.82l5.74 1.82 1.82 5.74a1.5 1.5 0 0 0 2.82.08l5.55-14.35a1.5 1.5 0 0 0-.1-1.33ZM11.89 12.11l-5.92-1.88 11.6-4.48-4.48 11.6-1.88-5.92a1.5 1.5 0 0 1 .68-1.72Z"
                      fill="currentColor"
                    />
                  </svg>
                </button>
              </div>
            </footer>
          </section>

          <button class="ava-core-avatar-button" type="button" aria-label="Open AVA Core assistant" aria-expanded="false">
            <span class="ava-core-avatar-halo"></span>
            <span class="ava-core-avatar-orbit ava-core-avatar-orbit-a"></span>
            <span class="ava-core-avatar-orbit ava-core-avatar-orbit-b"></span>
            <span class="ava-core-avatar-ring"></span>
            <span class="ava-core-avatar-scan"></span>
            <img class="ava-core-avatar-image" src="${avatarUrl}" alt="AVA Core avatar" />
            <span class="ava-core-avatar-badge">AVA</span>
          </button>
        </div>
      `;

      this.root.__avaCoreDestroy = () => this.destroy();
      document.body.appendChild(this.root);
    }

    cacheElements() {
      this.panel = this.root.querySelector(".ava-core-panel");
      this.avatarButton = this.root.querySelector(".ava-core-avatar-button");
      this.avatarStage = this.root.querySelector(".ava-core-avatar-stage");
      this.messages = this.root.querySelector(".ava-core-messages");
      this.emptyState = this.root.querySelector(".ava-core-empty-state");
      this.input = this.root.querySelector(".ava-core-input");
      this.sendButton = this.root.querySelector(".ava-core-send");
      this.micButton = this.root.querySelector(".ava-core-mic");
      this.closeButton = this.root.querySelector(".ava-core-close");
      this.statusValue = this.root.querySelector(".ava-core-status-text");
      this.quickActions = Array.from(this.root.querySelectorAll("[data-quick-action]"));
    }

    bindEvents() {
      this.avatarButton.addEventListener("click", () => this.togglePanel());
      this.closeButton.addEventListener("click", () => this.closePanel());
      this.sendButton.addEventListener("click", () => this.handleSend());
      this.micButton.addEventListener("click", () => this.toggleListening());

      this.input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          this.handleSend();
        }
      });

      this.quickActions.forEach((button) => {
        button.addEventListener("click", () => this.handleQuickAction(button.dataset.quickAction));
      });

      document.addEventListener("keydown", this.onDocumentKeydown);
    }

    initialize3DAvatar() {
      this.avatar3D = new Avatar3DSystem(this.avatarStage, this.root);
      this.avatar3D.init();
    }

    setupVoice() {
      this.setupSpeechRecognition();
      this.setupSpeechSynthesis();
      this.syncUiState();
    }

    setupSpeechRecognition() {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        this.micButton?.setAttribute("title", "Speech-to-text is not supported in this browser.");
        return;
      }

      try {
        this.recognition = new SpeechRecognition();
      } catch (error) {
        console.error("AVA Core speech recognition failed to initialize:", error);
        this.micButton?.setAttribute("title", "Speech-to-text is not available on this page.");
        return;
      }

      this.recognitionSupported = true;
      this.recognition.continuous = false;
      this.recognition.interimResults = true;
      this.recognition.maxAlternatives = 1;
      this.recognition.lang = document.documentElement.lang || navigator.language || "en-US";

      this.recognition.addEventListener("start", () => {
        this.recognizedText = "";
        this.setListening(true);
      });

      this.recognition.addEventListener("result", (event) => {
        const transcript = Array.from(event.results)
          .map((result) => result?.[0]?.transcript?.trim() || "")
          .filter(Boolean)
          .join(" ")
          .trim();

        const combinedTranscript = [this.recognitionPrefix, transcript].filter(Boolean).join(" ").trim();
        if (!combinedTranscript) {
          return;
        }

        this.recognizedText = combinedTranscript;
        this.input.value = combinedTranscript;
      });

      this.recognition.addEventListener("end", () => {
        this.setListening(false);
        this.recognitionPrefix = "";

        if (!this.recognizedText) {
          return;
        }

        this.openPanel();
        this.input.focus({ preventScroll: true });
        this.input.setSelectionRange(this.input.value.length, this.input.value.length);
      });

      this.recognition.addEventListener("error", (event) => {
        this.setListening(false);
        this.recognitionPrefix = "";

        if (!event?.error || event.error === "aborted") {
          return;
        }

        const message =
          event.error === "not-allowed" || event.error === "service-not-allowed"
            ? "Microphone access was blocked. Allow mic access in Chrome to use speech-to-text."
            : event.error === "audio-capture"
              ? "No microphone was detected for speech-to-text."
              : event.error === "no-speech"
                ? "I didn't catch any speech. Try again when you're ready."
                : `Voice input stopped: ${event.error}.`;

        this.addMessage("assistant", message);
      });
    }

    setupSpeechSynthesis() {
      if (!this.speechSynthesis || typeof window.SpeechSynthesisUtterance !== "function") {
        return;
      }

      this.pickSpeechVoice();

      if (typeof this.speechSynthesis.addEventListener === "function") {
        this.speechSynthesis.addEventListener("voiceschanged", this.onVoicesChanged);
      }
    }

    pickSpeechVoice() {
      if (!this.speechSynthesis) {
        return;
      }

      const voices = this.speechSynthesis.getVoices();
      if (!voices.length) {
        return;
      }

      const preferredLanguage = (document.documentElement.lang || navigator.language || "en-US").toLowerCase();
      const primaryLanguage = preferredLanguage.split("-")[0];

      this.speechVoice =
        voices.find((v) => v.name.includes("Natural") && v.lang.startsWith(primaryLanguage)) ||
        voices.find((v) => v.name.includes("Google") && v.lang.startsWith(primaryLanguage)) ||
        voices.find((voice) => voice.lang?.toLowerCase() === preferredLanguage) ||
        voices.find((voice) => voice.lang?.toLowerCase().startsWith(`${primaryLanguage}-`)) ||
        voices.find((voice) => voice.lang?.toLowerCase().startsWith(primaryLanguage)) ||
        voices.find((v) => v.lang.includes("en") && v.name.includes("Google")) ||
        voices[0];
    }

    toggleListening() {
      if (!this.recognitionSupported || !this.recognition) {
        this.addMessage("assistant", "Speech-to-text is not supported in this browser.");
        return;
      }

      if (this.isLoading) {
        return;
      }

      if (this.isListening) {
        this.stopListening();
        return;
      }

      this.stopSpeaking();
      this.openPanel();
      this.recognitionPrefix = this.input.value.trim();
      this.recognizedText = this.recognitionPrefix;

      try {
        this.recognition.start();
      } catch (error) {
        console.error("AVA Core speech recognition start failed:", error);
      }
    }

    stopListening() {
      if (!this.recognition || !this.isListening) {
        return;
      }

      this.recognitionPrefix = "";

      try {
        this.recognition.stop();
      } catch (error) {
        console.error("AVA Core speech recognition stop failed:", error);
      }
    }

    setListening(isListening) {
      this.isListening = isListening;
      this.syncUiState();
    }

    setSpeaking(isSpeaking) {
      this.isSpeaking = isSpeaking;
      this.syncUiState();
    }

    syncUiState() {
      this.root?.classList.toggle("ava-core-talking", this.isLoading || this.isSpeaking);
      this.root?.classList.toggle("ava-core-listening", this.isListening);

      if (this.statusValue) {
        this.statusValue.textContent = this.isLoading
          ? "Thinking"
          : this.isListening
            ? "Listening"
            : this.isSpeaking
              ? "Speaking"
              : "Online";
      }

      if (this.micButton) {
        const micLabel = this.isListening ? "Stop voice input" : "Start voice input";
        const fallbackLabel = "Speech-to-text unavailable";
        this.micButton.setAttribute("aria-pressed", String(this.isListening));
        this.micButton.setAttribute("aria-label", this.recognitionSupported ? micLabel : fallbackLabel);
        this.micButton.setAttribute(
          "title",
          this.recognitionSupported ? micLabel : "Speech-to-text is not supported in this browser."
        );
      }

      if (this.input) {
        this.input.placeholder = this.isListening ? "Listening..." : "Message AVA Core...";
      }

      this.avatar3D?.setTalking(this.isLoading || this.isListening || this.isSpeaking);
    }

    speakText(text) {
      const spokenText = text.trim();
      if (!spokenText || !this.speechSynthesis || typeof window.SpeechSynthesisUtterance !== "function") {
        return;
      }

      this.stopSpeaking();

      // Split text into smaller chunks (sentences) to prevent the Speech API from cutting off
      // which is a common limitation for long strings in browser TTS engines.
      const chunks = spokenText.match(/[^.!?]+[.!?]+|[^.!?]+/g) || [spokenText];

      chunks.forEach((chunk, index) => {
        const utterance = new SpeechSynthesisUtterance(chunk.trim());
        utterance.lang = this.speechVoice?.lang || document.documentElement.lang || navigator.language || "en-US";
        utterance.rate = 1.0;
        utterance.pitch = 1.0;

        if (this.speechVoice) {
          utterance.voice = this.speechVoice;
        }

        if (index === 0) {
          utterance.onstart = () => this.setSpeaking(true);
        }

        utterance.onend = () => {
          if (index === chunks.length - 1) this.setSpeaking(false);
        };
        utterance.onerror = () => this.setSpeaking(false);

        try {
          this.speechSynthesis.speak(utterance);
        } catch (e) { console.error("AVA Core speech failed", e); }
      });
    }

    stopSpeaking() {
      if (!this.speechSynthesis) {
        return;
      }

      if (this.speechSynthesis.speaking || this.speechSynthesis.pending) {
        this.speechSynthesis.cancel();
      }

      this.setSpeaking(false);
    }

    seedConversation() {
      this.addMessage(
        "assistant",
        "AVA Core online. Ask me to break down the page, explain highlighted text, or respond with live context."
      );
    }

    focusInput() {
      this.openPanel();
      this.input.focus({ preventScroll: true });
    }

    togglePanel() {
      if (this.root.classList.contains("ava-core-open")) {
        this.closePanel();
        return;
      }

      this.openPanel();
    }

    openPanel() {
      this.root.classList.add("ava-core-open");
      this.panel.setAttribute("aria-hidden", "false");
      this.avatarButton.setAttribute("aria-expanded", "true");
      window.setTimeout(() => this.input.focus({ preventScroll: true }), 120);
    }

    closePanel() {
      this.root.classList.remove("ava-core-open");
      this.panel.setAttribute("aria-hidden", "true");
      this.avatarButton.setAttribute("aria-expanded", "false");
      this.stopListening();
      this.stopSpeaking();
    }

    updateEmptyState() {
      this.emptyState.hidden = this.messages.children.length > 0;
    }

    createMessageElement(role) {
      const item = document.createElement("article");
      item.className = `ava-core-message ava-core-message-${role}`;

      const meta = document.createElement("span");
      meta.className = "ava-core-message-meta";
      meta.textContent = role === "user" ? "You" : "AVA Core";

      const bubble = document.createElement("div");
      bubble.className = "ava-core-bubble";

      const body = document.createElement("p");
      body.className = "ava-core-message-body";

      bubble.appendChild(body);
      item.appendChild(meta);
      item.appendChild(bubble);

      return { item, body };
    }

    addMessage(role, text) {
      const { item, body } = this.createMessageElement(role);
      body.textContent = text;
      this.messages.appendChild(item);
      this.updateEmptyState();
      this.scrollMessages();
      return { item, body };
    }

    createStreamingMessage() {
      const { item, body } = this.createMessageElement("assistant");
      item.classList.add("ava-core-message-streaming");
      body.textContent = LOADING_MESSAGE;
      this.messages.appendChild(item);
      this.updateEmptyState();
      this.scrollMessages();

      return { item, body };
    }

    scrollMessages() {
      window.requestAnimationFrame(() => {
        this.messages.scrollTop = this.messages.scrollHeight;
      });
    }

    getPageContent() {
      const previousDisplay = this.root.style.display;
      this.root.style.display = "none";
      const pageContent = (document.body?.innerText || "").slice(0, 3000);
      this.root.style.display = previousDisplay;
      return pageContent;
    }

    getSelectedText() {
      return window.getSelection()?.toString().trim() || "";
    }

    buildContextContent() {
      const pageContent = this.getPageContent();
      const selectedText = this.getSelectedText();

      if (!selectedText) {
        return pageContent;
      }

      return `Selected text:\n${selectedText.slice(0, 1200)}\n\nPage content:\n${pageContent}`;
    }

    extractReply(payload) {
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

    async fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

      try {
        return await fetch(url, {
          ...options,
          signal: controller.signal
        });
      } finally {
        window.clearTimeout(timeoutId);
      }
    }

    async sendToBackend(message, content) {
      const response = await this.fetchWithTimeout(BACKEND_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message,
          content
        })
      });

      if (!response.ok) {
        throw new Error(SERVER_ERROR_MESSAGE);
      }

      const contentType = response.headers.get("content-type") || "";
      const responseText = await response.text();
      const trimmedResponse = responseText.trim();

      if (!trimmedResponse) {
        return EMPTY_RESPONSE_MESSAGE;
      }

      if (contentType.includes("application/json")) {
        const data = JSON.parse(trimmedResponse);
        return this.extractReply(data) || EMPTY_RESPONSE_MESSAGE;
      }

      return trimmedResponse || EMPTY_RESPONSE_MESSAGE;
    }

    setLoading(isLoading) {
      this.isLoading = isLoading;
      this.sendButton.disabled = isLoading;
      this.input.disabled = isLoading;
      this.quickActions.forEach((button) => {
        button.disabled = isLoading;
      });
      this.syncUiState();
    }

    async typeText(target, text) {
      const finalText = text || EMPTY_RESPONSE_MESSAGE;
      target.textContent = "";

      await new Promise((resolve) => {
        let index = 0;

        const step = () => {
          if (!document.body.contains(target)) {
            resolve();
            return;
          }

          const remaining = finalText.length - index;
          const chunkSize = remaining > 220 ? 3 : remaining > 80 ? 2 : 1;

          target.textContent += finalText.slice(index, index + chunkSize);
          index += chunkSize;
          this.scrollMessages();

          if (index >= finalText.length) {
            resolve();
            return;
          }

          const previousCharacter = finalText[index - 1];
          const delay =
            previousCharacter === "\n"
              ? 42
              : /[.!?]/.test(previousCharacter)
                ? 34
                : /[,;:]/.test(previousCharacter)
                  ? 24
                  : 12;

          this.typingTimeout = window.setTimeout(step, delay);
        };

        step();
      });
    }

    async showAssistantResponse(placeholder, text, speakResponse = false) {
      placeholder.item.classList.remove("ava-core-message-streaming");
      
      // Start speaking immediately while the text is being typed out for better UX
      if (speakResponse && document.body.contains(this.root) && this.root.classList.contains("ava-core-open")) {
        this.speakText(text);
      }

      await this.typeText(placeholder.body, text);
    }

    handleQuickAction(action) {
      if (this.isLoading) {
        return;
      }

      this.openPanel();

      if (action === "summarize") {
        this.handleSend("Summarize this page in a crisp, helpful way.");
        return;
      }

      if (action === "selection") {
        const selectedText = this.getSelectedText();

        if (!selectedText) {
          this.addMessage("assistant", "Highlight text on the page first, then tap Use Selection again.");
          return;
        }

        this.handleSend(`Explain this selected text:\n${selectedText.slice(0, 1200)}`);
      }
    }

    async handleSend(forcedMessage) {
      if (this.isLoading) {
        return;
      }

      const message = (forcedMessage || this.input.value).trim();
      if (!message) {
        return;
      }

      this.openPanel();
      this.stopListening();
      this.stopSpeaking();
      this.addMessage("user", message);
      this.input.value = "";
      this.setLoading(true);

      const placeholder = this.createStreamingMessage();

      try {
        const responseText = await this.sendToBackend(message, this.buildContextContent());
        await this.showAssistantResponse(placeholder, responseText, true);
      } catch (error) {
        const fallbackMessage =
          error?.name === "AbortError" ? TIMEOUT_ERROR_MESSAGE : SERVER_ERROR_MESSAGE;

        await this.showAssistantResponse(placeholder, fallbackMessage, false);
        console.error("AVA Core backend error:", error);
      } finally {
        this.setLoading(false);
        this.focusInput();
      }
    }

    destroy() {
      window.clearTimeout(this.typingTimeout);
      document.removeEventListener("keydown", this.onDocumentKeydown);
      this.stopListening();
      this.stopSpeaking();
      if (this.speechSynthesis && typeof this.speechSynthesis.removeEventListener === "function") {
        this.speechSynthesis.removeEventListener("voiceschanged", this.onVoicesChanged);
      }
      this.avatar3D?.destroy();

      if (this.root) {
        this.root.__avaCoreDestroy = null;
      }
    }
  }

  const mount = () => {
    const assistant = new AvaCoreAssistant();
    assistant.init();
  };

  if (!document.body) {
    window.addEventListener("DOMContentLoaded", mount, { once: true });
    return;
  }

  mount();
})();
