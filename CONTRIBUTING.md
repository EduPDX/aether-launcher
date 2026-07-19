# Contribuindo

## Preparar o ambiente

Requisitos: Node 20+, pnpm, Rust estável e as
[dependências do Tauri](https://tauri.app/start/prerequisites/) do seu sistema
(no Windows, o WebView2 e as Build Tools do Visual Studio).

```bash
git clone https://github.com/EduPDX/aether-launcher.git
cd aether-launcher
pnpm install
pnpm tauri dev
```

A primeira compilação do Rust demora bastante e o diretório `src-tauri/target/`
passa de vários GB. Ele está no `.gitignore` — nunca versione.

## Testar sem servidor rodando

O launcher precisa de um Aether Core para sincronizar. Se você não tem um à mão,
suba o do outro repositório localmente:

```bash
git clone https://github.com/EduPDX/aether.git
cd aether && uv sync --all-packages
uv run python -m aether_core        # http://127.0.0.1:8600
```

Crie uma instância e publique um perfil de sync pela interface; o código do
perfil aparece na aba **Sync**. Aponte o launcher para `http://127.0.0.1:8600`.

Para mexer só na lógica sem tocar em rede, os testes cobrem as partes difíceis:

```bash
cd src-tauri
cargo test
cargo test sync::            # só um módulo
cargo clippy -- -D warnings
cargo fmt
```

## Fluxo de trabalho

```bash
git checkout -b fix/nome-curto
git push -u origin fix/nome-curto
gh pr create
```

Force-push e exclusão do `main` estão bloqueados. Mensagens de commit em
português, no formato `tipo(escopo): resumo`.

## Antes de mexer no launch do Minecraft

`minecraft.rs` e `play.rs` concentram a parte que mais custou depuração. Há
testes protegendo três armadilhas específicas — **se um deles falhar, leia o
commit que o criou antes de ajustar a asserção:**

- **A chave de dedupe de bibliotecas inclui o classificador.** Colapsar
  `lwjgl-3.3.1.jar` com `lwjgl-3.3.1-natives-windows.jar` descarta os natives, e
  o jogo morre com `UnsatisfiedLinkError: lwjgl.dll`.
- **O jar do cliente precisa ter o nome da versão lançada.** O Forge passa
  `-DignoreList=...,${version_name}.jar`; com outro nome o jogo quebra com
  `ResolutionException: Module minecraft contains package net.minecraft.obfuscate`.
- **Natives precisam ser extraídos**, não apenas estar no classpath.

Cada um desses custou uma sessão inteira de investigação. Nenhum aparece como
erro claro: o jogo simplesmente não abre.

## Antes de mexer na sincronização

`sync.rs` verifica a assinatura Ed25519 do manifesto **antes** de baixar
qualquer coisa. Isso não é formalidade: sem a verificação, quem controlasse a
rede entre o jogador e o servidor entregaria um `.jar` arbitrário que este
programa executaria na máquina dele.

Se precisar mudar o formato do manifesto, entenda primeiro que ele é um
**contrato entre dois repositórios**. O launcher instalado no computador do
jogador não se atualiza sozinho — mudança incompatível quebra quem já tem o
programa. Adicione campos ao lado; não altere nem remova os existentes.

O lado servidor do contrato está em
[apps/LAUNCHER.md](https://github.com/EduPDX/aether/blob/main/apps/LAUNCHER.md).

## Limitações conhecidas

Não são bugs a corrigir por acidente — são escolhas pendentes:

- **Só modo offline.** Login Microsoft não está implementado.
- **Executável não assinado**, o que faz o Windows Defender acusar falso
  positivo. Resolver isso é comprar um certificado, não mudar código.
- **Só Windows exercitado.** O código compila para Linux e macOS, mas o caminho
  de launch nunca foi testado neles — se você usa um desses, é uma boa primeira
  contribuição.
