# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## O que é

Launcher desktop do **Aether Platform**: o jogador instala, escolhe o perfil do
servidor, clica em Jogar e o launcher sincroniza os mods, instala o Java e o
Forge se preciso, e abre o Minecraft. Substitui "baixe este zip e coloque na
pasta mods".

O painel de administração vive em outro repositório (**EduPDX/aether**). Este
aqui é só o cliente.

## Comandos

```bash
pnpm install                 # dependências do front (Vite + React)
pnpm tauri dev               # roda o app com hot reload
pnpm tauri build             # gera o executável em src-tauri/target/release

cd src-tauri
cargo test                   # testes do núcleo Rust (16 testes)
cargo test sync::            # só um módulo
cargo clippy -- -D warnings  # lint
cargo fmt
```

`pnpm build` compila só o front; o executável de verdade sai de `pnpm tauri build`.

## Arquitetura

O front (`src/`) é uma tela fina: mostra progresso e chama comandos Tauri. Toda
a lógica está no Rust (`src-tauri/src/`), um módulo por responsabilidade:

| Módulo | Responsabilidade |
|---|---|
| `lib.rs` | Comandos Tauri expostos ao front e chamadas HTTP ao Core |
| `sync.rs` | Verificação do manifesto assinado, diff por SHA-256, plano de download |
| `java.rs` | Detecta e instala o Temurin pela API da Adoptium |
| `minecraft.rs` | Monta o classpath, extrai natives, resolve argumentos, roda o instalador do Forge |
| `play.rs` | Orquestra o pipeline completo e captura o log do jogo |

### Contrato com o Core

O launcher depende de **três endpoints públicos** e de nada mais. Essa é a
fronteira entre os dois repositórios — mudar o formato de qualquer um deles
quebra clientes já instalados:

```
GET /api/v1/public/sync/{profile_id}         → manifesto assinado
GET /api/v1/public/sync/{profile_id}/file    → download de um arquivo do manifesto
GET /api/v1/public/instances/{id}/status     → status do servidor
```

### Sincronização

O manifesto é assinado com **Ed25519** e verificado contra o JSON canônico antes
de qualquer download — sem isso, quem controlasse a rede entregaria um `.jar`
arbitrário que o launcher executaria na máquina do jogador.

Cada entrada tem `path` (destino no PC do jogador) **e** `source` (origem no
servidor). Os dois existem porque o perfil de cliente mora em
`aether-client/mods/` no servidor e precisa chegar em `mods/` no cliente.
Diretórios marcados como `managed` têm os arquivos extras removidos; fora deles
o launcher não apaga nada do jogador.

## Armadilhas que já custaram caro

Estas estão cobertas por teste. Se um teste aqui falhar, leia o histórico do
commit antes de "consertar" a asserção:

- **Dedupe de bibliotecas inclui o classificador.** Colapsar `lwjgl-3.3.1.jar`
  com `lwjgl-3.3.1-natives-windows.jar` descarta os natives e o jogo morre com
  `UnsatisfiedLinkError: lwjgl.dll`.
- **O jar do cliente precisa ter o nome da versão lançada.** O Forge passa
  `-DignoreList=...,${version_name}.jar`; com outro nome o jogo quebra com
  `ResolutionException: Module minecraft contains package net.minecraft.obfuscate`.
- **Natives precisam ser extraídos**, não só estar no classpath.

## Estado atual

Funciona ponta a ponta: sincroniza, instala Java e Forge, abre o jogo e entra
no servidor. Duas limitações conhecidas:

- **Sem login Microsoft** — só modo offline (`offline_uuid`). Serve para
  servidor com `online-mode=false`.
- **Sem assinatura de código** — o Windows Defender põe o executável em
  quarentena como falso positivo (`Trojan:Win32/Bearfoos.A!ml`), porque ele é
  não assinado, baixa executáveis e cria processos. É o que impede distribuir
  para os jogadores hoje. Caminho gratuito: submeter o arquivo à Microsoft como
  falso positivo. Caminho definitivo: certificado OV.
