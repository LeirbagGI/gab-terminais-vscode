#!/bin/bash
# Remove os "Terminais tmux". As sessoes que estiverem abertas continuam vivas
# ate o proximo reboot; os arquivos de dados (~/.gab-terminais*) ficam, caso
# queira reinstalar depois. Apague-os a mao se quiser limpar tudo.

set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
INICIO="# >>> terminais-tmux (gerado pelo instalador) >>>"
FIM="# <<< terminais-tmux <<<"
SETTINGS="$HOME/Library/Application Support/Code/User/settings.json"

for a in com.gab.terminais com.gab.terminais.salvar; do
  launchctl bootout "gui/$(id -u)/$a" 2>/dev/null || launchctl unload "$HOME/Library/LaunchAgents/$a.plist" 2>/dev/null
  rm -f "$HOME/Library/LaunchAgents/$a.plist"
done
echo "  agendamentos removidos"

for arq in "$HOME/.tmux.conf" "$HOME/.zshrc"; do
  [ -f "$arq" ] && python3 - "$arq" "$INICIO" "$FIM" <<'EOF'
import sys, re
arq, ini, fim = sys.argv[1:]
s = open(arq).read()
open(arq, "w").write(re.sub(r"\n*" + re.escape(ini) + r".*?" + re.escape(fim) + r"\n?", "\n", s, flags=re.S))
EOF
done
tmux set-hook -gu session-created 2>/dev/null; tmux set-hook -gu session-closed 2>/dev/null
tmux set-hook -gu after-rename-session 2>/dev/null; tmux set-hook -gu client-detached 2>/dev/null
echo "  ~/.tmux.conf e ~/.zshrc limpos"

CODE="$(command -v code 2>/dev/null || echo "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code")"
"$CODE" --uninstall-extension gab.gab-terminais >/dev/null 2>&1 && echo "  extensao removida"

[ -f "$SETTINGS" ] && python3 - "$SETTINGS" <<'EOF' && echo "  VS Code volta a usar o terminal comum"
import json, sys
arq = sys.argv[1]
try:
    d = json.load(open(arq))
except ValueError:
    sys.exit(1)
if d.get("terminal.integrated.defaultProfile.osx") == "tmux (persistente)":
    d.pop("terminal.integrated.defaultProfile.osx")
d.get("terminal.integrated.profiles.osx", {}).pop("tmux (persistente)", None)
d.pop("gabTerminais.abrirAoIniciar", None)
open(arq, "w").write(json.dumps(d, indent=4, ensure_ascii=False) + "\n")
EOF

for n in gab-attach gab-novo gab-nome gab-ir gab-fechar gab-renomear gab-claude gab-claude-novo \
         gab-conversas-mapear gab-terminais-sync gab-terminais-salvar gab-terminais-restore; do
  rm -f "$HOME/bin/$n"
done
[ -L "$HOME/bin/tmux" ] && rm -f "$HOME/bin/tmux"
rm -f "$HOME/.gab-terminais-sem-folderopen"
echo "  scripts removidos"
echo "Pronto. Reabra o VS Code."
