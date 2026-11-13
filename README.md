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
6. Crie a conta do administrador em Authentication → Users.
7. Marque o usuário com `app_metadata.role = "admin"` usando o SQL comentado no final de `schema.sql` (ou pelo fluxo administrativo equivalente). O frontend não confia em um campo editável pelo navegador.
8. Copie a Project URL e a Publishable Key para [`supabase-config.js`](supabase-config.js). A URL e a publishable/anon key podem estar no navegador; nunca coloque `service_role` no repositório.
9. No Storage, edite o bucket privado `profile-photos` e restrinja os tipos a JPEG, PNG e WebP e o tamanho a 5 MB. O navegador também valida esses limites, mas o bucket deve aplicá-los no servidor.
10. Publique a pasta raiz na branch `main` pelo GitHub Pages.

As políticas permitem leitura pública das três tabelas e escrita apenas para usuários autenticados cujo `app_metadata.role` seja `admin` e cuja sessão tenha login com senha. A foto do placar é processada localmente com Tesseract.js e não é enviada ao Supabase.

O cadastro público usa `auth.users` + `public.profiles`: qualquer pessoa pode criar a própria conta e concluir o perfil com uma foto obrigatória. O perfil começa como `pending`; somente o administrador pode aprovar e vincular a um jogador existente. As fotos ficam no bucket privado `profile-photos`, isoladas por usuário.

## Regras de negócio implementadas

- A pontuação é substituída por `(game_id, player_id)`, nunca somada em uma nova importação.
- O OCR é sugestão: a tabela de conferência é editável e campos ilegíveis ficam pendentes.
- A associação usa participante e pista, não a posição na tela do monitor.
- Uma partida só fica `final` quando todos os resultados vinculados têm pontos e foram confirmados.
- O ranking acumulado soma somente partidas `final`.
- Alterações em `players`, `games` e `scores` chegam aos visitantes por Supabase Realtime.
- O painel da partida exibe uma classificação provisória, separada do ranking oficial. O administrador pode corrigir pontos pelo celular sem foto e consultar/desfazer a última alteração de cada resultado.
- O botão Compartilhar mostra um QR Code estático para o endereço público do placar.
- O manifesto e o service worker permitem instalar a interface como PWA. O cache cobre apenas arquivos do site; resultados e autenticação continuam exigindo conexão com o Supabase.
- O administrador pode renomear ou remover pistas vazias, editar participantes e partidas, limpar pontuações e excluir partidas/jogadores. O ranking oficial é calculado a partir dos pontos das partidas finalizadas; correções e exclusões o recalculam. Excluir um jogador ou partida apaga seus resultados e registros de alteração.
- A aba de aprovações permite editar o nome do perfil e excluir contas de Auth. A exclusão remove as fotos pelo Storage antes de chamar uma função protegida no banco; se a remoção da conta falhar depois das fotos, o painel avisa para tentar novamente. O e-mail e a senha são gerenciados pelo fluxo de autenticação.

## Verificação local

```bash
node tests/app.test.cjs
```

Os testes cobrem associação do OCR somente a jogadores vinculados, conferência manual e escala do recorte. A migração SQL deve ser verificada no projeto Supabase antes de publicar o frontend.

Depois de aplicar `hardening-p0.sql`, execute [`tests/transaction-smoke.sql`](tests/transaction-smoke.sql) no SQL Editor. O teste finaliza e desfaz uma partida dentro de uma transação encerrada com `ROLLBACK`.
