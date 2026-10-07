// Terminais tmux (GAB) — cada aba do VS Code e uma sessao tmux persistente.
//
// O que esta extensao substitui: antes, a lista de abas era gerada dentro do
// .vscode/tasks.json e aberta por uma task com runOn: folderOpen. Isso tinha
// dois defeitos que esta extensao existe para corrigir:
//
//   1. A lista so era montada NA ABERTURA DA PASTA. Um terminal criado ou
//      renomeado depois disso nao aparecia ate um Reload Window.
//   2. O tasks.json vive no Google Drive. Quando o Drive monta depois do login,
//      o arquivo nao esta la, a task nao roda e o VS Code sobe sem aba nenhuma
//      — mesmo com todas as sessoes tmux vivas.
//
// A extensao le as sessoes direto do tmux e cria as abas pela API do VS Code,
// entao nao depende de arquivo em pasta sincronizada nem do momento do
// folderOpen.
//
// O que ela NAO faz de proposito: decidir quem vira aba. Essa regra (a
// "catraca") mora no gab-terminais-sync e e lida por `gab-terminais-sync
// --listar`. Duplicar a regra aqui seria garantir que as duas versoes
// divirjam na primeira vez que uma delas mudasse.

const vscode = require('vscode');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const HOME = os.homedir();
const MANIFESTO = path.join(HOME, '.gab-terminais.json');
const FLAG_FOLDEROPEN = path.join(HOME, '.gab-terminais-sem-folderopen');
const ARQ_WORKSPACE = path.join(HOME, '.gab-terminais-workspace');
const ARQ_ABERTAS = path.join(HOME, '.gab-terminais-abertas.json');
const ARQ_APARENCIA = path.join(HOME, '.gab-terminais-aparencia.json');
const ARQ_ICONES = path.join(HOME, '.gab-terminais-icones.json');
const ARQ_CRIACAO = path.join(HOME, '.gab-terminais-criacao.json');
const ARQ_ORDEM = path.join(HOME, '.gab-terminais-ordem.json');        // ordem das abas que a extensao conhece
const ARQ_ORDEM_MANUAL = path.join(HOME, '.gab-terminais-ordem-manual'); // bandeira: a pessoa arrumou as abas
const PERFIL = 'tmux (persistente)';   // nome das abas criadas pelo botao +
const ARQ_ATIVA = path.join(HOME, '.gab-terminais-ativa');
const ARQ_LOG = path.join(HOME, 'Library', 'Logs', 'gab-terminais-extensao.log');

// Log curto do que a extensao decide ao abrir. Serve para diagnosticar outros
// computadores: "o que aconteceu?" vira ler este arquivo.
function log(msg) {
  try {
    const st = fs.existsSync(ARQ_LOG) ? fs.statSync(ARQ_LOG) : null;
    if (st && st.size > 512 * 1024) fs.renameSync(ARQ_LOG, ARQ_LOG + '.1');
    fs.appendFileSync(ARQ_LOG, `[${new Date().toLocaleString('pt-BR')}] ${msg}\n`);
  } catch (e) { /* log nunca quebra nada */ }
}

// --- aparencia de cada sessao (nome da aba, icone, cor) ----------------------
//
// A API do VS Code deixa ler o NOME de uma aba, mas nao o icone nem a cor que o
// usuario escolhe no menu nativo. Por isso icone e cor sao trocados pelo
// comando da extensao ("Mudar icone e cor"), que grava aqui. O nome e gravado
// sozinho quando a aba e renomeada. Chave = sessao tmux, entao vale mesmo com a
// aba fechada e depois de reboot.
function lerJSON(arq) {
  try { return JSON.parse(fs.readFileSync(arq, 'utf8')) || {}; } catch (e) { return {}; }
}

function gravarJSON(arq, dados) {
  try {
    const tmp = `${arq}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(dados, null, 2));
    fs.renameSync(tmp, arq);
  } catch (e) { /* sem registro e melhor do que quebrar a janela */ }
}

function aparenciaDe(sessao) {
  const antigo = lerJSON(ARQ_ICONES)[sessao] || {};      // usado tambem pelo tasks.json
  const ap = lerJSON(ARQ_APARENCIA)[sessao] || {};
  return {
    nome: ap.nome || '',
    icone: ap.icone || antigo.id || 'terminal',
    cor: ap.cor || antigo.color || '',
  };
}

const RODIZIO = ['terminal.ansiMagenta', 'terminal.ansiRed', 'terminal.ansiGreen',
  'terminal.ansiBlue', 'terminal.ansiYellow', 'terminal.ansiCyan'];
function corPadrao(nome) {
  let h = 0;
  for (const ch of nome) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return RODIZIO[h % RODIZIO.length];
}

function mudarAparencia(sessao, mudancas) {
  const todas = lerJSON(ARQ_APARENCIA);
  const ap = { ...(todas[sessao] || {}), ...mudancas };
  for (const k of Object.keys(ap)) if (!ap[k]) delete ap[k];
  if (Object.keys(ap).length) todas[sessao] = ap; else delete todas[sessao];
  gravarJSON(ARQ_APARENCIA, todas);
  // O tasks.json (gab-terminais-sync) le icone e cor daqui.
  if (mudancas.icone !== undefined || mudancas.cor !== undefined) {
    const ic = lerJSON(ARQ_ICONES);
    const atual = aparenciaDe(sessao);
    ic[sessao] = { id: atual.icone, color: atual.cor && atual.cor !== 'nenhuma' ? atual.cor : 'terminal.ansiWhite' };
    gravarJSON(ARQ_ICONES, ic);
  }
}

const bin = (n) => path.join(HOME, 'bin', n);

function conf(chave, padrao) {
  const v = vscode.workspace.getConfiguration('gabTerminais').get(chave);
  return v === undefined || v === null || v === '' ? padrao : v;
}

// O tmux pode estar fora dos lugares de sempre (MacPorts, conda, Homebrew em
// outra pasta). Ordem: os caminhos conhecidos, o atalho ~/bin/tmux que o
// instalador cria, e por ultimo o shell de login do usuario (uma vez so).
let tmuxAchado = null;
function tmuxBin() {
  if (tmuxAchado) return tmuxAchado;
  const candidatos = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', path.join(HOME, 'bin', 'tmux'),
    '/opt/local/bin/tmux', '/usr/bin/tmux'];
  for (const b of candidatos) {
    try { fs.accessSync(b, fs.constants.X_OK); tmuxAchado = b; return b; } catch (e) { /* proximo */ }
  }
  try {
    const achado = require('child_process')
      .execFileSync('/bin/zsh', ['-lic', 'command -v tmux'], { timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().split('\n').pop();
    if (achado && achado.startsWith('/')) {
      fs.accessSync(achado, fs.constants.X_OK);
      tmuxAchado = achado;
      return achado;
    }
  } catch (e) { /* nao ha tmux no PATH do usuario */ }
  return 'tmux';
}

function rodar(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => {
      resolve({ ok: !err, saida: out || '', erro: (errOut || (err && err.message) || '').trim() });
    });
  });
}

// --- leitura do estado ------------------------------------------------------

// Tres chamadas no total, nao importa se sao 5 ou 500 sessoes. E barato o
// bastante para rodar a cada poucos segundos — ao contrario do teste da
// catraca, que gasta dois processos POR sessao.
//
// O programa que roda em cada painel vem do `ps`, e nao do
// `#{pane_current_command}` do tmux, que aqui mente de dois jeitos: numa sessao
// com claude ele devolve "2.1.285" (o nome da pasta versionada do executavel) e
// noutra devolve "zsh", embora o claude esteja rodando como filho. O mapa
// pai -> filhos resolve os dois casos com uma chamada so.
async function sessoesVivas() {
  const t = tmuxBin();
  const [ls, paineis, ps] = await Promise.all([
    rodar(t, ['list-sessions', '-F', '#{session_name}\t#{session_path}']),
    rodar(t, ['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}\t#{pane_in_mode}']),
    rodar('/bin/ps', ['-axo', 'ppid=,comm=']),
  ]);
  const filhos = new Map();
  for (const linha of ps.saida.split('\n')) {
    const corte = linha.trim().indexOf(' ');
    if (corte < 0) continue;
    const pai = linha.trim().slice(0, corte);
    const comm = path.basename(linha.trim().slice(corte + 1).trim());
    if (!filhos.has(pai)) filhos.set(pai, []);
    filhos.get(pai).push(comm);
  }
  const info = new Map();
  for (const linha of paineis.saida.split('\n')) {
    const p = linha.split('\t');
    if (p.length === 3 && !info.has(p[0])) {
      const dentro = filhos.get(p[1]) || [];
      info.set(p[0], { comando: dentro[0] || '', copyMode: p[2] === '1' });
    }
  }
  const out = [];
  for (const linha of ls.saida.split('\n')) {
    if (!linha.trim()) continue;
    const i = linha.indexOf('\t');
    const nome = i < 0 ? linha : linha.slice(0, i);
    if (nome.startsWith('__')) continue;   // sessoes internas
    out.push({
      nome,
      cwd: i < 0 ? HOME : linha.slice(i + 1),
      ...(info.get(nome) || { comando: '', copyMode: false }),
    });
  }
  return out;
}

// Data em que cada terminal foi aberto pela primeira vez — e a ordem das abas.
// O #{session_created} do tmux sozinho nao serve: depois de um reboot o
// gab-terminais-restore recria as sessoes e todas ganham a hora do boot. Por
// isso a data e gravada na primeira vez que a sessao aparece e so pode recuar.
async function datasDeCriacao() {
  const r = await rodar(tmuxBin(), ['list-sessions', '-F', '#{session_name}\t#{session_created}']);
  const datas = lerJSON(ARQ_CRIACAO) || {};
  let mudou = false;
  for (const linha of r.saida.split('\n')) {
    const i = linha.indexOf('\t');
    if (i < 0) continue;
    const nome = linha.slice(0, i);
    const ms = Number(linha.slice(i + 1)) * 1000;
    if (ms && !(datas[nome] <= ms)) { datas[nome] = ms; mudou = true; }
  }
  if (mudou) gravarJSON(ARQ_CRIACAO, datas);
  return datas;
}

// Ordena pela data de abertura; empate (sessoes recriadas no mesmo boot antes
// de existir o registro) fica na ordem em que ja estava.
async function porData(lista) {
  const datas = await datasDeCriacao();
  const d = (x) => datas[nomeDe(x)] || Infinity;
  return lista.map((x, i) => [x, i])
    .sort((a, b) => (d(a[0]) - d(b[0])) || (a[1] - b[1]))
    .map((p) => p[0]);
}

// Quem VIRA ABA — decidido pelo gab-terminais-sync, nunca aqui.
async function queViramAba() {
  const r = await rodar(bin('gab-terminais-sync'), ['--listar']);
  try { return JSON.parse(r.saida); } catch (e) { return null; }
}

// So a janela aberta no workspace registrado abre abas sozinha. Sem esta
// guarda, duas janelas do VS Code abririam as mesmas 50 sessoes e brigariam
// por elas: o gab-attach usa `new-session -A -D`, que ROUBA a sessao do outro
// cliente, entao as duas janelas ficariam se desconectando em looping.
function janelaDona() {
  let alvo = '';
  try { alvo = fs.readFileSync(ARQ_WORKSPACE, 'utf8').trim(); } catch (e) { return true; }
  if (!alvo) return true;
  const pastas = vscode.workspace.workspaceFolders || [];
  return pastas.some((p) => path.resolve(p.uri.fsPath) === path.resolve(alvo));
}

// --- abas -------------------------------------------------------------------

const abertos = new Map();   // nome da sessao -> vscode.Terminal

// Qual sessao tmux uma aba mostra. NAO da para usar t.name: o titulo da aba
// pode ser renomeado no VS Code (foi assim que "EDVID" virou "EDITOR VIDEO" e
// sumiu ao reabrir). O gab-attach da exec no tmux, entao o processId da aba E o
// pid do cliente tmux — e o tmux sabe em que sessao cada cliente esta.
async function clientesTmux() {
  const r = await rodar(tmuxBin(), ['list-clients', '-F', '#{client_pid}\t#{client_session}']);
  const m = new Map();
  for (const linha of r.saida.split('\n')) {
    const i = linha.indexOf('\t');
    if (i > 0) m.set(Number(linha.slice(0, i)), linha.slice(i + 1));
  }
  return m;
}

// A sessao que a aba foi criada para mostrar: "gab-attach NOME". Aba que o
// proprio VS Code recriou (persistencia nativa) tem essa linha de comando antes
// mesmo de o tmux conectar — e o que evita a extensao abrir outra por cima.
function sessaoDoComando(t) {
  const o = t.creationOptions || {};
  const args = Array.isArray(o.shellArgs) ? o.shellArgs : [];
  return typeof o.shellPath === 'string' && o.shellPath.endsWith('/gab-attach') && args[0] ? args[0] : null;
}

function criadaPeloPerfil(t) {
  const o = t.creationOptions || {};
  return t.name === PERFIL || (typeof o.shellPath === 'string' && o.shellPath.endsWith('/gab-novo'));
}

// Sessoes que JA aparecem numa aba do VS Code: tem um cliente tmux cujo pai e
// o processo de terminais do VS Code (ptyHost). No reload/reabertura com a
// persistencia nativa, o VS Code reconecta/recria as abas (com icone e cor)
// antes ou logo depois de a extensao ativar. Abrir outra aba para essas
// sessoes derrubava as do VS Code (o gab-attach usa -D) e o icone se perdia.
async function sessoesEmAbasDoVSCode() {
  const [cl, ps] = await Promise.all([
    rodar(tmuxBin(), ['list-clients', '-F', '#{client_pid}\t#{client_session}']),
    rodar('/bin/ps', ['-axo', 'pid=,ppid=,comm=']),
  ]);
  const pai = new Map();
  const nome = new Map();
  for (const linha of ps.saida.split('\n')) {
    const m = linha.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m) { pai.set(m[1], m[2]); nome.set(m[1], m[3]); }
  }
  const ehDoVSCode = (pid) => {
    for (let p = pai.get(pid), i = 0; p && p !== '1' && i < 6; p = pai.get(p), i++) {
      if (/Code Helper|Visual Studio Code|Electron/.test(nome.get(p) || '')) return true;
    }
    return false;
  };
  const out = new Set();
  for (const linha of cl.saida.split('\n')) {
    const i = linha.indexOf('\t');
    if (i > 0 && ehDoVSCode(linha.slice(0, i))) out.add(linha.slice(i + 1));
  }
  return out;
}

async function sessaoDaAba(t, clientes) {
  for (const [nome, aba] of abertos) if (aba === t) return nome;
  let pid;
  try { pid = await t.processId; } catch (e) { pid = undefined; }
  return (pid && clientes.get(pid)) || sessaoDoComando(t);
}

// Uma aba criada por outro caminho (a task antiga, o botao +, ou o proprio VS
// Code restaurando) ja esta conectada na sessao. Adotar em vez de criar outra e
// o que impede a lista de duplicar.
async function adotarExistentes() {
  const clientes = await clientesTmux();
  for (const t of vscode.window.terminals) {
    if (!vivo(t)) continue;
    const s = await sessaoDaAba(t, clientes);
    if (s && !vivo(abertos.get(s))) abertos.set(s, t);
  }
}

function vivo(t) { return t && t.exitStatus === undefined; }

// Ambiente da aba, montado a mao (strictEnv). Sem isso o VS Code injeta nas
// abas as variaveis do Claude Code (CLAUDE_CODE_SSE_PORT, porta nova a cada
// reinicio de extensoes), do Copilot e do Git — e, quando elas mudam, pinta o
// nome de TODAS as abas de amarelo com um ⚠ ("relaunch needed"). Nas abas do
// tmux essas variaveis nem servem: o tmux nao as repassa para as sessoes.
// Tentativa anterior (1.7.2, nunca publicada): dar "relaunch" nas abas. Deu
// errado — nas abas recriadas pelo VS Code o relaunch abre um terminal novo
// em vez de voltar para a sessao.
function ambienteDaAba() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(VSCODE_|ELECTRON_|APPLICATIONINSIGHTS|COPILOT_|CLAUDE_CODE_)/.test(k)) continue;
    if (['GIT_ASKPASS', 'NODE_OPTIONS', 'CLAUDECODE'].includes(k)) continue;
    env[k] = v;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'vscode';
  env.TERM_PROGRAM_VERSION = vscode.version;
  if (!/UTF-8/i.test(env.LANG || '')) env.LANG = 'C.UTF-8';
  return env;
}

function abrir(nome, cor, focar, rotulo) {
  let t = abertos.get(nome);
  if (!vivo(t)) {
    const ap = aparenciaDe(nome);
    // Sessao sem cor guardada recebe a cor que o metodo antigo (tasks.json)
    // mostrava, e ela e GRAVADA: antes a cor vinha de um rodizio pela posicao
    // na lista, entao mudava quando nascia um terminal e sumia ao reabrir.
    let c = ap.cor;
    if (!c) {
      c = cor || corPadrao(nome);
      mudarAparencia(nome, { cor: c });
    }
    t = vscode.window.createTerminal({
      name: ap.nome || rotulo || nome,
      shellPath: bin('gab-attach'),
      shellArgs: [nome],
      env: ambienteDaAba(),
      strictEnv: true,
      iconPath: new vscode.ThemeIcon(ap.icone),
      color: c && c !== 'nenhuma' ? new vscode.ThemeColor(c) : undefined,
    });
    abertos.set(nome, t);
  }
  if (focar) t.show(false);
  return t;
}

// --- lembrar quais abas estavam abertas -------------------------------------
//
// A extensao NAO deve abrir a lista inteira. Ter 50 sessoes guardadas nao
// significa querer 50 abas na tela: a maioria fica dormindo, viva no tmux, e so
// e aberta quando faz falta. O que se restaura depois de um reboot sao as abas
// que ESTAVAM abertas — nem mais, nem menos.
let tarefaRegistro = null;
// Enquanto a restauracao do login nao termina, NADA e gravado. Foi assim que a
// lista se perdeu no reboot de 2026-09-30: a extensao subiu antes do tmux
// recriar as sessoes, nao achou nenhuma para abrir, e 2,5 s depois gravou por
// cima a unica aba presente ("tmux (persistente)").
let restaurando = true;
// encolher=false (timer, aba aberta): a lista so cresce ou atualiza rotulos.
// encolher=true so quando o usuario fecha uma aba de verdade. Assim nenhuma
// saida do VS Code que escape da checagem de Shutdown consegue esvaziar a lista.
let podeEncolher = false;
function registrarAbertas(encolher = false) {
  if (restaurando) return;
  podeEncolher = podeEncolher || encolher;
  clearTimeout(tarefaRegistro);
  tarefaRegistro = setTimeout(async () => {
    const encolherAgora = podeEncolher;
    podeEncolher = false;
    if (encerrando) return;
    const clientes = await clientesTmux();
    const lista = [];
    const vistas = new Set();
    for (const t of vscode.window.terminals) {
      if (!vivo(t)) continue;
      const sessao = await sessaoDaAba(t, clientes);
      if (!sessao || vistas.has(sessao)) continue;   // aba que nao e tmux
      vistas.add(sessao);
      // Nome dado a aba fica guardado por sessao (vale com a aba fechada).
      // O nome do perfil ("tmux (persistente)") nao e escolha de ninguem.
      if (t.name && t.name !== PERFIL) {
        const guardado = aparenciaDe(sessao).nome;
        const novo = t.name === sessao ? '' : t.name;
        if (novo !== guardado) mudarAparencia(sessao, { nome: novo });
      }
      lista.push(sessao);
    }
    // Lista vazia nunca e gravada. No fechamento do VS Code todas as abas sao
    // descartadas de uma vez: se isso virasse registro, o proximo login abriria
    // nada e o trabalho pareceria perdido.
    if (!lista.length || encerrando) return;
    gravarOrdemConhecida(lista);
    // A ORDEM da lista e a ordem em que as abas voltam: a data em que cada
    // terminal foi aberto (ate a 1.7.3 era alfabetica, e a pessoa se perdia).
    const salvas = abertasSalvas();
    let existem = null;
    if (!encolherAgora) {
      const r = await rodar(tmuxBin(), ['list-sessions', '-F', '#{session_name}']);
      existem = new Set(r.saida.split('\n').filter(Boolean));
    }
    let final = [];
    const postas = new Set();
    for (const x of salvas) {
      const n = nomeDe(x);
      if (postas.has(n)) continue;
      if (vistas.has(n)) final.push(n);
      else if (existem && existem.has(n)) final.push(x);
      else continue;
      postas.add(n);
    }
    for (const s of lista) if (!postas.has(s)) { final.push(s); postas.add(s); }
    final = await porData(final);
    const antes = JSON.stringify(salvas);
    try {
      if (JSON.stringify(final) === antes) return;
      if ((lerLista(ARQ_ABERTAS) || []).length) fs.copyFileSync(ARQ_ABERTAS, ARQ_ABERTAS + '.anterior');
      gravarSeguro(ARQ_ABERTAS, JSON.stringify(final, null, 2));
    } catch (e) { /* sem registro e melhor do que quebrar a janela */ }
  }, 2500);
}

// Cada item e "SESSAO" ou { sessao, aba } quando o titulo da aba foi renomeado.
const nomeDe = (x) => (typeof x === 'string' ? x : x.sessao);
const rotuloDe = (x) => (typeof x === 'string' ? x : x.aba || x.sessao);

// Fechar o VS Code descarta as abas uma a uma. Se cada descarte virasse "o
// usuario fechou esta aba", o registro encolheria ate sobrar pouco ou nada.
let encerrando = false;

function lerLista(arq) {
  try {
    const l = JSON.parse(fs.readFileSync(arq, 'utf8'));
    return Array.isArray(l) ? l : null;
  } catch (e) { return null; }
}

// Num travamento (Mac desligado na marra) o arquivo pode voltar vazio ou
// cortado. Por isso ha uma copia (.anterior) e, por ultimo, a ordem conhecida.
function abertasSalvas() {
  for (const arq of [ARQ_ABERTAS, ARQ_ABERTAS + '.anterior', ARQ_ORDEM]) {
    const l = (lerLista(arq) || []).filter((x) => x && nomeDe(x));
    if (l.length) {
      if (arq !== ARQ_ABERTAS) log(`lista de abas lida de ${path.basename(arq)} (a principal estava vazia ou corrompida)`);
      return l;
    }
  }
  return [];
}

// Grava com fsync: sem ele, um travamento logo depois pode deixar o arquivo vazio.
function gravarSeguro(arq, texto) {
  const tmp = `${arq}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, texto); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, arq);
}

// Reabre exatamente o que estava aberto, e so o que ainda existe no tmux.
// forcar=true: abre a aba mesmo que a sessao ainda nao exista. O gab-attach
// chama `gab-terminais-restore --so NOME` e recria a sessao na hora (com
// historico e programa). Sem isto um Mac que travou voltava SEM NENHUMA aba: o
// restore do login espera ate 5 min pelas pastas (Google Drive) antes de criar
// qualquer sessao, e a extensao desistia em 3 min.
async function reabrirAbertas(forcar = false) {
  const querendo = await porData(abertasSalvas());
  if (!querendo.length) return { criados: 0, total: 0 };
  const vivas = new Set((await sessoesVivas()).map((s) => s.nome));
  const noManifesto = new Set((lerLista(MANIFESTO) || []).map((i) => i && i.nome));
  await adotarExistentes();
  const jaEmAbas = await sessoesEmAbasDoVSCode();
  const corDoSync = new Map(((await queViramAba()) || [])
    .map((s) => [s.nome, s.icone && s.icone.color]));
  let criados = 0;
  for (const item of querendo) {
    const nome = nomeDe(item);
    if (vivo(abertos.get(nome))) continue;
    if (!vivas.has(nome)) {
      if (!forcar) continue;
      // terminal-N sem nome e fora do manifesto era vazio: nao volta.
      if (/^terminal-\d+$/.test(nome) && !aparenciaDe(nome).nome && !noManifesto.has(nome)) continue;
      log(`sessao ${nome} ainda nao existe: abrindo a aba, o gab-attach recria`);
      abrir(nome, null, false, rotuloDe(item));
      criados++;
      continue;
    }
    if (jaEmAbas.has(nome)) {
      log(`nao reabri ${nome}: ja esta numa aba do VS Code`);
      continue;
    }
    // terminal-N vazio (sem nome, so o prompt) nao volta como aba: era assim
    // que os terminais criados sozinhos pelo VS Code se acumulavam a cada abertura.
    if (/^terminal-\d+$/.test(nome) && !aparenciaDe(nome).nome && await sessaoVazia(nome)) {
      log(`nao reabri ${nome}: vazio e sem nome`);
      continue;
    }
    abrir(nome, corDoSync.get(nome), false, rotuloDe(item));
    criados++;
  }
  return { criados, total: querendo.length };
}

// --- a ordem que a pessoa escolheu ------------------------------------------
//
// A data de abertura e so o PADRAO. Se a pessoa arrastar as abas para a ordem
// dela, a extensao nunca mais reorganiza. A API nao mostra a ordem da tela
// (vscode.window.terminals segue a ordem de criacao e nao muda quando se
// arrasta), mas o VS Code recria as abas na ordem da tela. Entao: a extensao
// guarda a ordem que conhece, e se na reabertura o VS Code trouxer outra, foi a
// pessoa que arrumou. O comando "Organizar por data" devolve ao padrao.
async function sessoesNaOrdemDasAbas() {
  const clientes = await clientesTmux();
  const out = [];
  for (const t of vscode.window.terminals) {
    if (!vivo(t)) continue;
    const s = await sessaoDaAba(t, clientes);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function gravarOrdemConhecida(lista) {
  let antes = null;
  try { antes = fs.readFileSync(ARQ_ORDEM, 'utf8'); } catch (e) { /* primeira vez */ }
  const agora = JSON.stringify(lista);
  if (agora !== antes) try { gravarSeguro(ARQ_ORDEM, agora); } catch (e) { /* ok */ }
}

function ordemFoiArrumada(trazidas) {
  let conhecida = [];
  try { conhecida = JSON.parse(fs.readFileSync(ARQ_ORDEM, 'utf8')); } catch (e) { return false; }
  if (!Array.isArray(conhecida)) return false;
  const a = trazidas.filter((s) => conhecida.includes(s));
  const b = conhecida.filter((s) => a.includes(s));
  return a.length > 1 && a.join('\n') !== b.join('\n');
}

function ordemManual() { return fs.existsSync(ARQ_ORDEM_MANUAL); }

// Poe as abas tmux na ordem em que os terminais foram abertos (mais antigo
// primeiro). O VS Code recria as abas na ordem em que estavam na tela e nao ha
// API para mover uma aba; o unico jeito e recriar, no fim, cada aba a partir da
// primeira fora do lugar. UMA POR VEZ e em sequencia: recriar em paralelo (ate
// a 1.7.2) fazia a ordem depender de qual tmux respondia primeiro.
// O icone, a cor e o nome voltam do ~/.gab-terminais-aparencia.json.
async function organizarPorData() {
  const clientes = await clientesTmux();
  const atual = [];
  for (const t of vscode.window.terminals) {
    if (!vivo(t)) continue;
    const s = await sessaoDaAba(t, clientes);
    if (s && !atual.some((a) => a.sessao === s)) atual.push({ sessao: s, t });
  }
  const certa = await porData(atual.map((a) => a.sessao));
  let i = 0;
  while (i < atual.length && atual[i].sessao === certa[i]) i++;
  if (i >= atual.length) return 0;
  const ativa = vscode.window.activeTerminal;
  let focar = null;
  for (const nome of certa.slice(i)) {
    const velha = atual.find((a) => a.sessao === nome).t;
    if (velha.name && velha.name !== PERFIL && velha.name !== nome && !aparenciaDe(nome).nome) {
      mudarAparencia(nome, { nome: velha.name });
    }
    abertos.delete(nome);
    velha.dispose();
    await esperar(150);   // o tmux solta o cliente antigo antes do novo entrar
    const nova = abrir(nome, null, false);
    if (velha === ativa) focar = nova;
  }
  if (focar) focar.show(false);
  log(`abas organizadas por data: ${certa.length - i} recriada(s) a partir de ${certa[i]}`);
  return certa.length - i;
}

// No login o tmux pode estar recriando as sessoes enquanto a extensao sobe.
// Tenta de novo ate todas as que estavam abertas existirem (prazo de 3 min) e
// so entao libera o registro.
async function sessaoVazia(sessao) {
  const r = await rodar(tmuxBin(), ['display', '-p', '-t', `${sessao}:`, '#{pane_pid}\t#{pane_current_command}']);
  const [pid, comando] = r.saida.trim().split('\t');
  if (!pid || !/^-?(zsh|bash|sh|fish)$/.test(comando || '')) return false;
  if ((await rodar('/usr/bin/pgrep', ['-P', pid])).saida.trim()) return false;
  const tela = await rodar(tmuxBin(), ['capture-pane', '-p', '-t', `${sessao}:`]);
  return tela.saida.split('\n').filter((l) => l.trim()).length <= 2;
}

// Ao terminar de restaurar, mostra o painel na aba em que a pessoa estava.
// As abas sao criadas em segundo plano; sem isto o painel abria fechado.
function mostrarAbaAtiva() {
  let alvo = null;
  try { alvo = abertos.get(fs.readFileSync(ARQ_ATIVA, 'utf8').trim()); } catch (e) { /* sem registro */ }
  if (!vivo(alvo)) alvo = [...abertos.values()].find(vivo);
  if (vivo(alvo)) alvo.show(true);
}

async function restaurarNoLogin() {
  const querendo = abertasSalvas();
  log(`abrindo: ${querendo.length} aba(s) para restaurar`);
  const prazo = Date.now() + 180000;
  // A ordem em que o VS Code trouxe as abas = a ordem da tela ao fechar.
  const trazidas = await sessoesNaOrdemDasAbas();
  if (!ordemManual() && ordemFoiArrumada(trazidas)) {
    try { fs.writeFileSync(ARQ_ORDEM_MANUAL, new Date().toISOString() + '\n'); } catch (e) { /* ok */ }
    log(`ordem arrumada pela pessoa (${trazidas.join(', ')}): nao reorganizo mais por data`);
  }
  try {
    const comeco = Date.now();
    for (;;) {
      // Primeiros 20 s: so o que ja existe (o VS Code e o restore do login
      // costumam trazer tudo). Depois disso, abre o que falta mesmo assim.
      await reabrirAbertas(Date.now() - comeco > 20000);
      const vivas = new Set((await sessoesVivas()).map((s) => s.nome));
      if (querendo.every((n) => vivas.has(nomeDe(n))) || Date.now() > prazo) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
  } finally {
    if (conf('ordenarPorData', true) && !ordemManual()) {
      try { await organizarPorData(); } catch (e) { log(`organizar por data falhou: ${e.message}`); }
    }
    restaurando = false;
    log(`restauracao terminou: ${[...abertos.values()].filter(vivo).length} aba(s) tmux abertas`);
    mostrarAbaAtiva();
    registrarAbertas();
  }
}

async function abrirTodos() {
  const lista = await queViramAba();
  if (lista === null) {
    vscode.window.showErrorMessage('Terminais tmux: nao consegui ler a lista (gab-terminais-sync --listar falhou).');
    return { criados: 0, total: 0 };
  }
  await adotarExistentes();
  let criados = 0;
  for (const s of lista) {
    if (vivo(abertos.get(s.nome))) continue;
    abrir(s.nome, s.icone && s.icone.color, false);
    criados++;
  }
  return { criados, total: lista.length };
}

// --- a lista na barra lateral ----------------------------------------------

class Lista {
  constructor() {
    this._mudou = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._mudou.event;
    this.sessoes = [];
    this.viramAba = new Set();
  }

  atualizar() { this._mudou.fire(); }

  // `completo` releva quem vira aba, o que custa caro: o teste da catraca gasta
  // dois processos POR sessao automatica (pgrep + capture-pane). Com 50 sessoes
  // isso nao pode rodar no timer de segundos — so quando o manifesto muda (ou
  // seja, quando o tmux avisou que algo nasceu, morreu ou foi renomeado) e
  // quando alguem pede a atualizacao a mao.
  async recarregar(completo) {
    this.sessoes = await sessoesVivas();
    if (completo || this.viramAba.size === 0) {
      const lista = await queViramAba();
      if (lista) this.viramAba = new Set(lista.map((s) => s.nome));
    }
    this.atualizar();
  }

  getTreeItem(s) {
    const ap = aparenciaDe(s.nome);
    const item = new vscode.TreeItem(ap.nome || s.nome, vscode.TreeItemCollapsibleState.None);
    const marcas = [];
    if (ap.nome) marcas.push(s.nome);
    if (vivo(abertos.get(s.nome))) marcas.push('aberto');
    if (s.comando && s.comando !== 'zsh' && s.comando !== 'bash') marcas.push(s.comando);
    if (s.copyMode) marcas.push('travado (copy-mode)');
    if (!this.viramAba.has(s.nome)) marcas.push('vazio');
    item.description = marcas.join(' · ');
    item.contextValue = 'sessao';
    item.iconPath = s.copyMode
      ? new vscode.ThemeIcon('warning')
      : new vscode.ThemeIcon(ap.icone, ap.cor && ap.cor !== 'nenhuma' ? new vscode.ThemeColor(ap.cor) : undefined);
    item.tooltip = new vscode.MarkdownString(
      `**${s.nome}**\n\n` +
      `pasta: \`${s.cwd}\`\n\n` +
      `rodando: \`${s.comando || '—'}\`\n\n` +
      (this.viramAba.has(s.nome)
        ? 'Entra em "Abrir todos" e volta depois de um reboot.'
        : 'Vazio: nao entra em "Abrir todos" nem no manifesto do reboot. Escreva algo dentro ou de um nome a ele para guarda-lo.'),
    );
    item.command = { command: 'gabTerminais.abrir', title: 'Abrir', arguments: [s] };
    return item;
  }

  getChildren() {
    const mostrarVazios = conf('mostrarVazios', true);
    return this.sessoes.filter((s) => mostrarVazios || this.viramAba.has(s.nome));
  }
}

// --- ciclo de vida ----------------------------------------------------------

const ICONES = [
  ['terminal', 'terminal'], ['rocket', 'foguete'], ['coffee', 'cafe'], ['github', 'github'],
  ['zap', 'raio'], ['star-full', 'estrela'], ['heart', 'coracao'], ['flame', 'fogo'],
  ['home', 'casa'], ['briefcase', 'maleta'], ['calendar', 'calendario'], ['mail', 'e-mail'],
  ['globe', 'globo / site'], ['device-camera-video', 'video'], ['device-camera', 'camera / foto'],
  ['play', 'play'], ['music', 'musica'], ['broadcast', 'transmissao'], ['megaphone', 'megafone'],
  ['comment-discussion', 'conversa'], ['robot', 'robo / bot'], ['sparkle', 'IA'], ['lightbulb', 'ideia'],
  ['tools', 'ferramentas'], ['gear', 'engrenagem'], ['bug', 'bug'], ['beaker', 'teste'],
  ['database', 'banco de dados'], ['server', 'servidor'], ['cloud', 'nuvem'], ['package', 'pacote'],
  ['shield', 'escudo / seguranca'], ['lock', 'cadeado'], ['key', 'chave'], ['credit-card', 'cartao / pagamento'],
  ['graph', 'grafico'], ['pie-chart', 'pizza'], ['file', 'arquivo'], ['folder', 'pasta'],
  ['book', 'livro'], ['pencil', 'lapis'], ['paintcase', 'pintura / arte'], ['symbol-color', 'cores'],
  ['vm', 'computador'], ['device-mobile', 'celular'], ['print', 'impressora'], ['person', 'pessoa'],
  ['organization', 'equipe'], ['tag', 'etiqueta'], ['bell', 'sino'], ['pin', 'alfinete'],
  ['flag', 'bandeira'], ['target', 'alvo'], ['trophy', 'trofeu'], ['gift', 'presente'],
];
const CORES_ABA = [
  ['nenhuma', 'Sem cor'],
  ['terminal.ansiRed', '🔴 Vermelho'], ['terminal.ansiGreen', '🟢 Verde'],
  ['terminal.ansiYellow', '🟡 Amarelo'], ['terminal.ansiBlue', '🔵 Azul'],
  ['terminal.ansiMagenta', '🟣 Magenta'], ['terminal.ansiCyan', '🩵 Ciano'],
  ['terminal.ansiWhite', '⚪ Branco'],
];

// --- atualizacao pela internet ---------------------------------------------
//
// Cada versao nova e publicada como release no GitHub, com o .vsix anexado.
// A extensao confere a ultima release ao abrir e a cada 6 h; se for mais nova,
// oferece "Atualizar", baixa o .vsix e instala pela propria API do VS Code.
const REPO = 'LeirbagGI/gab-terminais-vscode';

// --- verificacao da instalacao ----------------------------------------------
//
// A extensao sozinha nao guarda terminal nenhum: quem guarda sao o tmux, os
// scripts gab-* e o LaunchAgent do login. Num computador em que o instalador
// nao rodou (ou rodou uma versao velha) tudo parece funcionar e nada volta.
// Por isso ela confere as pecas e, faltando alguma, oferece rodar o instalador
// mais recente do GitHub. Subir VERSAO_SCRIPTS e o jeito de levar scripts
// novos aos outros computadores.
const VERSAO_SCRIPTS = 4;
const ARQ_VERSAO = path.join(HOME, '.gab-terminais-versao');
const URL_INSTALADOR = `https://github.com/${REPO}/releases/latest/download/Terminais-tmux-instalador.zip`;

function problemasDaInstalacao() {
  const faltas = [];
  const existe = (f) => { try { fs.accessSync(f); return true; } catch (e) { return false; } };
  const t = tmuxBin();
  if (t === 'tmux') faltas.push('tmux');
  const conhecido = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux'].some(existe) || existe(path.join(HOME, 'bin', 'tmux'));
  if (t !== 'tmux' && !conhecido) faltas.push(`atalho para o tmux (${t})`);
  for (const n of ['gab-attach', 'gab-novo', 'gab-terminais-sync', 'gab-terminais-salvar', 'gab-terminais-restore']) {
    if (!existe(bin(n))) faltas.push(n);
  }
  const perfil = vscode.workspace.getConfiguration('terminal.integrated').get('defaultProfile.osx');
  if (perfil !== PERFIL) faltas.push('tmux como terminal padrao do VS Code');
  if (!existe(path.join(HOME, 'Library', 'LaunchAgents', 'com.gab.terminais.plist'))) {
    faltas.push('recriar os terminais no login');
  }
  let versao = 0;
  try { versao = Number(fs.readFileSync(ARQ_VERSAO, 'utf8').trim()) || 0; } catch (e) { /* nunca instalado */ }
  if (!faltas.length && versao < VERSAO_SCRIPTS) faltas.push('scripts desatualizados');
  return faltas;
}

function reparar() {
  const cmdInstalar = [
    'cd /tmp',
    `curl -fsSL -o gab-terminais-instalador.zip ${URL_INSTALADOR}`,
    'rm -rf Terminais-tmux',
    'unzip -oq gab-terminais-instalador.zip',
    'bash Terminais-tmux/instalar.sh',
  ].join(' && ');
  const t = vscode.window.createTerminal({
    name: 'Instalando Terminais tmux',
    shellPath: '/bin/zsh',
    shellArgs: ['-lc', `${cmdInstalar}; echo; echo "Terminou. Feche e abra o VS Code (ou Developer: Reload Window)."; read -k1`],
    iconPath: new vscode.ThemeIcon('tools'),
  });
  t.show();
}

async function verificarInstalacao(manual) {
  const faltas = problemasDaInstalacao();
  if (!faltas.length) {
    if (manual) vscode.window.showInformationMessage('Terminais tmux: instalacao completa neste computador.');
    return;
  }
  const escolha = await vscode.window.showWarningMessage(
    `Terminais tmux: os terminais NAO estao sendo guardados neste computador. Falta: ${faltas.join(', ')}.`,
    'Reparar agora', 'Depois',
  );
  if (escolha === 'Reparar agora') reparar();
}

function baixar(url, destino, saltos = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'gab-terminais-vscode', Accept: 'application/vnd.github+json, application/octet-stream' },
      timeout: 20000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && saltos > 0) {
        res.resume();
        return resolve(baixar(res.headers.location, destino, saltos - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      if (destino) {
        const f = fs.createWriteStream(destino);
        res.pipe(f);
        f.on('finish', () => f.close(() => resolve(destino)));
        f.on('error', reject);
      } else {
        let corpo = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { corpo += c; });
        res.on('end', () => { try { resolve(JSON.parse(corpo)); } catch (e) { reject(e); } });
      }
    });
    req.on('timeout', () => req.destroy(new Error('tempo esgotado')));
    req.on('error', reject);
  });
}

function maisNova(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

const adiadas = new Set();   // versoes que o usuario mandou para "Depois" nesta sessao
let verificando = false;

async function verificarAtualizacao(context, manual) {
  if (verificando) return;
  verificando = true;
  try {
    const atual = context.extension.packageJSON.version;
    let rel;
    try {
      rel = await baixar(`https://api.github.com/repos/${REPO}/releases/latest`);
    } catch (e) {
      if (manual) vscode.window.showErrorMessage(`Terminais tmux: nao consegui consultar atualizacoes (${e.message}).`);
      return;
    }
    const nova = String(rel.tag_name || '').replace(/^v/, '');
    const vsix = (rel.assets || []).find((a) => a.name.endsWith('.vsix'));
    if (!vsix || !maisNova(nova, atual)) {
      if (manual) vscode.window.showInformationMessage(`Terminais tmux: voce ja esta na ultima versao (${atual}).`);
      return;
    }
    if (!manual && adiadas.has(nova)) return;
    const escolha = await vscode.window.showInformationMessage(
      `Terminais tmux: versao ${nova} disponivel (voce tem ${atual}).`, 'Atualizar', 'Depois',
    );
    if (escolha !== 'Atualizar') { adiadas.add(nova); return; }
    const destino = path.join(os.tmpdir(), `gab-terminais-${nova}.vsix`);
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Terminais tmux: instalando ${nova}...` },
        async () => {
          await baixar(vsix.browser_download_url, destino);
          await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(destino));
        },
      );
    } catch (e) {
      vscode.window.showErrorMessage(`Terminais tmux: a atualizacao falhou (${e.message}).`);
      return;
    }
    const r = await vscode.window.showInformationMessage(
      `Terminais tmux: atualizado para ${nova}. Recarregar a janela para usar? (os terminais continuam vivos no tmux)`,
      'Recarregar agora',
    );
    if (r) vscode.commands.executeCommand('workbench.action.reloadWindow');
  } finally {
    verificando = false;
  }
}

// --- o terminal que o VS Code cria sozinho ao abrir ---------------------------
//
// Se o painel de terminal estava aberto quando o VS Code fechou, ele cria um
// terminal padrao ao reabrir. Com o perfil tmux isso vira uma sessao
// terminal-N nova a CADA reabertura, alem das abas que a extensao restaura.
// Descarta so esse: nasceu nos primeiros segundos, e do perfil padrao, e uma
// sessao terminal-N criada agora e nao tem nada rodando. Um terminal aberto de
// proposito (ou que ja tinha algo) nunca e tocado.
const INICIO = Date.now();
// Hora em que o processo de extensoes subiu (logo que a janela abre). Medir
// "recem-criado" so a partir da ativacao da extensao falhava em Mac lento: o
// terminal do VS Code nascia mais de 15 s antes dela ativar.
const INICIO_JANELA = Date.now() - process.uptime() * 1000;
let autoDescartado = false;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function descartarTerminalAutomatico(t) {
  if ((autoDescartado && !persistenciaNativa()) || Date.now() - INICIO > 60000 || !criadaPeloPerfil(t)) return;
  if (!janelaDona() || !abertasSalvas().length) return;   // nada a restaurar: deixa o terminal
  // So descarta depois que a restauracao abriu alguma aba: sem isso o painel
  // podia ficar sem terminal nenhum.
  for (let i = 0; i < 120 && restaurando; i++) await esperar(500);
  if (![...abertos.values()].some((x) => x !== t && vivo(x))) {
    log('terminal automatico mantido: nenhuma aba restaurada');
    return;
  }
  let sessao = null;
  for (let i = 0; i < 12 && !sessao; i++) {
    sessao = await sessaoDaAba(t, await clientesTmux());
    if (!sessao) await esperar(500);
  }
  if (!sessao || !/^terminal-\d+$/.test(sessao) || !vivo(t) || autoDescartado) return;
  const r = await rodar(tmuxBin(), ['display', '-p', '-t', `${sessao}:`,
    '#{session_created}\t#{pane_pid}\t#{pane_current_command}']);
  const [criada, pid, comando] = r.saida.trim().split('\t');
  if (!pid || Number(criada) * 1000 < INICIO_JANELA - 30000) {   // sessao antiga, so reconectou
    log(`terminal automatico ${sessao} mantido: sessao antiga`);
    return;
  }
  if (!/^-?(zsh|bash|sh|fish)$/.test(comando || '')) return;    // o painel nao e um shell
  const filhos = await rodar('/usr/bin/pgrep', ['-P', pid]);
  if (filhos.saida.trim()) return;                               // tem algo rodando
  const tela = await rodar(tmuxBin(), ['capture-pane', '-p', '-t', `${sessao}:`]);
  if (tela.saida.split('\n').filter((l) => l.trim()).length > 2) return;   // ja tem conteudo
  autoDescartado = true;
  for (const [nome, aba] of abertos) if (aba === t) abertos.delete(nome);
  t.dispose();
  await rodar(tmuxBin(), ['kill-session', '-t', `=${sessao}`]);
  log(`terminal automatico ${sessao} descartado`);
  mostrarAbaAtiva();
}

// --- persistencia nativa do VS Code -------------------------------------------
//
// O icone e a cor escolhidos no menu nativo ("Change Icon/Color") so sao
// guardados pela persistencia do proprio VS Code: ao fechar ele grava cada aba
// (comando, titulo, icone, cor) e ao abrir recria. Para isso funcionar com o
// tmux, TODA aba precisa ser "gab-attach NOME": uma aba do botao + e "gab-novo"
// sem nome, e seria recriada como um terminal NOVO. Por isso a aba do + e
// trocada, logo que nasce, por uma "gab-attach <sua sessao>".
// gabTerminais.persistenciaNativa = false desliga tudo (chave de emergencia).
function persistenciaNativa() { return conf('persistenciaNativa', true); }

async function ajustarPersistenciaNativa() {
  const ti = vscode.workspace.getConfiguration('terminal.integrated');
  const ligada = persistenciaNativa();
  const quero = { enablePersistentSessions: ligada,
    persistentSessionReviveProcess: ligada ? 'onExitAndWindowClose' : 'never' };
  for (const [chave, valor] of Object.entries(quero)) {
    if (ti.get(chave) !== valor) {
      await ti.update(chave, valor, vscode.ConfigurationTarget.Global);
      log(`ajustei terminal.integrated.${chave} = ${valor}`);
    }
  }
}

const normalizando = new Set();
const nascimento = new WeakMap();   // aba -> quando ela apareceu
async function normalizarAba(t) {
  if (!persistenciaNativa() || !vivo(t) || normalizando.has(t)) return;
  if (Date.now() - INICIO < 60000) return;          // na abertura quem cuida e o descarte
  const doComando = sessaoDoComando(t);
  if (!criadaPeloPerfil(t) && !doComando) return;   // aba que nao e tmux
  if (doComando) {
    // Aba gab-attach: so precisa trocar se a sessao foi renomeada por dentro
    // (gab-nome, Ctrl+b $) — senao o VS Code a recriaria no nome antigo.
    let pid;
    try { pid = await t.processId; } catch (e) { pid = undefined; }
    const agora = pid && (await clientesTmux()).get(pid);
    if (!agora || agora === doComando) return;
  }
  normalizando.add(t);
  try {
    let sessao = null;
    for (let i = 0; i < 12 && !sessao && vivo(t); i++) {
      let pid;
      try { pid = await t.processId; } catch (e) { pid = undefined; }
      sessao = (pid && (await clientesTmux()).get(pid)) || null;
      if (!sessao) await esperar(500);
    }
    if (!sessao || !vivo(t)) return;
    // So a aba do + de verdade e trocada: o gab-novo sem nome cria um terminal-N
    // NOVO na hora. As abas que o proprio VS Code recriou ao abrir tambem
    // aparecem como "do perfil", mas mostram sessoes antigas. Troca-las (1.7.0 a
    // 1.7.2) recriava todas de uma vez, em paralelo, e embaralhava a ordem.
    if (!doComando) {
      if (!/^terminal-\d+$/.test(sessao)) return;
      const r = await rodar(tmuxBin(), ['display', '-p', '-t', `${sessao}:`, '#{session_created}']);
      const criada = Number(r.saida.trim()) * 1000;
      if (!criada || criada < (nascimento.get(t) || Date.now()) - 10000) return;
    }
    const ativa = vscode.window.activeTerminal === t;
    const rotulo = t.name !== PERFIL && t.name !== sessao ? t.name : '';
    if (rotulo) mudarAparencia(sessao, { nome: rotulo });
    for (const [nome, aba] of abertos) if (aba === t) abertos.delete(nome);
    const nova = abrir(sessao, null, false);
    if (ativa) nova.show(false);
    t.dispose();
    log(`aba ${doComando ? `de ${doComando} (renomeada)` : 'do +'} trocada por gab-attach ${sessao}`);
  } finally {
    normalizando.delete(t);
  }
}

// Espera o VS Code terminar de recriar/reconectar as abas dele: pelo menos 3 s,
// depois ate a quantidade de abas e de sessoes com cliente do VS Code ficar
// igual por 2 s seguidos (no maximo 12 s).
async function esperarAbasDoVSCode() {
  if (!persistenciaNativa()) return;
  await esperar(3000);
  let antes = '';
  let igual = 0;
  const fim = Date.now() + 9000;
  while (Date.now() < fim) {
    const agora = `${vscode.window.terminals.length}|${[...(await sessoesEmAbasDoVSCode())].sort().join(',')}`;
    igual = agora === antes ? igual + 1 : 0;
    if (igual >= 4) break;
    antes = agora;
    await esperar(500);
  }
  log(`abas do VS Code estabilizaram: ${vscode.window.terminals.length} aba(s)`);
}

function activate(context) {
  const lista = new Lista();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('gabTerminais.lista', lista),
  );

  const recarregar = (completo) => lista.recarregar(completo);

  // Duas fontes de atualizacao. O manifesto e reescrito pelos hooks do tmux
  // (session-created, session-closed, after-rename-session, client-detached),
  // entao vigia-lo da reacao imediata; o timer cobre o que nao passa por hook.
  // fs.watchFile e nao fs.watch: o sync grava num .tmp e da os.replace, ou seja,
  // TROCA o inode. O fs.watch segue o inode antigo e morre depois do primeiro
  // evento; o watchFile compara o stat e continua funcionando.
  fs.watchFile(MANIFESTO, { interval: 2000 }, (agora, antes) => {
    if (agora.mtimeMs !== antes.mtimeMs) recarregar(true);
  });
  context.subscriptions.push({ dispose: () => fs.unwatchFile(MANIFESTO) });

  const timer = setInterval(() => {
    recarregar(false);
    registrarAbertas();
    if (persistenciaNativa() && Date.now() - INICIO > 60000) {
      clientesTmux().then(async (clientes) => {
        for (const t of vscode.window.terminals) {
          const doComando = sessaoDoComando(t);
          if (!doComando || !vivo(t)) continue;
          let pid;
          try { pid = await t.processId; } catch (e) { pid = undefined; }
          const agora = pid && clientes.get(pid);
          if (agora && agora !== doComando) normalizarAba(t);
        }
      });
    }
  }, Math.max(2, conf('intervalo', 5)) * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((t) => {
      for (const [nome, aba] of abertos) if (aba === t) abertos.delete(nome);
      // Aba fechada porque o VS Code esta saindo nao e "o usuario fechou".
      const motivo = t.exitStatus && t.exitStatus.reason;
      if (vscode.TerminalExitReason && motivo === vscode.TerminalExitReason.Shutdown) {
        encerrando = true;
        clearTimeout(tarefaRegistro);
        return;
      }
      registrarAbertas(true);
      recarregar(false);
    }),
    vscode.window.onDidChangeActiveTerminal(async (t) => {
      if (!t || restaurando || encerrando) return;
      const s = await sessaoDaAba(t, await clientesTmux());
      if (s) try { fs.writeFileSync(ARQ_ATIVA, s); } catch (e) { /* ok */ }
    }),
    vscode.window.onDidOpenTerminal((t) => {
      nascimento.set(t, Date.now());
      descartarTerminalAutomatico(t);
      normalizarAba(t);
      adotarExistentes().then(() => { registrarAbertas(); recarregar(false); });
    }),
    // O titulo da aba muda quando ela e renomeada: regrava o rotulo.
    ...(vscode.window.onDidChangeTerminalState
      ? [vscode.window.onDidChangeTerminalState(() => registrarAbertas())] : []),
  );

  const cmd = (nome, fn) =>
    context.subscriptions.push(vscode.commands.registerCommand(nome, fn));

  cmd('gabTerminais.atualizar', () => recarregar(true));

  cmd('gabTerminais.verificarAtualizacao', () => verificarAtualizacao(context, true));
  cmd('gabTerminais.verificarInstalacao', () => verificarInstalacao(true));
  const conferir = setTimeout(() => verificarInstalacao(false), 8000);
  context.subscriptions.push({ dispose: () => clearTimeout(conferir) });
  if (conf('verificarAtualizacoes', true)) {
    const primeira = setTimeout(() => verificarAtualizacao(context, false), 30000);
    const periodica = setInterval(() => verificarAtualizacao(context, false), 6 * 3600 * 1000);
    context.subscriptions.push({ dispose: () => { clearTimeout(primeira); clearInterval(periodica); } });
  }

  cmd('gabTerminais.abrir', (s) => {
    const nome = typeof s === 'string' ? s : s && s.nome;
    if (nome) { abrir(nome, null, true); recarregar(false); }
  });

  cmd('gabTerminais.reabrirAbertas', async () => {
    const r = await reabrirAbertas();
    vscode.window.showInformationMessage(
      `Terminais tmux: ${r.criados} aba(s) reaberta(s) de ${r.total} que estavam abertas.`,
    );
    recarregar(true);
  });

  cmd('gabTerminais.organizarPorData', async () => {
    // Enquanto as abas sao recriadas, nada e gravado (senao o fechamento da
    // aba velha poderia encolher a lista).
    restaurando = true;
    let n = 0;
    try { fs.unlinkSync(ARQ_ORDEM_MANUAL); } catch (e) { /* nao havia */ }
    try { n = await organizarPorData(); } finally {
      restaurando = false;
      registrarAbertas();
    }
    vscode.window.showInformationMessage(n
      ? `Terminais tmux: abas organizadas pela data em que foram abertas (${n} recriada(s)).`
      : 'Terminais tmux: as abas ja estao na ordem em que foram abertas.');
    recarregar(true);
  });

  cmd('gabTerminais.abrirTodos', async () => {
    const r = await abrirTodos();
    vscode.window.showInformationMessage(
      `Terminais tmux: ${r.criados} aba(s) aberta(s), ${r.total - r.criados} ja estavam abertas.`,
    );
    recarregar(true);
  });

  cmd('gabTerminais.renomear', async (s) => {
    const antigo = typeof s === 'string' ? s : s && s.nome;
    if (!antigo) return;
    const novo = await vscode.window.showInputBox({
      prompt: `Novo nome para "${antigo}"`,
      value: antigo,
      validateInput: (v) => (v && v.trim() ? null : 'O nome nao pode ficar vazio'),
    });
    if (!novo || novo.trim() === antigo) return;
    // gab-renomear, e nao um tmux rename-session cru: o nome e chave em cinco
    // lugares (mapa de conversas, programas, manifesto, registro de nomes e os
    // arquivos de tela). Renomear so no tmux faria a sessao voltar do reboot
    // sem historico e na conversa errada.
    const r = await rodar(bin('gab-renomear'), [antigo, novo.trim()]);
    if (!r.ok) {
      vscode.window.showErrorMessage(`Nao consegui renomear: ${r.erro}`);
      return;
    }
    const todas = lerJSON(ARQ_APARENCIA);
    if (todas[antigo]) {
      todas[novo.trim()] = todas[antigo];
      delete todas[antigo];
      gravarJSON(ARQ_APARENCIA, todas);
    }
    const aba = abertos.get(antigo);
    if (vivo(aba)) { aba.dispose(); abertos.delete(antigo); }
    abrir(novo.trim(), null, false);
    recarregar(true);
  });

  cmd('gabTerminais.aparencia', async (s) => {
    let sessao = typeof s === 'string' ? s : s && s.nome;
    if (!sessao && vscode.window.activeTerminal) {
      sessao = await sessaoDaAba(vscode.window.activeTerminal, await clientesTmux());
    }
    if (!sessao) {
      vscode.window.showWarningMessage('Terminais tmux: clique antes numa aba de terminal tmux.');
      return;
    }
    const atual = aparenciaDe(sessao);
    const icone = await vscode.window.showQuickPick(
      ICONES.map(([id, rotulo]) => ({ label: `$(${id})  ${rotulo}`, id, picked: id === atual.icone,
        description: id === atual.icone ? 'atual' : '' })),
      { title: `Icone de "${atual.nome || sessao}"`, matchOnDescription: true },
    );
    if (!icone) return;
    const cor = await vscode.window.showQuickPick(
      CORES_ABA.map(([id, rotulo]) => ({ label: rotulo, id, description: id === atual.cor ? 'atual' : '' })),
      { title: `Cor de "${atual.nome || sessao}"` },
    );
    if (!cor) return;
    mudarAparencia(sessao, { icone: icone.id, cor: cor.id });
    // Icone e cor so se aplicam ao criar a aba: recria a aba, a sessao continua
    // a mesma (o gab-attach reconecta) e nada do que roda nela e interrompido.
    const aba = abertos.get(sessao) || vscode.window.activeTerminal;
    const nome = aba && aba.name !== PERFIL && aba.name !== sessao ? aba.name : '';
    if (nome) mudarAparencia(sessao, { nome });
    if (aba && vivo(aba)) { abertos.delete(sessao); aba.dispose(); }
    abrir(sessao, null, true);
    lista.atualizar();
  });

  cmd('gabTerminais.fechar', async (s) => {
    const nome = typeof s === 'string' ? s : s && s.nome;
    if (!nome) return;
    const ok = await vscode.window.showWarningMessage(
      `Encerrar "${nome}" de vez?`,
      { modal: true, detail: 'A sessao tmux e encerrada e o nome sai da lista. O que estiver rodando dentro dela para.' },
      'Encerrar',
    );
    if (ok !== 'Encerrar') return;
    const r = await rodar(bin('gab-fechar'), [nome]);
    if (!r.ok) { vscode.window.showErrorMessage(`Nao consegui encerrar: ${r.erro}`); return; }
    const aba = abertos.get(nome);
    if (vivo(aba)) { aba.dispose(); abertos.delete(nome); }
    recarregar(true);
  });

  // "O terminal nao aceita o que eu digito" quase sempre e copy-mode: a roda do
  // mouse entra nele e o tmux passa a interceptar o teclado.
  cmd('gabTerminais.destravar', async () => {
    const t = tmuxBin();
    const ids = (await rodar(t, ['list-panes', '-a', '-F', '#{pane_id}'])).saida
      .split('\n').filter(Boolean);
    for (const id of ids) await rodar(t, ['send-keys', '-t', id, '-X', 'cancel']);
    vscode.window.showInformationMessage(`Terminais tmux: ${ids.length} painel(eis) destravado(s).`);
    recarregar(true);
  });

  cmd('gabTerminais.assumir', async () => {
    fs.writeFileSync(FLAG_FOLDEROPEN, 'A extensao gab-terminais abre as abas.\n');
    await rodar(bin('gab-terminais-sync'), []);
    // De proposito NAO abre as abas agora: as abas criadas pela task antiga
    // ainda estao nesta janela. Se os nomes nao casarem exatamente, a adocao
    // falha e nasce uma segunda aba para cada sessao — a duplicacao que este
    // setup ja sofreu. Depois do reload o folderOpen nao dispara mais e a
    // extensao abre a lista limpa, uma aba por sessao.
    const escolha = await vscode.window.showInformationMessage(
      'Terminais tmux: pronto, o gatilho antigo (folderOpen) foi desligado. ' +
      'Recarregue a janela para a extensao abrir as abas sem risco de duplicar.',
      'Recarregar agora', 'Depois',
    );
    if (escolha === 'Recarregar agora') {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
    recarregar(true);
  });

  cmd('gabTerminais.devolver', async () => {
    try { fs.unlinkSync(FLAG_FOLDEROPEN); } catch (e) { /* ja estava assim */ }
    await rodar(bin('gab-terminais-sync'), []);
    vscode.window.showInformationMessage(
      'Terminais tmux: o tasks.json volta a abrir as abas no folderOpen (vale no proximo Reload Window).',
    );
  });

  // Abertura automatica. Enquanto o folderOpen do tasks.json estiver ligado a
  // extensao NAO abre nada: os dois abrindo a mesma lista dariam abas
  // duplicadas, que e exatamente o sintoma que este setup ja teve antes.
  // vscode://gab.gab-terminais/reabrir — permite reabrir as abas de fora do
  // editor (ex.: `open vscode://gab.gab-terminais/reabrir` no terminal).
  context.subscriptions.push(vscode.window.registerUriHandler({
    handleUri(uri) {
      if (uri.path === '/reabrir') {
        vscode.commands.executeCommand('gabTerminais.reabrirAbertas');
      }
    },
  }));

  ajustarPersistenciaNativa();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('gabTerminais.persistenciaNativa')) ajustarPersistenciaNativa();
  }));
  for (const t of vscode.window.terminals) descartarTerminalAutomatico(t);
  // Nao ha mais a passada "normalizar todas" 65 s depois de abrir: ela pegava
  // as abas recriadas pelo VS Code (na ordem certa) e as recriava em paralelo,
  // e a ordem das abas voltava embaralhada a cada reabertura.

  // Com a persistencia nativa o VS Code recria as abas logo ao abrir; da um
  // instante para elas aparecerem antes de decidir o que falta reabrir.
  esperarAbasDoVSCode().then(() => recarregar(true)).then(() => {
    if (!janelaDona()) { restaurando = false; return; }
    if (fs.existsSync(FLAG_FOLDEROPEN)) {
      if (conf('abrirAoIniciar', true)) {
        restaurarNoLogin().then(() => recarregar(true));
      } else {
        restaurando = false;
      }
      return;
    }
    restaurando = false;
    vscode.window.showInformationMessage(
      'Terminais tmux: quer que a extensao passe a abrir suas abas? Ela atualiza a lista na hora, sem Reload Window, e nao depende do tasks.json no Google Drive.',
      'Assumir as abas', 'Agora nao',
    ).then((escolha) => {
      if (escolha === 'Assumir as abas') vscode.commands.executeCommand('gabTerminais.assumir');
    });
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
