# Boliche dos Amigos

Score Board estático, em HTML/CSS/JavaScript puro, adaptado para importar fotos dos placares das pistas, conferir os resultados e publicar um ranking compartilhado.

## Executar localmente

```bash
python3 -m http.server 4173
```

Abra `http://localhost:4173`. Sem uma publishable key preenchida, a interface permanece vazia e informa que o Supabase precisa ser configurado; nenhum jogador ou partida fictícia é criado.

## Configurar o Supabase

1. Abra o SQL Editor do projeto e execute [`schema.sql`](schema.sql).
2. Execute [`registration.sql`](registration.sql) para habilitar cadastro, perfis e fotos privadas.
3. Execute [`admin-password-auth.sql`](admin-password-auth.sql) para exigir login com senha nas operações administrativas, inclusive após recuperação.
4. Execute [`hardening-p0.sql`](hardening-p0.sql) para bloquear autoaprovação, vincular perfis a jogadores existentes, salvar pontos em transação, sincronizar o status da partida e registrar alterações.
5. Execute [`management.sql`](management.sql) para habilitar edição e exclusão administrativa de pistas, partidas, resultados, jogadores e contas.
6. Execute [`public-ranking-photos.sql`](public-ranking-photos.sql) e imediatamente [`v12-profile-privacy.sql`](v12-profile-privacy.sql). A segunda restringe a leitura pública às fotos aprovadas, vinculadas e autorizadas pelo dono; não publique uma versão intermediária da interface entre as duas migrações.
7. Execute [`encounters.sql`](encounters.sql) e depois [`competition.sql`](competition.sql). A primeira migração reúne os dados existentes em um encontro inicial ativo, registra a pista em cada pontuação e cria preparação, encerramento e reabertura; a segunda habilita equipes, torneio e palpites. Ensaie em transação com `ROLLBACK` no projeto antes da aplicação.
8. Crie a conta do administrador em Authentication → Users.
9. Marque o usuário com `app_metadata.role = "admin"` usando o SQL comentado no final de `schema.sql` (ou pelo fluxo administrativo equivalente). O frontend não confia em um campo editável pelo navegador. Se o administrador também jogar, aprove e vincule seu perfil ao jogador correspondente.
10. Copie a Project URL e a Publishable Key para [`supabase-config.js`](supabase-config.js). A URL e a publishable/anon key podem estar no navegador; nunca coloque `service_role` no repositório.
11. No Storage, edite o bucket privado `profile-photos` e restrinja os tipos a JPEG, PNG e WebP e o tamanho a 5 MB. O navegador reduz fotos grandes e converte formatos que conseguir abrir para JPEG antes do envio; o bucket aplica os limites no servidor.
12. Publique a pasta raiz na branch `main` pelo GitHub Pages.

As políticas permitem leitura pública de jogadores, partidas, pontos e somente fotos de perfis aprovados, vinculados e com autorização explícita. A escrita do placar exige um usuário autenticado com `app_metadata.role = "admin"` e sessão de login com senha. A foto do placar é processada localmente com Tesseract.js e não é enviada ao Supabase.

O cadastro público usa `auth.users` + `public.profiles`: qualquer pessoa pode criar a própria conta e concluir o perfil com uma foto obrigatória. O perfil começa como `pending`; somente o administrador pode aprovar e vincular a um jogador existente. As fotos ficam no bucket privado `profile-photos`; a foto aprovada e vinculada aparece no ranking público por URL assinada de cinco minutos somente após autorização específica do próprio usuário. A autorização pode ser revogada no cadastro. O formulário oferece câmera e galeria e mostra a foto já salva ao reabrir o cadastro. Depois da substituição, fotos antigas sem referência são removidas; falhas de limpeza são exibidas.

## Regras de negócio implementadas

- A pontuação é substituída por `(game_id, player_id)`, nunca somada em uma nova importação.
- O OCR é sugestão: a tabela de conferência é editável e campos ilegíveis ficam pendentes. O total só é sugerido quando a posição e a sequência dos números indicam a última coluna; linhas ambíguas exigem preenchimento manual. Reimportar o mesmo total preserva a confirmação, mas alterar o valor exige nova confirmação.
- A associação usa participante e pista, não a posição na tela do monitor.
- Uma partida só fica `final` quando todos os resultados vinculados têm pontos e foram confirmados.
- O ranking acumulado soma somente partidas `final`.
- O ranking e a partida atual mostram a foto do jogador quando o perfil está aprovado e vinculado. A URL assinada é renovada ao voltar à página e periodicamente enquanto ela estiver aberta.
- A navegação usa uma barra superior horizontal. No celular, os atalhos podem ser deslizados lateralmente.
- O ranking oficial mostra um pódio. O perfil do jogador reúne foto, posição, recorde, média, vitórias, histórico e gráfico de evolução.
- A opção de compartilhar pode gerar uma imagem PNG com o pódio e a classificação oficial; enquanto não houver partida finalizada, essa imagem não é gerada.
- A foto do placar pode ser girada, ampliada e ter o contraste ajustado antes do recorte e da leitura OCR. No celular, o botão alterna entre mover a imagem ampliada e recortar; os pontos continuam sujeitos à conferência.
- Alterações em `players`, `games` e `scores` chegam aos visitantes por Supabase Realtime.
- O painel da partida exibe uma classificação provisória, separada do ranking oficial. O administrador pode corrigir pontos pelo celular sem foto e consultar/desfazer a última alteração de cada resultado.
- O botão Compartilhar mostra um QR Code estático para o endereço público do placar.
- O manifesto e o service worker permitem instalar a interface como PWA. O cache cobre apenas arquivos do site; resultados e autenticação continuam exigindo conexão com o Supabase.
- O administrador pode renomear ou remover pistas vazias, editar participantes e partidas, limpar pontuações e excluir partidas/jogadores. O ranking oficial é calculado a partir dos pontos das partidas finalizadas; correções e exclusões o recalculam. Excluir um jogador ou partida apaga seus resultados e registros de alteração.
- Cada encontro tem participantes, partidas e ranking próprios. O administrador prepara o encontro, inicia a competição, encerra com todas as partidas concluídas e pode reabrir para correções. A pista fica gravada em cada resultado da partida; mudar a pista padrão do cadastro não altera o histórico. A capacidade de cada pista é configurável, e o sorteio distribui jogadores de modo equilibrado sem ultrapassá-la.
- O ranking do encontro alterna entre pontos acumulados, média e melhor partida; mostra quantas partidas cada pessoa jogou e permite filtrar pela pista usada naquela partida. A partida atual exibe por pista os totais de participantes, pontos informados, confirmados, pendentes e o percentual.
- CSV em UTF-8 com BOM e delimitador `;`, e JSON com `schema_version`, exportam todos os encontros, participantes, partidas, pistas por participação, pontos e rankings consolidados. Textos de CSV são protegidos contra interpretação como fórmulas.
- Equipes próprias do encontro têm classificação por soma ou média de seus integrantes, e um jogador não pode estar em duas equipes no mesmo encontro. A chave eliminatória usa quatro ou oito jogadores e resultados reais de até três rodadas, com desempate pela posição na chave configurada pelo administrador. Palpites de participantes aprovados são feitos para o vencedor do encontro durante a preparação ou até o prazo definido; o banco bloqueia palpites tardios. Recordes históricos e modo telão, com alternância entre ranking oficial e provisório, completam a visualização.
- A aba de aprovações permite editar o nome do perfil e excluir contas de Auth. A exclusão remove as fotos pelo Storage antes de chamar uma função protegida no banco; se a remoção da conta falhar depois das fotos, o painel avisa para tentar novamente. O e-mail e a senha são gerenciados pelo fluxo de autenticação.

## Verificação local

```bash
node tests/app.test.cjs
```

Os testes cobrem OCR, conferência, ranking isolado por encontro, pista histórica, chave eliminatória, perfil e importação transacional. As migrações SQL devem ser verificadas no projeto Supabase antes de publicar o frontend.

Depois de aplicar todas as migrações, execute [`tests/transaction-smoke.sql`](tests/transaction-smoke.sql), [`tests/management-smoke.sql`](tests/management-smoke.sql), [`tests/encounter-smoke.sql`](tests/encounter-smoke.sql) e [`tests/privacy-smoke.sql`](tests/privacy-smoke.sql) no SQL Editor. Cada teste cria seus próprios registros sintéticos e termina com `ROLLBACK`.

O teste de encontro cobre pista histórica, rankings isolados, idempotência de criação, equipes, chave, bloqueio após encerramento e reabertura.
