# Glossário — /voice

**Sessão do pi**: o agente. Concentra contexto, decisões, ferramentas e guardas. É a única cabeça da conversa.

**Voz**: o canal de entrada e saída de áudio. Não raciocina nem decide.

**Transcrição**: converte a fala do usuário em texto. Só a transcrição consolidada vira mensagem; parciais ficam apenas na interface.

**Síntese de voz**: converte em áudio um texto fornecido pela sessão do pi. Não reformula, não responde.

**Mensagem de voz**: mensagem de usuário na sessão do pi, originada de uma transcrição consolidada e marcada como voz.

**Resumo falado**: texto curto (1 a 3 frases) produzido pela sessão do pi junto da resposta visual, lido pela síntese de voz.

**Steer**: injeção de uma instrução na execução em curso. Falar interrompe a reprodução de áudio, mas não cancela a execução; cancelar exige instrução explícita.

**Decisão pendente**: pedido de aprovação do pi no terminal. A voz apenas avisa; não interpreta "sim" como autorização.

**Sessão em que a voz foi iniciada**: a voz fica presa à sessão do pi onde foi aberta. Não acompanha mudanças de foco.

*Obsoleto*: "modelo realtime" descreve a implementação atual, não a responsabilidade. Use "transcrição" e "síntese de voz".
