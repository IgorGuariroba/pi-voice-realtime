# Contribuindo

Obrigado por ajudar. Este pacote é **alpha** e **Linux-only** no caminho ativo.

## Antes de começar

Para mudanças maiores que um bug pequeno, abra uma issue antes de escrever código. Isso evita trabalho descartado.

## Rodar os testes

Requer Node 24 (ou 22.6+ com `--experimental-strip-types`).

```bash
npm install
npm run test:unit        # bloqueante no CI
npm test                 # inclui integração (pendente, ver abaixo)
```

Os testes de integração ainda não rodam contra o código atual: esperam injeção de dependências em `index.ts` que não existe. Contribuições que implementem esse seam são bem-vindas.

## Padrão de commits

[Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `chore:`.

## Pull requests

- Um assunto por PR.
- O CI de testes unitários precisa passar.
- Mudanças de áudio ou de protocolo realtime precisam explicar como foram verificadas. Testes simulados não provam áudio audível.
- Nunca commite `voice.json`, `auth.json`, arquivos de ambiente ou chaves de API.

## Segurança

Não abra issue pública para vulnerabilidades. Veja [SECURITY.md](SECURITY.md).

## Licença

Ao contribuir, você concorda que sua contribuição é licenciada sob MIT.
