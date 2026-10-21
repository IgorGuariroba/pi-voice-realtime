/**
 * Testes offline do protocolo realtime V2 (ADR 0002): parser de eventos, payload
 * `session.update` e instruções.
 * Rodar: node --test --experimental-strip-types ~/.pi/agent/extensions/voice/tests/realtime.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS } from "../config.ts";
import { BACKGROUND_AGENT_TOOL, REMAIN_SILENT_TOOL, buildInstructions, buildSessionUpdate, developerItem, parseRealtimeEvent } from "../realtime.ts";
import { backendPrompt, START_INSTRUCTIONS, END_INSTRUCTIONS } from "../prompts.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures/realtime-events.json"), "utf8")) as Array<{
	name: string;
	raw: unknown;
	expect: Record<string, unknown>;
}>;

for (const testCase of fixture) {
	test(`realtime: ${testCase.name}`, () => {
		const event = parseRealtimeEvent(testCase.raw) as Record<string, unknown> | null;
		assert.ok(event, "evento deveria ser reconhecido");
		for (const [key, expected] of Object.entries(testCase.expect)) {
			if (key === "pcmBase64") {
				assert.equal((event.pcm as Buffer).toString("base64"), expected);
			} else if (key === "message") {
				assert.equal(event.message, expected);
			} else {
				assert.equal(event[key], expected, `campo ${key}`);
			}
		}
	});
}

test("lixo não vira evento", () => {
	assert.equal(parseRealtimeEvent(null), null);
	assert.equal(parseRealtimeEvent("texto"), null);
	assert.equal(parseRealtimeEvent({ no: "type" }), null);
});

test("payload V2: conversa com resposta automática e VAD do Codex", () => {
	const session = buildSessionUpdate(DEFAULT_SETTINGS, "instr") as any;
	assert.equal(session.type, "session.update");
	assert.equal(session.session.type, "realtime");
	assert.deepEqual(session.session.output_modalities, ["audio"]);
	const turn = session.session.audio.input.turn_detection;
	assert.equal(turn.type, "server_vad");
	assert.equal(turn.create_response, true);
	assert.equal(turn.interrupt_response, true);
	assert.equal(turn.silence_duration_ms, 500);
	assert.equal(session.session.audio.input.noise_reduction.type, "near_field");
	assert.equal(session.session.audio.input.transcription.model, "gpt-4o-mini-transcribe");
	assert.equal(session.session.audio.output.voice, DEFAULT_SETTINGS.voice);
	assert.equal(session.session.tool_choice, "auto");
	assert.equal(session.session.instructions, "instr");
	assert.equal(session.session.model, undefined, "modelo vai na URL, como no Codex");
});

test("payload V2 declara background_agent e remain_silent com os nomes do Codex", () => {
	const tools = (buildSessionUpdate(DEFAULT_SETTINGS, "x") as any).session.tools as Array<any>;
	assert.deepEqual(
		tools.map((tool) => tool.name),
		[BACKGROUND_AGENT_TOOL, REMAIN_SILENT_TOOL],
	);
	assert.deepEqual(tools[0].parameters.required, ["prompt"]);
	assert.equal(tools[0].parameters.additionalProperties, false);
});

test("modelo default prioriza custo-benefício", () => {
	assert.equal(DEFAULT_SETTINGS.model, "gpt-realtime-2.1-mini");
});

test("instruções: backend prompt do Codex, com contexto de início quando houver", () => {
	const prompt = backendPrompt("Igor");
	assert.ok(prompt.startsWith("## Identity, tone, and role"));
	assert.ok(prompt.includes("The user's name is Igor."));
	assert.ok(!prompt.includes("{{ user_first_name }}"));
	assert.equal(buildInstructions(prompt), prompt.trim());
	assert.equal(buildInstructions(prompt, "Contexto X"), `${prompt.trim()}\n\nContexto X`);
});

test("developer items de início e fim vêm dos templates do Codex", () => {
	assert.ok(START_INSTRUCTIONS.startsWith("Realtime conversation started."));
	assert.ok(END_INSTRUCTIONS.startsWith("Realtime conversation ended."));
	const item = developerItem("oi") as any;
	assert.equal(item.type, "conversation.item.create");
	assert.equal(item.item.role, "developer");
	assert.equal(item.item.content[0].type, "input_text");
});
