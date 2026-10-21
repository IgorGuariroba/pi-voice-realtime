/**
 * Regressão: o microfone enviava áudio enquanto o WebSocket ainda estava em
 * CONNECTING, e `send()` lançava exceção que derrubava o pi.
 * Rodar: node --test --experimental-strip-types ~/.pi/agent/extensions/voice/tests/
 *
 * O socket falso reproduz o `ws`: `send()` lança fora do estado OPEN.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../config.ts";
import { RealtimeSession, type VoiceEvent } from "../realtime.ts";
import type { OpenSocketOptions, VoiceSocket } from "../socket.ts";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

function fakeTransport() {
	const sent: string[] = [];
	let readyState = CONNECTING;
	let closeCalls = 0;
	let handlers!: OpenSocketOptions["handlers"];

	const socket: VoiceSocket = {
		transport: { impl: "ws", authMode: "header" },
		isOpen: () => readyState === OPEN,
		send(data: string) {
			if (readyState !== OPEN) {
				throw new Error(`WebSocket is not open: readyState ${readyState} (CONNECTING)`);
			}
			sent.push(data);
		},
		close() {
			closeCalls += 1;
			readyState = CLOSED;
		},
	};

	return {
		sent,
		get closeCalls() {
			return closeCalls;
		},
		openSocket: async (options: OpenSocketOptions) => {
			handlers = options.handlers;
			return socket;
		},
		open() {
			readyState = OPEN;
			handlers.onOpen();
		},
		/** Socket passa a CLOSED sem que o evento de close tenha chegado. */
		drop() {
			readyState = CLOSED;
		},
		message(event: Record<string, unknown>) {
			handlers.onMessage(JSON.stringify(event));
		},
		error(message: string) {
			handlers.onError(new Error(message));
		},
	};
}

/** Eventos de rede são assíncronos: dá uma volta ao event loop antes de disparar `open`. */
const tick = () => new Promise((r) => setImmediate(r));

function makeSession(transport: ReturnType<typeof fakeTransport>, overrides: { onClose?: (r: string) => void } = {}) {
	const events: VoiceEvent[] = [];
	const session = new RealtimeSession({
		apiKey: "test-key",
		settings: DEFAULT_SETTINGS,
		dialect: "ga",
		openSocket: transport.openSocket,
		onEvent: (event) => events.push(event),
		onClose: overrides.onClose,
	});
	return { session, events };
}

const audio = Buffer.alloc(960);

test("connect só resolve quando session.updated chega, não ao criar o socket", async () => {
	const transport = fakeTransport();
	const { session } = makeSession(transport);

	let resolved = false;
	const connecting = session.connect().then(() => (resolved = true));

	await new Promise((r) => setImmediate(r));
	assert.equal(resolved, false, "não pode estar pronto antes de abrir");

	await tick();
	transport.open();
	transport.message({ type: "session.created" });
	await new Promise((r) => setImmediate(r));
	assert.equal(resolved, false, "session.created não é configuração aplicada");

	transport.message({ type: "session.updated" });
	await connecting;
	assert.equal(resolved, true);
	assert.equal(transport.sent.length, 1, "exatamente um session.update");
});

test("áudio antes de pronto é descartado sem lançar nem enviar", async () => {
	const transport = fakeTransport();
	const { session } = makeSession(transport);
	void session.connect().catch(() => {});

	assert.doesNotThrow(() => session.appendAudio(audio));
	assert.equal(transport.sent.length, 0);
});

test("áudio após pronto é enviado", async () => {
	const transport = fakeTransport();
	const { session } = makeSession(transport);
	const connecting = session.connect();
	await tick();
	transport.open();
	transport.message({ type: "session.updated" });
	await connecting;

	session.appendAudio(audio);
	assert.equal(transport.sent.length, 2);
	assert.match(transport.sent[1], /input_audio_buffer.append/);
});

test("erro antes de pronto rejeita connect e bloqueia envios", async () => {
	const transport = fakeTransport();
	const { session } = makeSession(transport);
	const connecting = session.connect();

	transport.error("handshake recusado");
	await assert.rejects(connecting, /handshake recusado/);
	assert.doesNotThrow(() => session.appendAudio(audio));
	assert.equal(transport.sent.length, 0);
});

test("erro de configuração do servidor antes de pronto rejeita connect", async () => {
	const transport = fakeTransport();
	const { session } = makeSession(transport);
	const connecting = session.connect();

	await tick();
	transport.open();
	transport.message({ type: "error", error: { message: "unknown parameter: audio" } });
	await assert.rejects(connecting, /unknown parameter/);
});

test("close durante conexão rejeita connect sem lançar", async () => {
	const transport = fakeTransport();
	const { session } = makeSession(transport);
	const connecting = session.connect();
	await new Promise((r) => setImmediate(r));

	assert.doesNotThrow(() => session.close());
	await assert.rejects(connecting);
	assert.doesNotThrow(() => session.appendAudio(audio));
});

test("falha de envio depois de pronto encerra a voz sem lançar", async () => {
	const transport = fakeTransport();
	let closeReason: string | undefined;
	let closeCount = 0;
	const { session } = makeSession(transport, {
		onClose: (reason) => {
			closeCount += 1;
			closeReason = reason;
		},
	});
	const connecting = session.connect();
	await tick();
	transport.open();
	transport.message({ type: "session.updated" });
	await connecting;

	// Simula o socket caindo para CLOSED sem o evento de close ter chegado ainda.
	transport.drop();
	assert.doesNotThrow(() => session.appendAudio(audio));
	assert.doesNotThrow(() => session.appendAudio(audio));
	assert.equal(closeCount, 1, "encerra uma única vez");
	assert.ok(closeReason);
});

test("o dialeto da sessão chega ao handshake", async () => {
	const seen: Array<string | undefined> = [];
	const session = new RealtimeSession({
		apiKey: "test-key",
		settings: DEFAULT_SETTINGS,
		dialect: "ga",
		openSocket: async (options: OpenSocketOptions) => {
			seen.push(options.dialect);
			throw new Error("parado de propósito");
		},
		onEvent: () => {},
	});
	await assert.rejects(session.connect(), /parado de propósito/);
	assert.deepEqual(seen, ["ga"]);
});

test("barge-in sem resposta ativa não envia response.cancel", async () => {
	const transport = fakeTransport();
	const { session } = makeSession(transport);
	const connecting = session.connect();
	await tick();
	transport.open();
	transport.message({ type: "session.updated" });
	await connecting;

	const before = transport.sent.length;
	session.cancelResponse();
	assert.equal(transport.sent.length, before, "nada a cancelar");
});

test("barge-in com resposta ativa envia response.cancel", async () => {
	const transport = fakeTransport();
	const { session } = makeSession(transport);
	const connecting = session.connect();
	await tick();
	transport.open();
	transport.message({ type: "session.updated" });
	await connecting;

	transport.message({ type: "response.created" });
	const before = transport.sent.length;
	session.cancelResponse();
	assert.equal(transport.sent.length, before + 1);
	assert.match(transport.sent[before], /response\.cancel/);
});

test("erro 'no active response' não vira erro para o usuário", async () => {
	const transport = fakeTransport();
	const { session, events } = makeSession(transport);
	const connecting = session.connect();
	await tick();
	transport.open();
	transport.message({ type: "session.updated" });
	await connecting;

	events.length = 0;
	transport.message({
		type: "error",
		error: { message: "Cancellation failed: no active response found" },
	});
	assert.equal(events.filter((e) => e.kind === "error").length, 0);
});
