# Terminais tmux (GAB)

Cada aba de terminal do VS Code e uma sessao tmux persistente. Esta extensao
lista essas sessoes na barra lateral e reabre as abas — sem `Reload Window` e
sem depender do `tasks.json` no Google Drive.

## O que ela corrige

O mecanismo anterior gerava as abas dentro de `.vscode/tasks.json` e as abria
com uma task `runOn: folderOpen`. Dois problemas vinham dai:

1. **A lista so era montada na abertura da pasta.** Terminal criado ou
   renomeado depois disso so aparecia com um Reload Window.
2. **O `tasks.json` vive no Google Drive.** Quando o Drive monta depois do
   login, o arquivo nao esta la, a task nao roda e o VS Code sobe sem aba
   nenhuma — mesmo com todas as sessoes tmux vivas.

A extensao le o tmux direto e cria as abas pela API do VS Code, entao nao
depende de arquivo em pasta sincronizada nem do momento do `folderOpen`.

## O que ela NAO decide

Quem vira aba (a "catraca") continua sendo decidido pelo `gab-terminais-sync`,
lido aqui por `gab-terminais-sync --listar`. A regra mora num lugar so: sessao
de nome proprio sempre entra; `terminal-N` so entra se tiver algo dentro.
Duplicar essa regra na extensao seria garantir que as duas versoes divirjam.

## Instalacao

Pelo instalador completo (tmux, scripts `gab-*`, hooks e a extensao): baixe o
`Terminais-tmux-instalador.zip` da ultima release e rode `bash instalar.sh`.

So a extensao, num Mac que ja tem o resto:

```bash
curl -fsSL -o /tmp/gab-terminais.vsix \
  https://github.com/LeirbagGI/gab-terminais-vscode/releases/latest/download/gab-terminais.vsix
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension /tmp/gab-terminais.vsix --force
```

## Atualizacao

A partir da 1.4.0 a extensao se atualiza sozinha: ao abrir o VS Code (e a cada
6 h) ela confere a ultima release deste repositorio e, se houver versao nova,
mostra **Atualizar**. Tambem da para pedir na hora: `Terminais tmux: Procurar
atualizacao` na Command Palette. Desliga em `gabTerminais.verificarAtualizacoes`.

Para publicar uma versao nova: `./publicar.sh 1.5.0 "o que mudou"`.

## Uso

A lista aparece no Explorer, como **Terminais tmux**.

| Acao | Onde |
|---|---|
| Abrir um terminal | clique no nome |
| Reabrir as abas que estavam abertas | botao no topo da lista |
| Abrir todas as sessoes | paleta: `Terminais tmux: Abrir todos` (raramente e o que se quer) |
| Renomear | icone de lapis no item |
| Encerrar de vez | icone de lixeira no item (pede confirmacao) |
| Destravar o teclado (copy-mode) | paleta: `Terminais tmux: Destravar teclado` |

Marcas ao lado do nome: `aberto` (ja tem aba nesta janela), o programa que roda
dentro (`claude`, `python`...), `travado (copy-mode)` e `vazio` (nao entra em
"Abrir todos" nem volta depois de um reboot).

## A troca com o tasks.json

Na primeira vez, a extensao pergunta se pode **assumir as abas**. Enquanto
voce nao aceitar, ela nao abre nada — com o `folderOpen` ligado e a extensao
abrindo junto, as abas nasceriam duplicadas.

Aceitar cria `~/.gab-terminais-sem-folderopen`, que faz o `gab-terminais-sync`
parar de emitir o gatilho `folderOpen`. A task "Abrir meus terminais" continua
existindo para uso manual. Para voltar atras: `Terminais tmux: Devolver as abas
ao tasks.json`.

## O que ela restaura depois de um reboot

**As abas que estavam abertas — nem mais, nem menos.** Ter 50 sessoes guardadas
no tmux nao significa querer 50 abas na tela: a maioria fica dormindo, viva, e
so e aberta quando faz falta. A extensao registra em
`~/.gab-terminais-abertas.json` quais abas estao abertas (2,5s depois de cada
mudanca) e reabre exatamente essa lista.

Lista vazia nunca e gravada: no fechamento do VS Code todas as abas sao
descartadas de uma vez, e se isso virasse registro o proximo login abriria nada.

## Configuracao

| Opcao | Padrao | O que faz |
|---|---|---|
| `gabTerminais.abrirAoIniciar` | `true` | Abre as abas quando a janela inicia (so depois de "Assumir as abas") |
| `gabTerminais.intervalo` | `5` | Segundos entre releituras da lista |
| `gabTerminais.mostrarVazios` | `true` | Mostra os `terminal-N` vazios, marcados como `vazio` |

## Depende de

`~/bin/gab-attach`, `~/bin/gab-terminais-sync` (com `--listar`), `~/bin/gab-fechar`
e `~/bin/gab-renomear`.

## Cuidados que o codigo respeita

- **Nunca renomeia so no tmux.** O nome e chave em cinco lugares (mapa de
  conversas, programas, manifesto, registro de nomes e os arquivos de tela);
  por isso o rename passa pelo `gab-renomear`.
- **Adota abas existentes** em vez de criar outra para a mesma sessao — e o que
  impede a lista de duplicar durante a transicao.
- **So a janela aberta no workspace registrado** abre abas sozinha. Duas
  janelas abrindo as mesmas sessoes brigariam: o `gab-attach` usa
  `new-session -A -D`, que rouba a sessao do outro cliente.
