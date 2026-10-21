/**
 * Contexto de início (realtime_context.rs): orçamento e ordem cronológica.
 * Rodar: node --test --experimental-strip-types ~/.pi/agent/extensions/voice/tests/startup-context.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStartupContext, recentTurns } from "../startup-context.ts";

const msg = (role: string, content: unknown) => ({ type: "message", message: { role, content } });

test("ignora entradas que não são texto de usuário ou agente", () => {
	const turns = recentTurns([
		{ type: "model_change" },
		msg("user", "oi"),
		msg("toolResult", "saída"),
		msg("assistant", [{ type: "toolCall", name: "bash" }, { type: "text", text: "pronto" }]),
	]);
	assert.deepEqual(turns, [
		{ role: "USER", text: "oi" },
		{ role: "ASSISTANT", text: "pronto" },
	]);
});

test("respeita o orçamento e mantém a ordem cronológica dos turnos mais recentes", () => {
	const branch = Array.from({ length: 50 }, (_, i) => msg(i % 2 ? "assistant" : "user", `turno ${i} ` + "x".repeat(2000)));
	const context = buildStartupContext(branch, "/w", 1_000);
	assert.ok(context.length / 4 <= 1_050, "dentro do orçamento (com folga do cabeçalho)");
	assert.ok(context.includes("turno 49"), "o mais recente entra");
	assert.ok(!context.includes("turno 0 "), "o mais antigo sai");
	const lines = context.split("\n").filter((l) => /turno \d+/.test(l));
	const numbers = lines.map((l) => Number(/turno (\d+)/.exec(l)![1]));
	assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
});

test("sem turnos, ainda informa o diretório de trabalho", () => {
	const context = buildStartupContext([], "/w");
	assert.match(context, /Diretório de trabalho: \/w/);
	assert.ok(!context.includes("Turnos recentes"));
});
