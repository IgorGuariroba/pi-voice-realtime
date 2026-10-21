/**
 * Testes offline do parser de eventos realtime.
 * Rodar: node --test ~/.pi/agent/extensions/voice/tests/
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS } from "../config.ts";
import {
	DELEGATE_TOOL,
	buildSessionUpdate,
	parseRealtimeEvent,
	resolveDialect,
	voiceInstructions,
} from "../realtime.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures/realtime-events.json"), "utf8")) as Array<{
	name: string;
	raw: unknown;
	expect: Record<string, unknown> & { kind: string; pcmBase64?: string };
}>;

for (const testCase of fixture) {
	test(`realtime: ${testCase.name}`, () => {
		const event = parseRealtimeEvent(testCase.raw);
		assert.ok(event, "evento deveria ser reconhecido");
		assert.equal(event.kind, testCase.expect.kind);
		for (const [key, value] of Object.entries(testCase.expect)) {
			if (key === "kind" || key === "pcmBase64") continue;
			assert.deepEqual((event as Record<string, unknown>)[key], value, `campo ${key}`);
		}
		if (testCase.expect.pcmBase64) {
			assert.equal(
				(event as { pcm: Buffer }).pcm.toString("base64"),
				testCase.expect.pcmBase64,
				"PCM decodificado do base64",
			);
		}
	});
}

test("realtime: lixo não vira evento", () => {
	assert.equal(parseRealtimeEvent(null), null);
	assert.equal(parseRealtimeEvent("texto"), null);
	assert.equal(parseRealtimeEvent({}), null);
});

test("prompt de voz cita a ferramenta de delegação e define o papel", () => {
	const prompt = voiceInstructions("Movida");
	assert.ok(prompt.includes(DELEGATE_TOOL), "prompt precisa nomear a ferramenta");
	assert.ok(prompt.includes("Movida"), "prompt usa o nome do usuário");
	assert.ok(prompt.includes("[BACKEND]"), "prompt explica o canal de retorno");
	assert.ok(prompt.includes("português do Brasil"));
});

test("prompt não pede leitura literal de código", () => {
	const prompt = voiceInstructions();
	assert.ok(/nunca l[eê] c[oó]digo/i.test(prompt));
	assert.ok(/1 a 3\s*\n?\s*frases|1 a 3 frases/.test(prompt.replace(/\s+/g, " ")));
});

test("dialeto GA usa audio.input.format e não manda campos beta", () => {
	const update = buildSessionUpdate("ga", { ...DEFAULT_SETTINGS }, "Movida") as any;
	const session = update.session;
	assert.equal(session.type, "realtime");
	assert.equal(session.audio.input.format.rate, 24000);
	assert.equal(session.audio.output.format.type, "audio/pcm");
	assert.equal(session.audio.output.voice, "marin");
	assert.equal(session.voice, undefined);
	assert.equal(session.input_audio_format, undefined);
	assert.equal(session.turn_detection, undefined);
	assert.equal(session.audio.input.turn_detection.create_response, true);
});

test("dialeto beta usa campos planos e não manda audio", () => {
	const update = buildSessionUpdate("beta", { ...DEFAULT_SETTINGS }) as any;
	const session = update.session;
	assert.equal(session.audio, undefined);
	assert.equal(session.input_audio_format, "pcm16");
	assert.equal(session.output_audio_format, "pcm16");
	assert.equal(session.voice, "marin");
	assert.equal(session.turn_detection.interrupt_response, true);
});

test("payload sempre declara a ferramenta de delegação", () => {
	for (const dialect of ["ga", "beta"] as const) {
		const session = (buildSessionUpdate(dialect, { ...DEFAULT_SETTINGS }) as any).session;
		assert.equal(session.tools.length, 1);
		assert.equal(session.tools[0].name, DELEGATE_TOOL);
		assert.deepEqual(session.tools[0].parameters.required, ["input"]);
		assert.equal(session.tool_choice, "auto");
	}
});

test("dialeto é escolhido explicitamente, sem fallback automático", () => {
	assert.equal(resolveDialect({}), "ga");
	assert.equal(resolveDialect({ PI_VOICE_DIALECT: "beta" }), "beta");
	assert.equal(resolveDialect({ PI_VOICE_DIALECT: "GA" }), "ga");
	assert.equal(resolveDialect({ PI_VOICE_DIALECT: "qualquer" }), "ga");
});
