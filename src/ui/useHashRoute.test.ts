import { expect, test } from 'vitest'
import { parseHash, toHash, type Route } from './useHashRoute'

const routes: Route[] = [
  { team: 'default', view: 'planner' },
  { team: 'platform-2', view: 'planner', feature: 'f 1/é' },
  { team: 'mobile', view: 'planner', epic: 'e1' },
  { team: 'a', view: 'capacity' },
  { team: 'a', view: 'capacity', at: 'attention' },
  { team: 'a', view: 'capacity', at: 'scope' },
  { team: 'x9', view: 'status' },
  { team: 'x9', view: 'roadmap' },
]

test('toHash / parseHash round-trip every route', () => {
  for (const r of routes) expect(parseHash(toHash(r))).toEqual(r)
  expect(toHash({ team: 'platform-2', view: 'planner', feature: 'f 1/é' })).toBe('#/platform-2/planner?feature=f%201%2F%C3%A9')
})

test('a hash from before teams parses without a team, so the shell can fill it in', () => {
  expect(parseHash('#/planner')).toEqual({ view: 'planner' })
  expect(parseHash('#/planner?feature=f1')).toEqual({ view: 'planner', feature: 'f1' })
  expect(parseHash('#/capacity?at=scope')).toEqual({ view: 'capacity', at: 'scope' })
  expect(parseHash('#/roadmap')).toEqual({ view: 'roadmap' })
})

test('unknown cards and parameters are dropped, a feature wins over an epic', () => {
  expect(parseHash('#/t/capacity?at=nope')).toEqual({ team: 't', view: 'capacity' })
  expect(parseHash('#/t/planner?feature=f&epic=e')).toEqual({ team: 't', view: 'planner', feature: 'f' })
  expect(parseHash('#/t/status?x=1')).toEqual({ team: 't', view: 'status' })
})

test('anything else is no route', () => {
  for (const h of ['', '#', '#/', '#/nope', '#/t', '#/t/', '#/T/planner', '#/planner/planner', '#/api/status', '#/-a/planner', '#/a b/planner', `#/${'a'.repeat(41)}/planner`, '#/t/planner#x']) {
    expect(parseHash(h), h).toBeNull()
  }
})

test('the Program team is an ordinary team id in the hash', () => {
  expect(parseHash('#/program/roadmap')).toEqual({ team: 'program', view: 'roadmap' })
  expect(parseHash('#/program/planner?feature=x')).toEqual({ team: 'program', view: 'planner', feature: 'x' })
  expect(toHash({ team: 'program', view: 'capacity', at: 'scope' })).toBe('#/program/capacity?at=scope')
})
