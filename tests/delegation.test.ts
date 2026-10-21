/**
 * Testes offline do contrato voz ↔ agente (mesmo formato do handoff do Codex).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	HANDOFF_COMPLETE_ACK,
	STEER_ACK,
	delegationTranscript,
	finalAnswerText,
	unwrapDelegation,
	wrapDelegation,
} from "../delegation.ts";

test("delegação gera o envelope do Codex", () => {
	assert.equal(
		wrapDelegation("rode os testes"),
		"<realtime_delegation>\n  <input>rode os testes</input>\n</realtime_delegation>",
	);
});

test("envelope faz round-trip", () => {
	const input = "corrija o bug do parser em ~/.pi/agent/extensions/voice/audio.ts";
	assert.equal(unwrapDelegation(wrapDelegation(input)), input);
});

test("caracteres XML sobrevivem ao round-trip", () => {
	const input = 'compare <a> & <b> com "x" e <input>';
	const wrapped = wrapDelegation(input);
	assert.ok(wrapped.includes("&lt;a&gt;"));
	assert.equal(unwrapDelegation(wrapped), input);
});

test("transcript delta acompanha a delegação", () => {
	const wrapped = wrapDelegation("continua", "user: e agora?\nassistant: okay");
	assert.equal(delegationTranscript(wrapped), "user: e agora?\nassistant: okay");
	assert.ok(wrapped.indexOf("<input>") < wrapped.indexOf("<transcript_delta>"));
});

test("texto normal não é delegação", () => {
	assert.equal(unwrapDelegation("só uma pergunta"), undefined);
	assert.equal(unwrapDelegation("<realtime_delegation>\n  sem input\n</realtime_delegation>"), undefined);
	assert.equal(delegationTranscript("sem transcript"), undefined);
});

test("resposta final ignora thinking e blocos de ferramenta", () => {
	const messages = [
		{ role: "user", content: "rode os testes" },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "vou rodar" },
				{ type: "text", text: "Rodei os testes, todos passaram." },
				{ type: "toolCall", id: "1", name: "bash", arguments: {} },
			],
		},
	];
	assert.equal(finalAnswerText(messages), "Rodei os testes, todos passaram.");
});

test("resposta final usa a última mensagem do assistente", () => {
	const messages = [
		{ role: "assistant", content: [{ type: "text", text: "primeira" }] },
		{ role: "toolResult", content: [{ type: "text", text: "saída" }] },
		{ role: "assistant", content: [{ type: "text", text: "segunda" }] },
	];
	assert.equal(finalAnswerText(messages), "segunda");
});

test("resposta final vazia vira undefined", () => {
	assert.equal(finalAnswerText([{ role: "assistant", content: [{ type: "thinking", thinking: "x" }] }]), undefined);
	assert.equal(finalAnswerText([{ role: "user", content: "nada" }]), undefined);
	assert.equal(finalAnswerText([]), undefined);
});

test("textos de retorno da V2 iguais aos do Codex", () => {
	assert.equal(HANDOFF_COMPLETE_ACK, "Background agent finished. Use the preceding [BACKEND] messages as the result.");
	assert.equal(STEER_ACK, "This was sent to steer the previous background agent task.");
});

test("origem transcript_tail_flush aparece no envelope", () => {
	const text = wrapDelegation("oi", undefined, "transcript_tail_flush");
	assert.ok(text.includes("<source>transcript_tail_flush</source>"));
	assert.equal(unwrapDelegation(text), "oi");
});
