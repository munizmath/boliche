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
3. Crie a conta do administrador em Authentication → Users.
4. Marque o usuário com `app_metadata.role = "admin"` usando o SQL comentado no final de `schema.sql` (ou pelo fluxo administrativo equivalente). O frontend não confia em um campo editável pelo navegador.
5. Copie a Project URL e a Publishable Key para [`supabase-config.js`](supabase-config.js). A URL e a publishable/anon key podem estar no navegador; nunca coloque `service_role` no repositório.
6. Publique a pasta raiz na branch `main` pelo GitHub Pages.

As políticas permitem leitura pública das três tabelas e escrita apenas para usuários autenticados cujo `app_metadata.role` seja `admin`. A foto do placar é processada localmente com Tesseract.js e não é enviada ao Supabase.

O cadastro público usa `auth.users` + `public.profiles`: qualquer pessoa pode criar a própria conta e concluir o perfil com uma foto obrigatória. O perfil começa como `pending`; ele não vira jogador automaticamente e não concede acesso administrativo. As fotos ficam no bucket privado `profile-photos`, isoladas por usuário.

## Regras de negócio implementadas

- A pontuação é substituída por `(game_id, player_id)`, nunca somada em uma nova importação.
- O OCR é sugestão: a tabela de conferência é editável e campos ilegíveis ficam pendentes.
- A associação usa participante e pista, não a posição na tela do monitor.
- Uma partida só fica `final` quando todos os resultados vinculados têm pontos e foram confirmados.
- O ranking acumulado soma somente partidas `final`.
- Alterações em `players`, `games` e `scores` chegam aos visitantes por Supabase Realtime.
