#!/usr/bin/env bash
# Assemble dist/ puis publie sur Cloudflare Workers (mon-bilan-solaire.fr).
#
# dist/ est reconstruit à chaque fois, et ne contient que ce qui doit être
# public : le dépôt garde à sa racine le README, le script de remplacement du
# héros et la page d'essai, qui n'ont rien à faire en ligne.
set -euo pipefail
cd "$(dirname "$0")"

PAGES=(index.html merci.html merci-hors-zone.html merci-non-eligible.html
       mentions-legales.html confidentialite.html 404.html)

rm -rf dist && mkdir -p dist
for p in "${PAGES[@]}"; do cp "$p" dist/; done
cp -R img dist/img
cp _headers dist/_headers

echo "dist/ : $(find dist -type f | wc -l | tr -d ' ') fichiers, $(du -sh dist | cut -f1)"
exec npx wrangler@latest deploy "$@"
