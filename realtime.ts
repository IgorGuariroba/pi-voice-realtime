/**
 * Sessão realtime V2 (`/v1/realtime`) — equivalente de
 * `codex-rs/core/src/realtime_conversation.rs` (RealtimeWsVersion::V2) e de
 * `codex-api/src/endpoint/realtime_websocket/methods_v2.rs`.
 *
 * Divergências conscientes do Codex (ADR 0002):
 * 1. Auth: API key (`OPENAI_API_KEY`) em vez de ChatGPT + `intent=quicksilver`.
 * 2. Transporte: WebSocket PCM16 em vez de WebRTC (Node não tem o helper nativo).
 * Todo o resto do payload e do ciclo de handoff segue o Codex.
 */

import type { VoiceSettings } from "./config.ts";
import { openRealtimeSocket, type OpenSocketOptions, type TransportInfo, type VoiceSocket } from "./socket.ts";

export type VoiceEvent =
	| { kind: "ready" }
	| { kind: "audio"; pcm: Buffer; itemId?: string }
	| { kind: "user_transcript"; text: string }
	| { kind: "assistant_transcript"; text: string; final: boolean }
	| { kind: "speech_started" }
	| { kind: "speech_stopped" }
	| { kind: "background_agent"; callId: string; prompt: string }
	| { kind: "remain_silent"; callId: string }
	| { kind: "response_done" }
	| { kind: "error"; message: string; dialectHint: boolean }
	| { kind: "other"; type: string };

/** Ferramentas da V2 (methods_v2.rs). Nome e descrição idênticos ao Codex. */
export const BACKGROUND_AGENT_TOOL = "background_agent";
export const REMAIN_SILENT_TOOL = "remain_silent";

const BACKGROUND_AGENT_DESCRIPTION =
	"Send a user request to the background agent. Use this as the default action. Do not rephrase the user's ask or rewrite it in your own words; pass along the user's own words. If the background agent is idle, this starts a new task and returns the final result to the user. If the background agent is already working on a task, this sends the request as guidance to steer that previous task. If the user asks to do something next, later, after this, or once current work finishes, call this tool so the work is actually queued instead of merely promising to do it later.";
const REMAIN_SILENT_DESCRIPTION =
	"Call this when the best response is to say nothing. Use it instead of speaking after hidden system/control messages, after background agent updates in silent modes, or whenever acknowledging aloud would be distracting. This tool has no user-visible effect.";

/** Transcrição de entrada usada pelo Codex na V2. */
export const INPUT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

/** Taxa do PCM16 mono (24 kHz) usada pelo Codex. */
const PCM_RATE = 24_000;

/**
 * Normaliza um evento cru da API GA (`response.output_audio.*`).
 * Nomes beta não são mais enviados: a V2 do Codex usa só o formato GA.
 */
export function parseRealtimeEvent(raw: unknown): VoiceEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const event = raw as Record<string, any>;
	const type = typeof event.type === "string" ? event.type : "";
	if (!type) return null;

	switch (type) {
		case "session.created":
		case "session.updated":
			return { kind: "ready" };

		case "response.output_audio.delta":
			return {
				kind: "audio",
				pcm: Buffer.from(String(event.delta ?? ""), "base64"),
				itemId: typeof event.item_id === "string" ? event.item_id : undefined,
			};

		case "conversation.item.input_audio_transcription.completed":
			return { kind: "user_transcript", text: String(event.transcript ?? "").trim() };

		case "response.output_audio_transcript.delta":
			return { kind: "assistant_transcript", text: String(event.delta ?? ""), final: false };

		case "response.output_audio_transcript.done":
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
			const dialectHint = /unknown (parameter|field)|not supported|invalid (value|type)|audio.*(format|config)/i.test(message);
			return { kind: "error", message, dialectHint };
		}

		case "response.function_call_arguments.done": {
			const name = String(event.name ?? "");
			const callId = String(event.call_id ?? "");
			if (name === REMAIN_SILENT_TOOL) return { kind: "remain_silent", callId };
			if (name !== BACKGROUND_AGENT_TOOL) return { kind: "other", type };
			let prompt = "";
			try {
				const args = JSON.parse(String(event.arguments ?? "{}"));
				prompt = String(args.prompt ?? "").trim();
			} catch {
				return { kind: "error", message: "argumentos inválidos em background_agent", dialectHint: false };
			}
			if (!prompt) return { kind: "error", message: "background_agent sem pedido", dialectHint: false };
			return { kind: "background_agent", callId, prompt };
		}

		default:
			return { kind: "other", type };
	}
}

/** Instruções de sessão = backend_prompt (+ contexto de inicialização), como no Codex. */
export function buildInstructions(backendPrompt: string, startupContext = ""): string {
	return startupContext.trim() ? `${backendPrompt.trim()}\n\n${startupContext.trim()}` : backendPrompt.trim();
}

/**
 * Payload de `session.update` da V2 (methods_v2.rs, modo conversacional).
 * `model` vai na URL, como no Codex.
 */
export function buildSessionUpdate(
	settings: VoiceSettings,
	instructions: string,
): Record<string, unknown> {
	return {
		type: "session.update",
		session: {
			type: "realtime",
			instructions,
			output_modalities: ["audio"],
			audio: {
				input: {
					format: { type: "audio/pcm", rate: PCM_RATE },
					noise_reduction: { type: "near_field" },
					transcription: { model: INPUT_TRANSCRIPTION_MODEL },
					turn_detection: {
						type: "server_vad",
						interrupt_response: true,
						create_response: true,
						silence_duration_ms: 500,
					},
				},
				output: { format: { type: "audio/pcm", rate: PCM_RATE }, voice: settings.voice },
			},
			tools: [
				{
					type: "function",
					name: BACKGROUND_AGENT_TOOL,
					description: BACKGROUND_AGENT_DESCRIPTION,
					parameters: {
						type: "object",
						properties: {
							prompt: {
								type: "string",
								description: "The user request to delegate to the background agent.",
							},
						},
						required: ["prompt"],
						additionalProperties: false,
					},
				},
				{
					type: "function",
					name: REMAIN_SILENT_TOOL,
					description: REMAIN_SILENT_DESCRIPTION,
					parameters: { type: "object", properties: {}, additionalProperties: false },
				},
			],
			tool_choice: "auto",
		},
	};
}

/** Item de desenvolvedor injetado ao iniciar (realtime_start.md). */
export function developerItem(text: string): Record<string, unknown> {
	return {
		type: "conversation.item.create",
		item: { type: "message", role: "developer", content: [{ type: "input_text", text }] },
	};
}

export interface RealtimeSessionOptions {
	apiKey: string;
	settings: VoiceSettings;
	/** Instruções completas (backend prompt + contexto de inicialização). */
	instructions: string;
	/** Item de desenvolvedor enviado após `session.updated` (início da sessão). */
	startItem?: string;
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
 *   idle → connecting → configuring (session.update enviado, aguarda session.updated)
 *        → ready → closed (terminal)
 * Nada é enviado fora de `configuring`/`ready`, e `send` nunca lança para fora.
 */
type SessionState = "idle" | "connecting" | "configuring" | "ready" | "closed";

export class RealtimeSession {
	private socket: VoiceSocket | undefined;
	private state: SessionState = "idle";
	private setup: { resolve: () => void; reject: (error: Error) => void } | undefined;
	/** Há resposta do modelo em andamento (response.created … response.done). */
	private responseActive = false;
	/** Um `response.create` foi pedido enquanto havia resposta ativa (fila de 1, como o Codex). */
	private createPending = false;
	/** Áudio de saída da resposta corrente, para truncar no barge-in. */
	private outputAudio: { itemId: string; audioEndMs: number } | undefined;
	private readonly options: RealtimeSessionOptions;

	constructor(options: RealtimeSessionOptions) {
		this.options = options;
	}

	get transport(): TransportInfo | undefined {
		return this.socket?.transport;
	}

	/** Resolve só quando `session.updated` chega. Rejeita em erro, fechamento ou timeout. */
	connect(): Promise<void> {
		if (this.state !== "idle") return Promise.reject(new Error("sessão realtime já iniciada"));
		this.state = "connecting";
		const ready = new Promise<void>((resolve, reject) => {
			this.setup = { resolve, reject };
		});
		ready.catch(() => {});
		const timer = setTimeout(() => this.failSetup(new Error("tempo esgotado ao conectar na voz")), CONNECT_TIMEOUT_MS);
		void this.open().catch((error: Error) => this.failSetup(error));
		return ready.finally(() => clearTimeout(timer));
	}

	private async open(): Promise<void> {
		const openSocket = this.options.openSocket ?? openRealtimeSocket;
		const socket = await openSocket({
			apiKey: this.options.apiKey,
			model: this.options.settings.model,
			dialect: "ga",
			handlers: {
				onOpen: () => {
					if (this.state !== "connecting") return;
					this.state = "configuring";
					this.send(buildSessionUpdate(this.options.settings, this.options.instructions));
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
		if (type === "response.done") this.onResponseFinished();

		if (this.state === "configuring" && type === "session.updated") {
			this.state = "ready";
			if (this.options.startItem) this.send(developerItem(this.options.startItem));
			this.setup?.resolve();
		}

		// Barge-in: `interrupt_response` cancela no servidor; aqui só truncamos o áudio já emitido.
		if (type === "input_audio_buffer.speech_started") this.truncateOutputAudio();

		const event = parseRealtimeEvent(parsed);
		if (event?.kind === "audio" && event.itemId) {
			const ms = (event.pcm.length / 2 / PCM_RATE) * 1000;
			if (this.outputAudio?.itemId === event.itemId) this.outputAudio.audioEndMs += ms;
			else this.outputAudio = { itemId: event.itemId, audioEndMs: ms };
		}
		if (this.state === "configuring" && event?.kind === "error") {
			this.failSetup(new Error(event.message));
			return;
		}
		if (event) this.options.onEvent(event);
	}

	private onResponseFinished(): void {
		this.responseActive = false;
		this.outputAudio = undefined;
		if (this.createPending) {
			this.createPending = false;
			this.createResponse();
		}
	}

	private truncateOutputAudio(): void {
		const audio = this.outputAudio;
		this.outputAudio = undefined;
		if (!audio) return;
		this.send({
			type: "conversation.item.truncate",
			item_id: audio.itemId,
			content_index: 0,
			audio_end_ms: Math.floor(audio.audioEndMs),
		});
	}

	/** Envia um evento. Retorna false sem lançar quando não há envio possível. */
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

	/** Envia áudio só quando pronta. */
	appendAudio(frame: Buffer): void {
		if (this.state !== "ready") return;
		this.send({ type: "input_audio_buffer.append", audio: frame.toString("base64") });
	}

	/**
	 * Pede uma resposta falada. Se já há uma em andamento, fica pendente e é
	 * enviada ao `response.done` (`RealtimeResponseCreateQueue` do Codex).
	 */
	createResponse(): void {
		if (this.state !== "ready") return;
		if (this.responseActive) {
			this.createPending = true;
			return;
		}
		this.responseActive = true;
		this.send({ type: "response.create" });
	}

	/** Resultado de uma chamada de função (`background_agent`, `remain_silent`). */
	functionCallOutput(callId: string, output: string): void {
		if (this.state !== "ready") return;
		this.send({
			type: "conversation.item.create",
			item: { type: "function_call_output", call_id: callId, output },
		});
	}

	/** Texto digitado do usuário (mesmo papel que a transcrição de voz). Usado em testes E2E. */
	userText(text: string): void {
		if (this.state !== "ready") return;
		this.send({
			type: "conversation.item.create",
			item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
		});
	}

	/** Mensagem de desenvolvedor (início/fim da conversa, `realtime_start.md`/`realtime_end.md`). */
	developerText(text: string): void {
		if (this.state !== "ready") return;
		this.send(developerItem(text));
	}

	/** Item `[BACKEND] ` do Codex: progresso ou resultado do agente, lido pelo modelo como usuário. */
	backendItem(text: string): void {
		if (this.state !== "ready") return;
		this.send({
			type: "conversation.item.create",
			item: { type: "message", role: "user", content: [{ type: "input_text", text: `[BACKEND] ${text}` }] },
		});
	}

	/** Encerramento pedido pelo usuário: não dispara `onClose`. */
	close(): void {
		if (this.state === "closed") return;
		this.state = "closed";
		this.closeSocket();
		this.setup?.reject(new Error("sessão de voz encerrada antes de ficar pronta"));
	}
}
