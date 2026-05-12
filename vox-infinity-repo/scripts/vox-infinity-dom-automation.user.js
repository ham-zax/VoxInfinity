// ==UserScript==
// @name         VoxInfinity DOM Automation
// @namespace    vox-infinity-dom-automation
// @version      0.3.0
// @description  DOM automation long-form TTS queue. Chunks text, clicks Generate, captures DOM/network audio, and plays a custom queue.
// @match        https://platform.TARGET_DOMAIN/*
// @match        https://TARGET_DOMAIN/*
// @match        https://www.TARGET_DOMAIN/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const APP_ID = "vox";
  const VERSION = "0.3.0";

  const DEFAULTS = {
    maxChunkSize: 1900,
    minBreakSize: 500,
    lookAhead: 2,
    waitForDomMs: 60000,
    waitForButtonMs: 30000,
    waitForAudioMs: 120000,
    logLimit: 140,
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

  const state = {
    mounted: false,
    panelOpen: false,

    chunks: [],
    clips: new Map(),
    generationTasks: new Map(),
    generationChain: Promise.resolve(),

    capturedAudioQueue: [],
    objectUrls: new Set(),

currentAudio: null,
ownedAudioFlag: "__voxOwnedAudio",
silenceNativeAudio: true,
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
function shouldSilenceNativePageAudio() {
  return (
    state.silenceNativeAudio &&
    (state.running || state.generationTasks.size > 0 || state.clips.size > 0)
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

function silenceNativePlaybackFor(ms = 3500) {
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

  function debug(...args) {
    console.log(`[VoxInfinity Engine v${VERSION}]`, ...args);
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

    async function waitUntilTabVisible(reason = "generation") {
  if (document.visibilityState === "visible") return;

  log(`Tab is hidden. Pausing ${reason} until this tab is visible again.`, "warn");

  await new Promise((resolve) => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        document.removeEventListener("visibilitychange", onVisible);
        resolve();
      }
    };

    document.addEventListener("visibilitychange", onVisible);
  });

  log(`Tab is visible again. Resuming ${reason}.`);
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
      Array.from(document.querySelectorAll("button")).some((b) =>
        (b.textContent || "").trim().toLowerCase() === "generate"
      )
    );
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

  function updateUiState() {
    const total = state.chunks.length;
    const generated = state.clips.size;
    const current = state.currentIndex >= 0 ? state.currentIndex + 1 : 0;
    const chars = state.chunks.reduce((sum, chunk) => sum + chunk.length, 0);

    const activeIndex = state.currentIndex >= 0 ? state.currentIndex : state.nextToPlay;
    const chunkFraction =
      state.currentChunkDuration > 0
        ? Math.min(1, state.currentChunkCurrentTime / state.currentChunkDuration)
        : 0;

    const liveUnits =
      state.running && state.currentIndex >= 0
        ? activeIndex + chunkFraction
        : state.nextToPlay;

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

    const start = byId("start");
    const pause = byId("pause");
    const resume = byId("resume");
    const stop = byId("stop");
    const prepare = byId("prepare");
    const pregenerate = byId("pregenerate");

    if (start) start.disabled = state.running && !state.paused;
    if (pause) pause.disabled = !state.running || state.paused;
    if (resume) resume.disabled = !state.paused;
    if (stop) stop.disabled = !state.running && !state.currentAudio && !state.generationTasks.size;
    if (prepare) prepare.disabled = state.running || state.generationTasks.size > 0;
    if (pregenerate) pregenerate.disabled = state.running || state.generationTasks.size > 0;

    if (state.running) {
      setBadge(state.paused ? "Paused" : "Running");
    } else if (state.generationTasks.size > 0) {
      setBadge("Generating");
    } else if (state.chunks.length) {
      setBadge(`${state.chunks.length} chunks`);
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

  function getCurrentAudioSrcs() {
    return new Set(getAllPageAudios().map((audio) => audio.src).filter(Boolean));
  }

  function muteAndPausePageAudios() {
    for (const audio of getAllPageAudios()) {
      try {
        audio.muted = true;
        audio.pause();
      } catch {
        // ignore
      }
    }
  }

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
    return { textarea, button };
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

    textarea.dispatchEvent(new Event("change", { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
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
    }, DEFAULTS.waitForButtonMs, "Generate button to become enabled", 100);
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
    const clean = String(base64).replace(/^data:.*?;base64,/, "").replace(/\s/g, "");
    const byteCharacters = atob(clean);
    const sliceSize = 8192;
    const byteArrays = [];

    for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
      const slice = byteCharacters.slice(offset, offset + sliceSize);
      const bytes = new Uint8Array(slice.length);

      for (let i = 0; i < slice.length; i += 1) {
        bytes[i] = slice.charCodeAt(i);
      }

      byteArrays.push(bytes);
    }

    return new Blob(byteArrays, { type: mime || guessAudioMimeFromBase64(base64) });
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
        rememberCapturedAudio(blob, { source: "fetch-audio", mime: blob.type || contentType });
        return;
      }

      if (
        contentType.includes("json") ||
        contentType.includes("text") ||
        contentType === ""
      ) {
        const text = await response.clone().text();

        if (!text || !text.includes("audioContent")) return;

        let json;
        try {
          json = JSON.parse(text);
        } catch {
          return;
        }

        const audioContent = findAudioContentInJson(json);
        if (!audioContent) return;

        const mime = guessAudioMimeFromBase64(audioContent);
        const blob = base64ToBlob(audioContent, mime);

        rememberCapturedAudio(blob, {
          source: "fetch-json-audioContent",
          mime,
        });
      }
    } catch {
      // Never break the page.
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
          blob = new Blob([xhr.response], { type: contentType || "audio/mpeg" });
        }

        if (blob) rememberCapturedAudio(blob, { source: "xhr-audio", mime: blob.type || contentType });
        return;
      }

      const responseText =
        typeof xhr.responseText === "string"
          ? xhr.responseText
          : typeof xhr.response === "string"
            ? xhr.response
            : "";

      if (!responseText || !responseText.includes("audioContent")) return;

      let json;
      try {
        json = JSON.parse(responseText);
      } catch {
        return;
      }

      const audioContent = findAudioContentInJson(json);
      if (!audioContent) return;

      const mime = guessAudioMimeFromBase64(audioContent);
      const blob = base64ToBlob(audioContent, mime);

      rememberCapturedAudio(blob, {
        source: "xhr-json-audioContent",
        mime,
      });
    } catch {
      // Never break page XHR.
    }
  }

  function installAudioResponseCapture() {
    if (window.__voxAudioResponseCaptureInstalled) return;
    window.__voxAudioResponseCaptureInstalled = true;

    const originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
      window.fetch = async function patchedFetch(...args) {
        const response = await originalFetch.apply(this, args);
        inspectFetchResponseForAudio(response);
        return response;
      };
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
      this.__voxUrl = url;
      return originalOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function patchedSend(...args) {
      this.addEventListener("load", () => inspectXhrForAudio(this));
      return originalSend.apply(this, args);
    };

    debug("Audio response capture installed.");
  }

  installAudioResponseCapture();

  async function waitForFreshAudio(previousSrcs, captureStartIndex) {
    return await waitFor(() => {
      const captured = state.capturedAudioQueue[captureStartIndex];

      if (captured && captured.url) {
        return {
          src: captured.url,
          __voxCaptured: true,
          mime: captured.mime,
          size: captured.size,
          source: captured.source,
        };
      }

      const audios = getAllPageAudios()
        .filter((audio) => audio.src)
        .reverse();

      const fresh = audios.find((audio) => {
        return !previousSrcs.has(audio.src) && audio.readyState >= 1;
      });

      if (fresh) return fresh;

      return null;
    }, DEFAULTS.waitForAudioMs, "generated audio from network JSON/audio or DOM audio", 150);
  }

  async function cloneAudioBlobUrl(sourceUrl) {
    try {
      const response = await fetch(sourceUrl);
      if (!response.ok) throw new Error(`fetch failed with ${response.status}`);

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);

      state.objectUrls.add(objectUrl);

      return {
        url: objectUrl,
        mime: blob.type || "unknown",
        cloned: true,
      };
    } catch (error) {
      log(`Could not clone audio blob; using page blob URL directly. ${error.message}`, "warn");
      return {
        url: sourceUrl,
        mime: "unknown",
        cloned: false,
      };
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
      }, { once: true });

      audio.addEventListener("error", () => {
        window.clearTimeout(timer);
        finish(0);
      }, { once: true });

      audio.preload = "metadata";
      audio.src = url;
    });
  }

  async function generateClip(index) {
    if (state.stopRequested) throw new Error("Stopped.");

    const chunk = state.chunks[index];
    if (!chunk) throw new Error(`Missing chunk ${index + 1}.`);

await waitUntilTabVisible(`generation for chunk ${index + 1}`);
await waitForPlaygroundReady();

log(`Generating chunk ${index + 1}/${state.chunks.length} (${chunk.length} chars)...`);

    const beforeSrcs = getCurrentAudioSrcs();
    const captureStartIndex = state.capturedAudioQueue.length;

    await fillPlaygroundText(chunk);

const button = await waitForGenerateButtonEnabled();
button.click();

// Homepage auto-plays generated audio. Keep silencing native playback
// while we wait for the network/JSON audio capture.
silenceNativePlaybackFor(5000);

let generatedAudio;

try {
  generatedAudio = await waitForFreshAudio(beforeSrcs, captureStartIndex);
} catch (error) {
  if (document.visibilityState === "hidden") {
    await waitUntilTabVisible(`retry for chunk ${index + 1}`);
  }

  log(`Retrying chunk ${index + 1} after capture timeout...`, "warn");

  const retryBeforeSrcs = getCurrentAudioSrcs();
  const retryCaptureStartIndex = state.capturedAudioQueue.length;

  await fillPlaygroundText(chunk);

  const retryButton = await waitForGenerateButtonEnabled();
  retryButton.click();

  silenceNativePlaybackFor(5000);

  generatedAudio = await waitForFreshAudio(retryBeforeSrcs, retryCaptureStartIndex);
}
// The page may start playback again right after the response is handled.
silenceNativePlaybackFor(5000);

    let clipUrl;
    let sourceUrl;
    let mime;
    let captureSource;

    if (generatedAudio.__voxCaptured) {
      clipUrl = generatedAudio.src;
      sourceUrl = generatedAudio.src;
      mime = generatedAudio.mime || "audio/unknown";
      captureSource = generatedAudio.source || "network-captured";
    } else {
      sourceUrl = generatedAudio.src;
      const cloned = await cloneAudioBlobUrl(sourceUrl);
      clipUrl = cloned.url;
      mime = cloned.mime;
      captureSource = "dom-audio";
    }

    muteAndPausePageAudios();

    const duration = await getAudioDuration(clipUrl);

    const clip = {
      index,
      url: clipUrl,
      sourceUrl,
      mime,
      duration,
      chars: chunk.length,
      captureSource,
    };

    state.clips.set(index, clip);
    updateUiState();

    const durationText = duration ? `${duration.toFixed(1)}s` : "unknown duration";
    log(`Ready chunk ${index + 1}/${state.chunks.length} (${durationText}, ${mime}, ${captureSource}).`);

    if (mime.includes("mpeg") && !canDecodeAudioMpeg()) {
      log("Browser reports no audio/mpeg support. If playback fails, use Chrome/Edge or install Firefox system codecs.", "warn");
    }

    return clip;
  }

  function ensureClip(index) {
    if (index < 0 || index >= state.chunks.length) return Promise.resolve(null);

    if (state.clips.has(index)) {
      return Promise.resolve(state.clips.get(index));
    }

    if (state.generationTasks.has(index)) {
      return state.generationTasks.get(index);
    }

    const task = state.generationChain.then(() => generateClip(index));
    state.generationChain = task.catch(() => undefined);

    const tracked = task.finally(() => {
      state.generationTasks.delete(index);
      updateUiState();
    });

    state.generationTasks.set(index, tracked);
    updateUiState();

    return tracked;
  }

function fillLookAheadBuffer(fromIndex) {
  if (document.visibilityState === "hidden") {
    log("Tab is hidden. Not starting new background generation. Already captured audio can keep playing.", "warn");
    return;
  }

  const lookAhead = clampNumber(Number(byId("lookahead")?.value || DEFAULTS.lookAhead), 1, 3);

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
          Number.isFinite(audio.duration) && audio.duration > 0
            ? audio.duration
            : clip.duration || 0;

        updateUiState();
      }

      function onTimeUpdate() {
        state.currentChunkCurrentTime = audio.currentTime || 0;
        state.currentChunkDuration =
          Number.isFinite(audio.duration) && audio.duration > 0
            ? audio.duration
            : state.currentChunkDuration;

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

          if (!canDecodeAudioMpeg()) {
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

    log("Stopped. Any already-clicked Playground generation may still finish in the page.");
  }

  function resetQueueForNewText() {
    stopPlayback();

    state.clips.clear();
    state.generationTasks.clear();
    state.generationChain = Promise.resolve();
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

  function getPageCharacterLimit() {
    const textarea = getTextArea();

    if (textarea && textarea.maxLength && textarea.maxLength > 0 && textarea.maxLength < 100000) {
      return textarea.maxLength;
    }

    return 2000;
  }

  function getSafeChunkMax() {
    const requestedMax = Number(byId("max")?.value || DEFAULTS.maxChunkSize);
    const pageLimit = getPageCharacterLimit();
    const safeLimit = Math.max(250, pageLimit - 50);
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
    if (!isTTSRouteOrDomPresent()) {
      log("Open the VoxInfinity TTS/Homepage TTS widget first. I cannot see the TTS textarea yet.", "warn");
      openPanel();
      return;
    }

    if (!state.chunks.length) {
      prepareChunksFromUi();
    }

    if (!state.chunks.length) return;

    state.stopRequested = false;
    state.paused = false;
    updateUiState();

    log(`Pre-generating ${state.chunks.length} chunks. Keep this tab visible until this finishes.`);

    try {
      for (let index = 0; index < state.chunks.length; index += 1) {
        if (state.stopRequested) break;

        if (document.visibilityState === "hidden") {
          log("Tab is hidden. Generation may pause/fail. Keep this page visible while pre-generating.", "warn");
        }

        await ensureClip(index);
        log(`Pre-generated ${index + 1}/${state.chunks.length}.`);
      }

      if (!state.stopRequested) {
        log("All chunks pre-generated. Press Start. Background playback should now be more reliable.");
      }
    } catch (error) {
      log(`Pre-generation stopped: ${error.message}`, "error");
    } finally {
      updateUiState();
    }
  }

  async function startFromUi() {
    if (!isTTSRouteOrDomPresent()) {
      log("Open the VoxInfinity Text-to-Speech Playground/Homepage widget first. I cannot see the TTS textarea yet.", "warn");
      openPanel();
      return;
    }

    if (!state.chunks.length) {
      prepareChunksFromUi();
    }

    if (!state.chunks.length) return;

    if (!canDecodeAudioMpeg()) {
      log("Warning: this browser reports no audio/mpeg decoder. WAV may still work; MP3 may fail in Firefox.", "warn");
    }

    state.stopRequested = false;
    state.paused = false;
    updateUiState();

    playbackLoop(Math.min(state.nextToPlay, state.chunks.length - 1));
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
      `audio/mpeg=${canDecodeAudioMpeg() ? "supported" : "not supported"}`,
      `route=${/tts-playground/.test(location.href) ? "portal" : "homepage/other"}`,
    ].join(" · ");

    log(`Selector test: ${message}`);

    if (!textarea || !button) {
      log("If textarea/generate are missing, reload the TTS page after enabling the script.", "warn");
    }
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

    const shadow = host.attachShadow({ mode: "open" });
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
          width: min(520px, calc(100vw - 36px));
          max-height: min(820px, calc(100vh - 112px));
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
          min-height: 160px;
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

        input[type="number"] {
          width: 78px;
          border-radius: 10px;
          border: 1px solid rgba(255,255,255,0.16);
          background: rgba(255,255,255,0.07);
          color: #faf7f5;
          padding: 7px 8px;
          outline: none;
        }

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

        .status-card {
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

        .time-row {
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
            <div class="subtitle">v${VERSION} · JSON/audio capture · custom queue</div>
          </div>
          <button class="btn" id="${APP_ID}-close" type="button">Close</button>
        </div>

        <div class="body">
          <div id="${APP_ID}-codec-notice" class="notice">
            Firefox reports no audio/mpeg decoder. WAV may still work; MP3 may fail.
          </div>

          <textarea id="${APP_ID}-input" placeholder="Paste long text here..."></textarea>

          <div class="row">
            <label>Max chars <input id="${APP_ID}-max" type="number" min="250" max="2000" value="${DEFAULTS.maxChunkSize}"></label>
            <label>Min break <input id="${APP_ID}-min" type="number" min="100" max="1900" value="${DEFAULTS.minBreakSize}"></label>
            <label>Look-ahead <input id="${APP_ID}-lookahead" type="number" min="1" max="3" value="${DEFAULTS.lookAhead}"></label>
          </div>

          <div class="row">
            <button class="btn" id="${APP_ID}-prepare" type="button">Prepare</button>
            <button class="btn" id="${APP_ID}-pregenerate" type="button">Pre-gen all</button>
            <button class="btn primary" id="${APP_ID}-start" type="button">Start</button>
            <button class="btn" id="${APP_ID}-pause" type="button">Pause</button>
            <button class="btn" id="${APP_ID}-resume" type="button">Resume</button>
            <button class="btn danger" id="${APP_ID}-stop" type="button">Stop</button>
            <button class="btn" id="${APP_ID}-test" type="button">Test selectors</button>
          </div>

          <div class="status-card">
            <div id="${APP_ID}-status">Ready. Open the TTS Playground/Homepage widget, choose voice/model, then paste text here.</div>
            <div id="${APP_ID}-stats">0 chunks · 0 ready · current 0/0 · 0 chars</div>
            <div class="progress"><div id="${APP_ID}-progress-fill"></div></div>
            <div class="time-row">
              <span id="${APP_ID}-realtime">Chunk time 0:00 / 0:00</span>
              <span id="${APP_ID}-progress-text">0%</span>
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
            Homepage: usually 950-char chunks. Portal: usually 1900-char chunks. For background use, click Pre-gen all first.
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

    makePanelDraggable(byId("panel"), byId("drag"));

    if (!canDecodeAudioMpeg()) {
      byId("codec-notice").classList.add("show");
    }

    updateUiState();

    if (isTTSRouteOrDomPresent()) {
      openPanel();
      log("Loaded. Click Test selectors, then Prepare/Start.");
    } else {
      setStatus("Launcher loaded. Open the VoxInfinity TTS page/widget to use it.");
      setBadge("Open TTS");
    }

    debug("userscript loaded", location.href);
  }

  function makePanelDraggable(panel, handle) {
    let drag = null;

    handle.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;

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
          setStatus("TTS page/widget detected. Choose voice/model, then paste long text.");
        } else {
          setBadge("Open TTS");
        }
      }

      if (state.running || state.generationTasks.size > 0) {
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
    if (document.visibilityState === "hidden" && (state.running || state.generationTasks.size > 0)) {
      log("Tab is hidden. VoxInfinity UI generation may pause/throttle. For background use, pre-generate all chunks first.", "warn");
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
    state,
    splitLongText,
    selectors: SELECTORS,
    getTextArea,
    getCurrentAudio: () => state.currentAudio,
    getAllPageAudios,
    testSelectors,
    stopPlayback,
    openPanel,
  };
})();
