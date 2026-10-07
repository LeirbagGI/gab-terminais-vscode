#!/bin/bash
# Instala os "Terminais tmux": todo terminal do VS Code vira uma sessao tmux que
# sobrevive a fechar o VS Code e a reiniciar o Mac.
#
#   bash instalar.sh
#
# Pode rodar de novo quantas vezes quiser (atualiza sem duplicar nada).
# Para remover: bash desinstalar.sh

set -euo pipefail

AQUI="$(cd "$(dirname "$0")" && pwd)"
BIN="$HOME/bin"
AGENTES="$HOME/Library/LaunchAgents"
SETTINGS="$HOME/Library/Application Support/Code/User/settings.json"
BACKUP="$HOME/.gab-terminais-instalador-backup/$(date +%Y%m%d-%H%M%S)"
# Suba este numero junto com VERSAO_SCRIPTS da extensao quando mudar um script:
# a extensao dos outros computadores ve a diferenca e oferece "Reparar agora".
VERSAO_SCRIPTS=5
INICIO="# >>> terminais-tmux (gerado pelo instalador) >>>"
FIM="# <<< terminais-tmux <<<"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
aviso(){ printf '  \033[33m!\033[0m %s\n' "$1"; }
erro() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }

echo "Terminais tmux — instalador"
echo

[ "$(uname)" = "Darwin" ] || erro "Este instalador e so para macOS."

# ---- 1. Dependencias -------------------------------------------------------
export PATH="/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$PATH"

# O tmux pode estar fora dos lugares de sempre (MacPorts, conda, Homebrew em
# outra pasta). Pergunta tambem ao shell de login do usuario, que tem o PATH real.
TMUXBIN="$(command -v tmux 2>/dev/null || /bin/zsh -lic 'command -v tmux' 2>/dev/null | tail -1 || true)"
[ -n "$TMUXBIN" ] && [ -x "$TMUXBIN" ] && export PATH="$(dirname "$TMUXBIN"):$PATH"

if ! command -v tmux >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "  instalando tmux pelo Homebrew..."
    brew install tmux >/dev/null
  else
    erro "Falta o tmux. Instale o Homebrew (https://brew.sh) e rode este instalador de novo."
  fi
fi
ok "tmux $(tmux -V | cut -d' ' -f2) em $(command -v tmux)"

python3 -c 'import sys; assert sys.version_info >= (3, 8)' 2>/dev/null \
  || erro "Falta o python3. Rode: xcode-select --install  e depois este instalador de novo."
ok "python3"

CODE=""
for c in "$(command -v code 2>/dev/null || true)" \
         "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
         "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"; do
  [ -n "$c" ] && [ -x "$c" ] && { CODE="$c"; break; }
done
[ -n "$CODE" ] || erro "Nao achei o VS Code em /Applications. Instale-o e rode de novo."
ok "VS Code"

mkdir -p "$BACKUP"

# ---- 2. Scripts ------------------------------------------------------------
mkdir -p "$BIN"
for f in "$AQUI"/bin/gab-*; do
  n="$(basename "$f")"
  [ -e "$BIN/$n" ] && cp -p "$BIN/$n" "$BACKUP/"
  cp "$f" "$BIN/$n"
  chmod +x "$BIN/$n"
done
xattr -dr com.apple.quarantine "$BIN"/gab-* 2>/dev/null || true
# Atalho fixo ~/bin/tmux: scripts, extensao e LaunchAgents acham o tmux por ele,
# esteja o tmux onde estiver.
REAL="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$(command -v tmux)")"
[ "$REAL" != "$BIN/tmux" ] && ln -sf "$REAL" "$BIN/tmux"
ok "scripts em ~/bin ($(ls "$AQUI"/bin | wc -l | tr -d ' '))"

# ~/bin no PATH, para poder usar gab-nome, gab-fechar etc.
if ! grep -q 'HOME/bin' "$HOME/.zshrc" 2>/dev/null; then
  printf '\n%s\nexport PATH="$HOME/bin:$PATH"\n%s\n' "$INICIO" "$FIM" >> "$HOME/.zshrc"
  ok "~/bin adicionado ao PATH (~/.zshrc)"
fi

# ---- 3. tmux.conf ----------------------------------------------------------
# So o bloco entre as marcas e nosso; o resto do arquivo nao e tocado.
touch "$HOME/.tmux.conf"
cp "$HOME/.tmux.conf" "$BACKUP/tmux.conf"
python3 - "$HOME/.tmux.conf" "$INICIO" "$FIM" "$AQUI/tmux.conf.bloco" <<'EOF'
import sys, re
arq, ini, fim, bloco = sys.argv[1:]
s = open(arq).read()
s = re.sub(re.escape(ini) + r".*?" + re.escape(fim) + r"\n?", "", s, flags=re.S)
s = s.rstrip("\n") + ("\n\n" if s.strip() else "") + ini + "\n" + open(bloco).read().rstrip("\n") + "\n" + fim + "\n"
open(arq, "w").write(s)
EOF
tmux source-file "$HOME/.tmux.conf" 2>/dev/null || true
ok "~/.tmux.conf (hooks e mouse)"

# ---- 4. Quem abre as abas e a extensao ------------------------------------
# Esta bandeira desliga o metodo antigo (tasks.json + folderOpen); sem ela a
# extensao nao abre nada, para as duas nao abrirem abas em dobro.
touch "$HOME/.gab-terminais-sem-folderopen"
"$CODE" --install-extension "$AQUI"/gab-terminais-*.vsix --force >/dev/null 2>&1 \
  || erro "Nao consegui instalar a extensao no VS Code."
ok "extensao do VS Code"

# ---- 5. Configuracao do VS Code -------------------------------------------
mkdir -p "$(dirname "$SETTINGS")"
[ -f "$SETTINGS" ] && cp "$SETTINGS" "$BACKUP/settings.json"
if python3 - "$SETTINGS" "$BIN/gab-novo" <<'EOF'
import json, os, re, sys
arq, novo = sys.argv[1:]
txt = open(arq).read() if os.path.exists(arq) else "{}"
def sem_comentarios(t):
    # remove // e /* */ fora de strings, e virgulas sobrando
    out, i, n, em_str = [], 0, len(t), False
    while i < n:
        c = t[i]
        if em_str:
            out.append(c)
            if c == "\\": out.append(t[i+1]); i += 1
            elif c == '"': em_str = False
        elif c == '"': em_str = True; out.append(c)
        elif t.startswith("//", i): i = t.find("\n", i); i = n if i < 0 else i; continue
        elif t.startswith("/*", i): i = t.find("*/", i) + 2; continue
        else: out.append(c)
        i += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(out))
try:
    d = json.loads(sem_comentarios(txt) or "{}")
except ValueError:
    sys.exit(1)
perfis = d.setdefault("terminal.integrated.profiles.osx", {})
perfis["tmux (persistente)"] = {"path": novo, "icon": "terminal", "overrideName": True}
perfis.setdefault("zsh (comum)", {"path": "/bin/zsh", "args": ["-l"]})
d["terminal.integrated.defaultProfile.osx"] = "tmux (persistente)"
# Persistencia nativa ligada: e o que guarda icone/cor/nome escolhidos no menu
# da aba. A extensao cuida de nao duplicar (ela mesma mantem isto ajustado).
d["terminal.integrated.enablePersistentSessions"] = True
d["terminal.integrated.persistentSessionReviveProcess"] = "onExitAndWindowClose"
d["gabTerminais.abrirAoIniciar"] = True
open(arq, "w").write(json.dumps(d, indent=4, ensure_ascii=False) + "\n")
EOF
then
  ok "settings.json do VS Code (terminal padrao = tmux)"
else
  aviso "Nao consegui ler seu settings.json. Adicione a mao (Cmd+Shift+P > Open User Settings (JSON)):"
  cat <<EOF
      "terminal.integrated.profiles.osx": { "tmux (persistente)": { "path": "$BIN/gab-novo", "icon": "terminal", "overrideName": true } },
      "terminal.integrated.defaultProfile.osx": "tmux (persistente)",
      "terminal.integrated.enablePersistentSessions": false,
      "gabTerminais.abrirAoIniciar": true
EOF
fi

# ---- 6. Agendamentos (salvar telas a cada 5 min; recriar no login) ---------
mkdir -p "$AGENTES" "$HOME/Library/Logs"
LOG="$HOME/Library/Logs/gab-terminais.log"
PATHS="$BIN:/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cat > "$AGENTES/com.gab.terminais.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.gab.terminais</string>
    <key>ProgramArguments</key>
    <array><string>$BIN/gab-terminais-restore</string><string>--login</string></array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><false/>
    <key>ProcessType</key><string>Background</string>
    <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATHS</string></dict>
    <key>StandardOutPath</key><string>$LOG</string>
    <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
cat > "$AGENTES/com.gab.terminais.salvar.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.gab.terminais.salvar</string>
    <key>ProgramArguments</key><array><string>$BIN/gab-terminais-salvar</string></array>
    <key>StartInterval</key><integer>300</integer>
    <key>RunAtLoad</key><true/>
    <key>ProcessType</key><string>Background</string>
    <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATHS</string></dict>
    <key>StandardOutPath</key><string>$LOG</string>
    <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
for a in com.gab.terminais com.gab.terminais.salvar; do
  launchctl bootout "gui/$(id -u)/$a" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTES/$a.plist" 2>/dev/null \
    || launchctl load "$AGENTES/$a.plist" 2>/dev/null || true
done
ok "agendamentos (salvar a cada 5 min / recriar no login)"

"$BIN/gab-terminais-sync" >/dev/null 2>&1 || true
echo "$VERSAO_SCRIPTS" > "$HOME/.gab-terminais-versao"

echo
echo "Pronto. Agora feche e abra o VS Code (ou Cmd+Shift+P > Developer: Reload Window)."
echo "Todo terminal novo (Ctrl+\`) ja nasce salvo. Leia o LEIA-ME.txt para os comandos."
echo "Copia do que foi alterado: $BACKUP"
