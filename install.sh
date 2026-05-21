#!/usr/bin/env bash

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

# Unified skills directory
SKILLS_DIR="$HOME/.agents/skills"

# Install skills
mkdir -p "$SKILLS_DIR"

# Remove stale links from this repo (skills removed or renamed since last install)
for existing in "$SKILLS_DIR"/*; do
    [[ -L "$existing" ]] || continue
    target=$(readlink "$existing")
    [[ "$target" == "$REPO_DIR/skills/"* ]] || continue

    skill_name=$(basename "$existing")
    if [[ ! -d "$REPO_DIR/skills/$skill_name" ]]; then
        rm "$existing"
        echo "Removed stale skill link: $skill_name"
    fi
done

for skill in "$REPO_DIR/skills"/*; do
    [[ -d "$skill" ]] || continue
    skill_name=$(basename "$skill")
    ln -sfn "$skill" "$SKILLS_DIR/$skill_name"
    echo "Linked $skill_name -> $SKILLS_DIR/"
done

# Clean up retired agent files (replaced by scouts extension)
PI_AGENTS_DIR="$HOME/.pi/agent/agents"
RETIRED_AGENTS="code-analyzer.md code-locator.md code-pattern-finder.md web-searcher.md"
if [[ -d "$PI_AGENTS_DIR" ]]; then
    for retired in $RETIRED_AGENTS; do
        if [[ -f "$PI_AGENTS_DIR/$retired" ]]; then
            rm "$PI_AGENTS_DIR/$retired"
            echo "Removed retired agent: $retired"
        fi
    done
fi

# Pi extensions
PI_EXTENSIONS_DIR="$HOME/.pi/agent/extensions"
PI_EXTENSIONS_SRC="$REPO_DIR/pi-extensions"

# Stale extension links that may still exist from older installs.
STALE_EXTENSION_LINKS=(
    "custom-provider-claude-agent-sdk-v2"
    "custom-provider-claude-agent-sdk-v3"
)

mkdir -p "$PI_EXTENSIONS_DIR"
for stale in "${STALE_EXTENSION_LINKS[@]}"; do
    if [[ -L "$PI_EXTENSIONS_DIR/$stale" ]]; then
        rm "$PI_EXTENSIONS_DIR/$stale"
        echo "Removed stale extension link: $stale"
    fi
done

# Extensions to skip while walking pi-extensions/.
SKIP_EXTENSIONS=(
    "pi-subagents"
)

if [[ -d "$PI_EXTENSIONS_SRC" ]]; then
    mkdir -p "$PI_EXTENSIONS_DIR"
    for ext in "$PI_EXTENSIONS_SRC"/*; do
        [[ -e "$ext" ]] || continue
        ext_name=$(basename "$ext")
        skip_extension=false
        for skipped in "${SKIP_EXTENSIONS[@]}"; do
            if [[ "$ext_name" == "$skipped" ]]; then
                skip_extension=true
                break
            fi
        done

        if [[ "$skip_extension" == true ]]; then
            continue
        fi
        ln -sfn "$ext" "$PI_EXTENSIONS_DIR/$ext_name"
        echo "Linked $ext_name -> $PI_EXTENSIONS_DIR/"
    done
fi
