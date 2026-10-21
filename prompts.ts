/**
 * Prompts realtime copiados verbatim do Codex (`codex-rs/prompts/templates/realtime/`).
 * Mesmo texto = mesma política de delegação. Atualizar junto com o submódulo do Codex.
 */
import { readFileSync } from "node:fs";

const read = (name: string) => readFileSync(new URL(`./prompts/${name}`, import.meta.url), "utf8").trim();

/** Política do modelo de voz (backend_prompt.md). `{{ user_first_name }}` é substituído. */
export function backendPrompt(userFirstName = "there"): string {
	return read("backend.md").replace("{{ user_first_name }}", userFirstName);
}

/** Developer message ao iniciar a conversa (realtime_start.md). */
export const START_INSTRUCTIONS = read("start.md");

/** Developer message ao encerrar (realtime_end.md). */
export const END_INSTRUCTIONS = read("end.md");
