# Agent Guidelines

## Key Rules

- Extensions go in `pi-extensions/`, not `~/.pi/agent/extensions/` directly
- Public/installable skills go in `skills/`, not `~/.agents/skills/` directly
- Repo-local/private agent skills go in `.agents/skills/`; these are for this repository's agents and are not advertised in the public README
- `install.sh` symlinks public/installable skills to the right place
- Update `README.md` when adding new public extensions or public/installable skills
