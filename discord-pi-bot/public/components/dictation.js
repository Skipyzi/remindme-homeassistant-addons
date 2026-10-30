(function (globalScope) {
	"use strict";

	/**
	 * Dictation. On the Pi: the microphone is recorded as 16 kHz, 16-bit mono
	 * PCM (what Home Assistant's speech-to-text takes, so nothing needs
	 * converting) and sent to RemindMe, which has Whisper write it down. In
	 * the browser: its own speech recognition, where there is one. Either
	 * way the words go into the text box to be read before sending.
	 */

	const RATE = 16_000;
	const MAX_SECONDS = 60;

	/* The browser's own recogniser, if it has one (Chrome, Safari). */
	const Recognition = globalScope.SpeechRecognition || globalScope.webkitSpeechRecognition;

	function canRecord() {
		return Boolean(globalScope.isSecureContext && navigator.mediaDevices?.getUserMedia && (globalScope.AudioContext || globalScope.webkitAudioContext));
	}

	/* Float samples at the device's rate to 16 kHz 16-bit, averaging what falls into each new sample. */
	function toPcm(chunks, fromRate) {
		const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
		const all = new Float32Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			all.set(chunk, offset);
			offset += chunk.length;
		}
		const ratio = fromRate / RATE;
		const out = new Int16Array(Math.floor(length / ratio));
		for (let index = 0; index < out.length; index++) {
			const start = Math.floor(index * ratio);
			const end = Math.min(length, Math.floor((index + 1) * ratio)) || start + 1;
			let sum = 0;
			for (let at = start; at < end; at++) sum += all[at];
			const value = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
			out[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
		}
		return out;
	}

	/**
	 * Start recording. Resolves to a recorder whose stop() gives the PCM, or
	 * rejects when the microphone isn't allowed. Stops on its own after a minute.
	 */
	async function record(onLimit) {
		const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
		const Context = globalScope.AudioContext || globalScope.webkitAudioContext;
		const context = new Context();
		await context.resume?.();
		const source = context.createMediaStreamSource(stream);
		// ScriptProcessor is old but runs everywhere, Safari and the Home Assistant app included.
		const processor = context.createScriptProcessor(4096, 1, 1);
		const chunks = [];
		let level = 0;
		processor.onaudioprocess = (event) => {
			const samples = event.inputBuffer.getChannelData(0);
			chunks.push(new Float32Array(samples));
			let peak = 0;
			for (let index = 0; index < samples.length; index += 16) peak = Math.max(peak, Math.abs(samples[index]));
			level = peak;
		};
		source.connect(processor);
		processor.connect(context.destination);
		const close = () => {
			processor.onaudioprocess = null;
			processor.disconnect();
			source.disconnect();
			for (const track of stream.getTracks()) track.stop();
			void context.close().catch(() => {});
		};
		const limit = setTimeout(() => onLimit?.(), MAX_SECONDS * 1000);
		return {
			level: () => level,
			stop() {
				clearTimeout(limit);
				const rate = context.sampleRate;
				close();
				return toPcm(chunks, rate);
			},
			cancel() {
				clearTimeout(limit);
				close();
			},
		};
	}

	/** The browser's recogniser: calls onText with what it has so far, resolves with the final words. */
	function listen(language, onText) {
		const recognition = new Recognition();
		recognition.lang = language || navigator.language || "en-US";
		recognition.interimResults = true;
		recognition.continuous = true;
		let final = "";
		const done = new Promise((resolve, reject) => {
			recognition.onresult = (event) => {
				let interim = "";
				for (let index = event.resultIndex; index < event.results.length; index++) {
					const result = event.results[index];
					if (result.isFinal) final += result[0].transcript;
					else interim += result[0].transcript;
				}
				onText?.((final + interim).trim());
			};
			recognition.onerror = (event) => (event.error === "no-speech" || event.error === "aborted" ? resolve(final.trim()) : reject(new Error(event.error === "not-allowed" ? "The microphone isn't allowed here." : `Speech recognition failed (${event.error}).`)));
			recognition.onend = () => resolve(final.trim());
		});
		recognition.start();
		return { stop: () => recognition.stop(), cancel: () => recognition.abort(), done };
	}

	globalScope.RemindMeDictation = { canRecord, record, listen, browserCan: Boolean(Recognition), RATE };
})(typeof window !== "undefined" ? window : globalThis);
