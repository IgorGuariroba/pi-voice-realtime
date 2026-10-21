/**
 * Prévias de voz para o seletor de `/voice settings`.
 *
 * Gera uma amostra curta por voz via `/v1/audio/speech` (PCM 24 kHz mono, o
 * mesmo formato do player) e guarda em cache em `~/.pi/agent/voice/previews/`.
 * A geração acontece só na primeira vez que a voz é ouvida; depois é leitura de disco.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { playBackend } from "./audio.ts";
import { API_BASE, voiceDir, type VoiceName } from "./config.ts";

export const PREVIEW_MODEL = "gpt-4o-mini-tts";
export const PREVIEW_TEXT = "Oi, eu sou a sua voz da conversa. Assim eu vou soar.";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function previewDir(): string {
	return join(voiceDir(), "voice", "previews");
}

export function previewPath(voice: VoiceName, dir: string = previewDir()): string {
	return join(dir, `${voice}.pcm`);
}

/**
 * Garante que a amostra da voz existe em disco e devolve o caminho.
 * Escreve em arquivo temporário e renomeia, para não deixar cache pela metade.
 * Lança erro (com a mensagem da API) se a voz não puder ser gerada.
 */
export async function ensurePreview(
	voice: VoiceName,
	apiKey: string,
	opts: { dir?: string; fetchImpl?: FetchLike } = {},
): Promise<string> {
	const dir = opts.dir ?? previewDir();
	const path = previewPath(voice, dir);
	if (existsSync(path)) return path;

	const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);
	const res = await fetchImpl(`${API_BASE}/audio/speech`, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: PREVIEW_MODEL,
			voice,
			input: PREVIEW_TEXT,
			response_format: "pcm",
		}),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(`prévia da voz ${voice} indisponível (HTTP ${res.status}) ${detail.slice(0, 200)}`);
	}
	const pcm = Buffer.from(await res.arrayBuffer());
	if (pcm.length === 0) throw new Error(`prévia da voz ${voice} veio vazia`);

	mkdirSync(dir, { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, pcm);
	renameSync(tmp, path);
	return path;
}

/**
 * Toca um arquivo PCM pelo backend de saída. Devolve o processo para que o
 * chamador possa interrompê-lo quando o cursor mudar de voz.
 */
export function playPreviewFile(path: string, platform: NodeJS.Platform = process.platform): ChildProcess {
	const backend = playBackend(platform);
	const child = spawn(backend.command, backend.args, { stdio: ["pipe", "ignore", "ignore"] });
	child.stdin?.on("error", () => {});
	child.on("error", () => {});
	createReadStream(path).pipe(child.stdin!);
	return child;
}
