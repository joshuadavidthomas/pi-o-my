set dotenv-load
set shell := ["bash", "-euo", "pipefail", "-c"]
set unstable

# List all available commands
[private]
default:
    @just --list --list-submodules

fmt:
    just --fmt

# Install everything (skills, agents, extensions)
install:
    ./install.sh
