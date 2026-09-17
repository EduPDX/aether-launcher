# Convites e capas do launcher

## Administrador

1. No Core atualizado, abra a instância e publique um perfil na aba **Sync**.
2. Abra **Launcher**, ao lado de Sync, ou **Gerar convite** no perfil publicado.
3. Informe o endereço público do Core (acessível aos jogadores), o endereço do jogo e, opcionalmente, o mapa, nome, capa personalizada e crédito da imagem.
4. Salve, escolha o perfil e clique em **Copiar convite**.

A capa do provider é usada quando nenhuma capa personalizada é configurada. Os créditos do catálogo acompanham a imagem.

## Jogador

Em **Servidores → Adicionar**, cole o link de convite, clique em **Consultar**, confira o servidor e informe o nickname. A entrada direta é opcional. A pasta fica em **Opções avançadas**; sem escolher outra, a instalação usa a pasta local de dados do usuário, em `Aether/instances/<identificador>`.

O convite não instala o jogo imediatamente: isso acontece no fluxo normal de **Jogar**. A configuração manual continua disponível.

## Atualização dos dados

Os servidores adicionados por convite consultam os dados ao abrir o launcher e a cada 60 segundos. Nome, capa, endereço do jogo e mapa acompanham o painel. Nickname, memória, pasta e entrada direta permanecem locais. Sem conexão, permanecem os últimos metadados válidos.

O convite é um link HTTP(S) completo, não um código curto centralizado nem um protocolo de abertura automática do aplicativo. Se o domínio do Core mudar, o domínio antigo precisa continuar acessível ou o administrador deve distribuir um novo convite. O convite não permite acessar o painel administrativo.

## Contrato e implantação

- Administração autenticada: `GET/PUT /api/v1/instances/{id}/launcher`, com permissões `sync.read` e `sync.write`.
- Consulta pública: `GET /api/v1/public/launcher/{profile_id}`. Exige perfil publicado e endereço público configurado.
- Core: migração `0011` cria `launcher_settings`; aplicada pelo mecanismo normal de migrações na inicialização.
- Clientes antigos continuam usando os endpoints existentes. Instalações manuais não passam a ser controladas por convite automaticamente.
- O launcher verifica o manifesto assinado e confere os identificadores de instância e perfil antes de aceitar o convite.

As alterações precisam ser distribuídas no Core/painel e em uma nova versão do launcher. Nenhuma publicação ou implantação no servidor real foi realizada durante a implementação.

## Validação local

- 27 testes Python de convites, Sync e remoção passaram.
- 18 testes Rust passaram; o teste de ping público ficou ignorado. Um teste de integração adicional do consumidor Rust passou contra o Core local com manifesto assinado.
- 6 cenários da lista de jogadores passaram.
- TypeScript e builds do painel e launcher passaram.
- Na prévia: gravação das configurações, convite, nickname, entrada direta desmarcada, destino padrão, capa nos dois locais, mapa e atualização automática do nome conferidos.

A prévia de navegador usa um adaptador para os comandos Tauri; não executa o Minecraft. A parte nativa de consulta do convite foi testada separadamente contra a mesma API local.
