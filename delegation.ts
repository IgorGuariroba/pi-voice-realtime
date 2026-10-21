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

/** Origem do turno delegado (`RealtimeDelegationSource` do Codex). */
export type DelegationSource = "handoff" | "transcript_tail_flush";

/** Monta o turno delegado a partir da fala do usuário (`context/realtime_delegation.rs`). */
export function wrapDelegation(input: string, transcriptDelta?: string, source: DelegationSource = "handoff"): string {
	const lines = [OPEN_TAG];
	if (source === "transcript_tail_flush") lines.push("  <source>transcript_tail_flush</source>");
	lines.push(`  <input>${escapeXml(input.trim())}</input>`);
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

/** Retorno de `background_agent` quando a tarefa termina (V2, `REALTIME_V2_HANDOFF_COMPLETE_ACKNOWLEDGEMENT`). */
export const HANDOFF_COMPLETE_ACK = "Background agent finished. Use the preceding [BACKEND] messages as the result.";

/** Retorno de `background_agent` quando o pedido vira steer de tarefa ativa (`REALTIME_V2_STEER_ACKNOWLEDGEMENT`). */
export const STEER_ACK = "This was sent to steer the previous background agent task.";
