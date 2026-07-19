# Aether Launcher

> O jogador instala, clica em **Jogar**, e o Minecraft abre sincronizado com o
> servidor. Sem baixar zip, sem arrastar mod para pasta, sem "apaga tudo e baixa
> de novo".

Cliente desktop do [Aether Platform](https://github.com/EduPDX/aether). O painel
de administração vive naquele repositório; aqui é só o lado do jogador.

---

## O problema

Todo servidor de Minecraft modado tem o mesmo ritual: o dono muda um mod, manda
um zip no grupo, e metade dos jogadores erra a pasta, esquece de apagar o mod
antigo ou baixa a versão errada. Aí o jogo crasha e alguém passa a noite
descobrindo por quê.

O Aether Launcher troca isso por um botão. O servidor publica o que deve estar
na máquina do jogador; o launcher compara com o que já existe lá e baixa só a
diferença.

## O que ele faz

1. **Sincroniza os mods** — compara SHA-256 arquivo por arquivo e baixa só o que
   mudou. Em pastas marcadas como gerenciadas, remove o que sobrou de versões
   antigas; fora delas não apaga nada do jogador.
2. **Instala o Java** — detecta se falta e busca o Temurin pela API da Adoptium.
3. **Instala o Forge** — roda o instalador oficial quando a versão pedida não
   está presente.
4. **Abre o jogo** — monta o classpath, extrai os natives, resolve os argumentos
   e inicia o Minecraft já pronto para entrar no servidor.
5. **Captura o log** — se o jogo morre nos primeiros segundos, o erro aparece na
   tela em vez de a janela sumir sem explicação.

## Segurança

O manifesto que diz o que baixar é **assinado com Ed25519** pelo servidor e
verificado antes de qualquer download. Isso não é enfeite: sem a assinatura,
quem controlasse a rede entre o jogador e o servidor entregaria um `.jar`
arbitrário — e o launcher o executaria na máquina dele.

Cada arquivo baixado também é conferido por hash antes de entrar na pasta.

## Como usar

Na primeira vez o launcher pede quatro coisas:

| Campo | De onde vem |
|---|---|
| Endereço do servidor | o dono passa (ex.: `http://192.168.1.10:8600`) |
| Código do perfil | o dono copia do painel, na aba **Sync** |
| Nome do jogador | o nick que aparece no jogo |
| Pasta do jogo | normalmente `%APPDATA%\.minecraft` |

Depois disso é só clicar em **Jogar**.

> **Aviso conhecido:** o executável ainda não é assinado digitalmente, e o
> Windows Defender pode colocá-lo em quarentena como falso positivo
> (`Trojan:Win32/Bearfoos.A!ml`). Isso acontece porque ele é não assinado, baixa
> arquivos e inicia processos — o mesmo padrão de comportamento de um malware.
> Enquanto não há certificado, a saída é restaurar o arquivo manualmente ou
> compilar a partir do código.

## Desenvolvimento

Requisitos: Node 20+, pnpm, Rust estável e as
[dependências do Tauri](https://tauri.app/start/prerequisites/) do seu sistema.

```bash
pnpm install
pnpm tauri dev      # app com hot reload
pnpm tauri build    # executável em src-tauri/target/release
```

```bash
cd src-tauri
cargo test                    # testes do núcleo
cargo clippy -- -D warnings
```

### Como está organizado

O front (`src/`) é uma tela fina: mostra progresso e chama comandos Tauri. Toda
a lógica está em Rust:

| Módulo | Responsabilidade |
|---|---|
| `lib.rs` | Comandos expostos ao front e chamadas HTTP ao servidor |
| `sync.rs` | Verifica a assinatura, compara hashes e monta o plano de download |
| `java.rs` | Detecta e instala o Temurin |
| `minecraft.rs` | Classpath, natives, argumentos e instalador do Forge |
| `play.rs` | Orquestra o pipeline e captura o log do jogo |

### Contrato com o servidor

O launcher depende de **três endpoints públicos** e de nada mais:

```
GET /api/v1/public/sync/{profile_id}         → manifesto assinado
GET /api/v1/public/sync/{profile_id}/file    → download de um arquivo
GET /api/v1/public/instances/{id}/status     → status do servidor
```

Essa é a fronteira entre os dois repositórios. Mudar o formato deles quebra
launchers já instalados — que, ao contrário do servidor, não se atualizam
sozinhos.

## Limitações atuais

- **Só modo offline.** Não há login Microsoft; serve para servidor com
  `online-mode=false`.
- **Sem assinatura de código** — ver o aviso acima.
- **Só Windows testado.** O Tauri compila para Linux e macOS, mas o caminho de
  launch do Minecraft não foi exercitado nesses sistemas.
