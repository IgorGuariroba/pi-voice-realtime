/**
 * Ponte voz ↔ agente: o mesmo contrato de texto que o Codex usa no handoff.
 *
 * Entrada do turno delegado (Codex: `realtime_conversation.rs`):
 *   <realtime_delegation>
 *     <input>pedido</input>
 *     <transcript_delta>…</transcript_delta>
 *   </realtime_delegation>
 */

import type { TextContent } from "@earendil-works/pi-ai";

const OPEN_TAG = "<realtime_delegation>";
const CLOSE_TAG = "</realtime_delegation>";

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeXml(text: string): string {
	return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Monta o turno delegado a partir da fala do usuário. */
export function wrapDelegation(input: string, transcriptDelta?: string): string {
	const lines = [OPEN_TAG, `  <input>${escapeXml(input.trim())}</input>`];
	if (transcriptDelta?.trim()) {
		lines.push(`  <transcript_delta>${escapeXml(transcriptDelta.trim())}</transcript_delta>`);
	}
	lines.push(CLOSE_TAG);
	return lines.join("\n");
}

/** Extrai o pedido de um turno delegado; `undefined` se não for delegação. */
export function unwrapDelegation(text: string): string | undefined {
	const body = text.trim();
	if (!body.startsWith(OPEN_TAG) || !body.endsWith(CLOSE_TAG)) return undefined;
	const match = body.match(/<input>([\s\S]*?)<\/input>/);
	if (!match) return undefined;
	return unescapeXml(match[1]).trim();
}

/** Trecho do transcript que acompanha a delegação (opcional). */
export function delegationTranscript(text: string): string | undefined {
	const match = text.match(/<transcript_delta>([\s\S]*?)<\/transcript_delta>/);
	if (!match) return undefined;
	return unescapeXml(match[1]).trim() || undefined;
}

/**
 * Último texto do assistente de um run, ignorando blocos de raciocínio.
 * Equivale ao `MessagePhase::FinalAnswer` que o Codex fala: reasoning e
 * commentary nunca são lidos em voz alta.
 */
export function finalAnswerText(
	messages: readonly { role: string; content: unknown }[],
): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const content = message.content;
		if (typeof content === "string") return content.trim() || undefined;
		if (!Array.isArray(content)) return undefined;
		const text = content
			.filter((block): block is TextContent => (block as TextContent)?.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		return text || undefined;
	}
	return undefined;
}

/** Prefixo que o Codex usa ao devolver o resultado para a sessão de voz. */
export function backendHeader(kind: "final" | "decision"): string {
	return kind === "final" ? "[BACKEND] Agent Final Message:\n\n" : "[BACKEND] Agent needs a decision:\n\n";
}
