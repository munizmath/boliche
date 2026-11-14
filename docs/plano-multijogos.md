# Plano de produto e implementação — Jogatina dos Amigos

**Data:** 14/11/2026  
**Estado:** documento de produto. A base multijogos de Boliche, Quiz e Gincana foi implementada em v14/v15; as modalidades posteriores permanecem sujeitas às portas de aceite descritas abaixo. Consulte o README para o estado de implantação e verificação.  
**Base consultada para esta atualização:** `main` no commit `0fdcb26e3a59dce9e69e9e81023b6bca368b91b3`. Antes de cada incremento, consultar novamente o HEAD remoto e atualizar a situação de entrega.  
**Responsáveis propostos:** Matheus como Product Owner das regras e da ordem do backlog; Product Manager pela descoberta e pelos resultados do produto; engenharia pelas soluções e estimativas; QA pela verificação. Esses papéis podem ser exercidos por menos pessoas, desde que as decisões fiquem registradas.

## 1. Decisão de produto

### Objetivo

Permitir que o mesmo grupo organize encontros de jogos diferentes, registre resultados confiáveis no celular e acompanhe classificações públicas, preservando integralmente o boliche. A primeira entrega deverá fazer um organizador criar um encontro de quiz ou gincana, registrar rodadas e publicar o resultado sem treinamento técnico.

### Público e tarefas principais

| Pessoa | Tarefa | Resultado esperado |
| --- | --- | --- |
| Organizador/administrador | Escolher jogo, configurar regras, participantes e encontro | Iniciar uma disputa válida em poucos passos |
| Operador do placar | Lançar, corrigir e concluir resultados | Resultado auditável, sem soma ou duplicação acidental |
| Jogador | Conferir sua posição, histórico e eventuais palpites | Entender a regra e localizar seu resultado |
| Visitante | Abrir link ou QR Code | Acompanhar placar sem conta, sem controles de edição |

### Limites do produto

- Um encontro possui **uma modalidade e uma versão de regras**. A modalidade não muda depois do primeiro resultado. Encontros de modalidades diferentes mantêm rankings separados. Histórico global pode comparar recordes somente quando a unidade e a regra forem equivalentes.
- Boliche continua como padrão para os encontros existentes. Importação OCR, scorecard por frames e lançamento no tablet ficam disponíveis para boliche. Cada outra modalidade recebe entrada manual própria; reconhecimento por foto só é adicionado quando existir amostra real do placar e teste de acurácia.
- Visualização pública continua sem login. Cadastro, aprovação, fotos privadas e consentimento de exibição pública permanecem nas regras atuais.
- O produto é recreativo. Não inclui apostas em dinheiro, certificação de federações, serviços pagos, backend persistente nem editor de fórmulas arbitrárias.
- Regras regionais, como truco, são apresentadas como modelos versionados configuráveis antes de iniciar o encontro. Nunca se presume uma única regra universal.

## 2. Evidência do sistema atual e impacto

| Capacidade existente | Evidência no repositório | Consequência para a implementação |
| --- | --- | --- |
| Encontros, partidas, jogadores e resultados | schema.sql:6-30; encounters.sql:5-44 | Reusar a estrutura e migrar de forma incremental |
| Um resultado por partida/jogador e ponto inteiro de 0 a 300 | schema.sql:22-30; hardening-p0.sql:109-154 | A estrutura de participantes é reutilizável; o limite de 300 precisa ser específico do boliche já no MVP |
| Pista registrada em cada participação e distribuição por capacidade | encounters.sql:32-40, 295-345 | Exibir o rótulo apropriado por modalidade; preservar a localização histórica |
| Status final derivado dos resultados; histórico e desfazer | hardening-p0.sql:44-106, 166-239 | Atualizar os gatilhos e RPCs para reconhecer conclusão específica de cada jogo |
| Equipes, chave eliminatória e palpites | competition.sql:4-23, 101-165, 202-229 | Reusar permissões e interface; verificar premissas de maior pontuação nas classificações |
| Ranking por total, média, melhor partida e quantidade | app.js:855-926; index.html:116-117 | Tornar critério e unidade específicos da modalidade, preservando empates |
| OCR local e lançamento por frames | index.html:336-394; v13-throw-mode.sql:7-22, 168 | Conservar como módulos de boliche; não exibir controles incompatíveis |
| Exportação, PWA, Realtime, QR e teste automatizado | README.md:50-62; tests/app.test.cjs | Ampliar formato exportado e testes sem adicionar serviços |

## 3. Priorização de Product Owner e Product Manager

A ordem abaixo considera frequência provável de uso, valor para grupos, reaproveitamento, risco de regra e esforço. As estimativas são **faixas de planejamento**, a serem refinadas pela equipe após uma sessão curta de descoberta e inspeção do banco. Não são promessas de prazo.

| Ordem | Incremento | Modalidades e regra principal | Valor | Faixa indicativa |
| --- | --- | --- | --- | --- |
| P0 | Base segura | Boliche preservado; seleção e versionamento de modalidade | Evita regressão e cria base reutilizável | 1–2 semanas |
| P1 | MVP multijogos | Quiz e gincana de pontos por rodada; individual e equipes; maior total vence | Maior reaproveitamento com menor mudança operacional | 1–2 semanas |
| P2 | Confrontos | Pebolim e sinuca por vitórias/sets; depois tênis de mesa com 11 pontos e diferença mínima de 2; truco com modelo regional definido | Aproveita chaves e histórico | 2–3 semanas |
| P3 | Pontuação especial | Pinball por pontuação alta; minigolfe por tacadas; cubo/tempo por menor duração | Amplia formatos numéricos com regras claras | 1–2 semanas por família |
| P4 | Rodadas de dardos | 501, redução de saldo, bust e saída dupla conforme modelo escolhido | Requer lançamento e validação próprios | 2–3 semanas |

**Portas de decisão:** depois do MVP, priorizar a próxima família usando pedidos observados nos encontros piloto. Uma modalidade sem regra acordada, exemplos reais e dono de produto não entra em desenvolvimento. Isso mantém o backlog ordenado por valor e risco, sem retirar os itens do mapa.

## 4. Descoberta e especificação antes do primeiro incremento

1. Observar ou simular dois grupos usando a interface atual em celular e tablet: um encontro de boliche e um de quiz/gincana. Registrar passos, erros, tempo para publicar a primeira rodada e pontos de dúvida. Coletar apenas métricas necessárias, sem e-mails ou fotografias no relatório.
2. Para cada modalidade, aprovar uma ficha de regra: unidade, limite de valor, formato da disputa, condição de conclusão, cálculo de posição, tratamento de empate, resultado ausente, reversão e correção. Guardar exemplos de entrada e saída que virem testes.
3. Mapear fluxos em telas de 320, 390, 768 e 1024 px. Esboçar o assistente de criação de encontro e os controles de entrada por tipo de jogo; validar com um organizador e um operador.
4. Medir a linha de base antes de fixar metas: tempo para criar encontro, lançar oito resultados, erros por rodada e atraso de sincronização. As metas sugeridas na seção 10 poderão ser ajustadas pelo Product Owner após esse teste.

**Entregável:** ficha de regras assinada pelo Product Owner, fluxos de baixa fidelidade, backlog reordenado e exemplos reais para QA. **Saída:** nenhuma regra em aberto que permita dois vencedores diferentes para os mesmos dados.

## 5. Desenho técnico mínimo

### 5.1. Modelo de modalidades

- Criar migração incremental para **encounters.game_type** com valor padrão boliche e **rules_version**. Vincular configuração validada a cada encontro; travar tipo, versão e parâmetros que afetem placar após o primeiro lançamento. Fazer backfill de todos os encontros históricos para boliche, sem recalcular pontos.
- Manter **games** como partida/rodada do encontro e **scores** como resultado consolidado por participante. O par único de partida e jogador continua obrigatório. O campo histórico **scores.pista** continua representando o local da participação; a interface o apresenta como pista, mesa, estação ou local conforme a modalidade. Para quiz sem distribuição física, usar uma estação compartilhada configurada com capacidade adequada.
- Criar um catálogo pequeno de modalidades e modelos de regras, com valores permitidos e versionados. O frontend usa os metadados para rótulos, campos, ordenação e leitura; o banco valida modalidade, participantes, intervalo, encerramento e transições em RPCs e gatilhos. Não aceitar um cálculo de vencedor definido apenas no navegador.
- Na primeira migração, estender **scores.pontos** e as colunas correspondentes em **score_changes** para BIGINT. Preservar a faixa de 0 a 300 por regra SQL específica do boliche e validar os limites configurados do quiz no banco. Valores de pinball maiores que o inteiro seguro do JavaScript atravessam a API como texto decimal e são comparados com BigInt; nunca por Number ou ponto flutuante.
- Usar tabelas filhas pequenas para informação que o resultado único não expressa: **round_scores** para pontos por rodada de quiz/gincana; **match_sets** para sets/rodadas de confronto; **timed_results** para duração, DNF/DNS e tentativa quando necessário; **darts_turns** para lançamentos do 501. Cada tabela tem chave única, vínculo com encontro/partida e regras RLS. Não criar todas antes da respectiva entrega.
- Atualizar **sync_game_status**, **guard_game_status**, **save_game_scores**, **undo_score_change**, encerramento de encontro e funções de chave para considerar a condição de conclusão da modalidade. Cada escrita em tabela filha e no resultado consolidado ocorre em uma única transação/RPC; escrita direta que contorne a regra é rejeitada. Correções após encerramento requerem reabertura administrativa já existente.
- Para confronto individual, cada partida tem dois participantes e o vencedor é derivado de sets confirmados. Uma equipe pode ter múltiplos jogadores, mas confrontos entre equipes só entram após regra explícita de composição. A chave eliminatória recebe o vencedor confirmado, jamais uma sugestão do cliente.

### 5.2. Interface e integração

- Preservar navegação Placar, Histórico, Competições e Administração. Na criação do encontro, escolher modalidade e modelo de regra. Mostrar um resumo de como se vence antes de salvar.
- Renderizar apenas controles adequados ao encontro: ranking, unidade, formulário e rótulos contextuais. Foto do placar, OCR e tablet por frames aparecem apenas no boliche até existir um adaptador testado para outra modalidade.
- Reusar compartilhamento/QR, Realtime, perfis, avatares autorizados, exportação e PWA. Adicionar **game_type**, **rules_version**, unidade, rodadas/sets/tentativas e critério ao CSV/JSON sem expor autenticação ou fotos privadas.
- Preservar o rascunho de lançamento ao receber Realtime. Antes de sobrescrever um resultado que mudou em outro dispositivo, mostrar conflito e permitir comparar o valor local com o confirmado.

### 5.3. Segurança e compatibilidade

- Migrações novas após v13-throw-mode.sql; não editar scripts antigos para reconstruir instalações. Versões propostas: **v14-game-types.sql**, **v15-round-scores.sql**, **v16-match-sets.sql**, **v17-special-scores.sql** e **v18-darts.sql**, criadas apenas ao implementar cada incremento.
- Aplicar RLS e privilégios mínimos às novas tabelas e funções. Visitante lê apenas placar público; escrita fica com administrador ou com permissão específica e auditável, se a modalidade vier a exigir operadores. Palpites e fotos mantêm suas políticas existentes.
- Testar cada migração em banco de desenvolvimento com cópia **sem dados pessoais** ou conjunto sintético; ensaiar em transação com ROLLBACK quando viável; fazer backup verificável antes de produção. Implantar migração compatível, validar dados antigos, publicar frontend e executar smoke tests. GitHub Pages publicado não prova que o Supabase foi migrado.
- Ter plano de retorno por etapa: frontend anterior pode voltar sem apagar colunas/tabelas aditivas; após escrita de dados de modalidade nova, não reverter schema de modo destrutivo. Corrigir adiante com migração e, se preciso, ocultar a modalidade via configuração.

## 6. Backlog ordenado e critérios de aceite

| ID | História/entrega | Critério de aceite verificável | Arquivos principais |
| --- | --- | --- | --- |
| MJ01 | Como organizador, escolho um modelo de jogo para um encontro | Encontros existentes exibem boliche; tipo/regra não mudam após o primeiro lançamento; link de encontro continua válido | encounters.sql → v14-game-types.sql; app.js; index.html |
| MJ02 | Como operador, vejo formulário e unidade corretos | Modalidades não exibem OCR ou frames do boliche; boliche mantém ambos; 320 px sem rolagem horizontal da ação essencial | app.js; index.html; styles.css |
| MJ03 | Como administrador, publico sem violar regras | RPC rejeita participante ausente, jogo encerrado, valor inválido e usuário não autorizado; clique repetido mantém um resultado | hardening-p0.sql → v14-game-types.sql; tests/*.sql |
| MJ04 | Como operador de quiz, registro pontos por rodada | Pontos de cada rodada ficam auditáveis; total é derivado sem soma dupla; zero é válido; erro de uma rodada pode ser desfeito | v15-round-scores.sql; app.js; tests |
| MJ05 | Como grupo, vemos ranking individual e de equipes | Somente resultados elegíveis entram no oficial; empates dividem posição; equipe soma ou média conforme regra escolhida antes do início | competition.sql → v15-round-scores.sql; app.js; tests |
| MJ06 | Como visitante, consulto histórico e exportação | Encontros de jogos diferentes não se misturam; CSV/JSON trazem regra, unidade e dados para recompor o ranking; QR abre encontro certo | app.js; index.html; tests |
| MJ07 | Como operador, registro um confronto | Exatamente dois lados individuais; sets confirmados determinam vencedor; empate pendente exige regra definida; chave só avança com resultado final | v16-match-sets.sql; competition.sql → nova migração; app.js; tests |
| MJ08 | Como organizador, configuro tênis de mesa/truco | Modelo publicado mostra pontos-alvo, diferença e número de sets; servidor aplica a regra escolhida; versões anteriores mantêm seus resultados | v16-match-sets.sql; app.js; tests |
| MJ09 | Como operador, registro pinball | Pontuação acima de 300 funciona sem arredondamento; ranking ordena números grandes exatamente; auditoria/desfazer preservam o valor | v17-special-scores.sql; app.js; tests |
| MJ10 | Como operador, registro tempo ou tacadas | Menor valor vence; duração tem unidade explícita; DNF/DNS não viram zero nem primeiro lugar; empates compartilham posição | v17-special-scores.sql; app.js; tests |
| MJ11 | Como operador, registro 501 | Saldo inicia em 501; bust não reduz saldo; fechamento só ocorre com saída dupla no modelo escolhido; vitória só é confirmada após legs/sets completos | v18-darts.sql; app.js; tests |
| MJ12 | Como visitante, acompanho ao vivo | Dois dispositivos mostram a mesma posição após sincronização; reconexão busca estado confirmado; rascunho local não some | app.js; tests/app.test.cjs; teste manual |
| MJ13 | Como administrador, corrijo um erro | Histórico registra anterior/novo, ator e horário; desfazer usa transação; encontro encerrado bloqueia alteração direta até reabertura | novas migrações; app.js; testes SQL |
| MJ14 | Como usuário, navego em qualquer tela | Claro/escuro, teclado, foco, toque, diálogo e ranking legíveis em 320/390/768/1024 px; controles incompatíveis ausentes | index.html; styles.css; teste visual |
| MJ15 | Como Product Owner, libero cada incremento | Regressão de boliche, testes de regra/RLS e smoke de Supabase passam; piloto completa um encontro sem intervenção técnica | tests; README.md; evidência de piloto |

## 7. Sequência de entrega

| Etapa | Trabalho e dependências | Demonstração para aceite | Porta de passagem |
| --- | --- | --- | --- |
| D0 — Descoberta | Fichas de regras, exemplos, observação e linha de base | Fluxo de boliche e fluxo de quiz em celular | PO aprova regra e ordem do backlog |
| D1 — Base | MJ01–03; migração aditiva; catálogo; proteção no banco | Encontro antigo idêntico, encontro novo com modalidade fixa | Testes SQL e regressão de boliche aprovados |
| D2 — MVP | MJ04–06, MJ12–14 para quiz/gincana | Encontro de oito pessoas, três rodadas, equipe, exportação, QR e correção | Piloto com dois dispositivos e aceite do PO |
| D3 — Confrontos | MJ07–08; pebolim/sinuca; tênis de mesa; truco depois de regra regional aprovada | Chave de quatro/oito participantes sem avanço pendente | Regras de sets, empates e RLS aprovadas |
| D4 — Pontuações especiais | MJ09–10, cada família liberada separadamente | Pinball com placar grande; minigolfe/tempo com menor valor e DNF | Precisão, histórico e exportação aprovados |
| D5 — Dardos | MJ11 e regressão geral | 501 com bust, saída dupla e vencedor | Fluxo completo testado no celular/tablet |

Cada etapa termina com demonstração do incremento, decisão de aceitar/ajustar e ordenação do próximo conjunto. A equipe de desenvolvimento refina tamanho e tarefas; o Product Owner ordena e aceita valor. A Definition of Done é compartilhada, conforme o [Scrum Guide](https://scrumguides.org/docs/scrumguide/v2020/2020-Scrum-Guide-US.pdf).

## 8. Plano de validação

### Testes automatizados

1. **Compatibilidade:** fixture histórica de boliche conserva total, média, vencedor, status, pista, foto autorizada, exportação e lançamentos por frame.
2. **Regras de quiz:** várias rodadas, zero, correção, desfazer, soma única, empate, ranking por encontro e por equipe.
3. **Integridade e RLS:** visitante não grava; usuário comum não se torna administrador; encontro encerrado rejeita INSERT/UPDATE/DELETE e RPC; duplicidade concorrente retorna um resultado; modal e API rejeitam participante ausente.
4. **Confrontos:** dois lados, sets incompletos não avançam chave, vencedor após confirmação, critérios de desempate definidos por modalidade, reabertura e correção recálculam dependências.
5. **Pontuação especial:** 0–300 continua obrigatório no boliche; pinball usa valor acima de 300 e acima de 2^53 sem perda; menor tempo/tacadas classifica corretamente; DNF/DNS não é zero; 501 aplica bust e saída dupla.
6. **Exportação:** CSV seguro para planilha e JSON com schema_version e regra; reconstrução do ranking a partir do arquivo; ausência de e-mail, token e foto privada.
7. **Migração:** conjunto sintético dentro de transação ROLLBACK, inclusive banco sem partidas; legados viram boliche sem alterar resultados; contagens/constraints antes e depois.

### Testes manuais

- Celular 320/390/430 px, tablet 768/1024 px e desktop; temas claro/escuro; teclado, foco, Escape, diálogos e orientação. WCAG 2.2 AA como referência dos componentes alterados ([W3C](https://www.w3.org/TR/wcag/)).
- Dois dispositivos em redes distintas; criação, edição, correção, reconexão e atualização Realtime sem perda de rascunho.
- Boliche: foto real do monitor, OCR local, conferência, lançamento manual sem OCR e tablet por frames. Modos novos: entrada manual no celular.
- Projeto Supabase real: migrações e RLS verificados com contas anon, participante e administrador; GitHub Pages: arquivo publicado, cache/PWA e link/QR corretos. Registrar separadamente evidência de banco e de frontend.

**Definition of Done para cada história:** regra aprovada, migração e política RLS revisadas quando houver banco, testes determinísticos passando, fluxo funcional em celular, estados de erro/vazio/sucesso, tema e acessibilidade, histórico/exportação atualizados, documentação de implantação e demonstração aceita. Não declarar integração como validada sem execução no ambiente correspondente.

## 9. Riscos e resposta

| Risco | Sinal | Resposta e responsável |
| --- | --- | --- |
| Um ranking genérico produz vencedores incorretos | Modalidades com unidades diferentes aparecem misturadas | Um encontro/uma regra; rank específico e testes de exemplo; PO valida |
| Migração altera boliche histórico | Totais, status ou pistas mudam após backfill | Backup, ensaio, contagem e comparação de fixtures antes/depois; engenharia/QA |
| Condição de conclusão diverge entre UI e banco | Partida fecha cedo ou não fecha | RPC/gatilho por modalidade e teste direto na API; engenharia |
| Placar grande arredonda pontos | Valor de pinball muda no navegador/exportação | Texto decimal/BigInt e teste acima de 2^53; engenharia |
| Rascunho perdido pelo Realtime | Campo digitado muda sem ação do operador | Estado local isolado, detecção de conflito e teste em dois dispositivos; frontend/QA |
| Regras regionais indefinidas | Empate/truco suscita interpretação diferente | Ficha de regras e versão congelada; PO |
| Escopo compromete o MVP | Especializações atrasam quiz | Liberação por modalidade e porta de aceite por incremento; PM/PO |

## 10. Métricas e critérios de sucesso

Os números abaixo são **metas iniciais propostas**; medir linha de base na D0 e registrar revisão explícita do PO:

| Métrica | Como medir | Meta inicial para o piloto |
| --- | --- | --- |
| Tempo até o primeiro placar | Observação desde “Novo encontro” até primeiro resultado publicado | Mediana até 5 minutos |
| Tempo de uma rodada de oito pessoas | Observação da entrada manual e confirmação | Mediana até 2 minutos após cadastro |
| Conclusão sem ajuda | Organizador conclui quiz de três rodadas seguindo a interface | Pelo menos 4 de 5 tentativas |
| Integridade | Testes, auditoria de pontuação e feedback do piloto | Zero resultado duplicado ou perdido |
| Sincronização | Cronômetro entre confirmação no dispositivo A e exibição no B | 95% em até 5 segundos com conexão ativa |
| Reuso | Grupo cria um segundo encontro de modalidade diferente | Pelo menos um grupo piloto conclui o segundo encontro |

Usar registro agregado de tempos e falhas, sem adicionar serviço de analytics pago. Fracassos geram ajuste de backlog; aprovação de release depende sobretudo de integridade e conclusão do fluxo.

## 11. Governança, implantação e definição de pronto do programa

- **Product Owner:** mantém Product Goal, ordena backlog, aprova fichas de regras e aceita/rejeita incrementos demonstrados. **Product Manager:** observa usuários, mede resultado, registra hipóteses e recomenda priorização. **Engenharia:** decompõe trabalho, estima e mantém qualidade. **QA:** prova critérios e regressões. Base dos papéis: [Scrum Guide](https://scrumguides.org/docs/scrumguide/v2020/2020-Scrum-Guide-US.pdf).
- **Cadência:** refinamento curto antes de cada etapa; demonstração e decisão de release ao final. Manter tarefas técnicas dentro da história correspondente, sem roteiro paralelo de funcionalidades não pedidas.
- **Aplicação:** branch de implementação com commits pequenos; migrações versionadas; ensaio com ROLLBACK e backup antes do banco real; confirmar RLS, funções, dados legados e Realtime; depois publicar GitHub Pages; smoke com visitante e admin; registrar commit, versão de migração e evidências. Seguir fluxo de migrações versionadas do [Supabase](https://supabase.com/docs/guides/deployment) e validar políticas conforme a [documentação de RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).
- **Pronto do programa:** boliche intacto, MVP de quiz/gincana utilizado por grupo piloto, demais famílias concluídas conforme suas portas de passagem, histórico e exportação consistentes, acesso público de leitura e escrita protegida, testes de regra/RLS aprovados, implantação efetivamente verificada e pendências materiais registradas.

## 12. Registro de decisões de escopo

1. **Primeira modalidade nova:** quiz/gincana por rodadas não negativas, individual e por equipes.
2. **Unidade de competição:** encontro; ranking oficial não combina modalidades.
3. **Automação de captura:** boliche mantém OCR; novas modalidades começam com entrada manual.
4. **Confrontos:** primeiro individuais; confronto entre equipes depende de regra própria de composição.
5. **Especializações:** pinball, menor tempo/tacadas e 501 são entregas separadas, com validação de banco específica.
6. **Regra de federação:** usar como referência apenas se o grupo escolher o modelo; mesa com 11 pontos e vantagem de 2 segue os [estatutos de 2026 da ITTF](https://db.ittf.com/sites/default/files/public/2026-02/2026_Statutes_v1_consolidated_clean.pdf); 501 com saída dupla tem referência na [WDF](https://dartswdf.com/storage/uploads/be7ad99c-3d8b-4dbf-ab49-51c7c320d05e/2025-01-01_World_Ranking_Systems_Criteria_Seniors_45.pdf); cubo por tempo e DNF consulta a [WCA](https://www.worldcubeassociation.org/regulations/). Regras recreativas alternativas exigem ficha própria.
