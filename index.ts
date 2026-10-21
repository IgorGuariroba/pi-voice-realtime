/**
 * /voice — modo de conversa por voz, replicando o `/voice` do Codex CLI.
 *
 * Fluxo (igual ao Codex):
 *   /voice  → abre sessão realtime full-duplex (mic aberto, VAD do servidor).
 *   Você fala → o modelo de voz responde falando e, quando o pedido exige
 *   trabalho de código, delega para o agente Pi via `delegate_to_pi`.
 *   O pedido vira um turno normal: `<realtime_delegation><input>…</input></realtime_delegation>`.
 *   Ao terminar, a resposta final volta para a sessão realtime como
 *   `[BACKEND] Agent Final Message: …` e o modelo a resume em voz alta.
 *
 * Comandos: /voice [start|stop|mute|unmute|settings|status]
 * Atalho:   f9 — muta/desmuta o microfone.
 *
 * Requer OPENAI_API_KEY (ou PI_VOICE_API_KEY, ou openai em ~/.pi/agent/auth.json):
 * o transporte é o mesmo `/v1/realtime` do Codex, com API key em vez de auth ChatGPT.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SelectList, Text } from "@earendil-works/pi-tui";
import type { ChildProcess } from "node:child_process";
import { BYTES_PER_SAMPLE, Player, Recorder, rmsLevel } from "./audio.ts";
import { SAMPLE_RATE } from "./config.ts";
import { ensurePreview, playPreviewFile } from "./previews.ts";
import { openEchoAudio, EchoCleanup, type EchoAudio } from "./echo.ts";
import {
	VOICES,
	loadSettings,
	resolveApiKey,
	saveSettings,
	type VoiceName,
	type VoiceSettings,
} from "./config.ts";
import { finalAnswerText, unwrapDelegation, wrapDelegation } from "./delegation.ts";
import { createVoiceWidget, statusText, type VoiceViewState } from "./footer.ts";
import { RealtimeSession, resolveDialect, type VoiceEvent } from "./realtime.ts";

const WIDGET_KEY = "voice";
const STATUS_KEY = "voice";
const TRANSCRIPT_ENTRY = "voice-transcript";

export default function (pi: ExtensionAPI) {
	let settings: VoiceSettings = loadSettings();
	let session: RealtimeSession | undefined;
	let recorder: Recorder | undefined;
	let player: Player | undefined;
	let echoAudio: EchoAudio | undefined;
	const echoCleanup = new EchoCleanup();
	let muted = false;
	let speaking = false;
	let pendingDelegations = 0;
	let view: VoiceViewState = { phase: "listening", speaking: false };
	/** Pico do microfone desde a última amostra da onda. */
	// Mesma régra do áudio do agente: RMS médio por janela de 60 ms (não pico de frame).
	let micSum = 0;
	let micCount = 0;
	/** Segmentos de áudio do agente, com o instante em que devem tocar. */
	let outSchedule: Array<{ at: number; level: number }> = [];
	/** Instante (ms epoch) em que o áudio já enfileirado termina de tocar. */
	let playhead = 0;
	let speakingTimer: ReturnType<typeof setTimeout> | undefined;
	// O widget anima por conta própria (timer de 60 ms chamando tui.requestRender);
	// aqui só atualizamos o estado. O rodapé é atualizado por setStatus().
	const refresh = () => {};

	const setPhase = (phase: VoiceViewState["phase"]) => {
		view = { ...view, phase, speaking };
		refresh();
	};

	const active = () => Boolean(session);

	const caption = (text: string | undefined) => {
		view = { ...view, caption: text ? text.replace(/\s+/g, " ").slice(0, 120) : undefined };
		refresh();
	};

	const takeMicLevel = () => {
		const level = micCount ? micSum / micCount : 0;
		micSum = 0;
		micCount = 0;
		return level;
	};

	/** Maior nível dos segmentos que já deveriam estar tocando em `at`. */
	const outLevelAt = (at: number) => {
		let level = 0;
		while (outSchedule.length && outSchedule[0].at <= at) level = Math.max(level, outSchedule.shift()!.level);
		return level;
	};

	const scheduleOutput = (pcm: Buffer) => {
		const bytesPerMs = (SAMPLE_RATE * BYTES_PER_SAMPLE) / 1000;
		const segment = Math.floor(bytesPerMs * 60) & ~1;
		let at = Math.max(Date.now(), playhead);
		for (let off = 0; off < pcm.length; off += segment) {
			const chunk = pcm.subarray(off, Math.min(pcm.length, off + segment));
			outSchedule.push({ at, level: rmsLevel(chunk) });
			at += chunk.length / bytesPerMs;
		}
		playhead = at;
	};

	/** Só encerra "speaking" quando o áudio enfileirado terminou de tocar localmente. */
	const endSpeakingWhenPlayed = (ctx: ExtensionContext) => {
		if (speakingTimer) clearTimeout(speakingTimer);
		speakingTimer = setTimeout(() => {
			speakingTimer = undefined;
			speaking = false;
			outSchedule = [];
			view = {
				...view,
				phase: pendingDelegations > 0 ? "working" : muted ? "muted" : "listening",
				speaking: false,
			};
			refresh();
			setStatus(ctx);
		}, Math.max(0, playhead - Date.now()) + 100);
	};

	const setStatus = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(STATUS_KEY, statusText(view, ctx.ui.theme));
	};

	function recordTranscript(ctx: ExtensionContext, role: "user" | "agent", text: string) {
		if (!text.trim()) return;
		pi.appendEntry(TRANSCRIPT_ENTRY, { role, text });
		caption(text);
		void ctx;
	}

	function teardown(reason: string | undefined, ctx: ExtensionContext) {
		session?.close();
		session = undefined;
		recorder?.stop();
		recorder = undefined;
		player?.dispose();
		player = undefined;
		const oldEcho = echoAudio;
		echoAudio = undefined;
		if (oldEcho) echoCleanup.add(oldEcho);
		void echoCleanup.flush().catch(() => ctx.ui.notify("falha ao liberar módulo AEC; limpeza será tentada novamente", "warning"));
		speaking = false;
		pendingDelegations = 0;
		if (speakingTimer) clearTimeout(speakingTimer);
		speakingTimer = undefined;
		outSchedule = [];
		playhead = 0;
		micSum = 0;
		micCount = 0;
		view = { phase: "listening", speaking: false };
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		if (reason) ctx.ui.notify(`voz encerrada: ${reason}`, "warning");
	}

	function toggleMute(ctx: ExtensionContext) {
		if (!active()) return;
		muted = !muted;
		// Mutar afeta só a captura: o Codex continua reproduzindo a resposta.
		recorder?.setMuted(muted);
		view = { ...view, phase: muted ? "muted" : speaking ? "speaking" : "listening", speaking };
		refresh();
		setStatus(ctx);
		ctx.ui.notify(muted ? "microfone mutado (f9)" : "microfone ativo (f9)", "info");
	}

	async function start(ctx: ExtensionContext) {
		if (active()) {
			ctx.ui.notify("sessão de voz já está ativa — /voice stop para encerrar", "info");
			return;
		}
		const apiKey = resolveApiKey();
		if (!apiKey) {
			ctx.ui.notify(
				"sem credencial: rode /login openai (ou defina OPENAI_API_KEY)",
				"error",
			);
			return;
		}

		settings = loadSettings();
		muted = settings.muteOnStart;
		view = { phase: "starting", speaking: false };
		micSum = 0;
		micCount = 0;
		outSchedule = [];
		playhead = 0;

		if (ctx.mode === "tui") {
			ctx.ui.setWidget(WIDGET_KEY, createVoiceWidget(() => ({ ...view, takeMicLevel, outLevelAt })), {
				placement: "aboveEditor",
			});
		}

		const onEvent = (event: VoiceEvent) => handleEvent(event, ctx);

		// Estado "connecting" até a sessão estar configurada; microfone só depois.
		setStatus(ctx);

		const current = new RealtimeSession({
			apiKey,
			settings,
			userName: process.env.USER || process.env.USERNAME,
			dialect: resolveDialect(),
			onEvent,
			onClose: (reason) => {
				if (session === current) teardown(reason, ctx);
			},
		});
		session = current;

		try {
			await current.connect();
		} catch (error) {
			if (session === current) {
				teardown(undefined, ctx);
				ctx.ui.notify(`falha ao abrir voz: ${(error as Error).message}`, "error");
			}
			return;
		}
		// /voice stop (ou falha) durante a conexão já encerrou esta sessão.
		if (session !== current) return;

		try {
			if (settings.inputDevice || settings.outputDevice) {
				throw new Error("AEC usa os dispositivos padrão PulseAudio/PipeWire; remova inputDevice/outputDevice de voice.json");
			}
			const routes = await openEchoAudio();
			if (session !== current) {
				echoCleanup.add(routes);
				await echoCleanup.flush().catch(() => ctx.ui.notify("falha ao liberar AEC de sessão cancelada", "warning"));
				return;
			}
			echoAudio = routes;
			player = new Player(routes.playback, (error) => {
				if (session === current) teardown(`player: ${error.message}`, ctx);
			});
			recorder = new Recorder({
				onFrame: (frame) => {
					if (session !== current) return;
					current.appendAudio(frame);
					micSum += rmsLevel(frame);
					micCount++;
				},
				onError: (error) => {
					ctx.ui.notify(`microfone: ${error.message}`, "error");
					if (session === current) teardown("falha no microfone", ctx);
				},
			});
			recorder.setMuted(muted);
			recorder.start(routes.capture);
		} catch (error) {
			if (session !== current) return;
			teardown(`falha ao iniciar áudio: ${(error as Error).message}`, ctx);
			return;
		}

		view = { ...view, phase: muted ? "muted" : "listening" };
		setStatus(ctx);
		ctx.ui.notify(
			muted
				? "Voz conectada (mutado). f9 desmuta, /voice stop encerra."
				: "Conversa por voz iniciada. f9 muda, /voice stop encerra.",
			"info",
		);
	}

	function speak(text: string) {
		// O áudio do modelo chega por `response.output_audio.delta`; só marcamos o estado.
		speaking = true;
		view = { ...view, phase: "speaking", speaking: true };
		refresh();
		void text;
	}

	function handleEvent(event: VoiceEvent, ctx: ExtensionContext) {
		switch (event.kind) {
			case "ready":
				// Informativo: `start()` só passa a "listening" depois de connect() resolver.
				break;

			case "audio":
				if (muted) break;
				player?.write(event.pcm);
				scheduleOutput(event.pcm);
				if (speakingTimer) {
					clearTimeout(speakingTimer);
					speakingTimer = undefined;
				}
				if (!speaking) speak("");
				break;

			case "speech_started":
				// Barge-in: como o Codex, cancela a resposta no servidor e corta o áudio local.
				session?.cancelResponse();
				speaking = false;
				if (speakingTimer) clearTimeout(speakingTimer);
				speakingTimer = undefined;
				outSchedule = [];
				playhead = 0;
				player?.stop();
				view = { ...view, phase: "listening", speaking: false };
				refresh();
				break;

			case "speech_stopped":
				view = { ...view, phase: pendingDelegations > 0 ? "working" : "listening" };
				refresh();
				break;

			case "user_transcript":
				recordTranscript(ctx, "user", event.text);
				break;

			case "assistant_transcript":
				if (event.final) recordTranscript(ctx, "agent", event.text);
				break;

			case "delegate":
				void delegate(event.input, ctx);
				break;

			case "response_done":
				// A geração terminou, mas o áudio ainda pode estar tocando: a onda segue até o fim.
				endSpeakingWhenPlayed(ctx);
				break;

			case "error": {
				const atual = session?.dialectInUse ?? "ga";
				const alternativo = atual === "beta" ? "ga" : "beta";
				const hint = event.dialectHint
					? ` — payload rejeitado no dialeto "${atual}"; tente PI_VOICE_DIALECT=${alternativo}`
					: "";
				ctx.ui.notify(`voz: ${event.message}${hint}`, "error");
				break;
			}
		}
		setStatus(ctx);
	}

	async function delegate(input: string, ctx: ExtensionContext) {
		pendingDelegations += 1;
		setPhase("working");
		view = { ...view, phase: "working" };
		refresh();
		setStatus(ctx);
		recordTranscript(ctx, "user", input);

		const turn = wrapDelegation(input);
		try {
			pi.sendUserMessage(turn);
		} catch {
			try {
				pi.sendUserMessage(turn, { deliverAs: "steer" });
			} catch (error) {
				pendingDelegations = Math.max(0, pendingDelegations - 1);
				ctx.ui.notify(`não consegui iniciar o turno: ${(error as Error).message}`, "error");
			}
		}
	}

	// ------------------------------------------------------------------ comandos

	pi.registerCommand("voice", {
		description: "Conversa por voz com o agente (start | stop | mute | settings)",
		getArgumentCompletions: (prefix) =>
			["start", "stop", "mute", "unmute", "settings", "status"]
				.filter((option) => option.startsWith(prefix))
				.map((option) => ({ value: option, label: option })),
		handler: async (args, ctx) => {
			const action = (args || "").trim().toLowerCase();
			switch (action) {
				case "":
				case "start":
					await start(ctx);
					return;
				case "stop":
					if (!active()) {
						await echoCleanup.flush().catch(() => ctx.ui.notify("falha ao liberar módulo AEC", "warning"));
						ctx.ui.notify("nenhuma sessão de voz ativa", "info");
						return;
					}
					teardown(undefined, ctx);
					ctx.ui.notify("voz encerrada", "info");
					return;
				case "mute":
				case "unmute":
					if (!active()) {
						ctx.ui.notify("a voz não está ativa", "info");
						return;
					}
					if ((action === "mute") !== muted) toggleMute(ctx);
					return;
				case "status": {
					const key = resolveApiKey();
					ctx.ui.notify(
						[
							`estado: ${active() ? view.phase : "inativa"}`,
							`voz: ${settings.voice}`,
							`modelo: ${settings.model}`,
							`credencial: ${key ? "ok" : "ausente"}`,
							`transporte: ${session?.transport?.impl ?? "-"} · auth: ${session?.transport?.authMode ?? "-"} · dialeto: ${session?.dialectInUse ?? "-"}`,
							`saída: ${player ? "aberta" : "fechada"} · entrada: ${recorder ? "aberta" : "fechada"}`,
						].join("\n"),
						"info",
					);
					return;
				}
				case "settings":
					await openSettings(ctx);
					return;
				default:
					ctx.ui.notify(`/voice ${action}: use start, stop, mute, unmute, settings ou status`, "warning");
			}
		},
	});

	async function openSettings(ctx: ExtensionCommandContext) {
		const choice = await pickVoice(ctx);
		if (!choice) return;
		settings = { ...settings, voice: choice as VoiceName };
		saveSettings(settings);
		ctx.ui.notify(
			`voz definida para ${choice} — vale para a próxima sessão (/voice stop e /voice)`,
			"info",
		);
	}

	/**
	 * Seletor de voz com prévia: ao mudar o cursor, toca a amostra da voz
	 * (gerada uma vez e guardada em cache). Enter confirma, Esc cancela.
	 */
	function pickVoice(ctx: ExtensionCommandContext): Promise<VoiceName | undefined> {
		return ctx.ui.custom<VoiceName | undefined>((_tui, theme, _kb, done) => {
			let current: ChildProcess | undefined;
			let seq = 0;
			let warned = false;

			const stopPlayback = () => {
				current?.kill();
				current = undefined;
			};

			const preview = async (voice: VoiceName) => {
				const mine = ++seq;
				stopPlayback();
				const key = resolveApiKey();
				if (!key) {
					if (!warned) ctx.ui.notify("prévia indisponível: credencial OpenAI ausente", "warning");
					warned = true;
					return;
				}
				try {
					const path = await ensurePreview(voice, key);
					if (mine !== seq) return; // cursor já mudou
					current = playPreviewFile(path);
				} catch (error) {
					if (!warned) ctx.ui.notify(String((error as Error).message ?? error), "warning");
					warned = true;
				}
			};

			const list = new SelectList(
				VOICES.map((v) => ({ value: v, label: v, description: v === settings.voice ? "atual" : undefined })),
				VOICES.length,
				{
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => theme.fg("accent", t),
					description: (t) => theme.fg("dim", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				},
			);
			const initial = Math.max(0, VOICES.indexOf(settings.voice));
			list.setSelectedIndex(initial);
			list.onSelectionChange = (item) => void preview(item.value as VoiceName);
			list.onSelect = (item) => {
				stopPlayback();
				done(item.value as VoiceName);
			};
			list.onCancel = () => {
				stopPlayback();
				done(undefined);
			};

			return {
				render: (width: number) => [
					theme.fg("accent", `Voz da conversa (atual: ${settings.voice}) — ↑↓ ouvir prévia · enter escolhe · esc cancela`),
					...list.render(width),
				],
				handleInput: (data: string) => list.handleInput(data),
				invalidate: () => list.invalidate?.(),
				dispose: () => {
					seq++;
					stopPlayback();
				},
			};
		});
	}

	pi.registerShortcut("f9", {
		description: "Voz: mutar/desmutar microfone",
		handler: async (ctx) => {
			if (!active()) {
				ctx.ui.notify("voz inativa — use /voice para iniciar", "info");
				return;
			}
			toggleMute(ctx);
		},
	});

	// ------------------------------------------------------------------ eventos

	// Esconde o XML da delegação no transcript, mostrando só o pedido falado.
	pi.registerMarkdownTransformer((markdown) => {
		const unwrapped = unwrapDelegation(markdown);
		if (unwrapped === undefined) return markdown;
		return `🎙️ ${unwrapped}`;
	});

	pi.registerEntryRenderer(TRANSCRIPT_ENTRY, (entry, _options, theme) => {
		const data = (entry as { data?: { role?: string; text?: string } }).data;
		if (!data?.text) return undefined;
		const prefix = data.role === "user" ? "🎙️ você" : "🔊 agente";
		return new Text(`${theme.fg("dim", prefix)} ${data.text}`, 0, 0);
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!session || pendingDelegations === 0) return;
		const answer = finalAnswerText(event.messages);
		pendingDelegations = Math.max(0, pendingDelegations - 1);
		if (!answer) {
			view = { ...view, phase: muted ? "muted" : "listening" };
			refresh();
			setStatus(ctx);
			return;
		}
		const header = session.backendResult(answer, "final");
		session.createResponse(
			`${header.trim()} Resuma o resultado acima em 1 a 3 frases faladas, em português.`,
		);
		view = { ...view, phase: "speaking", speaking: true };
		refresh();
		setStatus(ctx);
	});

	// Pedido de decisão (permission prompt, erro, confirmação) é anunciado por voz.
	pi.on("ui_prompt_start", async (event, ctx) => {
		if (!session) return;
		const text = `o agente precisa de uma decisão: ${event.title ?? event.kind}`;
		const header = session.backendResult(text, "decision");
		session.createResponse(
			`${header.trim()} Avise o usuário em uma frase curta, em português, que o agente está esperando uma decisão no terminal.`,
		);
		refresh();
		setStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (session) teardown(undefined, ctx);
		await echoCleanup.flush().catch(() => ctx.ui.notify("falha ao liberar módulo AEC no shutdown", "warning"));
	});
}
