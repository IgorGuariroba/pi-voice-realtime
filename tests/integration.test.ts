/**
 * Integração de index.ts com um contrato mockado do pi, socket realtime, microfone e player.
 * Cobre T2 (steer e interrupção pelo caminho completo), término estimado por timer real,
 * timer antigo que não reescreve interrupção, T4 (sem resposta autônoma) e T5 (decisão pendente).
 * Não prova escuta nem interrupção audível: isso é medido por captura de saída.
 * Rodar: node --test --experimental-strip-types ~/.pi/agent/extensions/voice/tests/integration.test.ts
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { afterEach, beforeEach, mock, test } from "node:test";

register("./stub-hooks.mjs", import.meta.url);
const { default: voiceExtension } = await import("../index.ts");

type Handler = (event: any, ctx: any) => unknown;

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => unknown }>();
	const sent: Array<{ text: string; deliverAs?: string }> = [];
	let aborts = 0;
	return {
		sent,
		get aborts() {
			return aborts;
		},
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			return () => {};
		},
		registerCommand(name: string, def: { handler: (args: string, ctx: any) => unknown }) {
			commands.set(name, def);
		},
		registerEntryRenderer() {},
		registerMarkdownTransformer() {},
		registerShortcut() {},
		appendEntry() {},
		sendUserMessage(text: string, options?: { deliverAs?: string }) {
			sent.push({ text, deliverAs: options?.deliverAs });
		},
		abort() {
			aborts += 1;
		},
		async emit(name: string, event: any, ctx: any) {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
		command(name: string) {
			return commands.get(name)!;
		},
	};
}

const theme = { fg: (_color: string, text: string) => text };
const ctx = {
	mode: "tui",
	ui: { theme, notify() {}, setStatus() {}, setWidget() {}, custom() {} },
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup() {
	const pi = fakePi();
	let handlers: any;
	const socket = {
		sent: [] as any[],
		transport: { impl: "ws", authMode: "header" },
		isOpen: () => true,
		send(data: string) {
			const parsed = JSON.parse(data);
			socket.sent.push(parsed);
			if (parsed.type === "session.update") queueMicrotask(() => server({ type: "session.updated" }));
		},
		close() {},
	};
	const openSocket = async (options: any) => {
		handlers = options.handlers;
		queueMicrotask(() => options.handlers.onOpen());
		return socket;
	};
	let playerStops = 0;
	const written: Buffer[] = [];
	const player = {
		write(pcm: Buffer) {
			written.push(pcm);
		},
		stop() {
			playerStops += 1;
		},
		dispose() {},
	};
	const observed: Array<{ id: string; text: string; state: string; fraction?: number }> = [];
	const deps = {
		apiKey: "sk-test-redacted",
		openSocket,
		openEcho: async () => ({ capture: {}, playback: {}, close: async () => {} }),
		createRecorder: () => ({ start() {}, stop() {}, setMuted() {} }),
		createPlayer: () => player,
		observe: (record: any) => observed.push({ ...record }),
	};
	const server = (event: Record<string, unknown>) => handlers.onMessage(JSON.stringify(event));
	voiceExtension(pi as any, deps as any);
	return {
		pi,
		socket,
		server,
		observed,
		written,
		get playerStops() {
			return playerStops;
		},
	};
}

async function startVoice(env: ReturnType<typeof setup>) {
	await env.pi.command("voice").handler("start", ctx);
	await flush();
}

const transcript = (text: string) => ({
	type: "conversation.item.input_audio_transcription.completed",
	transcript: text,
});

/** PCM16 mono 24 kHz de `ms` milissegundos, em base64 como a API envia. */
const pcm = (ms: number) => Buffer.alloc(Math.floor((24000 * 2 * ms) / 1000)).toString("base64");

beforeEach(() => {
	mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
});

afterEach(() => {
	mock.timers.reset();
});

test("T4: transcrição vai ao pi e o realtime não responde por conta própria", async () => {
	const env = setup();
	await startVoice(env);

	const update = env.socket.sent.find((m) => m.type === "session.update");
	assert.ok(update, "session.update enviado");
	assert.equal(update.session.audio.input.turn_detection.create_response, false, "sem resposta automática no VAD");
	assert.equal(update.session.tools, undefined, "sem ferramenta de delegação: a voz não decide nada");

	env.server(transcript("Oi, tudo bem?"));
	await flush();

	assert.equal(env.pi.sent.length, 1, "toda fala vai ao pi");
	assert.ok(env.pi.sent[0].text.includes("Oi, tudo bem?"));
	assert.equal(
		env.socket.sent.filter((m) => m.type === "response.create").length,
		0,
		"o realtime não cria resposta própria",
	);
});

test("T5: fala com decisão pendente não resolve aprovação", async () => {
	const env = setup();
	await startVoice(env);

	await env.pi.emit("ui_prompt_start", { kind: "permission", title: "Apagar pasta?" }, ctx);
	env.server(transcript("Sim"));
	await flush();

	assert.equal(env.pi.sent.length, 0, '"sim" falado não é enviado como resposta à decisão');
	assert.equal(env.pi.aborts, 0);
	const announce = env.socket.sent.find((m) => m.type === "response.create");
	assert.ok(announce, "a voz avisa que há decisão pendente");
	assert.ok(/decisão/i.test(JSON.stringify(announce)));

	await env.pi.emit("ui_prompt_end", { kind: "permission", title: "Apagar pasta?" }, ctx);
	env.server(transcript("Explica o erro"));
	await flush();
	assert.equal(env.pi.sent.length, 1, "após a decisão, fala volta a ir ao pi");
});

test("T2 integrado: fala durante execução para o áudio, envia steer e não cancela o pi", async () => {
	const env = setup();
	await startVoice(env);

	env.server(transcript("Explica o cache."));
	await flush();
	await env.pi.emit("agent_start", {}, ctx);
	await env.pi.emit(
		"agent_end",
		{ messages: [{ role: "assistant", content: [{ type: "text", text: "Cache é uma memória intermediária." }] }] },
		ctx,
	);
	await flush();
	env.server({ type: "response.output_audio.delta", delta: pcm(3000) });
	await flush();
	assert.equal(env.observed.at(-1)?.state, "reproduzindo", "precondição: resposta sendo falada");

	await env.pi.emit("agent_start", {}, ctx);
	env.server({ type: "input_audio_buffer.speech_started" });
	env.server(transcript("Foca só no arquivo de testes."));
	await flush();

	assert.ok(env.playerStops >= 1, "começar a falar corta o áudio local");
	assert.equal(env.pi.aborts, 0, "fala não cancela a execução");
	const last = env.pi.sent.at(-1)!;
	assert.equal(last.deliverAs, "steer", "fala durante execução entra como steer");
	assert.ok(last.text.includes("Foca só no arquivo de testes."));
	assert.equal(env.observed.at(-1)?.state, "interrompida");
});

test("término estimado pelo timer real: áudio tocado até o fim vira concluida_estimada", async () => {
	const env = setup();
	await startVoice(env);

	await env.pi.emit("agent_start", {}, ctx);
	await env.pi.emit("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "Pronto." }] }] }, ctx);
	await flush();
	env.server({ type: "response.output_audio.delta", delta: pcm(1000) });
	env.server({ type: "response.done" });
	await flush();
	assert.equal(env.observed.at(-1)?.state, "reproduzindo");

	mock.timers.tick(2000);
	await flush();
	assert.equal(env.observed.at(-1)?.state, "concluida_estimada");
});

test("timer antigo não marca reprodução interrompida como concluída", async () => {
	const env = setup();
	await startVoice(env);

	// Primeira fala: ~2 s de áudio, término agendado pelo timer.
	await env.pi.emit("agent_start", {}, ctx);
	await env.pi.emit("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "Primeira." }] }] }, ctx);
	await flush();
	env.server({ type: "response.output_audio.delta", delta: pcm(2000) });
	env.server({ type: "response.done" });
	await flush();
	const firstId = env.observed.at(-1)!.id;

	// Interrompe antes do fim: o timer da primeira continua agendado.
	mock.timers.tick(500);
	env.server({ type: "input_audio_buffer.speech_started" });
	await flush();

	// Segunda fala começa; o timer antigo dispara depois.
	await env.pi.emit("agent_start", {}, ctx);
	await env.pi.emit("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "Segunda." }] }] }, ctx);
	await flush();
	mock.timers.tick(5000);
	await flush();

	const firstFinal = env.observed.filter((r) => r.id === firstId).at(-1)!;
	assert.equal(firstFinal.state, "interrompida", "timer antigo não reescreve a interrupção");
	assert.ok(firstFinal.fraction !== undefined && firstFinal.fraction > 0 && firstFinal.fraction < 1);
});
