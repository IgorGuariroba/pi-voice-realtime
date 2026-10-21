/** Testes do medidor de voz: escala perceptual, onda com histórico e largura fixa. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AutoGain, envelope, levelToUnit, meter, wave } from "../footer.ts";

test("fala típica (RMS 0.02–0.1) gera barras acima do piso", () => {
	for (const rms of [0.02, 0.05, 0.1]) assert.ok(levelToUnit(rms) > 0.2, `rms ${rms}`);
});

test("silêncio fica no piso e pico fica no topo", () => {
	assert.equal(levelToUnit(0), 0);
	assert.equal(levelToUnit(1), 1);
	assert.equal(meter(0), "▁▁▁▁▁▁▁▁▁▁");
});

test("onda tem largura fixa e mostra variação do histórico", () => {
	const bars = wave([0.1, 0.4, 0.9, 0.2, 0.6, 0.05].map(levelToUnit), 6);
	assert.equal([...bars].length, 6);
	assert.notEqual(new Set([...bars]).size, 1);
});

test("ataque sobe mais rápido que a liberação", () => {
	assert.ok(envelope(0, 1) - 0 > 0.5);
	assert.ok(1 - envelope(1, 0) < 0.5);
});

test("histórico curto é preenchido à esquerda com ▁", () => {
	assert.equal(wave([1], 6), "▁▁▁▁▁█");
});

test("ganho automático preenche a barra com microfone baixo e zera silêncio", () => {
	const gain = new AutoGain();
	let last = 0;
	for (let i = 0; i < 5; i++) last = gain.unit(0.004);
	assert.ok(last > 0.9, `got ${last}`);
	assert.equal(new AutoGain().unit(0.0005), 0);
});
