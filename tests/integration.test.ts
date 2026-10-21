/**
 * Integração de index.ts com contrato mockado do pi, socket realtime, microfone e player.
 * Cobre o ciclo do handoff da V2 (ADR 0002): background_agent, steer, remain_silent,
 * resultado [BACKEND] + function_call_output + response.create, histórico sem turno
 * e contexto de início.
 * Rodar: node --test --experimental-strip-types ~/.pi/agent/extensions/voice/tests/integration.test.ts
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { afterEach, beforeEach, test } from "node:test";

register("./stub-hooks.mjs", import.meta.url);
const { default: voiceExtension } = await import("../index.ts");
const { HANDOFF_COMPLETE_ACK, STEER_ACK } = await import("../delegation.ts");

type Handler = (event: any, ctx: any) => unknown;

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => unknown }>();
	const sent: Array<{ text: string; deliverAs?: string }> = [];
	const custom: Array<{ message: any; options?: any }> = [];
	const entries: Array<{ type: string; data: any }> = [];
	return {
		sent,
		custom,
		entries,
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
		appendEntry(type: string, data: any) {
			entries.push({ type, data });
		},
		sendUserMessage(text: string, options?: { deliverAs?: string }) {
			sent.push({ text, deliverAs: options?.deliverAs });
		},
		sendMessage(message: any, options?: any) {
			custom.push({ message, options });
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
const flush = () => new Promise((resolve) => setImmediate(resolve));

let savedKey: string | undefined;
beforeEach(() => {
	savedKey = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = "sk-test-redacted";
});
afterEach(() => {
	if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
	else process.env.OPENAI_API_KEY = savedKey;
});

function setup(branch: any[] = []) {
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
		setImmediate(() => options.handlers.onOpen());
		return socket;
	};
	const server = (event: Record<string, unknown>) => handlers.onMessage(JSON.stringify(event));
	const ctx = {
		mode: "tui",
		cwd: "/work/projeto",
		idle: true,
		isIdle() {
			return this.idle;
		},
		sessionManager: { getBranch: () => branch },
		ui: {
			theme,
			notify(message: string, level?: string) {
				if (globalThis.__VOICE_DEBUG__) console.log("NOTIFY", level, message);
			},
			setStatus() {},
			setWidget() {},
			custom() {},
		},
	};
	voiceExtension(pi as any, {
		openSocket,
		openEcho: async () => ({ capture: {}, playback: {}, close: async () => {} }),
		createRecorder: () => ({ start() {}, stop() {}, setMuted() {} }) as any,
		createPlayer: () => ({ write() {}, stop() {}, dispose() {} }) as any,
	} as any);
	return { pi, socket, server, ctx };
}

async function startVoice(env: ReturnType<typeof setup>) {
	await env.pi.command("voice").handler("start", env.ctx);
	await flush();
}

const transcript = (text: string) => ({
	type: "conversation.item.input_audio_transcription.completed",
	transcript: text,
});

const backgroundAgent = (callId: string, prompt: string) => ({
	type: "response.function_call_arguments.done",
	name: "background_agent",
	call_id: callId,
	arguments: JSON.stringify({ prompt }),
});

const messagesOf = (socket: { sent: any[] }) =>
	socket.sent.filter((e) => e.type !== "session.update" && e.item?.role !== "developer");

test("start envia instruções do Codex e o developer item de início", async () => {
	const env = setup([
		{ type: "message", message: { role: "user", content: "corrige o teste do parser" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "feito" }] } },
	]);
	await startVoice(env);
	const update = env.socket.sent.find((e) => e.type === "session.update");
	assert.match(update.session.instructions, /## Identity, tone, and role/);
	assert.match(update.session.instructions, /Diretório de trabalho: \/work\/projeto/);
	assert.match(update.session.instructions, /\[USER\] corrige o teste do parser/);
	const dev = env.socket.sent.find((e) => e.item?.role === "developer");
	assert.match(dev.item.content[0].text, /^Realtime conversation started\./);
});

test("background_agent ocioso inicia o turno com envelope de delegação, sem output ainda", async () => {
	const env = setup();
	await startVoice(env);
	env.server(backgroundAgent("call_1", "lista os arquivos do pacote"));
	assert.equal(env.pi.sent.length, 1);
	assert.match(env.pi.sent[0].text, /<realtime_delegation>\n {2}<input>lista os arquivos do pacote<\/input>/);
	assert.equal(env.pi.sent[0].deliverAs, undefined);
	assert.equal(messagesOf(env.socket).length, 0);
});

test("fim do run devolve [BACKEND], function_call_output e response.create nessa ordem", async () => {
	const env = setup();
	await startVoice(env);
	env.server(backgroundAgent("call_1", "faz X"));
	await env.pi.emit("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "X feito." }] }] }, env.ctx);
	const [backend, output, create] = messagesOf(env.socket);
	assert.equal(backend.item.content[0].text, "[BACKEND] X feito.");
	assert.deepEqual(output, {
		type: "conversation.item.create",
		item: { type: "function_call_output", call_id: "call_1", output: HANDOFF_COMPLETE_ACK },
	});
	assert.deepEqual(create, { type: "response.create" });
});

test("background_agent com agente ocupado vira steer e recebe o ack da própria chamada", async () => {
	const env = setup();
	await startVoice(env);
	env.server(backgroundAgent("call_1", "faz X"));
	env.ctx.idle = false;
	env.server(backgroundAgent("call_2", "e também Y"));
	assert.equal(env.pi.sent[1].deliverAs, "steer");
	const output = messagesOf(env.socket).find((e) => e.type === "conversation.item.create" && e.item.call_id === "call_2");
	assert.equal(output.item.output, STEER_ACK);
	// Um único fim de run completa a chamada original, não o steer.
	await env.pi.emit("agent_end", { messages: [] }, env.ctx);
	const completions = messagesOf(env.socket).filter((e) => e.item?.output === HANDOFF_COMPLETE_ACK);
	assert.deepEqual(completions.map((e) => e.item.call_id), ["call_1"]);
});

test("remain_silent devolve saída vazia e não pede resposta", async () => {
	const env = setup();
	await startVoice(env);
	env.server({ type: "response.function_call_arguments.done", name: "remain_silent", call_id: "call_s", arguments: "{}" });
	const [output] = messagesOf(env.socket);
	assert.deepEqual(output.item, { type: "function_call_output", call_id: "call_s", output: "" });
	assert.equal(messagesOf(env.socket).some((e) => e.type === "response.create"), false);
});

test("fala do usuário vai ao histórico do pi sem disparar turno", async () => {
	const env = setup();
	await startVoice(env);
	env.server(transcript("explica o módulo de áudio"));
	assert.equal(env.pi.sent.length, 0, "nenhum turno iniciado pela fala");
	assert.equal(env.pi.custom.length, 1);
	assert.equal(env.pi.custom[0].message.content, "[USER] explica o módulo de áudio");
	assert.equal(env.pi.custom[0].message.display, false);
	assert.equal(env.pi.custom[0].options, undefined, "sem triggerTurn");
	assert.deepEqual(env.pi.entries.map((e) => e.data.text), ["explica o módulo de áudio"]);
});
