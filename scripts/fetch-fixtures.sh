#!/usr/bin/env bash
# Clones the third-party fixture projects at pinned commits (they are git-ignored, not vendored).
set -euo pipefail
cd "$(dirname "$0")/../test/fixtures"

fetch() { # name url commit
  if [ ! -d "$1" ]; then git clone -q "$2" "$1"; fi
  git -C "$1" fetch -q --depth 1 origin "$3" && git -C "$1" checkout -q "$3"
}

fetch spring-petclinic    https://github.com/spring-projects/spring-petclinic.git   500158f732419217507c7656904b8e6aa1bcc0d6
fetch spring-petclinic-ai https://github.com/spring-petclinic/spring-petclinic-ai.git d48e749c07ada12aa6161a6223bf292cb96e63f3
echo "fixtures ready"
