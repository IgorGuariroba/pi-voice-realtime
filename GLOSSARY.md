# Glossário — /voice

**Sessão realtime**: conexão com o modelo de voz (`/v1/realtime`, protocolo V2 do Codex). Fala, escuta e decide quando delegar.

**Modelo de voz**: o modelo realtime. Conversa com o usuário e, para qualquer trabalho, chama `background_agent`. Não executa ferramentas de código.

**Agente**: o turno normal do pi, com as mesmas ferramentas, sandbox e permissões da sessão.

**background_agent**: ferramenta do modelo de voz que envia o pedido do usuário ao agente, sem reescrevê-lo. Ocioso, inicia tarefa; ocupado, faz steer.

**remain_silent**: ferramenta do modelo de voz para não falar (ex.: após mensagens de controle).

**Handoff**: uma chamada `background_agent` do início até a conclusão do run do agente.

**Steer**: nova instrução enviada à tarefa em execução. A chamada original continua até o fim; a nova recebe só o ack.

**Envelope de delegação**: `<realtime_delegation><input>…</input></realtime_delegation>`, o texto que o agente recebe como turno.

**[BACKEND]**: prefixo de item do modelo de voz com progresso ou resultado do agente. O modelo lê como mensagem de usuário, distinguível pelo prefixo.

**[USER]**: prefixo de fala consolidada no histórico do agente. Entra no contexto sem disparar turno.

**Contexto de início**: turnos recentes do ramo do pi e diretório de trabalho, enviados como instruções da sessão (orçamento de 5 300 tokens).

**Fila de response.create**: no máximo uma resposta do modelo por vez; pedidos enquanto há resposta ativa esperam o `response.done`.

**Truncate**: `conversation.item.truncate` enviado no barge-in, com o tempo de áudio já emitido.

**Voice owner**: a sessão do pi onde o `/voice` foi iniciado. Não acompanha mudanças de foco. (Codex: thread dona da voz.)

*Obsoleto*: "ouvido", "boca", "transcrição só como entrada", "síntese de voz", "resumo falado" (ADR 0001).
