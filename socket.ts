/**
 * Transporte WebSocket da sessão de voz.
 *
 * Fiel ao Codex: usa a biblioteca `ws` com header `Authorization`. O header
 * `OpenAI-Beta: realtime=v1` só é enviado no dialeto beta (endpoint legado).
 *
 * O `ws` não é resolvível por `import("ws")` a partir do diretório da extensão,
 * mas é por `createRequire(process.argv[1])` — o entrypoint do pi, que é o dono
 * do `node_modules` onde ele vive. Se essa resolução falhar (execução fora do
 * pi, instalação alterada), caímos no `WebSocket` global do Node, que não aceita
 * headers: nesse caso a API key é trocada por um client secret efêmero enviado
 * em subprotocolo. O modo usado aparece em `/voice status`.
 */

import { createRequire } from "node:module";
import { API_BASE } from "./config.ts";

export type AuthMode = "header" | "ephemeral-subprotocol";
export type SocketImpl = "ws" | "global-websocket";

export interface TransportInfo {
	impl: SocketImpl;
	authMode: AuthMode;
}

export interface SocketHandlers {
	onOpen(): void;
	onMessage(data: string): void;
	onClose(code: number, reason: string): void;
	onError(error: Error): void;
}

export interface VoiceSocket {
	readonly transport: TransportInfo;
	/** true só no estado OPEN. `send()` fora dele lança (`ws` e WebSocket global). */
	isOpen(): boolean;
	send(data: string): void;
	close(): void;
}

/** WebSocket.OPEN é 1 nas duas implementações. */
const WS_OPEN = 1;

interface WsLike {
	readyState: number;
	send(data: string): void;
	close(): void;
	on(event: string, listener: (...args: any[]) => void): void;
}

type WsCtor = new (
	url: string,
	options: { headers: Record<string, string> },
) => WsLike;

/** Carrega `ws` a partir do node_modules do pi. */
export function loadWs(): WsCtor | undefined {
	const candidates = [process.argv[1], process.execPath].filter(Boolean) as string[];
	for (const candidate of candidates) {
		try {
			const resolved = createRequire(candidate)("ws") as WsCtor | { default: WsCtor };
			const ctor = (resolved as { default?: WsCtor }).default ?? (resolved as WsCtor);
			if (typeof ctor === "function") return ctor;
		} catch {
			// tenta o próximo
		}
	}
	return undefined;
}

async function mintEphemeralKey(apiKey: string, model: string): Promise<string> {
	const attempts = [
		{ url: `${API_BASE}/realtime/client_secrets`, body: { session: { type: "realtime", model } } },
		{ url: `${API_BASE}/realtime/sessions`, body: { model } },
	];
	let lastError = "";
	for (const attempt of attempts) {
		const response = await fetch(attempt.url, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify(attempt.body),
		});
		if (!response.ok) {
			lastError = `${attempt.url} → HTTP ${response.status} ${(await response.text()).slice(0, 200)}`;
			continue;
		}
		const payload = (await response.json()) as Record<string, any>;
		const value =
			payload.value ??
			payload.client_secret?.value ??
			payload.client_secret ??
			payload.session?.client_secret?.value;
		if (typeof value === "string" && value) return value;
		lastError = `${attempt.url} → resposta sem client secret`;
	}
	throw new Error(`não foi possível obter client secret: ${lastError}`);
}

export type SocketDialect = "ga" | "beta";

/**
 * Headers do handshake. GA (`/v1/realtime`) só aceita Authorization: o header
 * `OpenAI-Beta` faz a API recusar com "The Realtime Beta API is no longer supported".
 */
export function buildHandshakeHeaders(apiKey: string, dialect: SocketDialect): Record<string, string> {
	const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
	if (dialect === "beta") headers["OpenAI-Beta"] = "realtime=v1";
	return headers;
}

/** Subprotocolos do caminho sem header (client secret efêmero). */
export function buildSubprotocols(secret: string, dialect: SocketDialect): string[] {
	const protocols = ["realtime", `openai-insecure-api-key.${secret}`];
	if (dialect === "beta") protocols.push("openai-beta.realtime-v1");
	return protocols;
}

export interface OpenSocketOptions {
	apiKey: string;
	model: string;
	dialect?: SocketDialect;
	handlers: SocketHandlers;
}

export async function openRealtimeSocket(options: OpenSocketOptions): Promise<VoiceSocket> {
	const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(options.model)}`;
	const Ws = loadWs();
	const dialect = options.dialect ?? "ga";

	if (Ws) {
		const socket = new Ws(url, {
			headers: buildHandshakeHeaders(options.apiKey, dialect),
		});
		socket.on("open", () => options.handlers.onOpen());
		socket.on("message", (data: unknown) => options.handlers.onMessage(String(data)));
		socket.on("close", (code: number, reason: Buffer | string) =>
			options.handlers.onClose(code, String(reason ?? "")),
		);
		socket.on("error", (error: Error) => options.handlers.onError(error));
		return {
			transport: { impl: "ws", authMode: "header" },
			isOpen: () => socket.readyState === WS_OPEN,
			send: (data) => socket.send(data),
			close: () => socket.close(),
		};
	}

	const secret = await mintEphemeralKey(options.apiKey, options.model);
	const socket = new WebSocket(url, buildSubprotocols(secret, dialect));
	socket.addEventListener("open", () => options.handlers.onOpen());
	socket.addEventListener("message", (event: MessageEvent) => options.handlers.onMessage(String(event.data)));
	socket.addEventListener("close", (event: CloseEvent) => options.handlers.onClose(event.code, event.reason));
	socket.addEventListener("error", () => options.handlers.onError(new Error("erro no WebSocket realtime")));
	return {
		transport: { impl: "global-websocket", authMode: "ephemeral-subprotocol" },
		isOpen: () => socket.readyState === WS_OPEN,
		send: (data) => socket.send(data),
		close: () => socket.close(),
	};
}
