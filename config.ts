/**
 * Configuração do /voice.
 *
 * Espelha o que o Codex expõe em config (`realtime.model`, `realtime.voice`,
 * dispositivos de entrada/saída) e resolve a credencial em ordem de precedência.
 *
 * Divergência deliberada do Codex: o Codex autentica com `CodexAuth` (ChatGPT)
 * e usa `intent=quicksilver`. Aqui usamos a API pública `/v1/realtime` com
 * `OPENAI_API_KEY`, que é o único caminho disponível fora do produto Codex.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Catálogo v1 de vozes da API Realtime (o Codex usa a mesma lista). */
export const VOICES = [
	"alloy",
	"ash",
	"ballad",
	"coral",
	"echo",
	"marin",
	"cedar",
	"sage",
	"shimmer",
	"verse",
] as const;

export type VoiceName = (typeof VOICES)[number];

export interface VoiceSettings {
	/** Voz falada pelo modelo realtime. */
	voice: VoiceName;
	/** Modelo realtime. Codex default: `gpt-realtime-1.5`. */
	model: string;
	/** Nome/dispositivo ALSA de entrada (`arecord -D`). */
	inputDevice?: string;
	/** Nome/dispositivo ALSA de saída (`aplay -D`). */
	outputDevice?: string;
	/** Começar mudo (f9 desmuta). */
	muteOnStart: boolean;
	/** Frase falada enquanto o pi trabalha (equivalente ao `delegation_ack_filler`). */
	ackFiller: string;
}

export const DEFAULT_SETTINGS: VoiceSettings = {
	voice: "marin",
	model: "gpt-realtime",
	inputDevice: undefined,
	outputDevice: undefined,
	muteOnStart: false,
	ackFiller: "Deixa comigo, já volto com a resposta.",
};

export const SAMPLE_RATE = 24_000;
/** Duração de cada frame enviado/consumido. 20 ms é o frame do Opus no Codex. */
export const FRAME_MS = 20;

export function voiceDir(): string {
	return join(homedir(), ".pi", "agent");
}

export function settingsPath(): string {
	return join(voiceDir(), "voice.json");
}

export function loadSettings(): VoiceSettings {
	const path = settingsPath();
	if (!existsSync(path)) return { ...DEFAULT_SETTINGS };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<VoiceSettings>;
		const settings: VoiceSettings = { ...DEFAULT_SETTINGS, ...raw };
		if (!VOICES.includes(settings.voice)) settings.voice = DEFAULT_SETTINGS.voice;
		return settings;
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export function saveSettings(settings: VoiceSettings): void {
	writeFileSync(settingsPath(), `${JSON.stringify(settings, null, "\t")}\n`, "utf8");
}

/**
 * Credencial da API. Precedência: `OPENAI_API_KEY` → `PI_VOICE_API_KEY` →
 * entrada `openai` de `~/.pi/agent/auth.json` (mesmo arquivo que o pi usa).
 */
export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const fromEnv = env.OPENAI_API_KEY || env.PI_VOICE_API_KEY;
	if (fromEnv?.trim()) return fromEnv.trim();

	const authPath = join(voiceDir(), "auth.json");
	if (!existsSync(authPath)) return undefined;
	try {
		const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
		for (const provider of ["openai", "openai-codex"]) {
			const entry = auth[provider] as { key?: unknown; apiKey?: unknown } | undefined;
			const key = entry?.key ?? entry?.apiKey;
			if (typeof key === "string" && key.trim()) return key.trim();
		}
	} catch {
		// arquivo ilegível: trata como ausente
	}
	return undefined;
}

export const API_BASE = "https://api.openai.com/v1";
