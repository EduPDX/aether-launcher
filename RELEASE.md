# Publicar uma atualização do launcher

O launcher se auto-atualiza pelo **updater do Tauri**, lendo o último release do
GitHub. Publicar uma versão nova é o que dispara a atualização em quem já tem o
launcher instalado.

## Pré-requisito: a chave de assinatura

As atualizações são **assinadas**. A chave privada NÃO está no repositório (se
vazar, qualquer um publica uma atualização maliciosa). Ela fica em:

    C:\Users\edupd\.aether\aether-launcher-updater.key   (privada — NUNCA commitar)
    C:\Users\edupd\.aether\aether-launcher-updater.key.pub (pública — já está no config)

A chave pública correspondente está em `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.
Quem for publicar precisa da privada. Guarde-a fora do repositório e compartilhe
por canal seguro (não por commit, não por chat público).

## Passos

1. **Suba a versão** nos três arquivos (o updater compara `tauri.conf.json`):
   - `src-tauri/tauri.conf.json` → `version`
   - `package.json` → `version`
   - `src-tauri/Cargo.toml` → `version`

2. **Build assinado** (as variáveis dão acesso à chave):

   ```bash
   export TAURI_SIGNING_PRIVATE_KEY="$(cat /c/Users/edupd/.aether/aether-launcher-updater.key)"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
   pnpm tauri build
   ```

   Sai o instalador e o `.sig` em `src-tauri/target/release/bundle/nsis/`.

3. **Monte o `latest.json`** apontando para o release novo:

   ```json
   {
     "version": "0.2.1",
     "notes": "o que mudou",
     "pub_date": "2026-07-21T00:00:00Z",
     "platforms": {
       "windows-x86_64": {
         "signature": "<conteúdo do arquivo .exe.sig>",
         "url": "https://github.com/EduPDX/aether-launcher/releases/download/v0.2.1/Aether_Launcher_0.2.1_x64-setup.exe"
       }
     }
   }
   ```

   Renomeie o instalador para um nome **sem espaços** (a URL do GitHub fica mais
   simples) e use esse nome na `url`.

4. **Publique o release** com o instalador e o manifesto:

   ```bash
   git tag v0.2.1 && git push --tags
   gh release create v0.2.1 Aether_Launcher_0.2.1_x64-setup.exe latest.json \
     --title "Aether Launcher 0.2.1" --notes "o que mudou"
   ```

O endpoint do updater é `releases/latest/download/latest.json`, então o
`latest.json` do release mais novo é sempre o que vale. Pronto: quem abrir o
launcher vê "Nova versão disponível" e atualiza sozinho.

> A primeira versão com o updater (0.2.0) precisa ser instalada à mão — versões
> anteriores não sabiam se atualizar. Da 0.2.0 em diante, é automático.
