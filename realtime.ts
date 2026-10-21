/**
 * Sessão realtime (`/v1/realtime`) — equivalente de
 * `codex-rs/core/src/realtime_conversation.rs` + `codex-api/realtime_websocket`.
 *
 * Divergências conscientes do Codex:
 * 1. Codex usa `intent=quicksilver` com auth ChatGPT; aqui é a API pública com
 *    API key (único caminho existente fora do produto Codex).
 * 2. Codex negocia WebRTC (SDP/ICE); aqui é WebSocket com PCM16. Mesmo modelo,
 *    mesmas vozes, mesmo VAD de servidor.
 * 3. O handoff é a tool `delegate_to_pi` (a API pública não expõe o handoff
 *    interno que o Codex usa entre a sessão de voz e o agente).
 *
 * Dialeto do payload é explícito (`PI_VOICE_DIALECT=ga|beta`), sem fallback
 * automático: reenviar em outro formato esconderia um payload errado.
 */

import { API_BASE, type VoiceSettings } from "./config.ts";
import { backendHeader } from "./delegation.ts";
import { openRealtimeSocket, type OpenSocketOptions, type TransportInfo, type VoiceSocket } from "./socket.ts";

export type VoiceEvent =
	| { kind: "ready" }
	| { kind: "audio"; pcm: Buffer }
	| { kind: "user_transcript"; text: string }
	| { kind: "assistant_transcript"; text: string; final: boolean }
	| { kind: "speech_started" }
	| { kind: "speech_stopped" }
	| { kind: "delegate"; callId: string; input: string }
	| { kind: "response_done" }
	| { kind: "error"; message: string; dialectHint: boolean }
	| { kind: "other"; type: string };

/** Nome da função exposta ao modelo de voz, no lugar do handoff nativo do Codex. */
export const DELEGATE_TOOL = "delegate_to_pi";

export type VoiceDialect = "ga" | "beta";

export function resolveDialect(env: NodeJS.ProcessEnv = process.env): VoiceDialect {
	const raw = (env.PI_VOICE_DIALECT ?? "").trim().toLowerCase();
	return raw === "beta" ? "beta" : "ga";
}

/**
 * Normaliza um evento cru da API. Aceita os nomes GA (`response.output_audio.delta`)
 * e os beta (`response.audio.delta`) porque o *parser* pode ser tolerante mesmo
 * que o *payload* seja enviado em um dialeto só.
 */
export function parseRealtimeEvent(raw: unknown): VoiceEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const event = raw as Record<string, any>;
	const type = typeof event.type === "string" ? event.type : "";
	if (!type) return null;

	switch (type) {
		case "session.created":
		case "session.updated":
		case "transcription_session.created":
		case "transcription_session.updated":
			// Informativo. Quem decide "pronto" é RealtimeSession, pelo tipo `*.updated`.
			return { kind: "ready" };

		case "response.output_audio.delta":
		case "response.audio.delta":
			return { kind: "audio", pcm: Buffer.from(String(event.delta ?? ""), "base64") };

		case "conversation.item.input_audio_transcription.completed":
			return { kind: "user_transcript", text: String(event.transcript ?? "").trim() };

		case "response.output_audio_transcript.delta":
		case "response.audio_transcript.delta":
			return { kind: "assistant_transcript", text: String(event.delta ?? ""), final: false };

		case "response.output_audio_transcript.done":
		case "response.audio_transcript.done":
			return { kind: "assistant_transcript", text: String(event.transcript ?? ""), final: true };

		case "input_audio_buffer.speech_started":
			return { kind: "speech_started" };

		case "input_audio_buffer.speech_stopped":
			return { kind: "speech_stopped" };

		case "response.done":
			return { kind: "response_done" };

		case "error": {
			const message = String(event.error?.message ?? event.message ?? "erro realtime");
			// Pistas de payload errado são reportadas, não corrigidas em silêncio.
			const dialectHint =
				/unknown (parameter|field)|not supported|invalid (value|type)|audio.*(format|config)/i.test(message);
			return { kind: "error", message, dialectHint };
		}

		case "response.function_call_arguments.done": {
			const name = String(event.name ?? "");
			if (name !== DELEGATE_TOOL) return { kind: "other", type };
			let input = "";
			try {
				const args = JSON.parse(String(event.arguments ?? "{}"));
				input = String(args.input ?? args.request ?? "").trim();
			} catch {
				return { kind: "error", message: "argumentos inválidos na delegação de voz", dialectHint: false };
			}
			if (!input) {
				return { kind: "error", message: "delegação de voz sem pedido", dialectHint: false };
			}
			return { kind: "delegate", callId: String(event.call_id ?? ""), input };
		}

		default:
			return { kind: "other", type };
	}
}

/** Prompt de voz: espírito do `BACKEND_PROMPT` do Codex, em pt-BR e curto. */
export function voiceInstructions(userName?: string): string {
	const name = userName ? ` O usuário se chama ${userName}.` : "";
	return `## Identidade, tom e papel
Você é a voz do Pi, um agente de programação que roda no terminal do usuário.${name}
Você fala português do Brasil, com frases curtas, tom direto e sem formalidade.
Você nunca lê código, caminhos de arquivo longos ou saídas de terminal em voz alta.
Você não executa trabalho de código você mesmo: você delega.

## Como você trabalha
- Pedido de código, análise, arquivo, comando ou investigação: chame \`${DELEGATE_TOOL}\`
  com o pedido reescrito de forma completa e autocontida (o agente de código não
  ouve a conversa), e diga em uma frase curta que já está cuidando disso.
- Pergunta simples de conversa ou sobre o que está acontecendo: responda direto.
- Enquanto o agente trabalha você recebe mensagens prefixadas com [BACKEND].
  Nunca invente progresso. Se o usuário falar nesse meio tempo, você pode
  complementar ou corrigir o pedido chamando \`${DELEGATE_TOOL}\` de novo com o
  pedido revisado.
- Quando chegar \`[BACKEND] Agent Final Message\`, resuma o resultado em 1 a 3
  frases faladas. Nunca leia diff, código ou lista de arquivos literalmente.
- Quando chegar \`[BACKEND] Agent needs a decision\`, avise em uma frase qual é a
  decisão pendente e espere a resposta do usuário.

## Limites
- Uma ideia por frase. Sem listas, sem markdown, sem emoji.
- Se não entendeu, peça para repetir em vez de adivinhar.`;
}

const TOOL_DEFINITION = {
	type: "function",
	name: DELEGATE_TOOL,
	description:
		"Delega um pedido de código, análise ou investigação ao agente Pi no terminal. Use sempre que o pedido exigir ler arquivos, rodar comandos ou alterar código.",
	parameters: {
		type: "object",
		properties: {
			input: {
				type: "string",
				description:
					"Pedido completo e autocontido, com todo o contexto necessário. O agente não ouve a conversa.",
			},
		},
		required: ["input"],
	},
} as const;

const TURN_DETECTION = {
	type: "server_vad",
	threshold: 0.5,
	prefix_padding_ms: 300,
	silence_duration_ms: 500,
	create_response: true,
	interrupt_response: true,
} as const;

/**
 * Payload de `session.update`, puro e testável.
 * GA (2025-08+): `audio.input.format` / `audio.output.voice`.
 * Beta (legado): `input_audio_format` / `output_audio_format` / `voice`.
 */
export function buildSessionUpdate(
	dialect: VoiceDialect,
	settings: VoiceSettings,
	userName?: string,
): Record<string, unknown> {
	const instructions = voiceInstructions(userName);
	const tools = [TOOL_DEFINITION];

	if (dialect === "beta") {
		return {
			type: "session.update",
			session: {
				model: settings.model,
				instructions,
				voice: settings.voice,
				input_audio_format: "pcm16",
				output_audio_format: "pcm16",
				input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
				turn_detection: TURN_DETECTION,
				tools,
				tool_choice: "auto",
			},
		};
	}

	return {
		type: "session.update",
		session: {
			type: "realtime",
			model: settings.model,
			instructions,
			audio: {
				input: {
					format: { type: "audio/pcm", rate: 24_000 },
					transcription: { model: "gpt-4o-mini-transcribe" },
					turn_detection: TURN_DETECTION,
				},
				output: { format: { type: "audio/pcm", rate: 24_000 }, voice: settings.voice },
			},
			tools,
			tool_choice: "auto",
		},
	};
}

export interface RealtimeSessionOptions {
	apiKey: string;
	settings: VoiceSettings;
	userName?: string;
	dialect?: VoiceDialect;
	/** Abertura do socket. Padrão: `openRealtimeSocket`; injetável para teste. */
	openSocket?: (options: OpenSocketOptions) => Promise<VoiceSocket>;
	onEvent: (event: VoiceEvent) => void;
	/** Só chamado depois de pronta. Falhas antes disso são rejeitadas por `connect()`. */
	onClose?: (reason: string) => void;
}

/** Tempo máximo para socket abrir e a sessão ser configurada. */
export const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Ciclo de vida:
 *   idle → connecting (socket criado, ainda não aberto)
 *        → configuring (aberto; session.update enviado, aguardando session.updated)
 *        → ready (só aqui há envio de áudio)
 *        → closed (terminal)
 * Nada é enviado fora de `configuring`/`ready`, e `send` nunca lança para fora.
 */
type SessionState = "idle" | "connecting" | "configuring" | "ready" | "closed";

const NO_ACTIVE_RESPONSE = /no active response/i;

export class RealtimeSession {
	private socket: VoiceSocket | undefined;
	private state: SessionState = "idle";
	private setup: { resolve: () => void; reject: (error: Error) => void } | undefined;
	/** Há resposta do modelo em andamento (response.created … response.done). */
	private responseActive = false;
	private readonly options: RealtimeSessionOptions;
	private readonly dialect: VoiceDialect;

	constructor(options: RealtimeSessionOptions) {
		this.options = options;
		this.dialect = options.dialect ?? resolveDialect();
	}

	get transport(): TransportInfo | undefined {
		return this.socket?.transport;
	}

	get dialectInUse(): VoiceDialect {
		return this.dialect;
	}

	/** Resolve só quando `session.updated` chega. Rejeita em erro, fechamento ou timeout. */
	connect(): Promise<void> {
		if (this.state !== "idle") return Promise.reject(new Error("sessão realtime já iniciada"));
		this.state = "connecting";
		const ready = new Promise<void>((resolve, reject) => {
			this.setup = { resolve, reject };
		});
		// Falha pode ocorrer antes de alguém aguardar: evita unhandled rejection.
		ready.catch(() => {});
		const timer = setTimeout(
			() => this.failSetup(new Error("tempo esgotado ao conectar na voz")),
			CONNECT_TIMEOUT_MS,
		);
		void this.open().catch((error: Error) => this.failSetup(error));
		return ready.finally(() => clearTimeout(timer));
	}

	private async open(): Promise<void> {
		const openSocket = this.options.openSocket ?? openRealtimeSocket;
		const socket = await openSocket({
			apiKey: this.options.apiKey,
			model: this.options.settings.model,
			dialect: this.dialect,
			handlers: {
				onOpen: () => {
					if (this.state !== "connecting") return;
					this.state = "configuring";
					this.send(buildSessionUpdate(this.dialect, this.options.settings, this.options.userName));
				},
				onMessage: (data) => this.handleMessage(data),
				onClose: (code, reason) => {
					const why = `conexão realtime encerrada (${code}${reason ? `: ${reason}` : ""})`;
					this.socket = undefined;
					if (this.state === "connecting" || this.state === "configuring") {
						this.failSetup(new Error(why));
					} else if (this.state === "ready") {
						this.state = "closed";
						this.options.onClose?.(why);
					}
				},
				onError: (error) => {
					if (this.state === "ready") {
						this.options.onEvent({ kind: "error", message: error.message, dialectHint: false });
					} else {
						this.failSetup(error);
					}
				},
			},
		});
		this.socket = socket;
		// Chegou depois de cancelado (timeout, /voice stop): não deixa socket aberto.
		if (this.state === "closed") this.closeSocket();
	}

	private handleMessage(data: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			return;
		}
		const type = (parsed as { type?: unknown } | null)?.type;
		if (type === "response.created") this.responseActive = true;
		if (type === "response.done") this.responseActive = false;
		// Barge-in sem resposta ativa: o servidor responde com erro. Não é falha do usuário.
		if (type === "error" && NO_ACTIVE_RESPONSE.test(JSON.stringify(parsed))) return;
		if (this.state === "configuring" && (type === "session.updated" || type === "transcription_session.updated")) {
			this.state = "ready";
			this.setup?.resolve();
		}
		const event = parseRealtimeEvent(parsed);
		if (this.state === "configuring" && event?.kind === "error") {
			this.failSetup(new Error(event.message));
			return;
		}
		if (event) this.options.onEvent(event);
	}

	/**
	 * Envia um evento. Retorna false sem lançar quando não há envio possível.
	 * Falha de transporte encerra a sessão em vez de propagar a exceção.
	 */
	private send(event: Record<string, unknown>): boolean {
		const socket = this.socket;
		if (!socket || !socket.isOpen()) {
			this.fatal("conexão de voz não está aberta");
			return false;
		}
		try {
			socket.send(JSON.stringify(event));
			return true;
		} catch (error) {
			this.fatal(`falha ao enviar à voz: ${(error as Error).message}`);
			return false;
		}
	}

	/** Encerramento por falha. Só age nos estados ativos e ocorre uma vez. */
	private fatal(reason: string): void {
		if (this.state === "connecting" || this.state === "configuring") {
			this.failSetup(new Error(reason));
			return;
		}
		if (this.state !== "ready") return;
		this.state = "closed";
		this.closeSocket();
		this.options.onClose?.(reason);
	}

	private failSetup(error: Error): void {
		if (this.state !== "connecting" && this.state !== "configuring") return;
		this.state = "closed";
		this.closeSocket();
		this.setup?.reject(error);
	}

	private closeSocket(): void {
		const socket = this.socket;
		this.socket = undefined;
		try {
			socket?.close();
		} catch {
			// já fechado
		}
	}

	/** Envia áudio só quando pronta. Antes disso o microfone nem deveria estar ligado. */
	appendAudio(frame: Buffer): void {
		if (this.state !== "ready") return;
		this.send({ type: "input_audio_buffer.append", audio: frame.toString("base64") });
	}

	/** Barge-in: cancela só se há resposta em andamento (senão o servidor responde com erro). */
	cancelResponse(): void {
		if (!this.responseActive) return;
		this.send({ type: "response.cancel" });
	}

	createResponse(instructions?: string): void {
		this.send({
			type: "response.create",
			response: instructions ? { instructions } : undefined,
		});
	}

	/** Injeta texto no fio da conversa: `[USER] ` ou `[BACKEND] `, como o Codex. */
	conversationText(role: "user" | "assistant", text: string): void {
		this.send({
			type: "conversation.item.create",
			item: { type: "message", role, content: [{ type: "input_text", text }] },
		});
	}

	/** Resultado do handoff: prefixo `[BACKEND]`, igual ao Codex. */
	backendResult(text: string, kind: "final" | "decision"): string {
		const header = backendHeader(kind);
		this.conversationText("user", header + text);
		return header;
	}

	/** Encerramento pedido pelo usuário: não dispara `onClose`. */
	close(): void {
		if (this.state === "closed") return;
		this.state = "closed";
		this.closeSocket();
		this.setup?.reject(new Error("sessão de voz encerrada antes de ficar pronta"));
	}
}
