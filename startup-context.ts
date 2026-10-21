/**
 * Contexto de inicialização da sessão realtime (`core/src/realtime_context.rs`).
 *
 * O Codex monta, ao iniciar, os turnos recentes da thread e o workspace, com
 * orçamento de 5 300 tokens. Aqui a "thread" é o ramo ativo da sessão do pi.
 * Tokens são estimados por caracteres / 4, como no Codex (`approx_token_count`).
 */

export const STARTUP_CONTEXT_TOKEN_BUDGET = 5_300;
/** Teto por turno (`REALTIME_TURN_TOKEN_BUDGET` no Codex). */
export const TURN_TOKEN_BUDGET = 400;

export interface BranchEntry {
	type: string;
	message?: { role?: string; content?: unknown };
}

const approxTokens = (text: string) => Math.ceil(text.length / 4);

function truncateToTokens(text: string, budget: number): string {
	const max = budget * 4;
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

/** Turnos user/assistant do ramo, do mais antigo ao mais recente, sem blocos de ferramenta. */
export function recentTurns(branch: readonly BranchEntry[]): Array<{ role: "USER" | "ASSISTANT"; text: string }> {
	const turns: Array<{ role: "USER" | "ASSISTANT"; text: string }> = [];
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = textOf(entry.message?.content);
		if (!text) continue;
		turns.push({ role: role === "user" ? "USER" : "ASSISTANT", text });
	}
	return turns;
}

/**
 * Monta o bloco de contexto. Preenche do turno mais recente para trás até o
 * orçamento; depois renderiza em ordem cronológica.
 */
export function buildStartupContext(
	branch: readonly BranchEntry[],
	cwd: string,
	budget = STARTUP_CONTEXT_TOKEN_BUDGET,
): string {
	const header = [
		"Contexto desta sessão de voz (montado ao iniciar a conversa a partir dos turnos recentes do agente e do diretório de trabalho).",
		`Diretório de trabalho: ${cwd}`,
	];
	let remaining = budget - approxTokens(header.join("\n"));
	const picked: string[] = [];
	const turns = recentTurns(branch);
	for (let i = turns.length - 1; i >= 0 && remaining > 0; i--) {
		const turn = turns[i];
		const line = `[${turn.role}] ${truncateToTokens(turn.text, Math.min(TURN_TOKEN_BUDGET, remaining))}`;
		const cost = approxTokens(line);
		if (cost > remaining) break;
		picked.push(line);
		remaining -= cost;
	}
	if (picked.length === 0) return header.join("\n");
	return [...header, "Turnos recentes (do mais antigo ao mais recente):", ...picked.reverse()].join("\n");
}
