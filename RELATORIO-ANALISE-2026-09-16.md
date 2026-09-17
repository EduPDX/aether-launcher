# Relatório de análise — Aether Launcher

Data: 16/09/2026. Versão declarada: 0.4.5. Commit analisado: `36c6aca`.

## Parecer

O projeto tem uma base útil: separa o cliente visual da lógica Rust, sincroniza incrementalmente, verifica hashes dos arquivos do manifesto, instala dependências do jogo e captura erros de inicialização. Entretanto, eu não recomendaria uma distribuição ampla antes de corrigir a confiança do manifesto, o confinamento dos arquivos e os defeitos da lixeira. Esses problemas são mais importantes que uma reformulação visual.

A análise distingue constatações por leitura do código, observação visual e limitações de execução. Uma constatação por código não significa que um ataque foi executado ou que o problema ocorreu em uma instalação real.

## Escopo e validações

Foram revisados o frontend React/TypeScript e CSS, comandos Tauri, sincronização, arquivos/lixeira, instalação de Java, preparação e execução do Minecraft/Forge, integração Modrinth, ping, configurações, documentação e testes existentes.

| Verificação | Resultado |
|---|---|
| `node node_modules/typescript/bin/tsc --noEmit` | Passou, código de saída 0. |
| `pnpm build` | Bloqueado: o pnpm do ambiente tentou instalar/reconciliar dependências e abortou por ausência de TTY. |
| Vite executado diretamente para build e desenvolvimento | Bloqueado por `ERR_MODULE_NOT_FOUND`: pacote `rollup` ausente. |
| `cargo test --locked --offline --manifest-path src-tauri/Cargo.toml` | Bloqueado antes de executar os testes: build Tauri referencia permissões geradas em `E:\Projetos\...`, mas o projeto está em `D:\Projetos\...`. |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | Falhou por diferenças de formatação em vários arquivos Rust. |
| Inspeção visual | Tela de configuração do `dist` existente, em navegador local, no viewport padrão e em 860 × 600. |
| Execução real do jogo, instalação Java/Forge e atualização | Não exercitadas. |
| Clippy e auditoria de vulnerabilidades das dependências | Não executados; não há conclusão sobre ausência de vulnerabilidades conhecidas. |

O `dist` não foi reconstruído e não foi demonstrada sua equivalência exata ao código atual. A análise das telas internas foi feita pelo código, sem simular uma conexão bem-sucedida com um Core. Os problemas de dependências/cache são limitações do checkout atual, não prova de que um checkout limpo também falha. Nenhum arquivo de implementação foi alterado.

## Achados prioritários

### 1. Crítico — a assinatura do manifesto não estabelece confiança no servidor

**Evidência:** [lib.rs:64](D:/Projetos/aether-launcher/src-tauri/src/lib.rs:64), especialmente a leitura de `public_key` na linha 87; [sync.rs:86](D:/Projetos/aether-launcher/src-tauri/src/sync.rs:86).

O manifesto, a assinatura e a chave pública vêm da mesma resposta HTTP. O launcher verifica que a assinatura corresponde à chave recebida, mas não compara essa chave com uma chave previamente confiável. O cadastro e a documentação permitem HTTP.

**Cenário:** um intermediário capaz de substituir a resposta em uma conexão HTTP pode entregar seu próprio manifesto, assinatura e chave. A verificação criptográfica passa; os hashes também passam se o intermediário fornecer arquivos correspondentes. Isso contradiz a proteção contra controle da rede prometida no README. HTTPS corretamente validado reduz esse cenário, mas não transforma a assinatura atual em uma autenticação independente do transporte.

**Correção:** estabelecer uma raiz de confiança por servidor/perfil, com chave ou fingerprint obtidos por canal confiável; persistir a identidade e rejeitar alterações inesperadas. Se adotar confiança no primeiro uso, deixar claro que ela não protege um primeiro contato já comprometido. Definir rotação de chaves e uma política explícita de HTTPS.

### 2. Crítico — caminhos do manifesto podem escapar da pasta do jogo

**Evidência:** [lib.rs:178](D:/Projetos/aether-launcher/src-tauri/src/lib.rs:178), [sync.rs:196](D:/Projetos/aether-launcher/src-tauri/src/sync.rs:196), [sync.rs:245](D:/Projetos/aether-launcher/src-tauri/src/sync.rs:245).

Os campos `path` e `managed.dir` são usados em `join()` sem validação de confinamento. Caminhos com `..`, absolutos ou prefixos de unidade não são rejeitados na interpretação do manifesto. Assinatura válida não torna um caminho seguro: o servidor pode estar comprometido, mal configurado ou substituído conforme o achado anterior.

**Impacto:** leitura para cálculo de hash e escrita fora da instância, sob as permissões do usuário. Diretórios gerenciados também precisam de validação antes da varredura e movimentação. A exploração não foi executada.

**Correção:** validar todos os caminhos antes de qualquer operação, recusar raízes, prefixos Windows, caminhos ascendentes e áreas internas; conferir ancestrais e links; rejeitar destinos duplicados e aliases. Centralizar essa regra em um tipo de caminho validado. `join()` sozinho não fornece esse confinamento, conforme a [documentação de caminhos do Rust](https://doc.rust-lang.org/std/path/struct.PathBuf.html#method.push).

### 3. Alto — gerenciador de arquivos não contém links/junctions

**Evidência:** [files.rs:53](D:/Projetos/aether-launcher/src-tauri/src/files.rs:53) e [files.rs:167](D:/Projetos/aether-launcher/src-tauri/src/files.rs:167).

`resolve()` canonicaliza apenas a base e depois acrescenta componentes. Um ancestral dentro da pasta pode ser um link/junction para outro diretório. A rejeição de `..` não impede que a operação siga esse link para fora. O sync também usa `is_dir()` e recursão sem uma política explícita para links.

Além disso, `guard_internal()` compara texto antes da normalização: um caminho como `./.aether-trash/...` não começa textualmente por `.aether`, embora resolva para a área interna. Isso é relevante na fronteira dos comandos, mesmo que o caminho não seja produzido pela navegação normal.

**Correção:** validar o destino real ou o ancestral existente para criação; tratar reparse points/junctions e links; normalizar antes de verificar áreas reservadas; avaliar corridas entre validação e escrita. Testar também links circulares na varredura.

### 4. Alto — excluir um arquivo chamado `meta.json` destrói seu conteúdo na lixeira

**Evidência:** [files.rs:250](D:/Projetos/aether-launcher/src-tauri/src/files.rs:250).

`fs_delete()` move o arquivo para `slot/<nome>` e em seguida grava os metadados em `slot/meta.json`. Se o nome original for `meta.json`, a segunda gravação sobrescreve o arquivo que deveria ser recuperável. Restaurar devolve metadados, não o conteúdo original.

**Correção:** separar dados e metadados: por exemplo, `slot/payload` e `slot/meta.json`, com identificador único e criação exclusiva do slot. Gravar de maneira transacional e testar arquivo e pasta chamados `meta.json`, falhas de gravação e colisões de identificador.

### 5. Alto — a lixeira do sync é incompatível com a interface de restauração

**Evidência:** [sync.rs:245](D:/Projetos/aether-launcher/src-tauri/src/sync.rs:245) e [files.rs:281](D:/Projetos/aether-launcher/src-tauri/src/files.rs:281).

O sync cria uma pasta por timestamp em segundos, achata os caminhos substituindo `/` por `_` e não escreve `meta.json`. A interface só lista slots com esse arquivo. Logo, mods aposentados pelo sync ficam invisíveis e não podem ser restaurados pela UI, apesar de fisicamente permanecerem na pasta.

O achatamento também cria colisões: `mods/a_b.jar` e `mods/a/b.jar` viram `mods_a_b.jar`. Conforme o comportamento da operação no sistema, pode haver erro ou sobrescrita. `fs_trash_empty()` remove a lixeira inteira, inclusive os itens que a listagem não mostrou.

**Correção:** reutilizar uma implementação única de lixeira com caminho original, conteúdo separado e IDs únicos; migrar ou exibir explicitamente os itens antigos. A ação de esvaziar precisa refletir o conteúdo efetivamente eliminado.

### 6. Alto — temporários de download colidem para nomes com extensões diferentes

**Evidência:** [lib.rs:183](D:/Projetos/aether-launcher/src-tauri/src/lib.rs:183), paralelismo em [lib.rs:257](D:/Projetos/aether-launcher/src-tauri/src/lib.rs:257).

`with_extension("aether-part")` substitui a extensão. `config/example.json` e `config/example.toml` usam o mesmo temporário `config/example.aether-part`. Como há quatro downloads paralelos, eles podem truncar, verificar, renomear ou remover o temporário uns dos outros.

**Correção:** preservar o nome completo e acrescentar um identificador exclusivo da operação; usar criação exclusiva e substituição final apenas após validação. A mesma construção existe em [content.rs:222](D:/Projetos/aether-launcher/src-tauri/src/content.rs:222).

### 7. Alto — comparação de caminhos diverge do filesystem Windows

**Evidência:** [sync.rs:214](D:/Projetos/aether-launcher/src-tauri/src/sync.rs:214).

O conjunto de caminhos do manifesto diferencia maiúsculas e minúsculas. Em diretórios Windows com comportamento usual, `mods/Alpha.jar` e `mods/alpha.jar` identificam o mesmo arquivo. A verificação pode contá-lo como correto, enquanto a varredura o considera extra e o envia à lixeira por não encontrar a mesma grafia no conjunto.

**Correção:** definir representação canônica de caminhos compatível com a plataforma, incluindo separadores, e detectar duplicidades no manifesto. Testar mudança apenas de capitalização em um volume Windows real.

### 8. Alto — não há coordenação robusta entre sincronização, jogo e troca de perfil

**Evidência:** [App.tsx:311](D:/Projetos/aether-launcher/src/App.tsx:311), [App.tsx:456](D:/Projetos/aether-launcher/src/App.tsx:456), [play.rs:167](D:/Projetos/aether-launcher/src-tauri/src/play.rs:167).

`busy` pertence ao hook React e volta a `false` depois que o processo é iniciado. O backend não mantém um bloqueio por pasta nem um registro de execução que impeça outro launch/sync. O usuário pode sincronizar enquanto joga ou iniciar outra instância sobre a mesma pasta. Entrar em adicionar/editar servidor desmonta `Shell`; a operação Rust continua, mas o estado visual de bloqueio se perde.

**Impacto:** concorrência em mods, bibliotecas, temporários, natives e no log `aether-game.log`. Dois perfis também podem apontar para a mesma `.minecraft` sem uma barreira de isolamento.

**Correção:** serviço de operações no Rust com identidade de perfil, pasta, job e PID; exclusão mútua por diretório; UI derivada desse estado; instâncias isoladas por padrão. Atualizações e fechamento do launcher também devem considerar operações em andamento.

### 9. Alto — rede sem timeout explícito e sem cancelamento de operação

**Evidência:** [lib.rs:58](D:/Projetos/aether-launcher/src-tauri/src/lib.rs:58), [java.rs:95](D:/Projetos/aether-launcher/src-tauri/src/java.rs:95), [App.tsx:321](D:/Projetos/aether-launcher/src/App.tsx:321).

Os clientes HTTP não configuram limites de conexão/leitura/operação. Um servidor que aceita a conexão mas não termina a resposta pode deixar o fluxo pendente. No cadastro, o botão Cancelar fica desabilitado durante a consulta; no dashboard, o polling pode acumular chamadas pendentes a cada 15 segundos.

**Correção:** timeout de conexão, timeout de inatividade adequado a downloads, limites de resposta e cancelamento cooperativo; polling sem sobreposição; erros recuperáveis. A [documentação do reqwest 0.12.28](https://docs.rs/reqwest/0.12.28/reqwest/struct.ClientBuilder.html#method.timeout) documenta a configuração de timeout e a ausência de timeout total por padrão.

### 10. Médio — erros de varredura podem produzir diagnóstico falso de sincronização

**Evidência:** [sync.rs:221](D:/Projetos/aether-launcher/src-tauri/src/sync.rs:221).

Quando `walk_files()` falha, o plano simplesmente ignora aquele diretório gerenciado. Se não houver downloads pendentes, pode retornar `synced=true` mesmo sem ter verificado arquivos extras em uma área ilegível.

**Correção:** retornar `Result<Plan, ...>` ou um plano explicitamente incompleto; não declarar sucesso em caso de falha de leitura. Propagar diretório e causa para uma mensagem útil.

### 11. Médio — integridade e recuperação de downloads não são uniformes

**Evidência:** [content.rs:163](D:/Projetos/aether-launcher/src-tauri/src/content.rs:163), [java.rs:89](D:/Projetos/aether-launcher/src-tauri/src/java.rs:89), [minecraft.rs:280](D:/Projetos/aether-launcher/src-tauri/src/minecraft.rs:280).

Downloads do sync verificam SHA-256, mas o fluxo Modrinth não compara hash nem tamanho final, e a instalação do Java não verifica um checksum do pacote. O download genérico do Minecraft carrega o corpo inteiro em memória e grava no destino definitivo; arquivos sem hash são reutilizados só por existirem. O Forge installer é baixado com `sha1=None`, portanto um cache incompleto pode ser reutilizado indefinidamente.

**Correção:** unificar download por streaming, limites de tamanho, validação de integridade quando disponível, temporário exclusivo, commit atômico e limpeza em falhas. Instalar Java em staging e promover apenas um runtime completamente validado. Não se trata de afirmar que HTTPS está ausente nesses provedores: falta uma validação adicional de integridade e recuperação local.

### 12. Médio — loaders não suportados caem silenciosamente em vanilla

**Evidência:** [play.rs:215](D:/Projetos/aether-launcher/src-tauri/src/play.rs:215).

Apenas `forge` com versão preenchida tem tratamento especial. Fabric, NeoForge, erro de grafia ou Forge sem versão seguem o ramo vanilla. Isso pode abrir um jogo sem o loader necessário e deslocar o diagnóstico para a conexão com o servidor.

**Correção:** validar explicitamente a combinação loader/versão e retornar erro claro para combinações não suportadas. Não é necessário implementar todos os loaders antes de fazer essa validação.

### 13. Médio — monitoramento do processo termina após aproximadamente 7,5 minutos

**Evidência:** [play.rs:335](D:/Projetos/aether-launcher/src-tauri/src/play.rs:335).

O loop acompanha 900 intervalos de 500 ms, depois abandona o monitoramento mesmo que o jogo continue rodando. Fechamentos posteriores deixam de emitir o evento de encerramento. Além disso, `read_tail()` lê o log inteiro para apresentar apenas suas últimas linhas.

**Correção:** monitorar até o encerramento real com identidade do processo e extrair o final do log por leitura limitada; aplicar rotação/tamanho máximo. Evitar que execuções concorrentes sobrescrevam o mesmo log.

### 14. Médio — suporte multiplataforma é incompleto na implementação

**Evidência:** [java.rs:37](D:/Projetos/aether-launcher/src-tauri/src/java.rs:37), [java.rs:73](D:/Projetos/aether-launcher/src-tauri/src/java.rs:73), [java.rs:148](D:/Projetos/aether-launcher/src-tauri/src/java.rs:148).

O seletor de SO usa Windows ou Linux; macOS também recebe Linux. A arquitetura é sempre x64, e a extração é sempre ZIP. Portanto o código não oferece um pipeline portável simplesmente porque o Tauri compila em outros sistemas. O README já reconhece que apenas Windows foi testado.

**Correção:** delimitar o suporte oficial a Windows x64 até validar uma matriz real; depois tratar SO, arquitetura, formato do pacote e layout de runtime separadamente. Para versões antigas do Minecraft, validar também os formatos de argumentos e natives: o código atual privilegia metadados modernos.

## Frontend: comportamento, interface e acessibilidade

### 15. Médio — configuração inicial fica cortada na janela mínima

**Evidência:** [App.css:35](D:/Projetos/aether-launcher/src/App.css:35), [App.css:492](D:/Projetos/aether-launcher/src/App.css:492), [tauri.conf.json:15](D:/Projetos/aether-launcher/src-tauri/tauri.conf.json:15).

Observado no `dist` existente em 860 × 600: parte da marca/título fica acima da área visível e o cartão alcança o limite inferior. `body` usa `overflow:hidden`, e o setup centraliza um formulário alto sem rolagem própria. Mensagens de erro e escalas maiores de texto podem agravar o problema.

**Correção:** permitir rolagem no setup, usar alinhamento seguro no eixo vertical e separar campos opcionais em uma expansão. Testar 860 × 600, tamanho padrão, zoom e escala do Windows. A primeira configuração também não renderiza os controles de janela de `Shell`, embora a janela nativa tenha `decorations:false`; acrescentar controles acessíveis nessa tela.

### 16. Médio — troca de servidor preserva dados e eventos de outra operação

**Evidência:** [App.tsx:321](D:/Projetos/aether-launcher/src/App.tsx:321) e [App.tsx:333](D:/Projetos/aether-launcher/src/App.tsx:333).

Ao mudar servidor/perfil, o hook limpa `info`, mas mantém `plan`, `activity`, `error` e `log`. Os eventos globais não incluem identidade de job/perfil. Resultado: dashboard do servidor B pode exibir atividade ou erros do A. Uma consulta de status que volta a funcionar também não limpa automaticamente o erro anterior.

**Correção:** associar consultas e eventos ao perfil/job; impedir respostas antigas de atualizar o estado atual; separar estado de conexão de erros de operação. Preservar histórico apenas se estiver identificado para o usuário.

### 17. Médio — buscas e instalações de conteúdo têm corridas de estado

**Evidência:** [App.tsx:1256](D:/Projetos/aether-launcher/src/App.tsx:1256), [App.tsx:1267](D:/Projetos/aether-launcher/src/App.tsx:1267).

Buscas não têm cancelamento ou número de sequência. Alternar rapidamente Shaders/Texturas permite que a resposta antiga sobrescreva a busca nova. O resultado não transporta seu tipo, e instalar usa o `kind` atual, potencialmente incompatível com o card antigo. Alternar aba durante download também permite que a conclusão antiga altere o estado visual da categoria atual.

O estado de instalado vem exclusivamente de `localStorage`: existe `content_installed` no Rust, mas a tela não o usa para reconciliar arquivos. Exclusão manual ou pela seção Arquivos deixa um item falsamente instalado. Quando a versão do jogo ainda não carregou ou sua consulta falhou, o filtro de compatibilidade pode resultar em busca/instalação sem versão, apesar de `useCompat=true`.

**Correção:** chavear consultas por perfil/tipo/versão/texto; ignorar respostas obsoletas; usar jobs persistentes de instalação; reconciliar catálogo e disco; distinguir compatibilidade desconhecida de filtro desativado. A seleção de shader deve considerar o loader efetivamente disponível, não somente a versão do Minecraft.

### 18. Médio — armazenamento local não valida os dados lidos

**Evidência:** [App.tsx:82](D:/Projetos/aether-launcher/src/App.tsx:82), [App.tsx:109](D:/Projetos/aether-launcher/src/App.tsx:109), [App.tsx:534](D:/Projetos/aether-launcher/src/App.tsx:534).

`loadServers()` aceita qualquer array como `Server[]`. Um valor como `[{}]` passa na leitura e posteriormente falha em `current.username.charAt(...)`. O índice ativo também não é normalizado no carregamento: o render usa fallback para `servers[0]`, enquanto `patch()` continua usando o índice inválido e pode não salvar a alteração no servidor exibido.

**Correção:** validar schema em runtime, versionar/migrar configurações, normalizar índice e permitir recuperação de configuração inválida. Adicionar uma fronteira de erro para que uma falha de renderização não produza apenas uma tela vazia.

### 19. Médio — lacunas de acessibilidade e teclado

**Evidência:** [App.tsx:703](D:/Projetos/aether-launcher/src/App.tsx:703), [App.tsx:1005](D:/Projetos/aether-launcher/src/App.tsx:1005), [App.tsx:1102](D:/Projetos/aether-launcher/src/App.tsx:1102), [App.css:506](D:/Projetos/aether-launcher/src/App.css:506), [index.html:2](D:/Projetos/aether-launcher/index.html:2).

- Labels do setup não estão associados aos inputs por `htmlFor`/`id`; a árvore de acessibilidade inspecionada apresentou campos sem nome associado.
- O HTML declara `lang="en"` para uma interface em português.
- No breakpoint de 880 px, o texto dos botões de navegação desaparece com `display:none`; `NavItem` não tem `aria-label` ou `title` alternativo.
- O toggle tem nome, mas não comunica seu estado com `aria-checked` ou `aria-pressed`.
- Progresso, logs e erros não têm semântica específica de atualização para leitores de tela.
- A exclusão em grade é um `span` clicável dentro do botão do arquivo, sem foco/semântica de botão. O botão externo fica desabilitado para arquivos não editáveis, comprometendo esse controle; o comportamento de clique deve ser validado no WebView2.
- Alguns inputs removem o outline sem reposição de foco equivalente; não há tratamento de redução de movimento.

**Correção:** labels associados, nomes persistentes nos ícones, controles irmãos em vez de ação dentro do botão de tile, estados ARIA corretos, foco visível e anúncios discretos de progresso. Validar com teclado e leitor de tela, não apenas por inspeção de markup.

### 20. Médio — fronteira de conteúdo remoto precisa de endurecimento

**Evidência:** [tauri.conf.json:26](D:/Projetos/aether-launcher/src-tauri/tauri.conf.json:26), [App.tsx:1397](D:/Projetos/aether-launcher/src/App.tsx:1397).

CSP está desativada (`null`), a URL do mapa não tem validação explícita de protocolo e o iframe não tem sandbox. Isso reduz defesa em profundidade. Não foi demonstrado que um iframe remoto tenha acesso aos comandos Tauri; a ausência de CSP não equivale, sozinha, a uma exploração comprovada.

**Correção:** validar esquemas e origem do mapa, configurar CSP para as necessidades reais do launcher, escolher permissões mínimas do iframe e oferecer fallback para bloqueios de embedding ou carregamento. A [documentação oficial do Tauri](https://v2.tauri.app/security/csp/) explica que a proteção CSP depende de configuração explícita.

### Melhorias de experiência e apresentação

A tela inicial observada tem identidade consistente, boa separação dos campos e ação principal reconhecível. O código também oferece tokens de tema, estados de atividade, logs opcionais e separação de seções. Eu preservaria essa base visual.

As melhorias com maior retorno são:

1. **Simplificar o primeiro uso:** receber um código/link de convite que resolva endereço e perfil; sugerir uma pasta exclusiva da instância; mover mapa e endereço alternativo para opções avançadas.
2. **Validar antes de baixar:** setup e edição de nick aceitam qualquer texto não vazio, enquanto Rust só rejeita o nick após o frontend já executar o sync. Aplicar a mesma regra de 3–16 caracteres e alfabeto permitido antes de iniciar o fluxo, mantendo a validação no backend.
3. **Mostrar uma prévia útil da sincronização:** arquivos a baixar/aposentar, tamanho e consequências. Atualmente a verificação fica principalmente no log, recolhido por padrão.
4. **Apresentar estados distintos:** preparando, baixando, jogo em execução, encerrado e falha. O botão volta a “Jogar” sem manter um estado operacional do processo.
5. **Melhorar progresso:** mostrar bytes e velocidade quando disponíveis; encaminhar o callback do download Java, atualmente descartado no pipeline de play; permitir cancelar com segurança.
6. **Corrigir a métrica Ping:** o dashboard exibe tempo de requisição HTTP ao Core como “até o servidor”. Isso inclui processamento HTTP e pode nem medir o host do jogo. Usar o comando `server_ping` existente para o destino correto ou rotular como latência da API.
7. **Proteger trabalho não salvo:** o editor fecha com “Voltar” ou navegação sem aviso sobre alterações pendentes. Oferecer salvar/descartar, sem pedir confirmação quando nada mudou.
8. **RAM contextual:** o slider permite até 16 GB independentemente da memória disponível. Mostrar recomendação e limite coerentes, com reserva para o sistema, e validar limites também no backend.
9. **Atualização com diagnóstico:** falhas do `check()` são silenciadas. Adicionar verificação manual, versão atual, progresso e tratamento de atualização durante operações.
10. **Polimento:** trocar favicon Vite, uniformizar “Dashboard” com o idioma escolhido e remover frases de suporte em primeira pessoa como “te ajudo com o passo a passo”.

Não foi medida a razão de contraste de todos os temas nem testada sua renderização. `inkFor()` usa uma heurística de luminosidade, não um cálculo formal de contraste; testar todas as combinações antes de afirmar conformidade.

## Arquitetura, desempenho e manutenção

**O que vale preservar:** módulos Rust com responsabilidades reconhecíveis; TypeScript estrito; verificação de hash antes de promover arquivos do sync; paralelismo limitado; proteção contra sobrescrita no fluxo normal de restauração; teste de assinatura gerada em Python; testes para deduplicação de natives e nome do jar Forge; assinatura própria de atualizações configurada com chave pública no aplicativo.

**Reorganização sugerida:** dividir o `App.tsx` de aproximadamente 1.400 linhas em componentes de seção, hooks de consulta/operação, tipos de IPC, persistência e temas. Não há necessidade demonstrada de trocar React ou adicionar uma grande biblioteca de estado. O principal é definir quem possui o estado de um job e a identidade da instância.

No Rust, extrair serviços compartilhados para caminhos seguros, downloads, lixeira e estado de processos. Algumas operações síncronas de disco, extração e `java -version` ocorrem dentro do fluxo async; mover trabalho bloqueante relevante para tarefas apropriadas. Reutilizar o cliente HTTP favorece pooling. Evitar baixar/verificar o manifesto inteiro a cada polling de status quando uma identidade de instância já validada basta.

Uma sincronização mais robusta deve operar sobre uma revisão de manifesto estável. Hoje o frontend chama sync e depois play, e cada comando busca novamente o manifesto. Uma publicação entre essas etapas pode produzir arquivos de uma revisão e metadados de jogo de outra. Downloads também dependem de o endpoint manter o conteúdo esperado até o fim do job.

## Testes e documentação

Não há script de testes ou lint frontend no `package.json`, nem workflow de CI versionado encontrado em `.github`. Os testes Rust presentes não cobrem vários fluxos novos, especialmente arquivos/lixeira, conteúdo e coordenação de operações.

Os testes live de Core e Java retornam cedo sem suas variáveis de ambiente. Portanto podem aparecer como sucesso sem terem exercitado a integração real. O teste de ping público está marcado para ser ignorado por padrão. Uma futura execução verde precisa informar quais integrações foram realmente exercitadas.

Ordem sugerida para testes de regressão:

| Área | Casos essenciais |
|---|---|
| Confiança | Chave diferente, assinatura inválida, manifesto alterado, rotação autorizada. |
| Caminhos | `..`, absoluto, unidade/UNC, separadores, links/junctions e área interna normalizada. |
| Lixeira | `meta.json`, caminhos que antes colidiam, sync/restauração, slots concorrentes e falha parcial. |
| Sync | Capitalização Windows, diretório ilegível, dois nomes-base iguais, interrupção, revisão alterada. |
| Processos | Duplo launch, sync durante jogo, troca/edição de perfil durante job e encerramento tardio. |
| Frontend | Respostas fora de ordem, storage inválido, retorno ao editor, keyboard-only e janela mínima. |
| Integração | Core controlado, runtime limpo, instalação Forge e atualização real com artefatos de teste. |

O README está desatualizado em pontos objetivos: afirma dependência de apenas três endpoints e que clientes não se atualizam sozinhos, mas o código contém skins, Modrinth e updater. A documentação também menciona `source` no manifesto, enquanto `ManifestFile` só modela `path`; isso deve ser conciliado com o contrato do Core, sem presumir bug de download, pois o endpoint pode fazer o mapeamento internamente.

Fixar as versões de ferramentas no ambiente de desenvolvimento, documentar instalação reproduzível e reconstruir o cache Rust em um diretório limpo. O erro observado em `target` mostra que artefatos copiados entre unidades não devem ser usados como prova de saúde do build. Manter assinatura de atualização e assinatura do executável como controles distintos.

## Plano de ação

| Etapa | Entrega | Critério de conclusão |
|---|---|---|
| 1 — segurança e dados | Confiança do manifesto, caminhos confinados, lixeira única, temporários exclusivos e comparação de caminhos Windows. | Regressões direcionadas passam; nenhum caso de saída da instância ou perda de conteúdo nos cenários cobertos. |
| 2 — confiabilidade | Jobs no backend, bloqueio por instância, timeouts/cancelamento, revisão estável e monitoramento do processo. | Operações concorrentes e falhas parciais têm resultado previsível e recuperável. |
| 3 — frontend | Setup rolável, validação antecipada, estado por perfil, buscas ordenadas, reconciliação do conteúdo e acessibilidade. | Fluxos completos em janela mínima, teclado e condições de rede degradada. |
| 4 — distribuição | Ambiente reproduzível, build limpo, CI, testes de integração e documentação alinhada. | Build e testes demonstrados em máquina limpa Windows; limitações de plataforma publicadas. |

Não atribuo uma nota numérica ao projeto: sem build completo e execução real do launcher, isso sugeriria uma precisão que a análise não tem. Há evidência suficiente para priorizar as correções acima; a validação final de distribuição depende de executar a matriz de testes após resolvê-las.
