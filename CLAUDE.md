# will-terminal

Multiplexador de terminal para Windows (estilo tmux), tema **Neon**. Tauri 2 + Rust no backend, React 19 + TypeScript + Tailwind v4 na interface. Mesma base do will-notes e o terminal do will-repo.

O dono vem do **Delphi** e está aprendendo Rust e React: ao explicar código novo, dê uma analogia curta com Delphi/Pascal. Responda em **português**.

## Arquitetura

- `src-tauri/src/pty.rs`: shells reais em ConPTY (portable-pty), copiado do will-repo. Saída vai por eventos `pty-output` / `pty-exit`. Integração com o shell: o prompt de cada um emite OSC 133;D;<código> (fim do comando) e OSC 9;9;<pasta>; testes com shells reais.
- `src-tauri/src/lib.rs`: registro dos comandos (**comando novo precisa entrar aqui**), ícone na bandeja e single-instance. Fechar a janela só a esconde (detach); os shells continuam no mesmo processo. "Sair" na bandeja emite `quit-requested`, a janela salva o layout e chama `exit_app`.
- `src/panes.ts`: árvore de painéis de uma aba (funções puras: `split`, `remove`, `leaves`, `neighbor`). Testes em `panes.test.ts`.
- `src/session.ts`: sessões xterm.js vivem num `Map` fora do React. Dividir um painel remonta o componente; se ele fosse dono do shell, o shell morreria. O componente `Leaf` só pega emprestado o `el`.
- `src/App.tsx`: abas, prefixo (teclas do tmux), modo cópia, sincronizar, salvar/restaurar layout, lista de comandos da paleta.
- `src/updater.ts`: atualizador (igual ao will-repo). Chave em `~/.tauri/will-terminal.key`; pública em `tauri.conf.json`.
- Perfis (`Profile` em `components/Settings.tsx`): `layoutTree` em `panes.ts` monta os painéis com tamanhos iguais (`size` no split).
- `src/commands.ts`: tipo `Command` e busca da paleta (mesmas regras do will-repo).
- `src/components/`: `Palette`, `SearchBar`, `Settings`, `WindowControls`, `ui`.
- Preferências e layout ficam em `localStorage` (`will-terminal.*`). O layout é salvo ao fechar a janela; fechar o último painel apaga o layout.

## Convenções

- Interface em **português**; código, nomes e comentários em **inglês**.
- Ícones só do **lucide-react**. Tokens Neon em `src/index.css` (igual aos outros apps).
- Atalhos deliberados levam um comentário `ponytail:` com o limite e o caminho de melhoria.

## Testes

```bash
cd src-tauri && cargo test   # pty real
npm test                     # Vitest
npx tsc --noEmit -p .
```

CI em `.github/workflows/ci.yml`; release por tag `v*` em `release.yml`.
