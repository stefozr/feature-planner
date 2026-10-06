#!/usr/bin/env node
// Builds the demo data a fresh database starts from (`just seed`):
//   server/seed.json        the "Demo team" (scripts/seed/demo.mjs)
//   server/seed-teams.json  the other demo teams, [{ id, name, doc }]: "Mobile apps" (mobile.mjs),
//                           "Data platform" (data.mjs) and the built-in "Program" (program.mjs: its
//                           own roadmap and notes; the server creates an empty one when the seeds
//                           are not used)
// A fresh database gets all of them; scripts/add-demo-teams.mjs loads the extra teams into a
// running one. Everything is invented. Week keys are computed from PROJECT_START
// (scripts/seed/helpers.mjs) so every team stays coherent — the "current" week is PROJECT_START + 4.
//
// Each document is checked with the same payloadProblem() the server runs on an import, then
// written pretty-printed. Run it from the repo root: `node scripts/make-seed.mjs`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkDoc, summary } from './seed/helpers.mjs'
import demoTeam from './seed/demo.mjs'
import mobileTeam from './seed/mobile.mjs'
import dataTeam from './seed/data.mjs'
import programTeam from './seed/program.mjs'
import { PROGRAM_ID } from '../shared/db.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SEED = path.join(ROOT, 'server/seed.json')
const SEED_TEAMS = path.join(ROOT, 'server/seed-teams.json')

const demo = demoTeam()
const extra = [
  { id: 'mobile-apps', name: 'Mobile apps', doc: mobileTeam() },
  { id: 'data-platform', name: 'Data platform', doc: dataTeam() },
  { id: PROGRAM_ID, name: 'Program', doc: programTeam() },
]

try {
  checkDoc('Demo team', demo)
  for (const t of extra) checkDoc(t.name, t.doc)
} catch (e) {
  console.error(`seed: ${e instanceof Error ? e.message : e}`)
  process.exit(1)
}

fs.writeFileSync(SEED, JSON.stringify(demo, null, 2) + '\n')
fs.writeFileSync(SEED_TEAMS, JSON.stringify(extra, null, 2) + '\n')
console.log(`seed OK — wrote ${path.relative(ROOT, SEED)} (Demo team): ${summary(demo)}`)
for (const t of extra) console.log(`seed OK — wrote ${path.relative(ROOT, SEED_TEAMS)} (${t.name}): ${summary(t.doc)}`)
