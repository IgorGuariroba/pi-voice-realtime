# Política de segurança

A extensão manipula credenciais da OpenAI (`OPENAI_API_KEY`, `auth.json`) e áudio do microfone.

## Reportar uma vulnerabilidade

**Não abra issue pública.** Use o aviso privado de segurança do GitHub deste repositório (aba *Security* → *Report a vulnerability*).

Inclua: versão do pacote, passos para reproduzir e impacto esperado.

## Escopo

Dentro do escopo: vazamento de credenciais, execução de comandos via configuração, gravação de áudio sem indicação ao usuário.

Fora do escopo: problemas no pi, na API Realtime da OpenAI ou no PipeWire — reporte a eles diretamente.
