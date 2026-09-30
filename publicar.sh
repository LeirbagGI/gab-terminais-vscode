#!/bin/bash
# Publica uma versao nova da extensao como release no GitHub.
# Os VS Codes com a extensao instalada oferecem "Atualizar" sozinhos.
#
#   ./publicar.sh 1.5.0 "o que mudou"
set -euo pipefail
cd "$(dirname "$0")"
V="${1:?uso: ./publicar.sh VERSAO \"o que mudou\"}"
NOTAS="${2:-versao $V}"
python3 - "$V" <<'PY'
import json, sys
p = json.load(open("package.json")); p["version"] = sys.argv[1]
open("package.json", "w").write(json.dumps(p, indent=2, ensure_ascii=False) + "\n")
PY
rm -f gab-terminais-*.vsix
npx --yes @vscode/vsce package --allow-missing-repository >/dev/null
cp "gab-terminais-$V.vsix" gab-terminais.vsix
git add -A && git commit -qm "v$V: $NOTAS" && git tag "v$V" && git push -q && git push -q --tags
ANEXOS=(gab-terminais.vsix)
[ -f "$HOME/Desktop/Terminais-tmux-instalador.zip" ] && ANEXOS+=("$HOME/Desktop/Terminais-tmux-instalador.zip")
gh release create "v$V" "${ANEXOS[@]}" --title "v$V" --notes "$NOTAS"
rm -f gab-terminais.vsix
echo "Publicado: v$V"
