// ==UserScript==
// @name         VoxInfinity Direct API
// @namespace    vox-infinity-direct-api
// @version      0.4.0
// @description  Direct API long-form TTS queue. Chunks text, POSTs speech requests directly, decodes audioContent, and plays a custom queue.
// @match        https://platform.TARGET_DOMAIN/*
// @match        https://TARGET_DOMAIN/*
// @match        https://www.TARGET_DOMAIN/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
    "use strict";

    const APP_ID = "vox";
    const VERSION = "0.4.0";

    const DEFAULTS = {
        maxChunkSize: 950,
        minBreakSize: 300,
        lookAhead: 2,
        concurrentDirectRequests: 1,
        requestTimeoutMs: 120000,
        waitForDomMs: 60000,
        logLimit: 180,
        defaultUrl: "/api/create-speech",
        defaultVoiceId: "Levi",
        defaultModelId: "TARGET_MODEL",
        defaultDeliveryMode: "DEFAULT",
        defaultAudioEncoding: "LINEAR16",
        defaultSampleRateHertz: 48000,
        defaultSpeakingRate: 1.25,
    };

    const SELECTORS = {
        textArea: [
            'textarea[name="text"]:not([aria-hidden="true"])',
            'textarea#tts-text:not([aria-hidden="true"])',
            'textarea[placeholder*="Enter text"][maxlength]:not([aria-hidden="true"])',
            'textarea[placeholder*="generate speech"]:not([aria-hidden="true"])',
            'textarea:not([aria-hidden="true"])',
        ],
        generateButton: [
            'button[aria-label="Generate speech"]',
            'button[aria-label*="Generate"]',
            'button',
        ],
        pageAudio: [
            'audio[src^="blob:"]',
            'audio[src]',
            'audio',
        ],
    };

    const FALLBACK_VOICES = [{
            id: "Sarah",
            label: "Sarah",
            role: "Support"
        },
        {
            id: "Jason",
            label: "Jason",
            role: "Assistant"
        },
        {
            id: "Hana",
            label: "Hana",
            role: "Companion"
        },
        {
            id: "Blake",
            label: "Blake",
            role: "Narrator"
        },
        {
            id: "Mark",
            label: "Mark",
            role: "Commentator"
        },
        {
            id: "Hades",
            label: "Hades",
            role: "Gaming"
        },
        {
            id: "Reed",
            label: "Reed",
            role: "Training"
        },
        {
            id: "Levi",
            label: "Levi",
            role: "Audiobook"
        },
        {
            id: "Luna",
            label: "Luna",
            role: "Voiceover"
        },
        {
            id: "Victor",
            label: "Victor",
            role: "Coach"
        },
    ];

    const state = {
        mounted: false,
        panelOpen: false,

        directMode: true,
        directConfig: {
            url: DEFAULTS.defaultUrl,
            method: "POST",
            headers: {
                "content-type": "application/json"
            },
            bodyTemplate: null,
            capturedAt: null,
            capturedFrom: "default",
        },

        chunks: [],
        clips: new Map(),
        generationTasks: new Map(),
        activeDirectRequests: 0,
        directQueue: [],
        internalDirectRequestDepth: 0,

        objectUrls: new Set(),
        capturedAudioQueue: [],

        currentAudio: null,
        ownedAudioFlag: "__voxOwnedAudio",
        silenceNativeAudio: true,
        usePageVoice: false,
        pageVoiceId: "",
        pageVoiceRole: "",
        currentIndex: -1,
        nextToPlay: 0,
        currentChunkCurrentTime: 0,
        currentChunkDuration: 0,

        running: false,
        paused: false,
        stopRequested: false,

        lastRoute: location.href,
        host: null,
        shadow: null,
    };

    function debug(...args) {
        console.log(`[VoxInfinity Engine v${VERSION}]`, ...args);
    }

    function sleep(ms) {
        return new Promise((resolve) => window.setTimeout(resolve, ms));
    }

    function byId(id) {
        return state.shadow ? state.shadow.getElementById(`${APP_ID}-${id}`) : null;
    }

    function log(message, level = "info") {
        const logEl = byId("log");

        if (logEl) {
            const line = document.createElement("div");
            line.className = `log-line ${level}`;
            line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
            logEl.appendChild(line);

            while (logEl.children.length > DEFAULTS.logLimit) {
                logEl.removeChild(logEl.firstChild);
            }

            logEl.scrollTop = logEl.scrollHeight;
        }

        setStatus(message);

        if (level === "error") {
            console.error(`[VoxInfinity Engine v${VERSION}] ${message}`);
        } else if (level === "warn") {
            console.warn(`[VoxInfinity Engine v${VERSION}] ${message}`);
        } else {
            console.log(`[VoxInfinity Engine v${VERSION}] ${message}`);
        }
    }

    function setStatus(message) {
        const el = byId("status");
        if (el) el.textContent = message;
    }

    function setBadge(message) {
        const el = byId("badge");
        if (el) el.textContent = message;
    }

    function formatTime(seconds) {
        if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
        const total = Math.floor(seconds);
        const minutes = Math.floor(total / 60);
        const secs = total % 60;
        return `${minutes}:${String(secs).padStart(2, "0")}`;
    }

    function canDecodeAudioMpeg() {
        const audio = document.createElement("audio");
        const result = audio.canPlayType("audio/mpeg");
        return result === "probably" || result === "maybe";
    }

    function isTTSRouteOrDomPresent() {
        return (
            /tts-playground/.test(location.href) ||
            !!document.querySelector('textarea[name="text"]:not([aria-hidden="true"])') ||
            !!document.querySelector('textarea#tts-text:not([aria-hidden="true"])') ||
            !!document.querySelector('button[aria-label="Generate speech"]') ||
            Array.from(document.querySelectorAll("button")).some((button) =>
                (button.textContent || "").trim().toLowerCase() === "generate"
            )
        );
    }

    function normalizeVoiceName(name) {
        return String(name || "").trim();
    }

    function isLikelySelectedVoiceButton(button) {
        if (!(button instanceof HTMLButtonElement)) return false;
        const className = String(button.className || "");
        const ariaPressed = button.getAttribute("aria-pressed");
        return ariaPressed === "true" || className.includes("bg-background-raised") || className.includes("Mui-selected") || className.includes("selected");
    }

    function discoverPageVoices() {
        const known = new Map();

        for (const voice of FALLBACK_VOICES) {
            known.set(voice.id.toLowerCase(), Object.assign({}, voice, {
                selected: false,
                source: "fallback"
            }));
        }

        const buttons = Array.from(document.querySelectorAll("button"));

        for (const button of buttons) {
            const aria = button.getAttribute("aria-label") || "";
            let voiceId = "";
            let role = "";
            const ariaMatch = aria.match(new RegExp("Select voice:[ ]*([^,]+)", "i"));

            if (ariaMatch) voiceId = normalizeVoiceName(ariaMatch[1]);

            const parts = Array.from(button.querySelectorAll("div, span, p"))
                .map(function(node) {
                    return normalizeVoiceName(node.textContent);
                })
                .filter(Boolean);

            for (const fallback of FALLBACK_VOICES) {
                if (!voiceId && parts.includes(fallback.id)) voiceId = fallback.id;
            }

            if (!voiceId) continue;

            const voiceIndex = parts.findIndex(function(part) {
                return part === voiceId;
            });
            if (voiceIndex >= 0 && parts[voiceIndex + 1] && parts[voiceIndex + 1] !== voiceId) {
                role = parts[voiceIndex + 1];
            }

            const fallback = FALLBACK_VOICES.find(function(item) {
                return item.id.toLowerCase() === voiceId.toLowerCase();
            });
            const selected = isLikelySelectedVoiceButton(button);

            known.set(voiceId.toLowerCase(), {
                id: voiceId,
                label: voiceId,
                role: role || (fallback && fallback.role) || "",
                selected: selected,
                source: "page",
            });
        }

        return Array.from(known.values()).sort(function(a, b) {
            const ai = FALLBACK_VOICES.findIndex(function(voice) {
                return voice.id.toLowerCase() === a.id.toLowerCase();
            });
            const bi = FALLBACK_VOICES.findIndex(function(voice) {
                return voice.id.toLowerCase() === b.id.toLowerCase();
            });
            return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || a.label.localeCompare(b.label);
        });
    }

    function renderVoiceOptions(voices, preferredVoiceId) {
        const select = byId("voice");
        if (!select) return;

        const current = preferredVoiceId || select.value || DEFAULTS.defaultVoiceId;
        select.innerHTML = "";

        for (const voice of voices) {
            const option = document.createElement("option");
            option.value = voice.id;
            option.textContent = voice.role ? voice.label + " — " + voice.role : voice.label;
            select.appendChild(option);
        }

        const match = voices.find(function(voice) {
            return voice.id.toLowerCase() === String(current).toLowerCase();
        });
        select.value = match ? match.id : DEFAULTS.defaultVoiceId;
    }

    function getSelectedPageVoice() {
        const voices = discoverPageVoices();
        const voiceById = new Map(voices.map(function(voice) {
            return [voice.id.toLowerCase(), voice];
        }));

        const buttons = Array.from(document.querySelectorAll("button")).filter(isVisibleEnough);

        // Homepage source of truth: the compact voice dropdown in the action row.
        // Its visible text is exactly "Sarah", "Levi", etc.
        for (const button of buttons) {
            const text = normalizeVoiceName(button.textContent).replace(/\s+/g, " ");

            if (/generate|play|pause|cancel|english|routing|speech-to|text-to/i.test(text)) continue;
            if (text.includes("🇺🇸")) continue;

            const exact = voiceById.get(text.toLowerCase());
            if (exact) {
                return Object.assign({}, exact, {
                    selected: true,
                    source: "action-row-dropdown"
                });
            }

            const spanText = Array.from(button.querySelectorAll("span"))
                .map(function(span) {
                    return normalizeVoiceName(span.textContent);
                })
                .filter(Boolean)[0];

            if (spanText) {
                const spanMatch = voiceById.get(spanText.toLowerCase());
                if (spanMatch) {
                    return Object.assign({}, spanMatch, {
                        selected: true,
                        source: "action-row-dropdown"
                    });
                }
            }
        }

        return voices.find(function(voice) {
            return voice.selected;
        }) || null;
    }

    function updateVoiceModeUi() {
        const select = byId("voice");
        const usePage = byId("usePageVoice");
        const syncButton = byId("syncVoices");
        const label = byId("voiceModeLabel");

        if (select) select.disabled = state.usePageVoice;
        if (usePage) usePage.checked = state.usePageVoice;

        if (syncButton) {
            syncButton.textContent = "Refresh voices";
        }

        if (label) {
            if (state.usePageVoice && state.pageVoiceId) {
                label.textContent = "Using selected page voice: " + state.pageVoiceId + (state.pageVoiceRole ? " — " + state.pageVoiceRole : "");
            } else {
                label.textContent = "Manual: dropdown voice " + ((select && select.value) || DEFAULTS.defaultVoiceId);
            }
        }
    }

    function setUsePageVoice(enabled) {
        state.usePageVoice = !!enabled;

        if (state.usePageVoice) {
            const selected = getSelectedPageVoice();
            if (selected) {
                state.pageVoiceId = selected.id;
                state.pageVoiceRole = selected.role || "";
                renderVoiceOptions(discoverPageVoices(), selected.id);
                log("Using selected page voice: " + selected.id + (selected.role ? " (" + selected.role + ")" : "") + ".");
            } else {
                log("Could not detect selected page voice. Keeping current dropdown voice.", "warn");
                state.usePageVoice = false;
            }
        }

        updateVoiceModeUi();
        updateUiState();
    }

    function syncVoiceOptionsFromPage(preferPageSelection = true) {
        const voices = discoverPageVoices();
        const selected = getSelectedPageVoice();
        const preferred =
            preferPageSelection && selected ?
            selected.id :
            (byId("voice") && byId("voice").value) || DEFAULTS.defaultVoiceId;

        renderVoiceOptions(voices, preferred);

        if (selected && preferPageSelection) {
            state.pageVoiceId = selected.id;
            state.pageVoiceRole = selected.role || "";
            log("Synced selected page voice: " + selected.id + (selected.role ? " (" + selected.role + ")" : "") + ".");
        } else {
            log("Loaded " + voices.length + " voice options.");
        }

        updateVoiceModeUi();
        return voices;
    }

    function updateUiState() {
        const total = state.chunks.length;
        const generated = state.clips.size;
        const current = state.currentIndex >= 0 ? state.currentIndex + 1 : 0;
        const chars = state.chunks.reduce((sum, chunk) => sum + chunk.length, 0);

        const activeIndex = state.currentIndex >= 0 ? state.currentIndex : state.nextToPlay;
        const chunkFraction =
            state.currentChunkDuration > 0 ?
            Math.min(1, state.currentChunkCurrentTime / state.currentChunkDuration) :
            0;

        const liveUnits =
            state.running && state.currentIndex >= 0 ?
            activeIndex + chunkFraction :
            state.nextToPlay;

        const progress = total ? Math.min(100, Math.round((liveUnits / total) * 100)) : 0;

        const stats = byId("stats");
        if (stats) {
            stats.textContent = `${total} chunks · ${generated} ready · current ${current}/${total} · ${chars.toLocaleString()} chars`;
        }

        const bar = byId("progress-fill");
        if (bar) bar.style.width = `${progress}%`;

        const progressText = byId("progress-text");
        if (progressText) progressText.textContent = `${progress}%`;

        const realtime = byId("realtime");
        if (realtime) {
            realtime.textContent = `Chunk time ${formatTime(state.currentChunkCurrentTime)} / ${formatTime(state.currentChunkDuration)}`;
        }

        const mode = byId("mode");
        if (mode) mode.textContent = state.directMode ? "Direct mode" : "UI fallback";

        const learned = byId("learned");
        if (learned) {
            const source = state.directConfig.capturedFrom || "default";
            learned.textContent = `${state.directConfig.url || "no endpoint"} · ${source}`;
        }

        const start = byId("start");
        const pause = byId("pause");
        const resume = byId("resume");
        const stop = byId("stop");
        const prepare = byId("prepare");
        const pregenerate = byId("pregenerate");

        const generating = state.generationTasks.size > 0 || state.activeDirectRequests > 0;

        if (start) start.disabled = state.running && !state.paused;
        if (pause) pause.disabled = !state.running || state.paused;
        if (resume) resume.disabled = !state.paused;
        if (stop) stop.disabled = !state.running && !state.currentAudio && !generating;
        if (prepare) prepare.disabled = state.running || generating;
        if (pregenerate) pregenerate.disabled = state.running || generating;

        if (state.running) {
            setBadge(state.paused ? "Paused" : "Running");
        } else if (generating) {
            setBadge("Generating");
        } else if (state.chunks.length) {
            setBadge(`${state.chunks.length} chunks`);
        } else if (state.directConfig.capturedAt || state.directConfig.url) {
            setBadge("Direct");
        } else {
            setBadge(isTTSRouteOrDomPresent() ? "Ready" : "Open TTS");
        }
    }

    function queryFirst(selectorList, predicate = () => true) {
        for (const selector of selectorList) {
            let nodes = [];
            try {
                nodes = Array.from(document.querySelectorAll(selector));
            } catch {
                continue;
            }

            const match = nodes.find((node) => node && predicate(node));
            if (match) return match;
        }

        return null;
    }

    function isVisibleEnough(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function getTextArea() {
        return queryFirst(SELECTORS.textArea, (el) => {
            return (
                el instanceof HTMLTextAreaElement &&
                el.getAttribute("aria-hidden") !== "true" &&
                !el.readOnly &&
                isVisibleEnough(el)
            );
        });
    }

    function isButtonDisabled(button) {
        return (
            !button ||
            button.disabled ||
            button.getAttribute("aria-disabled") === "true" ||
            button.classList.contains("Mui-disabled") ||
            button.classList.contains("cursor-not-allowed")
        );
    }

    function isGenerateButtonCandidate(btn) {
        if (!(btn instanceof HTMLButtonElement)) return false;

        const label = `${btn.getAttribute("aria-label") || ""} ${btn.textContent || ""}`
            .trim()
            .toLowerCase();

        return (
            label.includes("generate") &&
            !label.includes("cancel") &&
            !label.includes("pause") &&
            !label.includes("play")
        );
    }

    function getGenerateButton() {
        const buttons = Array.from(document.querySelectorAll("button"));

        const enabledGenerate = buttons.find((button) => {
            return isGenerateButtonCandidate(button) && !isButtonDisabled(button) && isVisibleEnough(button);
        });

        if (enabledGenerate) return enabledGenerate;

        return buttons.find((button) => isGenerateButtonCandidate(button) && isVisibleEnough(button)) || null;
    }

    function getAllPageAudios() {
        return Array.from(document.querySelectorAll("audio[src]"));
    }

    function muteAndPausePageAudios() {
        for (const audio of getAllPageAudios()) {
            try {
                if (!audio[state.ownedAudioFlag]) {
                    audio.muted = true;
                    audio.pause();
                }
            } catch {
                // ignore
            }
        }
    }

    function shouldSilenceNativePageAudio() {
        return (
            state.silenceNativeAudio &&
            (state.running || state.generationTasks.size > 0 || state.activeDirectRequests > 0)
        );
    }

    function getButtonLabel(button) {
        return `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`
            .trim()
            .toLowerCase();
    }

    function stopNativePagePlayback() {
        try {
            muteAndPausePageAudios();
        } catch {
            // ignore
        }

        const buttons = Array.from(document.querySelectorAll("button"));

        const pauseButton = buttons.find((button) => {
            if (!(button instanceof HTMLButtonElement)) return false;
            if (!isVisibleEnough(button)) return false;
            if (isButtonDisabled(button)) return false;

            const label = getButtonLabel(button);

            return (
                label.includes("pause") &&
                !label.includes("resume") &&
                !label.includes("paused")
            );
        });

        if (pauseButton) {
            try {
                pauseButton.click();
                return true;
            } catch {
                return false;
            }
        }

        return false;
    }

    function silenceNativePlaybackFor(ms = 1500) {
        stopNativePagePlayback();
        const startedAt = performance.now();

        const timer = window.setInterval(() => {
            stopNativePagePlayback();
            if (performance.now() - startedAt >= ms) {
                window.clearInterval(timer);
            }
        }, 180);
    }

    function installNativePlaybackGuard() {
        if (window.__voxNativePlaybackGuardInstalled) return;
        window.__voxNativePlaybackGuardInstalled = true;

        const originalPlay = HTMLMediaElement.prototype.play;

        HTMLMediaElement.prototype.play = function patchedPlay(...args) {
            if (!this[state.ownedAudioFlag] && shouldSilenceNativePageAudio()) {
                try {
                    this.muted = true;
                    this.pause();
                } catch {
                    // ignore
                }
                return Promise.resolve();
            }

            return originalPlay.apply(this, args);
        };

        if (
            window.AudioBufferSourceNode &&
            AudioBufferSourceNode.prototype &&
            AudioBufferSourceNode.prototype.start
        ) {
            const originalStart = AudioBufferSourceNode.prototype.start;

            AudioBufferSourceNode.prototype.start = function patchedAudioBufferSourceStart(...args) {
                if (shouldSilenceNativePageAudio()) {
                    return undefined;
                }

                return originalStart.apply(this, args);
            };
        }

        debug("Native playback guard installed.");
    }

    installNativePlaybackGuard();

    async function waitFor(fn, timeoutMs, label, intervalMs = 100) {
        const startedAt = performance.now();
        let lastError = null;

        while (performance.now() - startedAt < timeoutMs) {
            try {
                const result = fn();
                if (result) return result;
            } catch (error) {
                lastError = error;
            }

            await sleep(intervalMs);
        }

        const suffix = lastError ? ` Last error: ${lastError.message}` : "";
        throw new Error(`Timed out waiting for ${label}.${suffix}`);
    }

    async function waitForPlaygroundReady() {
        const textarea = await waitFor(() => getTextArea(), DEFAULTS.waitForDomMs, "TTS textarea");
        const button = await waitFor(() => getGenerateButton(), DEFAULTS.waitForDomMs, "Generate button");
        return {
            textarea,
            button
        };
    }

    function setReactTextareaValue(textarea, value) {
        textarea.focus();

        const prototype = Object.getPrototypeOf(textarea);
        const descriptor =
            Object.getOwnPropertyDescriptor(prototype, "value") ||
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");

        if (descriptor && descriptor.set) {
            descriptor.set.call(textarea, value);
        } else {
            textarea.value = value;
        }

        textarea.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: value,
        }));

        textarea.dispatchEvent(new Event("change", {
            bubbles: true
        }));
        textarea.dispatchEvent(new KeyboardEvent("keyup", {
            bubbles: true
        }));
    }

    async function fillPlaygroundText(text) {
        const textarea = getTextArea();
        if (!textarea) throw new Error("Could not find the TTS textarea.");

        setReactTextareaValue(textarea, text);

        await waitFor(() => {
            const current = getTextArea();
            return current && current.value === text;
        }, 5000, "textarea value to update", 50);
    }

    async function waitForGenerateButtonEnabled() {
        return await waitFor(() => {
            const button = getGenerateButton();
            return button && !isButtonDisabled(button) ? button : null;
        }, 30000, "Generate button to become enabled", 100);
    }

    function normalizeUrl(url) {
        if (!url) return DEFAULTS.defaultUrl;
        try {
            return new URL(url, location.href).toString();
        } catch {
            return url;
        }
    }

    function cleanHeaders(headersLike) {
        const out = {};

        try {
            const headers = new Headers(headersLike || {});
            for (const [key, value] of headers.entries()) {
                const k = key.toLowerCase();

                if (
                    k === "host" ||
                    k === "cookie" ||
                    k === "content-length" ||
                    k === "origin" ||
                    k === "referer" ||
                    k.startsWith("sec-") ||
                    k.startsWith("proxy-")
                ) {
                    continue;
                }

                out[key] = value;
            }
        } catch {
            // ignore
        }

        out["content-type"] = "application/json";
        return out;
    }

    function getUrl(input) {
        if (typeof input === "string") return input;
        if (input instanceof URL) return String(input);
        if (input instanceof Request) return input.url;
        return "";
    }

    function getMethod(input, init) {
        return (
            (init && init.method) ||
            (input instanceof Request && input.method) ||
            "GET"
        ).toUpperCase();
    }

    function headersFrom(input, init) {
        try {
            if (init && init.headers) return new Headers(init.headers);
            if (input instanceof Request) return new Headers(input.headers);
        } catch {
            // ignore
        }
        return new Headers();
    }

    async function bodyToText(input, init) {
        try {
            if (init && typeof init.body === "string") return init.body;
            if (input instanceof Request) return await input.clone().text();
            if (init && init.body instanceof Blob) return await init.body.text();
            return "";
        } catch {
            return "";
        }
    }

    function guessAudioMimeFromBase64(base64) {
        if (!base64) return "audio/wav";
        if (base64.startsWith("UklGR")) return "audio/wav";
        if (base64.startsWith("SUQz")) return "audio/mpeg";
        if (base64.startsWith("//u") || base64.startsWith("/+M")) return "audio/mpeg";
        if (base64.startsWith("T2dnUw")) return "audio/ogg";
        return "audio/wav";
    }

    function base64ToBlob(base64, mime) {
        const clean = String(base64)
            .replace(/^data:.*?;base64,/, "")
            .replace(/\s/g, "");

        const bytes = atob(clean);
        const chunks = [];
        const chunkSize = 8192;

        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            const slice = bytes.slice(offset, offset + chunkSize);
            const arr = new Uint8Array(slice.length);

            for (let i = 0; i < slice.length; i += 1) {
                arr[i] = slice.charCodeAt(i);
            }

            chunks.push(arr);
        }

        return new Blob(chunks, {
            type: mime || guessAudioMimeFromBase64(base64)
        });
    }

    function findAudioContentInJson(value) {
        if (!value || typeof value !== "object") return null;

        if (typeof value.audioContent === "string" && value.audioContent.length > 1000) {
            return value.audioContent;
        }

        if (
            value.result &&
            typeof value.result.audioContent === "string" &&
            value.result.audioContent.length > 1000
        ) {
            return value.result.audioContent;
        }

        if (
            value.audio &&
            typeof value.audio.audioContent === "string" &&
            value.audio.audioContent.length > 1000
        ) {
            return value.audio.audioContent;
        }

        for (const key of Object.keys(value)) {
            const nested = value[key];
            if (nested && typeof nested === "object") {
                const found = findAudioContentInJson(nested);
                if (found) return found;
            }
        }

        return null;
    }

    function extractAudioContent(text) {
        if (!text) return null;

        try {
            const json = JSON.parse(text);
            const found = findAudioContentInJson(json);
            if (found) return {
                audioContent: found,
                source: "json-audioContent"
            };
        } catch {
            // Fall through to NDJSON/SSE parsing.
        }

        const lines = text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);

        for (let line of lines) {
            if (line.startsWith("data:")) {
                line = line.slice(5).trim();
            }

            try {
                const json = JSON.parse(line);
                const found = findAudioContentInJson(json);
                if (found) return {
                    audioContent: found,
                    source: "ndjson-audioContent"
                };
            } catch {
                // ignore non-json lines
            }
        }

        return null;
    }

    function rememberCapturedAudio(blob, meta = {}) {
        if (!blob || blob.size < 1000) return;

        const url = URL.createObjectURL(blob);
        state.objectUrls.add(url);

        const item = {
            url,
            mime: blob.type || meta.mime || "audio/unknown",
            size: blob.size,
            capturedAt: Date.now(),
            source: meta.source || "unknown",
        };

        state.capturedAudioQueue.push(item);
        debug("Captured audio", item);
    }

    async function inspectFetchResponseForAudio(response) {
        try {
            const contentType = response.headers.get("content-type") || "";

            if (
                contentType.includes("audio") ||
                contentType.includes("mpeg") ||
                contentType.includes("wav") ||
                contentType.includes("mp3")
            ) {
                const blob = await response.clone().blob();
                rememberCapturedAudio(blob, {
                    source: "fetch-audio",
                    mime: blob.type || contentType
                });
                return;
            }

            if (
                contentType.includes("json") ||
                contentType.includes("text") ||
                contentType.includes("ndjson") ||
                contentType === ""
            ) {
                const text = await response.clone().text();
                if (!text || !text.includes("audioContent")) return;

                const extracted = extractAudioContent(text);
                if (!extracted) return;

                const mime = guessAudioMimeFromBase64(extracted.audioContent);
                const blob = base64ToBlob(extracted.audioContent, mime);
                rememberCapturedAudio(blob, {
                    source: `fetch-${extracted.source}`,
                    mime
                });
            }
        } catch {
            // Never break page fetch.
        }
    }

    function inspectXhrForAudio(xhr) {
        try {
            const contentType = xhr.getResponseHeader("content-type") || "";

            if (
                contentType.includes("audio") ||
                contentType.includes("mpeg") ||
                contentType.includes("wav") ||
                contentType.includes("mp3")
            ) {
                let blob = null;

                if (xhr.response instanceof Blob) {
                    blob = xhr.response;
                } else if (xhr.response instanceof ArrayBuffer) {
                    blob = new Blob([xhr.response], {
                        type: contentType || "audio/mpeg"
                    });
                }

                if (blob) rememberCapturedAudio(blob, {
                    source: "xhr-audio",
                    mime: blob.type || contentType
                });
                return;
            }

            const responseText =
                typeof xhr.responseText === "string" ?
                xhr.responseText :
                typeof xhr.response === "string" ?
                xhr.response :
                "";

            if (!responseText || !responseText.includes("audioContent")) return;

            const extracted = extractAudioContent(responseText);
            if (!extracted) return;

            const mime = guessAudioMimeFromBase64(extracted.audioContent);
            const blob = base64ToBlob(extracted.audioContent, mime);
            rememberCapturedAudio(blob, {
                source: `xhr-${extracted.source}`,
                mime
            });
        } catch {
            // Never break page XHR.
        }
    }

    function installRequestCapture() {
        if (window.__voxRequestCaptureInstalled) return;
        window.__voxRequestCaptureInstalled = true;

        const originalFetch = window.fetch;

        if (typeof originalFetch === "function") {
            window.fetch = async function patchedFetch(input, init = {}) {
                const url = getUrl(input);
                const method = getMethod(input, init);
                const isCreateSpeech =
                    method === "POST" &&
                    /create-speech/i.test(url) &&
                    state.internalDirectRequestDepth === 0;
                if (isCreateSpeech) {
                    const bodyText = await bodyToText(input, init);
                    let bodyTemplate = null;

                    try {
                        bodyTemplate = JSON.parse(bodyText);
                    } catch {
                        bodyTemplate = null;
                    }

                    state.directConfig = {
                        url: normalizeUrl(url),
                        method,
                        headers: cleanHeaders(headersFrom(input, init)),
                        bodyTemplate,
                        capturedAt: Date.now(),
                        capturedFrom: "fetch-create-speech",
                    };

                    updateRequestFieldsFromTemplate(bodyTemplate);
                    updateUiState();
                    log(`Learned create-speech endpoint: ${state.directConfig.url}`);
                }

                const response = await originalFetch.apply(this, arguments);

                if (isCreateSpeech) {
                    inspectFetchResponseForAudio(response);
                }

                return response;
            };
        }

        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

        XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
            this.__voxMethod = method;
            this.__voxUrl = url;
            this.__voxHeaders = {};
            return originalOpen.call(this, method, url, ...rest);
        };

        XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(key, value) {
            try {
                this.__voxHeaders = this.__voxHeaders || {};
                this.__voxHeaders[key] = value;
            } catch {
                // ignore
            }

            return originalSetRequestHeader.call(this, key, value);
        };

        XMLHttpRequest.prototype.send = function patchedSend(body) {
            const method = String(this.__voxMethod || "GET").toUpperCase();
            const url = String(this.__voxUrl || "");
            const isCreateSpeech = method === "POST" && /create-speech/i.test(url);

            if (isCreateSpeech && typeof body === "string") {
                let bodyTemplate = null;
                try {
                    bodyTemplate = JSON.parse(body);
                } catch {
                    bodyTemplate = null;
                }

                state.directConfig = {
                    url: normalizeUrl(url),
                    method,
                    headers: cleanHeaders(this.__voxHeaders || {}),
                    bodyTemplate,
                    capturedAt: Date.now(),
                    capturedFrom: "xhr-create-speech",
                };

                updateRequestFieldsFromTemplate(bodyTemplate);
                updateUiState();
                log(`Learned create-speech endpoint: ${state.directConfig.url}`);
            }

            this.addEventListener("load", () => {
                if (isCreateSpeech) inspectXhrForAudio(this);
            });

            return originalSend.apply(this, arguments);
        };

        debug("Request capture installed.");
    }

    installRequestCapture();

    function updateRequestFieldsFromTemplate(template) {
        if (!template || typeof template !== "object") return;

        const voice = byId("voice");
        const model = byId("model");
        const delivery = byId("delivery");
        const encoding = byId("encoding");
        const sampleRate = byId("sampleRate");
        const speakingRate = byId("speakingRate");

        if (voice && template.voiceId) {
            renderVoiceOptions(discoverPageVoices(), template.voiceId);
        }
        if (model && template.modelId) model.value = template.modelId;
        if (delivery && template.deliveryMode) delivery.value = template.deliveryMode;

        if (template.audioConfig) {
            if (encoding && template.audioConfig.audioEncoding) {
                encoding.value = template.audioConfig.audioEncoding;
            }
            if (sampleRate && template.audioConfig.sampleRateHertz) {
                sampleRate.value = String(template.audioConfig.sampleRateHertz);
            }
            if (speakingRate && template.audioConfig.speakingRate) {
                speakingRate.value = String(clampSpeakingRate(template.audioConfig.speakingRate));
            }
        }
    }

    function buildPayload(text) {
        const template =
            state.directConfig.bodyTemplate && typeof state.directConfig.bodyTemplate === "object" ?
            structuredCloneSafe(state.directConfig.bodyTemplate) :
            {};

        const templateAudioConfig =
            template.audioConfig && typeof template.audioConfig === "object" ?
            template.audioConfig :
            {};

        const selectedPageVoice = state.usePageVoice ? getSelectedPageVoice() : null;

        if (selectedPageVoice) {
            state.pageVoiceId = selectedPageVoice.id;
            state.pageVoiceRole = selectedPageVoice.role || "";
        }

        const voiceId =
            (state.usePageVoice && state.pageVoiceId) ||
            byId("voice")?.value?.trim() ||
            template.voiceId ||
            DEFAULTS.defaultVoiceId;

        const modelId =
            byId("model")?.value?.trim() ||
            template.modelId ||
            DEFAULTS.defaultModelId;

        const deliveryMode =
            byId("delivery")?.value?.trim() ||
            template.deliveryMode ||
            DEFAULTS.defaultDeliveryMode;

        const audioEncoding =
            byId("encoding")?.value?.trim() ||
            templateAudioConfig.audioEncoding ||
            DEFAULTS.defaultAudioEncoding;

        const sampleRateHertz = Number(
            byId("sampleRate")?.value ||
            templateAudioConfig.sampleRateHertz ||
            DEFAULTS.defaultSampleRateHertz
        );

        const speakingRate = clampSpeakingRate(
            byId("speakingRate")?.value ||
            templateAudioConfig.speakingRate ||
            DEFAULTS.defaultSpeakingRate
        );

        return {
            ...template,
            text,
            voiceId,
            modelId,
            deliveryMode,
            audioConfig: {
                ...templateAudioConfig,
                audioEncoding,
                sampleRateHertz,
                speakingRate,
            },
        };
    }

    function structuredCloneSafe(value) {
        try {
            return structuredClone(value);
        } catch {
            return JSON.parse(JSON.stringify(value));
        }
    }

    function withTimeout(promise, ms, label) {
        const controller = new AbortController();
        let timer = null;

        const timeoutPromise = new Promise((_, reject) => {
            timer = window.setTimeout(() => {
                try {
                    controller.abort();
                } catch {
                    // ignore
                }
                reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s.`));
            }, ms);
        });

        return {
            signal: controller.signal,
            promise: Promise.race([promise(controller.signal), timeoutPromise]).finally(() => {
                if (timer) window.clearTimeout(timer);
            }),
        };
    }

    async function directCreateSpeech(text, index) {
        const payload = buildPayload(text);
        const url = normalizeUrl(state.directConfig.url || DEFAULTS.defaultUrl);
        const headers = {
            ...(state.directConfig.headers || {}),
            "content-type": "application/json",
        };

        log(`Direct generating chunk ${index + 1}/${state.chunks.length} (${text.length} chars, voice=${payload.voiceId}, speed=${payload.audioConfig?.speakingRate}x)...`);
        state.activeDirectRequests += 1;
        updateUiState();

        try {
            const request = withTimeout(async (signal) => {
                state.internalDirectRequestDepth += 1;

                let response;
                try {
                    response = await fetch(url, {
                        method: state.directConfig.method || "POST",
                        credentials: "include",
                        mode: "cors",
                        headers,
                        body: JSON.stringify(payload),
                        signal,
                    });
                } finally {
                    state.internalDirectRequestDepth = Math.max(0, state.internalDirectRequestDepth - 1);
                }

                const responseText = await response.text();

                if (!response.ok) {
                    throw new Error(`Direct request failed: ${response.status}. ${responseText.slice(0, 400)}`);
                }

                const extracted = extractAudioContent(responseText);
                if (!extracted) {
                    throw new Error(`No audioContent found in direct response. Preview: ${responseText.slice(0, 400)}`);
                }

                const mime = guessAudioMimeFromBase64(extracted.audioContent);
                const blob = base64ToBlob(extracted.audioContent, mime);
                const objectUrl = URL.createObjectURL(blob);
                state.objectUrls.add(objectUrl);

                const duration = await getAudioDuration(objectUrl);

                return {
                    index,
                    url: objectUrl,
                    sourceUrl: url,
                    mime,
                    duration,
                    chars: text.length,
                    captureSource: `direct-${extracted.source}`,
                    bytes: blob.size,
                    payload,
                };
            }, DEFAULTS.requestTimeoutMs, `Direct request for chunk ${index + 1}`);

            const clip = await request.promise;
            state.clips.set(index, clip);

            const durationText = clip.duration ? `${clip.duration.toFixed(1)}s` : "unknown duration";
            log(`Ready chunk ${index + 1}/${state.chunks.length} (${durationText}, ${clip.mime}, ${clip.captureSource}, ${clip.bytes} bytes).`);

            return clip;
        } finally {
            state.activeDirectRequests = Math.max(0, state.activeDirectRequests - 1);
            updateUiState();
        }
    }

    async function getAudioDuration(url) {
        return await new Promise((resolve) => {
            const audio = new Audio();
            let settled = false;

            const finish = (duration) => {
                if (settled) return;
                settled = true;

                try {
                    audio.removeAttribute("src");
                    audio.load();
                } catch {
                    // ignore cleanup errors
                }

                resolve(Number.isFinite(duration) ? duration : 0);
            };

            const timer = window.setTimeout(() => finish(0), 7000);

            audio.addEventListener("loadedmetadata", () => {
                window.clearTimeout(timer);
                finish(audio.duration);
            }, {
                once: true
            });

            audio.addEventListener("error", () => {
                window.clearTimeout(timer);
                finish(0);
            }, {
                once: true
            });

            audio.preload = "metadata";
            audio.src = url;
        });
    }

    async function uiGenerateClip(index) {
        const chunk = state.chunks[index];
        if (!chunk) throw new Error(`Missing chunk ${index + 1}.`);

        await waitForPlaygroundReady();
        log(`UI fallback generating chunk ${index + 1}/${state.chunks.length} (${chunk.length} chars)...`);

        const beforeCount = state.capturedAudioQueue.length;
        await fillPlaygroundText(chunk);

        const button = await waitForGenerateButtonEnabled();
        button.click();
        silenceNativePlaybackFor(5000);

        const captured = await waitFor(() => {
            return state.capturedAudioQueue[beforeCount] || null;
        }, DEFAULTS.requestTimeoutMs, `captured UI fallback audio for chunk ${index + 1}`, 150);

        silenceNativePlaybackFor(5000);

        const duration = await getAudioDuration(captured.url);

        const clip = {
            index,
            url: captured.url,
            sourceUrl: captured.url,
            mime: captured.mime,
            duration,
            chars: chunk.length,
            captureSource: captured.source,
            bytes: captured.size,
        };

        state.clips.set(index, clip);
        log(`Ready chunk ${index + 1}/${state.chunks.length} (${duration ? duration.toFixed(1) + "s" : "unknown duration"}, ${clip.mime}, UI fallback).`);
        return clip;
    }

    function getGenerationConcurrency() {
        return clampNumber(Number(byId("concurrency")?.value || DEFAULTS.concurrentDirectRequests), 1, 3);
    }

    function ensureClip(index) {
        if (index < 0 || index >= state.chunks.length) return Promise.resolve(null);

        if (state.clips.has(index)) {
            return Promise.resolve(state.clips.get(index));
        }

        if (state.generationTasks.has(index)) {
            return state.generationTasks.get(index);
        }

        const task = runGenerationWithQueue(index);

        const tracked = task.finally(() => {
            state.generationTasks.delete(index);
            updateUiState();
        });

        state.generationTasks.set(index, tracked);
        updateUiState();
        return tracked;
    }

    function runGenerationWithQueue(index) {
        return new Promise((resolve, reject) => {
            state.directQueue.push({
                index,
                resolve,
                reject
            });
            pumpGenerationQueue();
        });
    }

    function pumpGenerationQueue() {
        const concurrency = getGenerationConcurrency();

        while (state.activeDirectRequests < concurrency && state.directQueue.length > 0) {
            const item = state.directQueue.shift();
            const chunk = state.chunks[item.index];

            const job = (async () => {
                if (state.stopRequested) throw new Error("Stopped.");

                if (state.directMode) {
                    return await directCreateSpeech(chunk, item.index);
                }

                return await uiGenerateClip(item.index);
            })();

            job.then(item.resolve).catch(item.reject).finally(() => {
                // directCreateSpeech updates activeDirectRequests itself. UI fallback does not.
                if (!state.directMode) {
                    updateUiState();
                }
                pumpGenerationQueue();
            });
        }
    }

    function fillLookAheadBuffer(fromIndex) {
        const lookAhead = clampNumber(Number(byId("lookahead")?.value || DEFAULTS.lookAhead), 1, 5);

        for (let index = fromIndex; index < Math.min(state.chunks.length, fromIndex + lookAhead); index += 1) {
            if (!state.clips.has(index) && !state.generationTasks.has(index)) {
                ensureClip(index).catch((error) => {
                    if (!state.stopRequested) {
                        log(`Could not prepare chunk ${index + 1}: ${error.message}`, "error");
                    }
                });
            }
        }
    }

    function playClip(clip) {
        return new Promise((resolve, reject) => {
            if (state.stopRequested) {
                resolve();
                return;
            }

            const audio = new Audio();
            audio[state.ownedAudioFlag] = true;

            state.currentAudio = audio;
            state.currentIndex = clip.index;
            state.nextToPlay = clip.index;
            state.currentChunkCurrentTime = 0;
            state.currentChunkDuration = clip.duration || 0;
            state.paused = false;

            updateUiState();

            audio.preload = "auto";
            audio.volume = 1;
            audio.src = clip.url;

            let settled = false;

            const cleanup = () => {
                audio.removeEventListener("loadedmetadata", onLoadedMetadata);
                audio.removeEventListener("timeupdate", onTimeUpdate);
                audio.removeEventListener("ended", onEnded);
                audio.removeEventListener("error", onError);
            };

            const finish = () => {
                if (settled) return;
                settled = true;
                cleanup();

                if (state.currentAudio === audio) {
                    state.currentAudio = null;
                }

                state.nextToPlay = clip.index + 1;
                state.currentIndex = -1;
                state.currentChunkCurrentTime = 0;
                state.currentChunkDuration = 0;

                updateUiState();
                resolve();
            };

            const fail = (error) => {
                if (settled) return;
                settled = true;
                cleanup();

                if (state.currentAudio === audio) {
                    state.currentAudio = null;
                }

                reject(error);
            };

            function onLoadedMetadata() {
                state.currentChunkDuration =
                    Number.isFinite(audio.duration) && audio.duration > 0 ?
                    audio.duration :
                    clip.duration || 0;

                updateUiState();
            }

            function onTimeUpdate() {
                state.currentChunkCurrentTime = audio.currentTime || 0;
                state.currentChunkDuration =
                    Number.isFinite(audio.duration) && audio.duration > 0 ?
                    audio.duration :
                    state.currentChunkDuration;

                updateUiState();
            }

            function onEnded() {
                log(`Finished chunk ${clip.index + 1}/${state.chunks.length}.`);
                finish();
            }

            function onError() {
                const error = audio.error;
                const code = error ? error.code : "unknown";
                fail(new Error(`Audio playback failed for chunk ${clip.index + 1}. Browser error code: ${code}.`));
            }

            audio.addEventListener("loadedmetadata", onLoadedMetadata);
            audio.addEventListener("timeupdate", onTimeUpdate);
            audio.addEventListener("ended", onEnded);
            audio.addEventListener("error", onError);

            log(`Playing chunk ${clip.index + 1}/${state.chunks.length}...`);
            silenceNativePlaybackFor(1200);

            audio.play()
                .then(() => {
                    fillLookAheadBuffer(clip.index + 1);
                })
                .catch((error) => {
                    state.paused = true;
                    updateUiState();

                    if (!canDecodeAudioMpeg() && clip.mime.includes("mpeg")) {
                        fail(new Error(`Playback failed because this browser likely cannot decode audio/mpeg. Try Chrome/Edge or install Firefox system codecs. Original error: ${error.message}`));
                    } else {
                        fail(new Error(`Playback was blocked or failed. Click Resume/Start after user interaction. Original error: ${error.message}`));
                    }
                });
        });
    }

    async function playbackLoop(startIndex = 0) {
        if (state.running) return;

        state.running = true;
        state.paused = false;
        state.stopRequested = false;
        state.nextToPlay = startIndex;
        updateUiState();

        try {
            fillLookAheadBuffer(startIndex);
            await ensureClip(startIndex);

            for (let index = startIndex; index < state.chunks.length; index += 1) {
                if (state.stopRequested) break;

                fillLookAheadBuffer(index);

                const clip = await ensureClip(index);
                if (state.stopRequested || !clip) break;

                await playClip(clip);
            }

            if (!state.stopRequested) {
                state.nextToPlay = state.chunks.length;
                log("Done. All chunks played.");
            }
        } catch (error) {
            if (!state.stopRequested) {
                log(error.message, "error");
            }
        } finally {
            state.running = false;
            state.paused = false;
            state.currentAudio = null;
            state.currentIndex = -1;
            state.currentChunkCurrentTime = 0;
            state.currentChunkDuration = 0;
            updateUiState();
        }
    }

    function pausePlayback() {
        if (state.currentAudio && !state.currentAudio.paused) {
            state.currentAudio.pause();
            state.paused = true;
            updateUiState();
            log("Paused.");
            return;
        }

        state.paused = true;
        updateUiState();
        log("Paused state set. No audio was actively playing.", "warn");
    }

    async function resumePlayback() {
        if (state.currentAudio && state.currentAudio.paused) {
            try {
                await state.currentAudio.play();
                state.paused = false;
                updateUiState();
                log("Resumed.");
            } catch (error) {
                log(`Could not resume: ${error.message}`, "error");
            }
            return;
        }

        if (state.chunks.length && !state.running) {
            const index = Math.min(state.nextToPlay, state.chunks.length - 1);
            state.stopRequested = false;
            playbackLoop(Math.max(0, index));
        }
    }

    function stopPlayback() {
        state.stopRequested = true;
        state.running = false;
        state.paused = false;
        state.directQueue.length = 0;

        if (state.currentAudio) {
            try {
                state.currentAudio.pause();
                state.currentAudio.currentTime = 0;
            } catch {
                // ignore
            }

            state.currentAudio = null;
        }

        state.currentIndex = -1;
        state.currentChunkCurrentTime = 0;
        state.currentChunkDuration = 0;

        muteAndPausePageAudios();
        updateUiState();

        log("Stopped. Already-started requests may still finish and be cached.");
    }

    function resetQueueForNewText() {
        stopPlayback();

        state.clips.clear();
        state.generationTasks.clear();
        state.directQueue.length = 0;
        state.currentIndex = -1;
        state.nextToPlay = 0;
        state.currentChunkCurrentTime = 0;
        state.currentChunkDuration = 0;
        state.capturedAudioQueue.length = 0;

        for (const url of state.objectUrls) {
            try {
                URL.revokeObjectURL(url);
            } catch {
                // ignore
            }
        }

        state.objectUrls.clear();
    }

    function splitLongText(input, maxSize = DEFAULTS.maxChunkSize, minBreakSize = DEFAULTS.minBreakSize) {
        const text = input
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n")
            .replace(/[ \t]+\n/g, "\n")
            .trim();

        if (!text) return [];

        const chunks = [];
        let start = 0;

        while (start < text.length) {
            const remaining = text.length - start;

            if (remaining <= maxSize) {
                const finalChunk = text.slice(start).trim();
                if (finalChunk) chunks.push(finalChunk);
                break;
            }

            const windowText = text.slice(start, start + maxSize);
            let breakAt = findBestBreak(windowText, minBreakSize, maxSize);

            if (breakAt <= 0) breakAt = maxSize;

            const chunk = text.slice(start, start + breakAt).trim();
            if (chunk) chunks.push(chunk);

            start += breakAt;

            while (start < text.length && /\s/.test(text[start])) {
                start += 1;
            }
        }

        return chunks;
    }

    function findBestBreak(windowText, minBreakSize, maxSize) {
        const min = Math.min(minBreakSize, Math.floor(maxSize * 0.5));

        const paragraph = lastIndexAtOrAfter(windowText, "\n\n", min);
        if (paragraph > 0) return paragraph + 2;

        const line = lastIndexAtOrAfter(windowText, "\n", min);
        if (line > 0) return line + 1;

        const sentence = lastSentenceBreak(windowText, min);
        if (sentence > 0) return sentence;

        const space = lastIndexAtOrAfter(windowText, " ", min);
        if (space > 0) return space + 1;

        return maxSize;
    }

    function lastIndexAtOrAfter(text, needle, minIndex) {
        let best = -1;
        let from = 0;

        while (true) {
            const index = text.indexOf(needle, from);
            if (index === -1) break;
            if (index >= minIndex) best = index;
            from = index + needle.length;
        }

        return best;
    }

    function lastSentenceBreak(text, minIndex) {
        const regex = /[.!?]["')\]]?\s+/g;
        let best = -1;
        let match;

        while ((match = regex.exec(text)) !== null) {
            const end = match.index + match[0].length;
            if (end >= minIndex) best = end;
        }

        return best;
    }

    function clampNumber(value, min, max) {
        if (!Number.isFinite(value)) return min;
        return Math.max(min, Math.min(max, value));
    }

    function clampSpeakingRate(value) {
        const n = Number(value);

        if (!Number.isFinite(n)) {
            return DEFAULTS.defaultSpeakingRate;
        }

        return Math.max(0.5, Math.min(1.5, n));
    }

    function getPageCharacterLimit() {
        const textarea = getTextArea();

        if (textarea && textarea.maxLength && textarea.maxLength > 0 && textarea.maxLength < 100000) {
            return textarea.maxLength;
        }

        return 2000;
    }

    function getSafeChunkMax() {
        const requestedMax = Number(byId("max")?.value || DEFAULTS.maxChunkSize);

        // VoxInfinity create-speech requests should stay below the 2,000 char hard limit.
        // 1,900 is the safer long-text target.
        const apiSafeLimit = 1900;

        const textarea = getTextArea();
        const pageLimit =
            textarea && textarea.maxLength && textarea.maxLength > 0 && textarea.maxLength < 100000 ?
            textarea.maxLength :
            apiSafeLimit;

        const safeLimit = Math.min(apiSafeLimit, Math.max(250, pageLimit - 50));

        return clampNumber(requestedMax, 250, safeLimit);
    }

    function prepareChunksFromUi() {
        const input = byId("input")?.value || "";
        const max = getSafeChunkMax();
        const min = clampNumber(Number(byId("min")?.value || DEFAULTS.minBreakSize), 100, max);

        resetQueueForNewText();

        state.chunks = splitLongText(input, max, min);

        const maxBox = byId("max");
        if (maxBox) maxBox.value = String(max);

        renderPreview();
        updateUiState();

        if (!state.chunks.length) {
            log("Paste text first, then Prepare/Start.", "warn");
            return;
        }

        log(`Prepared ${state.chunks.length} chunks. Max chunk: ${max}. Longest actual chunk: ${Math.max(...state.chunks.map((chunk) => chunk.length))} chars.`);
    }

    function renderPreview() {
        const preview = byId("preview");
        if (!preview) return;

        preview.innerHTML = "";

        state.chunks.slice(0, 14).forEach((chunk, index) => {
            const item = document.createElement("div");
            item.className = "preview-item";
            item.textContent = `${index + 1}. ${chunk.length} chars — ${chunk.slice(0, 130).replace(/\s+/g, " ")}${chunk.length > 130 ? "…" : ""}`;
            preview.appendChild(item);
        });

        if (state.chunks.length > 14) {
            const more = document.createElement("div");
            more.className = "preview-item";
            more.textContent = `…and ${state.chunks.length - 14} more chunks`;
            preview.appendChild(more);
        }
    }

    async function pregenerateAllFromUi() {
        if (!state.chunks.length) {
            prepareChunksFromUi();
        }

        if (!state.chunks.length) return;

        applySettingsFromUi();

        state.stopRequested = false;
        state.paused = false;
        updateUiState();

        log(`Pre-generating ${state.chunks.length} chunks in ${state.directMode ? "direct mode" : "UI fallback"}.`);

        try {
            for (let index = 0; index < state.chunks.length; index += 1) {
                if (state.stopRequested) break;
                await ensureClip(index);
                log(`Pre-generated ${index + 1}/${state.chunks.length}.`);
            }

            if (!state.stopRequested) {
                log("All chunks pre-generated. Press Start. Background playback should now be reliable.");
            }
        } catch (error) {
            log(`Pre-generation stopped: ${error.message}`, "error");
        } finally {
            updateUiState();
        }
    }

    async function startFromUi() {
        if (!state.chunks.length) {
            prepareChunksFromUi();
        }

        if (!state.chunks.length) return;

        applySettingsFromUi();

        if (!state.directMode && !isTTSRouteOrDomPresent()) {
            log("UI fallback needs the TTS page/widget visible. Direct mode does not.", "warn");
            openPanel();
            return;
        }

        if (!canDecodeAudioMpeg()) {
            log("Warning: this browser reports no audio/mpeg decoder. WAV should still work; MP3 may fail.", "warn");
        }

        state.stopRequested = false;
        state.paused = false;
        updateUiState();

        playbackLoop(Math.min(state.nextToPlay, state.chunks.length - 1));
    }

    function applySettingsFromUi() {
        const mode = byId("directMode");
        state.directMode = mode ? mode.checked : true;

        const silence = byId("silenceNative");
        state.silenceNativeAudio = silence ? silence.checked : true;

        const endpoint = byId("endpoint")?.value?.trim();
        if (endpoint) state.directConfig.url = endpoint;

        state.directConfig.headers = {
            ...(state.directConfig.headers || {}),
            "content-type": "application/json",
        };

        updateUiState();
    }

    function fillUiFromSettings() {
        const endpoint = byId("endpoint");
        const voice = byId("voice");
        const model = byId("model");
        const delivery = byId("delivery");
        const encoding = byId("encoding");
        const sampleRate = byId("sampleRate");
        const speakingRate = byId("speakingRate");
        const directMode = byId("directMode");
        const silenceNative = byId("silenceNative");
        const usePageVoice = byId("usePageVoice");

        if (endpoint) endpoint.value = state.directConfig.url || DEFAULTS.defaultUrl;
        if (voice) renderVoiceOptions(discoverPageVoices(), DEFAULTS.defaultVoiceId);
        if (model) model.value = DEFAULTS.defaultModelId;
        if (delivery) delivery.value = DEFAULTS.defaultDeliveryMode;
        if (encoding) encoding.value = DEFAULTS.defaultAudioEncoding;
        if (sampleRate) sampleRate.value = String(DEFAULTS.defaultSampleRateHertz);
        if (speakingRate) speakingRate.value = String(DEFAULTS.defaultSpeakingRate);
        if (directMode) directMode.checked = state.directMode;
        if (silenceNative) silenceNative.checked = state.silenceNativeAudio;
        if (usePageVoice) usePageVoice.checked = state.usePageVoice;
        updateVoiceModeUi();
    }

    function selectCurrentPageVoice() {
        const voices = discoverPageVoices();
        const selected = getSelectedPageVoice();

        renderVoiceOptions(voices, selected ? selected.id : byId("voice")?.value || DEFAULTS.defaultVoiceId);

        if (selected) {
            state.pageVoiceId = selected.id;
            state.pageVoiceRole = selected.role || "";

            log(
                "Refreshed voices. Page voice is: " +
                selected.id +
                (selected.role ? " (" + selected.role + ")" : "") +
                "."
            );
        } else {
            log("Refreshed voices, but no selected page voice was detected.", "warn");
        }

        updateVoiceModeUi();
    }

    function toggleUsePageVoiceFromUi() {
        setUsePageVoice(!!byId("usePageVoice")?.checked);
    }

    function learnFromPagePrompt() {
        log("Click the page's normal Generate button once. I will capture the create-speech request and switch back to direct mode.", "warn");
    }

    function testSelectors() {
        const textarea = getTextArea();
        const button = getGenerateButton();
        const audios = getAllPageAudios();

        const message = [
            `textarea=${textarea ? "yes" : "no"}`,
            `limit=${textarea?.maxLength || "unknown"}`,
            `generate=${button ? (isButtonDisabled(button) ? "found but disabled" : "yes") : "no"}`,
            `audioTags=${audios.length}`,
            `captured=${state.capturedAudioQueue.length}`,
            `directUrl=${state.directConfig.url}`,
            `voice=${byId("voice")?.value || "unknown"}`,
            `voices=${byId("voice")?.options?.length || 0}`,
            `speed=${byId("speakingRate")?.value || "unknown"}`,
            `audio/mpeg=${canDecodeAudioMpeg() ? "supported" : "not supported"}`,
            `route=${/tts-playground/.test(location.href) ? "portal" : "homepage/other"}`,
        ].join(" · ");

        log(`Selector/direct test: ${message}`);
    }

    function openPanel() {
        if (!state.host) return;
        state.panelOpen = true;
        const panel = byId("panel");
        if (panel) panel.classList.add("open");
    }

    function closePanel() {
        state.panelOpen = false;
        const panel = byId("panel");
        if (panel) panel.classList.remove("open");
    }

    function togglePanel() {
        if (state.panelOpen) closePanel();
        else openPanel();
    }

    function whenBodyReady(callback) {
        if (document.body) {
            callback();
            return;
        }

        const timer = window.setInterval(() => {
            if (document.body) {
                window.clearInterval(timer);
                callback();
            }
        }, 50);
    }

    function mountUi() {
        if (state.mounted || !document.body) return;

        state.mounted = true;

        const host = document.createElement("div");
        host.id = `${APP_ID}-host`;
        host.style.position = "fixed";
        host.style.zIndex = "2147483647";
        host.style.inset = "0";
        host.style.pointerEvents = "none";

        const shadow = host.attachShadow({
            mode: "open"
        });
        state.host = host;
        state.shadow = shadow;

        shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }

        * { box-sizing: border-box; }

        #${APP_ID}-launcher {
          position: fixed;
          right: 18px;
          bottom: 18px;
          width: 62px;
          height: 62px;
          border: 1px solid rgba(255,255,255,0.18);
          border-radius: 999px;
          background: linear-gradient(145deg, #00a85a, #007c43);
          color: #fff;
          box-shadow: 0 16px 44px rgba(0,0,0,0.48);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          pointer-events: auto;
          user-select: none;
          transition: transform 160ms ease, box-shadow 160ms ease;
        }

        #${APP_ID}-launcher:hover {
          transform: translateY(-2px);
          box-shadow: 0 20px 56px rgba(0,0,0,0.56);
        }

        .launcher-main {
          font-weight: 900;
          font-size: 15px;
          line-height: 1;
          letter-spacing: -0.02em;
        }

        #${APP_ID}-badge {
          margin-top: 4px;
          font-size: 9px;
          font-weight: 700;
          opacity: 0.92;
          max-width: 54px;
          text-align: center;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        #${APP_ID}-panel {
          position: fixed;
          right: 18px;
          bottom: 92px;
          width: min(560px, calc(100vw - 36px));
          max-height: min(860px, calc(100vh - 112px));
          display: none;
          flex-direction: column;
          gap: 10px;
          background: rgba(18, 18, 18, 0.97);
          color: #faf7f5;
          border: 1px solid rgba(255,255,255,0.14);
          border-radius: 18px;
          box-shadow: 0 24px 70px rgba(0,0,0,0.55);
          padding: 14px;
          pointer-events: auto;
          overflow: hidden;
        }

        #${APP_ID}-panel.open { display: flex; }

        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          cursor: move;
          user-select: none;
        }

        .title {
          font-size: 14px;
          line-height: 1.2;
          font-weight: 900;
        }

        .subtitle {
          margin-top: 2px;
          color: rgba(250,247,245,0.62);
          font-size: 12px;
        }

        .body {
          overflow: auto;
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding-right: 2px;
        }

        textarea {
          width: 100%;
          min-height: 150px;
          resize: vertical;
          border-radius: 12px;
          border: 1px solid rgba(255,255,255,0.16);
          background: rgba(255,255,255,0.07);
          color: #faf7f5;
          padding: 10px;
          outline: none;
          font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        }

        textarea:focus,
        input:focus {
          border-color: rgba(255,255,255,0.44);
        }

        .row {
          display: flex;
          gap: 8px;
          align-items: center;
          flex-wrap: wrap;
        }

        label {
          display: flex;
          align-items: center;
          gap: 6px;
          color: rgba(250,247,245,0.75);
          font-size: 12px;
        }

input[type="number"],
input[type="text"],
select {
  color-scheme: dark;
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.16);
  background: rgba(255,255,255,0.07);
  color: #faf7f5;
  padding: 7px 8px;
  outline: none;
  min-width: 78px;
}

select option {
  background: #1f1f1f;
  color: #faf7f5;
}

        input.small { width: 78px; }
        input.medium { width: 130px; }
        select.medium { width: 220px; min-width: 220px; }
        input.long { width: min(360px, 100%); flex: 1; }

        .checkbox-label input { min-width: auto; }

        .btn {
          border: 0;
          border-radius: 999px;
          padding: 8px 11px;
          background: rgba(255,255,255,0.12);
          color: #faf7f5;
          cursor: pointer;
          font-weight: 800;
          font-size: 12px;
          transition: background 120ms ease, opacity 120ms ease;
        }

        .btn:hover { background: rgba(255,255,255,0.18); }

        .btn:disabled {
          opacity: 0.42;
          cursor: not-allowed;
        }

        .primary {
          background: #faf7f5;
          color: #111;
        }

        .primary:hover { background: #fff; }

        .danger {
          background: rgba(255, 83, 83, 0.20);
          color: #ffd6d6;
        }

        .status-card, .settings-card {
          border-radius: 12px;
          background: rgba(255,255,255,0.07);
          border: 1px solid rgba(255,255,255,0.10);
          padding: 10px;
        }

        #${APP_ID}-status {
          font-weight: 800;
          font-size: 12px;
          margin-bottom: 4px;
        }

        #${APP_ID}-stats,
        #${APP_ID}-progress-text,
        #${APP_ID}-realtime,
        #${APP_ID}-mode,
        #${APP_ID}-learned,
        .small {
          color: rgba(250,247,245,0.64);
          font-size: 12px;
        }

        .progress {
          height: 7px;
          border-radius: 999px;
          background: rgba(255,255,255,0.10);
          overflow: hidden;
          margin: 8px 0 4px;
        }

        #${APP_ID}-progress-fill {
          width: 0%;
          height: 100%;
          background: #faf7f5;
          border-radius: 999px;
          transition: width 180ms ease;
        }

        .time-row, .meta-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          color: rgba(250,247,245,0.64);
          font-size: 12px;
        }

        #${APP_ID}-preview,
        #${APP_ID}-log {
          border-radius: 12px;
          background: rgba(0,0,0,0.30);
          border: 1px solid rgba(255,255,255,0.09);
          padding: 8px;
          max-height: 140px;
          overflow: auto;
        }

        .preview-item,
        .log-line {
          color: rgba(250,247,245,0.75);
          font-size: 12px;
          padding: 3px 0;
          border-bottom: 1px solid rgba(255,255,255,0.06);
        }

        .preview-item:last-child,
        .log-line:last-child {
          border-bottom: 0;
        }

        .warn { color: #ffd37a; }
        .error { color: #ff9f9f; }

        .notice {
          border-radius: 12px;
          border: 1px solid rgba(255, 211, 122, 0.24);
          background: rgba(255, 211, 122, 0.09);
          padding: 9px 10px;
          color: #ffe5a6;
          font-size: 12px;
          display: none;
        }

        .notice.show { display: block; }
      </style>

      <button id="${APP_ID}-launcher" type="button" title="Open VoxInfinity Engine Queue">
        <div class="launcher-main">TTS</div>
        <div id="${APP_ID}-badge">Ready</div>
      </button>

      <section id="${APP_ID}-panel" aria-label="VoxInfinity Engine Queue">
        <div class="header" id="${APP_ID}-drag">
          <div>
            <div class="title">VoxInfinity Engine Queue</div>
            <div class="subtitle">v${VERSION} · direct request mode · custom queue</div>
          </div>
          <button class="btn" id="${APP_ID}-close" type="button">Close</button>
        </div>

        <div class="body">
          <div id="${APP_ID}-codec-notice" class="notice">
            Firefox reports no audio/mpeg decoder. WAV should still work; MP3 may fail.
          </div>

          <textarea id="${APP_ID}-input" placeholder="Paste long text here..."></textarea>

          <div class="settings-card">
            <div class="row">
              <label>Voice <select id="${APP_ID}-voice" class="medium"></select></label>
              <button class="btn" id="${APP_ID}-syncVoices" type="button">Refresh voices</button>
              <label class="checkbox-label"><input id="${APP_ID}-usePageVoice" type="checkbox"> Use selected page voice</label>
              <span id="${APP_ID}-voiceModeLabel" class="small">Manual: dropdown voice</span>
              <label>Model <input id="${APP_ID}-model" class="medium" type="text" value="${DEFAULTS.defaultModelId}"></label>
              <label>Delivery <input id="${APP_ID}-delivery" class="medium" type="text" value="${DEFAULTS.defaultDeliveryMode}"></label>
            </div>
            <div class="row" style="margin-top:8px">
              <label>Encoding <input id="${APP_ID}-encoding" class="medium" type="text" value="${DEFAULTS.defaultAudioEncoding}"></label>
              <label>Sample rate <input id="${APP_ID}-sampleRate" class="small" type="number" value="${DEFAULTS.defaultSampleRateHertz}"></label>
<label>Speed 0.5–1.5x <input id="${APP_ID}-speakingRate" class="small" type="number" min="0.5" max="1.5" step="0.01" value="${DEFAULTS.defaultSpeakingRate}"></label>
<label>Max chars <input id="${APP_ID}-max" class="small" type="number" min="250" max="2000" value="${DEFAULTS.maxChunkSize}"></label>
              <label>Min break <input id="${APP_ID}-min" class="small" type="number" min="100" max="1900" value="${DEFAULTS.minBreakSize}"></label>
            </div>
            <div class="row" style="margin-top:8px">
              <label>Look-ahead <input id="${APP_ID}-lookahead" class="small" type="number" min="1" max="5" value="${DEFAULTS.lookAhead}"></label>
              <label>Concurrency <input id="${APP_ID}-concurrency" class="small" type="number" min="1" max="3" value="${DEFAULTS.concurrentDirectRequests}"></label>
              <label class="checkbox-label"><input id="${APP_ID}-directMode" type="checkbox" checked> Direct mode</label>
              <label class="checkbox-label"><input id="${APP_ID}-silenceNative" type="checkbox" checked> Silence native player</label>
            </div>
            <div class="row" style="margin-top:8px">
              <label style="flex:1">Endpoint <input id="${APP_ID}-endpoint" class="long" type="text" value="${DEFAULTS.defaultUrl}"></label>
              <button class="btn" id="${APP_ID}-learn" type="button">Learn from page</button>
            </div>
          </div>

          <div class="row">
            <button class="btn" id="${APP_ID}-prepare" type="button">Prepare</button>
            <button class="btn" id="${APP_ID}-pregenerate" type="button">Pre-gen all</button>
            <button class="btn primary" id="${APP_ID}-start" type="button">Start</button>
            <button class="btn" id="${APP_ID}-pause" type="button">Pause</button>
            <button class="btn" id="${APP_ID}-resume" type="button">Resume</button>
            <button class="btn danger" id="${APP_ID}-stop" type="button">Stop</button>
            <button class="btn" id="${APP_ID}-test" type="button">Test</button>
          </div>

          <div class="status-card">
            <div id="${APP_ID}-status">Ready. Direct mode can use /api/create-speech without clicking Generate.</div>
            <div id="${APP_ID}-stats">0 chunks · 0 ready · current 0/0 · 0 chars</div>
            <div class="progress"><div id="${APP_ID}-progress-fill"></div></div>
            <div class="time-row">
              <span id="${APP_ID}-realtime">Chunk time 0:00 / 0:00</span>
              <span id="${APP_ID}-progress-text">0%</span>
            </div>
            <div class="meta-row" style="margin-top:6px">
              <span id="${APP_ID}-mode">Direct mode</span>
              <span id="${APP_ID}-learned">/api/create-speech · default</span>
            </div>
          </div>

          <div>
            <div class="small">Chunk preview</div>
            <div id="${APP_ID}-preview"></div>
          </div>

          <div>
            <div class="small">Log</div>
            <div id="${APP_ID}-log"></div>
          </div>

          <div class="small">
            Direct mode avoids homepage autoplay, hidden-tab Generate aborts, and DOM audio waiting. If direct mode fails, click Learn from page, manually Generate once, then retry.
          </div>
        </div>
      </section>
    `;

        document.body.appendChild(host);

        byId("launcher").addEventListener("click", togglePanel);
        byId("close").addEventListener("click", closePanel);
        byId("prepare").addEventListener("click", prepareChunksFromUi);
        byId("pregenerate").addEventListener("click", pregenerateAllFromUi);
        byId("start").addEventListener("click", startFromUi);
        byId("pause").addEventListener("click", pausePlayback);
        byId("resume").addEventListener("click", resumePlayback);
        byId("stop").addEventListener("click", stopPlayback);
        byId("test").addEventListener("click", testSelectors);
        byId("learn").addEventListener("click", learnFromPagePrompt);
        byId("syncVoices").addEventListener("click", selectCurrentPageVoice);
        byId("voice").addEventListener("change", updateVoiceModeUi);
        byId("usePageVoice").addEventListener("change", toggleUsePageVoiceFromUi);

        makePanelDraggable(byId("panel"), byId("drag"));

        if (!canDecodeAudioMpeg()) {
            byId("codec-notice").classList.add("show");
        }

        fillUiFromSettings();
        syncVoiceOptionsFromPage(true);
        updateVoiceModeUi();
        updateUiState();

        if (isTTSRouteOrDomPresent() || /\.ai/.test(location.hostname)) {
            openPanel();
            log("Loaded v0.4 direct mode. Set voice, paste text, Prepare, then Start or Pre-gen all.");
        } else {
            setStatus("Launcher loaded. Open an VoxInfinity TTS page/widget to use it.");
            setBadge("Open TTS");
        }

        debug("userscript loaded", location.href);
    }

    function makePanelDraggable(panel, handle) {
        let drag = null;

        handle.addEventListener("pointerdown", (event) => {
            if (event.target.closest("button") || event.target.closest("input") || event.target.closest("select") || event.target.closest("label")) return;
            const rect = panel.getBoundingClientRect();
            drag = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                left: rect.left,
                top: rect.top,
            };

            panel.setPointerCapture(event.pointerId);
            event.preventDefault();
        });

        panel.addEventListener("pointermove", (event) => {
            if (!drag || event.pointerId !== drag.pointerId) return;

            const dx = event.clientX - drag.startX;
            const dy = event.clientY - drag.startY;

            panel.style.left = `${Math.max(8, drag.left + dx)}px`;
            panel.style.top = `${Math.max(8, drag.top + dy)}px`;
            panel.style.right = "auto";
            panel.style.bottom = "auto";
        });

        panel.addEventListener("pointerup", (event) => {
            if (!drag || event.pointerId !== drag.pointerId) return;

            try {
                panel.releasePointerCapture(event.pointerId);
            } catch {
                // ignore
            }

            drag = null;
        });
    }

    function watchSpaRouteAndDom() {
        const observer = new MutationObserver(() => {
            if (location.href !== state.lastRoute) {
                state.lastRoute = location.href;

                if (isTTSRouteOrDomPresent()) {
                    setBadge("Ready");
                    setStatus("TTS page/widget detected. Direct mode is ready.");
                }
            }

            if (state.running || state.generationTasks.size > 0 || state.activeDirectRequests > 0) {
                stopNativePagePlayback();
            }
        });

        observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["src", "aria-label", "disabled"],
        });
    }

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden" && !state.directMode && (state.running || state.generationTasks.size > 0)) {
            log("Tab is hidden. UI fallback generation may pause/throttle. Direct mode is recommended.", "warn");
        }
    });

    function boot() {
        whenBodyReady(() => {
            mountUi();
            watchSpaRouteAndDom();
        });
    }

    boot();

    window.__voxLongTTS = {
        version: VERSION,
        state: state,
        splitLongText: splitLongText,
        selectors: SELECTORS,
        getTextArea: getTextArea,
        getGenerateButton: getGenerateButton,
        getAllPageAudios: getAllPageAudios,
        getCurrentAudio: function() {
            return state.currentAudio;
        },
        syncVoiceOptionsFromPage: syncVoiceOptionsFromPage,
        discoverPageVoices: discoverPageVoices,
        testSelectors: testSelectors,
        stopPlayback: stopPlayback,
        openPanel: openPanel,
        directCreateSpeech: directCreateSpeech
    };
})();
