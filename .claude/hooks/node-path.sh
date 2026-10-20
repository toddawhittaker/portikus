# Sourced by the hooks. Prints the bin directory of the highest installed
# nvm Node whose major version matches <repo>/.nvmrc, or nothing.
node_bin_for() {
  local repo="$1" major dir
  [ -f "$repo/.nvmrc" ] || return 0
  major="$(tr -d ' \nv' <"$repo/.nvmrc" | cut -d. -f1)"
  [ -n "$major" ] || return 0
  dir="$(find "$HOME/.nvm/versions/node" -maxdepth 1 -name "v$major.*" 2>/dev/null | sort -V | tail -n 1)"
  if [ -n "$dir" ] && [ -x "$dir/bin/node" ]; then
    printf '%s/bin\n' "$dir"
  fi
  return 0
}
