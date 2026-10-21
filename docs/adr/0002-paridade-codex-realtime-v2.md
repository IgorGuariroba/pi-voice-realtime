# ADR 0002 — Paridade com o `/voice` do Codex (realtime V2, duplo agente)

**Status:** proposta. Substitui a ADR 0001.
**Referência:** `codex-rs` em `/home/movida/projetos/codex` (commit `c419fd01a7`).

## Contexto

A ADR 0001 pôs o modelo de voz só como "ouvido" e "boca": ele não respondia nem delegava, e a fala era síntese de texto do pi. Essa escolha divergia do Codex, que é a referência adotada. A regra desta ADR: decisões do Codex prevalecem, salvo quando forem incompatíveis com o pi ou com a linguagem (Node/TypeScript).

## Decisão

Replicar a sessão realtime **V2** do Codex (default `RealtimeConversationVersion::V2`), com transporte WebSocket.

### 1. Sessão realtime (`session.update`)

Fonte: `codex-api/src/endpoint/realtime_websocket/methods_v2.rs`.

- `output_modalities: ["audio"]`.
- Entrada: PCM 24 kHz, `noise_reduction: near_field`, transcrição `gpt-4o-mini-transcribe`.
- VAD `server_vad` com `interrupt_response: true`, **`create_response: true`**, `silence_duration_ms: 500`.
- `tool_choice: "auto"`.
- Voz default V2: `marin` (`protocol/src/protocol.rs:408`).
- Modelo default: `gpt-realtime-1.5` (`core/src/realtime_conversation.rs:112`).

**Diverge do estado atual:** `create_response: false` e instruções de "só ouvido" saem.

### 2. Instruções

- `instructions` = `backend_prompt.md` (identidade, política "delegue tudo", prefixos `[USER]`/`[BACKEND]`) + contexto de inicialização (`realtime_context.rs`, orçamento 5 300 tokens).
- Ao iniciar, developer message com `realtime_start.md` ("Realtime conversation started…"). Ao encerrar, `realtime_end.md`.
- O prompt diz explicitamente que trabalho passa pelo backend e nunca é recusado. Toda a política de delegação vem daí, não de código.

### 3. Ferramentas

| Codex | Função |
|---|---|
| `background_agent(prompt)` | Ação padrão. Envia a fala do usuário (sem reescrever) ao agente. Se ocioso, inicia tarefa; se ocupado, faz *steer*. |
| `remain_silent()` | Não falar após mensagens de controle ou atualizações silenciosas. |

Substitui `delegate_to_pi`.

### 4. Ciclo do handoff (V2)

Fonte: `realtime_conversation.rs` (`handle_handoff_output`, `RealtimeEventParser::RealtimeV2`).

- **Início:** `background_agent` vira turno com `<realtime_delegation><input>…</input><transcript_delta>…</transcript_delta></realtime_delegation>`. O `transcript_delta` são os turnos desde o último handoff.
- **Progresso:** cada saída do agente vai como item `user` com prefixo `[BACKEND] `.
- **Conclusão:** `function_call_output` com `"Background agent finished. Use the preceding [BACKEND] messages as the result."`, seguido de `response.create`.
- **Steer (agente ocupado):** nova chamada recebe `function_call_output` `"This was sent to steer the previous background agent task."` e `response.create`.
- **Fila de `response.create`:** só uma resposta ativa por vez (`RealtimeResponseCreateQueue`).
- **Não falar o raciocínio:** só a resposta final é falada; canais de commentary vêm do BEM (ver lacunas).

**Diverge do estado atual:** hoje a resposta vira `[BACKEND] Agent Final Message` sem `function_call_output`. Sem o output da chamada, a API não fecha o ciclo da tool.

### 5. Barge-in

Codex: ao `input_audio_buffer.speech_started`, envia `conversation.item.truncate` com `audio_end_ms` do que já tocou (`ResponseCancelled`/`OutputAudioState`). Não é só `response.cancel` + corte local.

### 6. Persistência e histórico

- Codex grava `RealtimeItem` no rollout: `RealtimeSessionStarted`, `TranscriptSegment{role,text}`, `BemItemPromoted`, `RealtimeSessionClosed{outcome}` (`protocol/src/realtime.rs`).
- Transcrição de fala é registrada também no **histórico do modelo** (`realtime_history.rs`, `transcript_tail.rs`). Diverge do README atual ("fora do contexto"), que fica revogado.
- No fim da sessão, o trecho de transcrição não consumido vai ao Codex como `<realtime_delegation>` com `<source>transcript_tail_flush</source>`.

### 7. Limites de tamanho

Codex trunca: 4 KiB por campo de delegação; 1 000 tokens de saída do agente; 8 192 tokens para itens iniciais; 128 itens. Adotar os mesmos valores.

## Lacunas e como fechar

| # | Lacuna | Fonte Codex | Fechamento |
|---|---|---|---|
| L1 | Modelo não responde (`create_response: false`) | `methods_v2.rs` | Mudar para `true`; política no prompt. |
| L2 | Instruções de "ouvido" | `prompts/templates/realtime/*.md` | Usar `backend_prompt.md` e `realtime_start.md`. |
| L3 | Tool `delegate_to_pi` | `background_agent`, `remain_silent` | Renomear; adicionar `remain_silent`. |
| L4 | Sem `function_call_output` / `response.create` | `handle_handoff_output` | Enviar nos três casos (conclusão, steer, silêncio). |
| L5 | Sem fila de `response.create` | `RealtimeResponseCreateQueue` | Portar a fila. |
| L6 | Barge-in sem truncate | `OutputAudioState` | Rastrear `item_id` e `audio_end_ms`. |
| L7 | Transcrição fora do contexto do modelo | `realtime_history.rs` | Gravar no histórico do pi e no contexto. |
| L8 | Sem transcript tail flush | `transcript_tail.rs` | Enviar resto ao encerrar. |
| L9 | Sem startup context | `realtime_context.rs` | Montar: turnos recentes da sessão + cwd. |
| L10 | Sem commentary/BEM | `bem.rs` | Fase FinalAnswer obrigatória; commentary não falado. |
| L11 | Sem reconexão | `tui/src/app/reconnect.rs` | Portar após o fluxo básico. |
| L12 | Sem steer em tarefa ativa | `REALTIME_V2_STEER_ACKNOWLEDGEMENT` | `deliverAs: steer` + ack. |
| L13 | Modelo default `gpt-realtime` | `realtime_conversation.rs:112` | Trocar para `gpt-realtime-1.5`. |

## Desvios justificados (pi / linguagem)

- **Transporte WebSocket, não WebRTC.** O Codex suporta `transport = "websocket"` (`config_toml.rs`). Node não tem WebRTC nativo com Opus/AEC equivalente ao helper `voice-host`. Revisitar se a medição acústica falhar.
- **Captura e AEC por PipeWire** (`parec`/`pacat` + `module-echo-cancel`), não `voice-host`. Só Linux, como já declarado.
- **Sem voice owner entre threads.** O pi tem uma sessão ativa por `/voice`; `background_voice` fica fora do escopo.
- **Persistência via `pi.appendEntry`** em vez de rollout do Codex.

## Consequências

- Muda o papel da voz: o modelo conversa e delega. A ADR 0001 é superada, e o trabalho em andamento de TTS/ponte (`speech.ts`, `bridge.ts`, `docs/plano-implementacao.md`) deixa de ser o caminho.
- Latência de conversa simples cai. Risco: o modelo responder algo que deveria ir ao agente. A política do prompt é o controle; deve ser testada.
- Muda `GLOSSARY.md` (termos: `background_agent`, handoff, steer, `[BACKEND]`).

## Critério de sucesso

1. Pedido de código sai como `background_agent` com `<realtime_delegation>` e volta com `function_call_output` + resposta falada.
2. Fala durante execução gera `steer` com ack, sem cancelar a execução.
3. Fala interrompida corta o áudio e registra `conversation.item.truncate`.
4. Transcrição aparece no histórico do pi e no contexto do modelo.
5. Fim de sessão envia `transcript_tail_flush`.
