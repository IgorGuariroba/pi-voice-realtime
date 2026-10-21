/**
 * Ponte voz ↔ sessão do pi (docs/adr/0001, docs/plano-implementacao.md).
 * Etapa atual: interface mínima, sem comportamento. As implementações entram uma a uma até T1–T3 passarem.
 */

export type PlaybackState = "pendente" | "reproduzindo" | "concluida_estimada" | "interrompida";

export interface PiPort {
	sendUserMessage(text: string, options: { deliverAs?: "prompt" | "steer"; origin: "voice" | "text" }): void;
	abort(): void;
	isBusy(): boolean;
}

export interface Playback {
	id: string;
	text: string;
	durationMs: number;
	stop(): void;
	onEnd(callback: () => void): void;
}

export interface SynthPort {
	speak(text: string, durationMs?: number): Playback;
}

export interface BridgeOptions {
	pi: PiPort;
	synth: SynthPort;
	now: () => number;
}

export interface PlaybackRecord {
	id: string;
	text: string;
	state: PlaybackState;
	fraction?: number;
}

export interface VoiceBridge {
	/** Transcrição consolidada da fala do usuário. */
	onTranscript(text: string): void;
	/** Texto final produzido pelo pi, a ser falado. */
	onAssistantText(text: string, options: { final: boolean }): void;
	/** Usuário começou a falar: corta áudio em reprodução. */
	onSpeechStart(): void;
	playbacks(): PlaybackRecord[];
}

interface Active {
	playback: Playback;
	startedAt: number;
	record: PlaybackRecord;
}

export function createVoiceBridge({ pi, synth, now }: BridgeOptions): VoiceBridge {
	const records: PlaybackRecord[] = [];
	let active: Active | undefined;

	return {
		onTranscript(text) {
			// Fala com a sessão do pi, sempre. Durante execução vira steer; a execução não é cancelada.
			pi.sendUserMessage(text, { deliverAs: pi.isBusy() ? "steer" : "prompt", origin: "voice" });
		},
		onAssistantText(text, { final }) {
			if (!final) return;
			const playback = synth.speak(text);
			const record: PlaybackRecord = { id: playback.id, text, state: "reproduzindo" };
			records.push(record);
			const entry: Active = { playback, startedAt: now(), record };
			active = entry;
			playback.onEnd(() => {
				if (record.state === "reproduzindo") record.state = "concluida_estimada";
				if (active === entry) active = undefined;
			});
		},
		onSpeechStart() {
			if (!active || active.record.state !== "reproduzindo") return;
			const { playback, startedAt, record } = active;
			playback.stop();
			const elapsed = now() - startedAt;
			record.state = "interrompida";
			record.fraction = Math.min(1, Math.max(0, elapsed / playback.durationMs));
			active = undefined;
		},
		playbacks() {
			return records.map((r) => ({ ...r }));
		},
	};
}
