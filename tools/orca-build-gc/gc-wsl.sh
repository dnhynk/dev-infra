#!/bin/bash
# orca-build-gc 의 WSL 절반. $1=최소 나이(일), $2=apply|dry
# cargo·rustup·pnpm-store·node-* 는 공유 툴체인이므로 대상이 아니다.
days="$1"; mode="$2"; mins=$((days*1440))
if [ "$mode" = "apply" ]; then act="rm -rf --"; else act="echo would-rm"; fi

cd "$HOME" 2>/dev/null || exit 0
find . -maxdepth 1 -type d -name 't[0-9]*' -mmin +"$mins" -print0 | xargs -0 -r $act

ci="$HOME/.local/share/academic-platform-ci"
[ -d "$ci" ] || exit 0
find "$ci" -maxdepth 1 -type d \( -name 'target*' -o -name 'tmp-*' \) -mmin +"$mins" -print0 | xargs -0 -r $act
[ -d "$ci/work" ] && find "$ci/work" -maxdepth 1 -mindepth 1 -type d -mmin +"$mins" -print0 | xargs -0 -r $act
exit 0
