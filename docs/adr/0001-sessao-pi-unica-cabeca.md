# ADR 0001 — A sessão do pi é a única cabeça da conversa de voz

**Status:** superada pela ADR 0002 (paridade com o `/voice` do Codex). Mantida como histórico.

## Contexto

O `/voice` usava um modelo realtime com instruções próprias, que respondia sozinho e não via a sessão do pi. Resultado: perda de contexto ("corrige isso" sem referente), respostas divergentes do agente e fala fora do histórico.

## Decisão

- A sessão do pi concentra contexto, decisões e execução.
- A voz transporta: transcreve a entrada e sintetiza a saída a partir de texto fornecido pelo pi.
- Toda fala consolidada entra na sessão como mensagem de voz (`steer` quando há execução em curso).
- O resumo falado é gerado pelo pi junto da resposta visual.
- Decisões pendentes continuam no terminal; a voz só avisa.

## Consequências

- Latência por turno sobe: cada fala passa pelo agente. Medir antes de otimizar.
- A fronteira "só boca" não pode depender apenas de prompt. A transcrição e a síntese devem ser serviços separados, ou a integração deve controlar quando o realtime emite áudio e qual conteúdo fala.
- Exige registrar, no histórico, quais respostas já foram faladas em áudio.

## Alternativas consideradas

- **Voz com cérebro próprio** (estado atual): rápida em conversa simples, mas diverge do agente. Rejeitada.
- **Voz só para ditado** (transcreve e digita): sem respostas faladas. Rejeitada por não atender ao uso desejado.

## Critério de sucesso

Alternar entre falar e digitar preserva a mesma conversa e as mesmas decisões. Após "corrige isso", a sessão tem o referente e a instrução, e sabe qual resposta já foi falada.
