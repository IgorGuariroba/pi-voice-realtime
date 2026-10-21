# Plano — voz como canal da sessão do pi

Decisões de referência: `docs/adr/0001-sessao-pi-unica-cabeca.md` e `GLOSSARY.md`. Este plano não implementa nada ainda.

## Fronteira técnica

- **Entrada:** transcrição consolidada → mensagem de usuário na sessão do pi (`steer` se houver execução em curso).
- **Saída:** texto produzido pelo pi → síntese → reprodução. A voz nunca gera conteúdo.
- O realtime não recebe autorização para responder por conta própria: a sessão de voz só transcreve, e a síntese recebe apenas texto do pi.

## Estados de reprodução (novo)

Cada fala sintetizada tem um registro com um destes estados:

| Estado | Significado |
|---|---|
| `pendente` | texto recebido, áudio ainda não começou |
| `reproduzindo` | áudio em andamento |
| `concluída (estimada)` | o timer indica que o áudio terminou sem interrupção. Não significa que o usuário ouviu |
| `interrompida` | usuário falou ou `/voice stop` cortou o áudio; registrar a fração estimada ouvida |

Regra: `concluída` significa reprodução concluída, não compreensão ou escuta comprovada. Até existir um evento confiável do player, o timer registra conclusão estimada. O pi só pode presumir que uma explicação foi *reproduzida* com o estado `concluída (estimada)`, nunca que foi ouvida. Significado de `concluída (estimada)`: estima-se que o áudio terminou de tocar; esse término não é observado. Em `interrompida`, o pi recebe a informação no histórico como "resposta interrompida em ~X%" e pode reapresentar o restante por texto ou voz.

Limite técnico: o `Player` não recebe confirmação de quanto foi ouvido. Hoje o fim é inferido por timer (`index.ts:105`). A fração de `interrompida` será estimada a partir do PCM enviado e do tempo decorrido, e deve ser marcada como estimativa.

## Histórico: equivalente, não idêntico

Critério: voz e digitação preservam **conteúdo, ordem e referências**. Podem diferir em pontuação, capitalização e metadados de origem (`origem: voz`, timestamps). Não é exigida igualdade byte a byte.

## Ordem de implementação

1. **Testes de aceitação** (antes de qualquer código de produção).
2. **Estados de reprodução e registro de interrupção**, com síntese simulada.
3. **Transcrição só como entrada** (sem geração de resposta pelo realtime).
4. **Síntese** a partir de texto do pi. Primeiro com Kokoro local; TTS da API somente se a prova de Kokoro falhar.
5. **Resumo falado** gerado pelo pi na mesma execução da resposta visual.

## Testes de aceitação

**T1 — Equivalência de histórico.** Mesma sequência de conversa por voz e por digitação ("explica X", depois "corrige isso"). Verificar que o histórico do pi tem o mesmo conteúdo, ordem e referências; que a segunda mensagem resolve o referente; e que a origem (voz/texto) está marcada.

**T2 — Steer durante execução.** Pi em execução longa. Começar a falar deve:
- interromper o áudio em reprodução;
- enviar a transcrição consolidada como `steer`;
- **não** cancelar a execução;
- registrar a resposta anterior como `interrompida`.

Esse teste protege a distinção mais delicada do desenho.

**T3 — Estado de reprodução.** Resposta curta falada até o fim → `concluída (estimada)` (o teste não prova escuta). Mesma resposta interrompida no meio → `interrompida` com fração > 0 e < 100%. Verificar o texto recebido pela síntese simulada e os eventos de reprodução.

**T4 — Sem autonomia conversacional.** Entrada que não é pedido ("oi", "tudo bem?") gera apenas transcrição e passa pelo pi; a síntese só fala texto fornecido pelo pi. Nenhuma saída de áudio origina no realtime.

**T5 — Fronteira de decisão.** Pedido de aprovação do pi: a voz avisa; "sim" falado não autoriza nada (nenhuma aprovação é enviada).

## Critério de Kokoro (prova antes de adotar)

A prova usa o script existente (`~/.pi/agent/voz/kokoro_speak.py`), ainda não inspecionado em detalhe além da leitura do código:

- **Qualidade em pt-BR:** amostra avaliada por você, com frases do próprio uso.
- **Tempo até começar a falar:** medido a partir da chamada, com o modelo carregado e com carga a frio. O script atual recarrega o modelo a cada invocação, o que tende a ser o gargalo. Se medir alto, a alternativa é um processo persistente.
- **Interrupção:** meta inicial de 20 ms, com medição explicitada. Dois intervalos separados: (a) da detecção de fala até a chamada de `Player.stop()`; (b) da detecção até o som cessar de fato, medido por captura de saída. O intervalo (a) não prova que o som parou, porque buffers do driver podem continuar tocando após matar o processo. Só (b) comprova a meta.

Medir separadamente partida fria (primeira chamada, com carregamento do modelo) e chamadas com o modelo já carregado. Um processo persistente só se justifica se o carregamento dominar a latência **e** a qualidade for suficiente; o custo de memória também precisa ser validado.

Nem toda falha aponta para trocar de TTS, porque cada problema tem uma origem diferente:
- **Qualidade em português:** sintetizador (modelo, fonemas do g2p).
- **Demora:** carregamento (partida fria) ou processamento por chunk.
- **Interrupção lenta ou áudio que continua:** player (buffers, matar o processo).

Trocar para API pode preservar o problema de reprodução, que não depende do sintetizador. Diagnosticar a origem antes de trocar.

## Fora do escopo

- Escolha final de TTS (depende da prova acima).
- Confirmação de aprovações por voz.
- Otimização de latência antes de medir.
