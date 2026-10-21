/**
 * Captura e reprodução via binários de sistema, em PCM16 mono 24 kHz.
 *
 * Fidelidade ao Codex: o helper nativo dele fala Opus/RTP sobre GStreamer.
 * Aqui o transporte é PCM16 cru (formato que a API Realtime aceita direto), com
 * os mesmos limites de frame (20 ms) e o mesmo comportamento de mute: ao mutar,
 * descartamos o que ainda estava no buffer de captura.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { SAMPLE_RATE } from "./config.ts";

export const BYTES_PER_SAMPLE = 2;
/** 20 ms por frame, como o Opus do Codex. */
export const FRAME_BYTES = Math.floor((SAMPLE_RATE * 20) / 1000) * BYTES_PER_SAMPLE;

export interface Backend {
	command: string;
	args: string[];
}

/** Recomenda um backend de captura por SO. `device` é opcional. */
export function captureBackend(
	platform: NodeJS.Platform = process.platform,
	device?: string,
): Backend {
	if (platform === "darwin") {
		const input = device ?? ":0";
		return {
			command: "ffmpeg",
			args: [
				"-hide_banner",
				"-loglevel",
				"error",
				"-f",
				"avfoundation",
				"-i",
				input,
				"-ac",
				"1",
				"-ar",
				String(SAMPLE_RATE),
				"-f",
				"s16le",
				"-",
			],
		};
	}
	if (platform === "win32") {
		return {
			command: "ffmpeg",
			args: [
				"-hide_banner",
				"-loglevel",
				"error",
				"-f",
				"dshow",
				"-i",
				`audio=${device ?? "default"}`,
				"-ac",
				"1",
				"-ar",
				String(SAMPLE_RATE),
				"-f",
				"s16le",
				"-",
			],
		};
	}
	const args = ["-q", "-t", "raw", "-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", "1"];
	if (device) args.push("-D", device);
	args.push("-");
	return { command: "arecord", args };
}

/** Recomenda um backend de reprodução por SO. */
export function playBackend(platform: NodeJS.Platform = process.platform, device?: string): Backend {
	if (platform === "darwin") {
		return {
			command: "ffplay",
			args: [
				"-hide_banner",
				"-loglevel",
				"error",
				"-nodisp",
				"-autoexit",
				"-f",
				"s16le",
				"-ar",
				String(SAMPLE_RATE),
				"-ac",
				"1",
				"-i",
				"pipe:0",
			],
		};
	}
	if (platform === "win32") {
		return {
			command: "ffplay",
			args: [
				"-hide_banner",
				"-loglevel",
				"error",
				"-nodisp",
				"-autoexit",
				"-f",
				"s16le",
				"-ar",
				String(SAMPLE_RATE),
				"-ac",
				"1",
				"-i",
				"pipe:0",
			],
		};
	}
	const args = ["-q", "-t", "raw", "-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", "1"];
	if (device) args.push("-D", device);
	args.push("-");
	return { command: "aplay", args };
}

/**
 * Nível RMS normalizado (0..1) de um bloco PCM16LE mono.
 * Usado pelo medidor de microfone do rodapé.
 */
export function rmsLevel(pcm: Buffer): number {
	const samples = Math.floor(pcm.length / BYTES_PER_SAMPLE);
	if (samples === 0) return 0;
	let sum = 0;
	for (let i = 0; i < samples; i++) {
		const value = pcm.readInt16LE(i * BYTES_PER_SAMPLE) / 32768;
		sum += value * value;
	}
	return Math.min(1, Math.sqrt(sum / samples));
}

/**
 * Acumula bytes e devolve frames de tamanho fixo, guardando o resto.
 * Necessário porque `arecord`/`ffmpeg` entregam blocos de tamanho arbitrário
 * e a API Realtime espera base64 de frames contínuos.
 */
export class FrameChunker {
	private remainder: Buffer = Buffer.alloc(0);
	private readonly frameBytes: number;

	constructor(frameBytes: number = FRAME_BYTES) {
		this.frameBytes = frameBytes;
	}

	push(chunk: Buffer): Buffer[] {
		this.remainder = this.remainder.length ? Buffer.concat([this.remainder, chunk]) : chunk;
		const frames: Buffer[] = [];
		let offset = 0;
		while (this.remainder.length - offset >= this.frameBytes) {
			frames.push(this.remainder.subarray(offset, offset + this.frameBytes));
			offset += this.frameBytes;
		}
		this.remainder = this.remainder.subarray(offset);
		return frames;
	}

	/** Descarta o parcial acumulado (usado ao mutar, como o Codex invalida buffers). */
	reset(): void {
		this.remainder = Buffer.alloc(0);
	}

	get pending(): number {
		return this.remainder.length;
	}
}

export interface RecorderHandlers {
	onFrame(frame: Buffer): void;
	onError(error: Error): void;
	onExit?(code: number | null): void;
}

export class Recorder {
	private child: ChildProcessByStdio<null, Readable, Readable> | undefined;
	private chunker = new FrameChunker();
	private muted = false;
	private stopping = false;
	private readonly handlers: RecorderHandlers;

	constructor(handlers: RecorderHandlers) {
		this.handlers = handlers;
	}

	start(backend: Backend = captureBackend()): void {
		if (this.child) return;
		const child = spawn(backend.command, backend.args, { stdio: ["ignore", "pipe", "pipe"] });
		this.child = child;
		child.stdout.on("data", (data: Buffer) => {
			if (this.muted) return;
			for (const frame of this.chunker.push(data)) this.handlers.onFrame(frame);
		});
		let stderr = "";
		child.stderr.on("data", (data: Buffer) => {
			stderr = (stderr + data.toString("utf8")).slice(-2000);
		});
		child.on("error", (error) => this.handlers.onError(error));
		child.on("exit", (code) => {
			this.child = undefined;
			const error = stderr.trim();
			// SIGTERM intencional (stop) não é falha: o arecord sai com 1 nesse caso.
			if (!this.stopping && code && code !== 0) {
				this.handlers.onError(
					new Error(`${backend.command} saiu com código ${code}${error ? `: ${error}` : ""}`),
				);
			}
			this.handlers.onExit?.(code);
		});
	}

	get isRunning(): boolean {
		return Boolean(this.child);
	}

	setMuted(muted: boolean): void {
		this.muted = muted;
		// Como o Codex ao mutar: descarta o buffer pendente para não enviar áudio pré-mute.
		if (muted) this.chunker.reset();
	}

	stop(): void {
		this.stopping = true;
		this.muted = true;
		this.chunker.reset();
		const child = this.child;
		this.child = undefined;
		if (!child) return;
		child.kill("SIGTERM");
		setTimeout(() => {
			if (!child.killed) child.kill("SIGKILL");
		}, 500).unref?.();
	}
}

/** Player com fila simples; `stop()` interrompe a fala em andamento (barge-in). */
export class Player {
	private child: ChildProcessByStdio<Writable, null, Readable> | undefined;
	private started = false;
	private readonly backend: Backend;
	private readonly onError?: (error: Error) => void;

	constructor(backend: Backend = playBackend(), onError?: (error: Error) => void) {
		this.backend = backend;
		this.onError = onError;
	}

	private ensure(): ChildProcessByStdio<Writable, null, Readable> | undefined {
		if (this.started && this.child) return this.child;
		try {
			const child = spawn(this.backend.command, this.backend.args, {
				stdio: ["pipe", "ignore", "pipe"],
			});
			child.on("error", (error) => this.onError?.(error));
			child.on("exit", () => {
				if (this.child === child) {
					this.child = undefined;
					this.started = false;
				}
			});
			child.stderr.on("data", () => {});
			child.stdin.on("error", () => {});
			this.child = child;
			this.started = true;
			return child;
		} catch (error) {
			this.onError?.(error as Error);
			return undefined;
		}
	}

	write(pcm: Buffer): void {
		const child = this.ensure();
		child?.stdin.write(pcm);
	}

	/** Corta o áudio imediatamente (usado quando o usuário começa a falar). */
	stop(): void {
		const child = this.child;
		this.child = undefined;
		this.started = false;
		if (!child) return;
		child.stdin.end();
		child.kill("SIGTERM");
	}

	dispose(): void {
		this.stop();
	}
}
