/**
 * Testes offline do framing PCM (o equivalente ao empacotamento de 256 amostras
 * que o `codex-voice-host` faz para atravessar callbacks irregulares do backend).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	BYTES_PER_SAMPLE,
	FRAME_BYTES,
	FrameChunker,
	captureBackend,
	playBackend,
	rmsLevel,
} from "../audio.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures/pcm-frames.json"), "utf8")) as {
	frameBytes: number;
	cases: Array<{ name: string; chunks: number[]; frames: number[]; remainder: number }>;
	levels: Array<{ name: string; samples: number; amplitude: number; min?: number; max?: number }>;
};

test("frame de 20 ms a 24 kHz = 960 bytes", () => {
	assert.equal(FRAME_BYTES, 960);
	assert.equal(FRAME_BYTES, ((24_000 * 20) / 1000) * BYTES_PER_SAMPLE);
});

for (const testCase of fixture.cases) {
	test(`framing: ${testCase.name}`, () => {
		const chunker = new FrameChunker(fixture.frameBytes);
		const frames: number[] = [];
		for (const size of testCase.chunks) {
			for (const frame of chunker.push(Buffer.alloc(size, 1))) frames.push(frame.length);
		}
		assert.deepEqual(frames, testCase.frames);
		assert.equal(chunker.pending, testCase.remainder);
	});
}

test("framing: reset descarta o parcial (mute)", () => {
	const chunker = new FrameChunker(960);
	assert.equal(chunker.push(Buffer.alloc(500, 1)).length, 0);
	assert.equal(chunker.pending, 500);
	chunker.reset();
	assert.equal(chunker.pending, 0);
	assert.deepEqual(chunker.push(Buffer.alloc(960, 1)).map((frame) => frame.length), [960]);
});

test("framing: bytes são preservados na ordem", () => {
	const chunker = new FrameChunker(4);
	const first = chunker.push(Buffer.from([1, 2, 3]))[0];
	assert.equal(first, undefined);
	const frames = chunker.push(Buffer.from([4, 5, 6, 7, 8]));
	assert.deepEqual([...frames[0]], [1, 2, 3, 4]);
	assert.deepEqual([...frames[1]], [5, 6, 7, 8]);
});

for (const level of fixture.levels) {
	test(`nível RMS: ${level.name}`, () => {
		const pcm = Buffer.alloc(level.samples * BYTES_PER_SAMPLE);
		const value = Math.round(level.amplitude * 32767);
		for (let i = 0; i < level.samples; i++) pcm.writeInt16LE(value, i * BYTES_PER_SAMPLE);
		const measured = rmsLevel(pcm);
		if (level.min !== undefined) assert.ok(measured >= level.min, `RMS ${measured} < ${level.min}`);
		if (level.max !== undefined) assert.ok(measured <= level.max, `RMS ${measured} > ${level.max}`);
	});
}

test("nível RMS: buffer vazio é zero", () => {
	assert.equal(rmsLevel(Buffer.alloc(0)), 0);
});

test("backends por SO", () => {
	const linuxCapture = captureBackend("linux");
	assert.equal(linuxCapture.command, "arecord");
	assert.ok(linuxCapture.args.includes("S16_LE"));
	assert.ok(linuxCapture.args.includes("24000"));

	const linuxWithDevice = captureBackend("linux", "plughw:2,0");
	assert.ok(linuxWithDevice.args.includes("plughw:2,0"));
	assert.deepEqual(linuxWithDevice.args.slice(-3), ["-D", "plughw:2,0", "-"]);

	assert.equal(captureBackend("darwin").command, "ffmpeg");
	assert.ok(captureBackend("darwin").args.includes("avfoundation"));
	assert.equal(captureBackend("win32").command, "ffmpeg");

	const linuxPlay = playBackend("linux");
	assert.equal(linuxPlay.command, "aplay");
	assert.deepEqual(linuxPlay.args.slice(-1), ["-"]);
	assert.equal(playBackend("darwin").command, "ffplay");
});

test("backend padrão do host atual responde", () => {
	assert.ok(captureBackend().args.length > 0);
	assert.ok(playBackend().args.length > 0);
});
