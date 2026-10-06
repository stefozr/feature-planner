import { describe, expect, it } from 'vitest'
import { budgetHours, sumHours } from './tracking'

describe('budgetHours', () => {
  it('is estimate − logged − remaining', () => {
    expect(budgetHours({ estimate: 40, logged: 12, remaining: 20 })).toBe(8)
  })
  it('treats missing logged / remaining as 0', () => {
    expect(budgetHours({ estimate: 10 })).toBe(10)
    expect(budgetHours({ estimate: 10, logged: 4 })).toBe(6)
  })
  it('goes negative when more was spent than estimated', () => {
    expect(budgetHours({ estimate: 10, logged: 12, remaining: 3 })).toBe(-5)
  })
  it('is null without an estimate', () => {
    expect(budgetHours({ logged: 5, remaining: 2 })).toBeNull()
    expect(budgetHours({})).toBeNull()
  })
})

describe('sumHours', () => {
  it('sums each column and foots the budget', () => {
    const t = sumHours([
      { estimate: 40, logged: 12, remaining: 20 },
      { estimate: 10, logged: 14, remaining: 2 },
    ])
    expect(t).toEqual({ estimate: 50, logged: 26, remaining: 22, budget: 2, n: 2 })
    expect(t.budget).toBe(t.estimate - t.logged - t.remaining)
  })
  it('skips features with no figures and counts the rest', () => {
    const t = sumHours([{}, { logged: 3 }, { estimate: 8 }])
    expect(t).toEqual({ estimate: 8, logged: 3, remaining: 0, budget: 5, n: 2 })
  })
  it('is all zeros with n = 0 for an empty list', () => {
    expect(sumHours([])).toEqual({ estimate: 0, logged: 0, remaining: 0, budget: 0, n: 0 })
  })
})
