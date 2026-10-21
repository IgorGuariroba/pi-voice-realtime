/**
 * T1–T3 do plano (docs/plano-implementacao.md), com sessão do pi e síntese/player simulados.
 * Não prova escuta nem interrupção audível: isso é da captura de saída (fora deste arquivo).
 * Rodar: node --test --experimental-strip-types ~/.pi/agent/extensions/voice/tests/bridge.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createVoiceBridge } from "../bridge.ts";

interface SentMessage {
	text: string;
	deliverAs: "prompt" | "steer";
	origin: "voice" | "text";
}

function fakePi() {
	const sent: SentMessage[] = [];
	let busy = false;
	let aborted = false;
	return {
		sent,
		setBusy(value: boolean) {
			busy = value;
		},
		get aborted() {
			return aborted;
		},
		sendUserMessage(text: string, options: { deliverAs?: "prompt" | "steer"; origin: "voice" | "text" }) {
			sent.push({ text, deliverAs: options.deliverAs ?? (busy ? "steer" : "prompt"), origin: options.origin });
		},
		abort() {
			aborted = true;
		},
		isBusy: () => busy,
	};
}

function fakeSynth() {
	const playbacks: Array<{ id: string; text: string; stopped: boolean; end(): void; durationMs: number }> = [];
	return {
		playbacks,
		speak(text: string, durationMs = 2000) {
			const id = `pb-${playbacks.length + 1}`;
			let onEnd: (() => void) | undefined;
			const playback = {
				id,
				text,
				durationMs,
				stopped: false,
				stop() {
					this.stopped = true;
				},
				onEnd(cb: () => void) {
					onEnd = cb;
				},
				end() {
					onEnd?.();
				},
			};
			playbacks.push(playback);
			return playback;
		},
	};
}

const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

test("T1: histórico por voz equivale ao digitado (conteúdo, ordem e referência)", () => {
	const typed = fakePi();
	const voice = fakePi();
	const synthVoice = fakeSynth();
	const bridgeVoice = createVoiceBridge({ pi: voice, synth: synthVoice, now: () => 0 });

	// Digitação: mesma conversa, sem voz.
	typed.sendUserMessage("explica o cache", { origin: "text" });
	typed.sendUserMessage("corrige isso", { origin: "text" });

	// Voz: transcrição consolidada entra pela ponte.
	bridgeVoice.onTranscript("Explica o cache.");
	bridgeVoice.onTranscript("Corrige isso.");

	assert.deepEqual(
		voice.sent.map((m) => normalize(m.text)),
		typed.sent.map((m) => normalize(m.text)),
		"conteúdo e ordem devem coincidir após normalização",
	);
	assert.ok(voice.sent.every((m) => m.origin === "voice"), "mensagens de voz devem estar marcadas como voz");
	assert.equal(voice.sent[1].text.includes("isso"), true, "a instrução preserva a referência ao turno anterior");
});

test("T2: fala durante execução interrompe áudio, envia steer e não cancela o pi", () => {
	const pi = fakePi();
	const synth = fakeSynth();
	const bridge = createVoiceBridge({ pi, synth, now: () => 0 });

	pi.setBusy(true);
	bridge.onAssistantText("Vou ler os arquivos do módulo.", { final: true });
	const [playback] = synth.playbacks;
	assert.equal(playback.stopped, false, "precondição: áudio em reprodução");

	bridge.onSpeechStart();
	bridge.onTranscript("Foca só no arquivo de testes.");

	assert.equal(playback.stopped, true, "começar a falar deve parar o áudio");
	assert.equal(pi.aborted, false, "a execução não deve ser cancelada por fala");
	assert.deepEqual(
		pi.sent.map((m) => m.deliverAs),
		["steer"],
		"a transcrição consolidada entra como steer",
	);
	assert.equal(bridge.playbacks()[0].state, "interrompida");
});

test("T3: estados de reprodução distinguem conclusão estimada de interrupção", () => {
	const pi = fakePi();
	const synth = fakeSynth();
	let clock = 0;
	const bridge = createVoiceBridge({ pi, synth, now: () => clock });

	// Caso 1: termina sem interrupção.
	bridge.onAssistantText("Pronto.", { final: true });
	clock = 2000;
	synth.playbacks[0].end();
	assert.equal(bridge.playbacks()[0].state, "concluida_estimada");

	// Caso 2: interrompida no meio.
	bridge.onAssistantText("Explicação longa que será cortada no meio.", { final: true });
	clock = 2000 + 500;
	bridge.onSpeechStart();
	const second = bridge.playbacks()[1];
	assert.equal(second.state, "interrompida");
	assert.ok(second.fraction !== undefined && second.fraction > 0 && second.fraction < 1, "fração estimada entre 0 e 1");
});
