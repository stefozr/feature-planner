import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FULL_ACCESS, NO_ACCESS, ROLE_ADMIN, ROLE_EDITOR, ROLE_VIEWER, accessOf, canEditTeam, editorRole, rolesOfToken } from '../shared/auth.mjs'
import { PROGRAM_ID } from '../shared/db.mjs'

test('an admin reads and writes everything, the Program included', () => {
  const a = accessOf([ROLE_ADMIN])
  assert.equal(a.canView, true)
  assert.equal(a.admin, true)
  assert.equal(canEditTeam(a, 'mobile-apps'), true)
  assert.equal(canEditTeam(a, PROGRAM_ID), true)
})

test('a per-team editor writes that team only, never the Program', () => {
  const a = accessOf([editorRole('mobile-apps'), editorRole('data-platform')])
  assert.equal(a.canView, true)
  assert.equal(a.admin, false)
  assert.deepEqual([...a.teams].sort(), ['data-platform', 'mobile-apps'])
  assert.equal(canEditTeam(a, 'mobile-apps'), true)
  assert.equal(canEditTeam(a, 'data-platform'), true)
  assert.equal(canEditTeam(a, 'demo'), false)
  assert.equal(canEditTeam(a, PROGRAM_ID), false)
})

test('an editor role naming the Program grants nothing on it', () => {
  const a = accessOf([editorRole(PROGRAM_ID)])
  assert.equal(a.canView, true)
  assert.equal(canEditTeam(a, PROGRAM_ID), false)
})

test('viewer and the plain editor role read everything and write nothing', () => {
  for (const role of [ROLE_VIEWER, ROLE_EDITOR]) {
    const a = accessOf([role])
    assert.equal(a.canView, true, role)
    assert.equal(a.admin, false, role)
    assert.equal(a.teams.size, 0, role)
    assert.equal(canEditTeam(a, 'demo'), false, role)
  }
})

test('no planner role at all means no access; unrelated roles are ignored', () => {
  const a = accessOf(['offline_access', 'uma_authorization', 'feature-planner-editor:'])
  assert.equal(a.canView, false)
  assert.equal(a.admin, false)
  assert.equal(a.teams.size, 0)
  assert.deepEqual(accessOf([]), { canView: false, admin: false, teams: new Set() })
  assert.deepEqual(accessOf(undefined), { canView: false, admin: false, teams: new Set() })
})

test('the two constants match what accessOf would say', () => {
  assert.equal(canEditTeam(FULL_ACCESS, PROGRAM_ID), true)
  assert.equal(canEditTeam(NO_ACCESS, 'demo'), false)
  assert.equal(NO_ACCESS.canView, false)
})

test('rolesOfToken merges realm roles with every client\'s roles', () => {
  const roles = rolesOfToken({
    realm_access: { roles: [ROLE_VIEWER, 'offline_access'] },
    resource_access: {
      'feature-planner': { roles: [editorRole('demo')] },
      account: { roles: ['manage-account'] },
      broken: {},
    },
  })
  assert.deepEqual([...roles].sort(), [editorRole('demo'), 'manage-account', 'offline_access', ROLE_VIEWER].sort())
  assert.equal(rolesOfToken(null).size, 0)
  assert.equal(rolesOfToken({}).size, 0)
})
