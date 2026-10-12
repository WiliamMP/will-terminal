<p align="center">
  <img src="public/icon.svg" width="96" alt="will-terminal" />
</p>

<h1 align="center">will-terminal</h1>

<p align="center">Terminal com abas e painéis estilo tmux, feito com Tauri, React e Rust.</p>

## Funcionalidades

- Abas e painéis divididos, redimensionáveis com o mouse
- Teclas do tmux: prefixo `Ctrl+B`, depois `%` `"` `c` `x` `z` `n` `p` `o`, setas e `1-9` (`Ctrl+B ?` mostra todas)
- PowerShell, PowerShell 7, cmd ou Git Bash (escolha na barra de status)
- Painel e aba novos abrem na pasta do painel atual
- Renomear aba: duplo clique ou `Ctrl+B ,`
- `Ctrl+C` com texto selecionado copia, `Ctrl+V` cola; botão direito copia a seleção ou cola
- `Ctrl+clique` em links abre no navegador
- `Ctrl +`, `Ctrl -` e `Ctrl 0` mudam o tamanho da fonte
- Tema claro e escuro, seguindo o sistema

## Como rodar

```bash
npm install
npm run tauri dev
```

Instalador: `npm run tauri build` (fica em `src-tauri/target/release/bundle/`).

## Licença

[MIT](LICENSE)
