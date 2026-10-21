/**
 * Regressão: o handshake enviava `OpenAI-Beta: realtime=v1` mesmo no dialeto GA,
 * e a API recusa com "The Realtime Beta API is no longer supported".
 * Rodar: node --test --experimental-strip-types ~/.pi/agent/extensions/voice/tests/
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHandshakeHeaders, buildSubprotocols } from "../socket.ts";

test("GA: handshake não envia header beta", () => {
	const headers = buildHandshakeHeaders("test-key", "ga");
	assert.equal(headers.Authorization, "Bearer test-key");
	assert.equal("OpenAI-Beta" in headers, false);
});

test("beta: mantém header beta para o endpoint legado", () => {
	const headers = buildHandshakeHeaders("test-key", "beta");
	assert.equal(headers["OpenAI-Beta"], "realtime=v1");
});

test("subprotocolo GA não usa openai-beta.realtime-v1", () => {
	const protocols = buildSubprotocols("secret", "ga");
	assert.deepEqual(protocols, ["realtime", "openai-insecure-api-key.secret"]);
});

test("subprotocolo beta mantém o marcador legado", () => {
	assert.ok(buildSubprotocols("secret", "beta").includes("openai-beta.realtime-v1"));
});
