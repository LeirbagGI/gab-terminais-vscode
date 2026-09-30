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
const PERFIL = 'tmux (persistente)';   // nome das abas criadas pelo botao +

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

function tmuxBin() {
  for (const b of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']) {
    try { fs.accessSync(b, fs.constants.X_OK); return b; } catch (e) { /* proximo */ }
  }
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

async function sessaoDaAba(t, clientes) {
  for (const [nome, aba] of abertos) if (aba === t) return nome;
  let pid;
  try { pid = await t.processId; } catch (e) { pid = undefined; }
  return (pid && clientes.get(pid)) || null;
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
    if (!encolherAgora) {
      const r = await rodar(tmuxBin(), ['list-sessions', '-F', '#{session_name}']);
      const existem = new Set(r.saida.split('\n').filter(Boolean));
      for (const x of abertasSalvas()) {
        if (!existem.has(nomeDe(x)) || vistas.has(nomeDe(x))) continue;
        vistas.add(nomeDe(x));
        lista.push(x);
      }
    }
    const antes = JSON.stringify(abertasSalvas());
    lista.sort((a, b) => nomeDe(a).localeCompare(nomeDe(b)));
    try {
      if (JSON.stringify(lista) === antes) return;
      const tmp = ARQ_ABERTAS + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(lista, null, 2));
      fs.renameSync(tmp, ARQ_ABERTAS);
    } catch (e) { /* sem registro e melhor do que quebrar a janela */ }
  }, 2500);
}

// Cada item e "SESSAO" ou { sessao, aba } quando o titulo da aba foi renomeado.
const nomeDe = (x) => (typeof x === 'string' ? x : x.sessao);
const rotuloDe = (x) => (typeof x === 'string' ? x : x.aba || x.sessao);

// Fechar o VS Code descarta as abas uma a uma. Se cada descarte virasse "o
// usuario fechou esta aba", o registro encolheria ate sobrar pouco ou nada.
let encerrando = false;

function abertasSalvas() {
  try {
    const l = JSON.parse(fs.readFileSync(ARQ_ABERTAS, 'utf8'));
    return Array.isArray(l) ? l.filter((x) => x && nomeDe(x)) : [];
  } catch (e) { return []; }
}

// Reabre exatamente o que estava aberto, e so o que ainda existe no tmux.
async function reabrirAbertas() {
  const querendo = abertasSalvas();
  if (!querendo.length) return { criados: 0, total: 0 };
  const vivas = new Set((await sessoesVivas()).map((s) => s.nome));
  await adotarExistentes();
  const corDoSync = new Map(((await queViramAba()) || [])
    .map((s) => [s.nome, s.icone && s.icone.color]));
  let criados = 0;
  for (const item of querendo) {
    const nome = nomeDe(item);
    if (!vivas.has(nome) || vivo(abertos.get(nome))) continue;
    abrir(nome, corDoSync.get(nome), false, rotuloDe(item));
    criados++;
  }
  return { criados, total: querendo.length };
}

// No login o tmux pode estar recriando as sessoes enquanto a extensao sobe.
// Tenta de novo ate todas as que estavam abertas existirem (prazo de 3 min) e
// so entao libera o registro.
async function restaurarNoLogin() {
  const querendo = abertasSalvas();
  const prazo = Date.now() + 180000;
  try {
    for (;;) {
      await reabrirAbertas();
      const vivas = new Set((await sessoesVivas()).map((s) => s.nome));
      if (querendo.every((n) => vivas.has(nomeDe(n))) || Date.now() > prazo) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
  } finally {
    restaurando = false;
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

  const timer = setInterval(() => { recarregar(false); registrarAbertas(); }, Math.max(2, conf('intervalo', 5)) * 1000);
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
    vscode.window.onDidOpenTerminal(() => {
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

  recarregar(true).then(() => {
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
