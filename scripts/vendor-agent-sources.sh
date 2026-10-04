#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REFRESH=false
case "${1:-}" in
  --refresh) REFRESH=true ;;
  '') ;;
  -h|--help) echo 'Usage: scripts/vendor-agent-sources.sh [--refresh]'; exit 0 ;;
  *) echo 'Unknown argument' >&2; exit 1 ;;
esac
pin() {
  node -p "require('${ROOT}/package.json').devDependencies['$1']"
}
clone_source() {
  local owner="$1" repo="$2" ref="$3" dest="${ROOT}/.agent_sources/github.com/$1/$2"
  if [[ -d "$dest/.git" ]]; then
    if [[ -n "$(git -C "$dest" status --porcelain)" ]]; then
      echo "Refusing to replace modified mirror: $owner/$repo" >&2
      exit 1
    fi
    if [[ "$REFRESH" != true ]]; then
      local wanted
      wanted="$(git -C "$dest" rev-parse "${ref}^{commit}" 2>/dev/null || true)"
      if [[ -z "$wanted" || "$wanted" != "$(git -C "$dest" rev-parse HEAD)" ]]; then
        echo "Mirror ref mismatch: $owner/$repo; pass --refresh" >&2
        exit 1
      fi
      return
    fi
    if [[ "$ref" == cf20298 ]]; then
      git -C "$dest" fetch origin
    else
      git -C "$dest" fetch --depth 1 origin "refs/tags/${ref}:refs/tags/${ref}"
    fi
  elif [[ -e "$dest" ]]; then
    echo 'Refusing to overwrite a non-mirror directory' >&2
    exit 1
  else
    mkdir -p "$(dirname "$dest")"
    if [[ "$ref" == cf20298 ]]; then
      git clone --filter=blob:none --no-checkout "https://github.com/${owner}/${repo}.git" "$dest"
    else
      git clone --depth 1 --branch "$ref" "https://github.com/${owner}/${repo}.git" "$dest"
    fi
  fi
  git -C "$dest" checkout --detach "$ref"
  local commit
  commit="$(git -C "$dest" rev-parse HEAD)"
  printf '\n.agent-source.json\n' >> "$dest/.git/info/exclude"
  printf '{"type":"github-repo-source","owner":"%s","repo":"%s","remote":"https://github.com/%s/%s.git","ref":"%s","commit":"%s","addedAt":"%s","note":"Pinned reference-only source mirror."}\n' "$owner" "$repo" "$owner" "$repo" "$ref" "$commit" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$dest/.agent-source.json"
  printf '%s @ %s (%s)\n' "$owner/$repo" "$ref" "$commit"
}
clone_source Effect-TS effect "effect@$(pin effect)"
clone_source statelyai xstate "xstate@$(pin xstate)"
clone_source alchemy-run alchemy "v$(pin alchemy)"
clone_source denoland celld v0.6.1
clone_source nicobailon pi-intercom v0.15.0
clone_source taslabs-net homeflare-kit cf20298
printf 'Pinned source mirrors ready. Reference only; never runtime dependencies.\n'
