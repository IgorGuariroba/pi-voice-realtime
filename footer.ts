/**
 * Visual da sessão de voz no terminal.
 *
 * Reproduz a linha de status do Codex, com o agente pi no lugar do codex:
 *   voice ● speaking              f9 mute    /voice stop
 *   mic ▅▆▇▅▃▂   pi ▁▂▃▅▇█
 *
 * Usa `setWidget` acima do editor (animado, redesenha por frame) + `setStatus`
 * no rodapé nativo, que continua mostrando tokens/git/modelo.
 */

import type { Component, TUI, Theme } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type VoicePhase = "starting" | "listening" | "muted" | "speaking" | "working" | "stopping";

export interface VoiceViewState {
	phase: VoicePhase;
	/** Pico RMS do microfone desde a última leitura, 0..1 (consumido pela onda). */
	takeMicLevel?: () => number;
	/** RMS, 0..1, do áudio do agente que está tocando no instante `at` (ms epoch). */
	outLevelAt?: (at: number) => number;
	/** Fala do agente em andamento. */
	speaking: boolean;
	/** Última transcrição reconhecida (usuário ou agente). */
	caption?: string;
}

const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const WAVE_MS = 30;
/** Quantidade de barras por onda. */
const BARS = 10;
/** Piso do medidor (dB). Ruído de fundo fica abaixo; fala típica sobe até ~-20 dB. */
const FLOOR_DB = -55;
/** Topo do medidor (dB): acima disso a barra fica cheia. */
const CEIL_DB = -12;
/** Mic captado (medido com a fala do usuário): ruído ~-48..-43 dB, fala típica -45..-30 dB, pico ~-22 dB. */
const MIC_FLOOR_DB = -48;
const MIC_CEIL_DB = -28;
/** Subida rápida (ataque) e queda suave (liberação) para a barra não "tremer". */
const ATTACK = 0.75;
const RELEASE = 0.15;
/** Ganho automático: referência mínima, queda do pico por tick e porta de ruído (RMS). */
const REF_MIN = 0.003;
const PEAK_DECAY = 0.985;
const GATE = 0.0015;

/** Mapeia RMS linear (0..1) para 0..1 em escala logarítmica, perceptual. */
export function levelToUnit(level: number): number {
	return dbToUnit(level, FLOOR_DB, CEIL_DB);
}

/** Mesma escala logarítmica, com piso/topo do microfone. */
export function micLevelToUnit(level: number): number {
	return dbToUnit(level, MIC_FLOOR_DB, MIC_CEIL_DB);
}

function dbToUnit(level: number, floorDb: number, ceilDb: number): number {
	if (!(level > 0)) return 0;
	const db = 20 * Math.log10(level);
	return Math.max(0, Math.min(1, (db - floorDb) / (ceilDb - floorDb)));
}

/**
 * Ganho automático: normaliza pelo pico recente, com decaimento lento.
 * Microfone captura bem menos que a saída do agente; sem isso a barra fica baixa.
 * Abaixo de `gate` é silêncio.
 */
export class AutoGain {
	private peak = REF_MIN;
	unit(level: number): number {
		if (!(level > GATE)) {
			this.peak = Math.max(REF_MIN, this.peak * PEAK_DECAY);
			return 0;
		}
		this.peak = Math.max(level, this.peak * PEAK_DECAY, REF_MIN);
		return Math.min(1, level / this.peak);
	}
}

/** Suaviza um nível com ataque rápido e liberação lenta. */
export function envelope(prev: number, target: number): number {
	const k = target > prev ? ATTACK : RELEASE;
	return prev + (target - prev) * k;
}

/**
 * Onda em duas linhas (16 níveis): a linha de cima só enche depois que a de baixo está cheia.
 * Retorna [linhaDeCima, linhaDeBaixo], ambas com `width` colunas, mais recente à direita.
 */
export function waveRows(history: readonly number[], width: number): [string, string] {
	const start = Math.max(0, history.length - width);
	const pad = width - (history.length - start);
	let top = " ".repeat(pad);
	let bottom = " ".repeat(pad);
	for (let i = start; i < history.length; i++) {
		const total = Math.round(Math.max(0, Math.min(1, history[i])) * 16);
		const low = Math.min(8, total);
		const high = Math.max(0, total - 8);
		bottom += low === 0 ? " " : BLOCKS[low - 1];
		top += high === 0 ? " " : BLOCKS[high - 1];
	}
	return [top, bottom];
}

/** Uma barra por amostra (0..1), mais recente à direita; preenche com `▁` à esquerda. */
export function wave(history: readonly number[], width: number): string {
	const start = Math.max(0, history.length - width);
	let out = BLOCKS[0].repeat(width - (history.length - start));
	for (let i = start; i < history.length; i++) {
		out += BLOCKS[Math.min(BLOCKS.length - 1, Math.round(history[i] * (BLOCKS.length - 1)))];
	}
	return out;
}

export function meter(level: number, width = BARS): string {
	return wave(Array.from({ length: width }, () => levelToUnit(level)), width);
}

function phaseLabel(state: VoiceViewState): string {
	switch (state.phase) {
		case "starting":
			return "connecting";
		case "listening":
			return "listening";
		case "muted":
			return "muted";
		case "speaking":
			return "speaking";
		case "working":
			return "delegated";
		case "stopping":
			return "stopping";
	}
}

export function statusText(state: VoiceViewState, theme: Theme): string {
	const dot = state.phase === "muted" ? theme.fg("dim", "○") : theme.fg("accent", "●");
	const caption = state.caption ? theme.fg("dim", ` ${truncateToWidth(state.caption, 60)}`) : "";
	return `${theme.fg("muted", "voice")} ${dot} ${theme.fg("dim", phaseLabel(state))}${caption}`;
}

class VoiceWidget implements Component {
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly micHistory: number[] = [];
	private readonly outHistory: number[] = [];
	private micEnv = 0;
	private outEnv = 0;
	private readonly state: () => VoiceViewState;
	private readonly tui: TUI;
	private readonly theme: Theme;

	constructor(state: () => VoiceViewState, tui: TUI, theme: Theme) {
		this.state = state;
		this.tui = tui;
		this.theme = theme;
		this.timer = setInterval(() => {
			const s = this.state();
			const mic = s.takeMicLevel?.() ?? 0;
			// Mapeia dB absoluto: normalizar pelo pico (AutoGain) achata tudo em barra cheia.
			const micTarget = s.phase === "muted" ? 0 : micLevelToUnit(mic);
			const outTarget = s.speaking ? levelToUnit(s.outLevelAt?.(Date.now()) ?? 0) : 0;
			if (s.phase === "muted") {
				this.micHistory.length = 0;
				this.micEnv = 0;
			} else {
				this.micEnv = envelope(this.micEnv, micTarget);
			}
			this.outEnv = envelope(this.outEnv, outTarget);
			push(this.micHistory, this.micEnv);
			push(this.outHistory, this.outEnv);
			this.tui.requestRender();
		}, WAVE_MS);
	}

	invalidate(): void {}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	render(width: number): string[] {
		const state = this.state();
		const theme = this.theme;
		const dot = state.phase === "muted" ? theme.fg("dim", "○") : theme.fg("accent", "●");
		const label = theme.fg(state.phase === "muted" ? "dim" : "muted", ` ${phaseLabel(state)}`);

		const left = `${theme.fg("muted", "voice")} ${dot}${label}`;
		const hintMute = state.phase === "muted" ? "f9 unmute" : "f9 mute";
		const right =
			theme.fg("dim", hintMute) + theme.fg("muted", "   ") + theme.fg("dim", "/voice stop");
		const pad = " ".repeat(Math.max(1, width - 2 - visibleWidth(left) - visibleWidth(right)));

		const micMuted = state.phase === "muted";
		// Barras separadas mostram o histórico recente da fala.
		const micBars = wave(micMuted ? [] : this.micHistory, BARS).split("").join(" ");
		const mic = `${theme.fg("muted", "mic")}  ${theme.fg(micMuted ? "dim" : "accent", micBars)}`;
		const out = state.speaking
			? `    ${theme.fg("muted", "pi")}  ${theme.fg("accent", wave(this.outHistory, BARS).split("").join(" "))}`
			: "";
		const detail = `  ${mic}${out}`;
		const captionWidth = Math.max(0, width - visibleWidth(detail) - 3);
		const caption = state.caption && captionWidth > 0
			? theme.fg("dim", `   ${truncateToWidth(state.caption, captionWidth)}`)
			: "";

		return [
			truncateToWidth(`  ${left}${pad}${right}`, width),
			truncateToWidth(`${detail}${caption}`, width),
		];
	}
}

function push(history: number[], value: number): void {
	history.push(value);
	if (history.length > BARS) history.shift();
}

export function createVoiceWidget(state: () => VoiceViewState) {
	return (tui: TUI, theme: Theme): Component & { dispose?(): void } =>
		new VoiceWidget(state, tui, theme);
}
