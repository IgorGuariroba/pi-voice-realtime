/**
 * Visual da sessão de voz no terminal.
 *
 * Reproduz a linha de status do Codex:
 *   voice ● listening              f9 mute    /voice stop
 *   mic ▂▃▅▂▁   codex ____
 *
 * Usa `setWidget` acima do editor (animado, redesenha por frame) + `setStatus`
 * no rodapé nativo, que continua mostrando tokens/git/modelo. Não substitui o
 * rodapé inteiro para não perder as outras informações.
 */

import type { Component, TUI, Theme } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type VoicePhase = "starting" | "listening" | "muted" | "speaking" | "working" | "stopping";

export interface VoiceViewState {
	phase: VoicePhase;
	/** Nível do microfone, 0..1. */
	level: number;
	/** Fala do agente em andamento (para a onda). */
	speaking: boolean;
	/** Última transcrição reconhecida (usuário ou agente). */
	caption?: string;
}

const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const WAVE_MS = 60;

export function meter(level: number, width = 5): string {
	const filled = Math.max(0, Math.min(width, Math.round(level * width * 1.6)));
	let out = "";
	for (let i = 0; i < width; i++) {
		const factor = i < filled ? 1 : 0.15;
		out += BLOCKS[Math.min(BLOCKS.length - 1, Math.round(level * 7 * factor))];
	}
	return out;
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
	private started = Date.now();
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly state: () => VoiceViewState;
	private readonly tui: TUI;
	private readonly theme: Theme;

	constructor(state: () => VoiceViewState, tui: TUI, theme: Theme) {
		this.state = state;
		this.tui = tui;
		this.theme = theme;
		this.timer = setInterval(() => this.tui.requestRender(), WAVE_MS);
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
		const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));

		let detail: string;
		if (state.phase === "muted") {
			detail = `${theme.fg("dim", "mic")} ${theme.fg("dim", meter(0))}`;
		} else if (state.speaking) {
			const frames = (Math.floor((Date.now() - this.started) / WAVE_MS) % 4) + 1;
			detail = `${theme.fg("muted", "codex")} ${theme.fg("accent", "_".repeat(frames * 4))}`;
		} else {
			detail = `${theme.fg("muted", "mic")} ${theme.fg("success", meter(state.level, 6))}`;
		}

		const caption = state.caption
			? theme.fg("dim", `  ${truncateToWidth(state.caption, Math.max(10, width - 30))}`)
			: "";

		return [
			truncateToWidth(`  ${left}${pad}${right}`, width),
			truncateToWidth(`    ${detail}${caption}`, width),
		];
	}
}

export function createVoiceWidget(state: () => VoiceViewState) {
	return (tui: TUI, theme: Theme): Component & { dispose?(): void } =>
		new VoiceWidget(state, tui, theme);
}
