# feature-planner tasks — run `just` to list. (dev = `npm run dev`, keycloak = `docker compose up -d`.)

# one-shot dev: install deps if missing, then run server + vite on random free ports
# (prints both URLs) — so several branches/worktrees run at once without collisions
dev:
    #!/usr/bin/env sh
    [ -d node_modules ] || npm install
    npm run dev

# regenerate server/seed.json (the demo data set) from scripts/make-seed.mjs; the seed is only
# read when data/db.sqlite does not exist yet — see README "Run"
seed:
    node scripts/make-seed.mjs

# start over on the demo data: stop the server first
reset-db:
    rm -f data/db.sqlite data/db.sqlite-wal data/db.sqlite-shm data/db.json
    @echo "data/ cleared — the next server start seeds from server/seed.json"

# type-check the frontend and the shared module (no output)
typecheck:
    npx tsc --noEmit

# run every test: vitest over src/, node:test over server/
test:
    npm test

# the app's favicon and touch icon (needs Pillow: pip install pillow)
favicon:
    python3 scripts/make-favicon.py

# where the image is pushed; override on the command line: `just release IMG=registry/you/feature-planner`
img := env_var_or_default("IMG", "feature-planner")
# Default tag = short git SHA (unique + immutable per commit; "-dirty" if uncommitted changes).
tag := `git describe --always --dirty --abbrev=8`

# build + push the image (buildx + --platform linux/amd64 so it cross-builds from an arm64 Mac)
release TAG=tag:
    docker buildx build --platform linux/amd64 -t "{{img}}:{{TAG}}" --push .
    @echo "pushed {{img}}:{{TAG}}"
