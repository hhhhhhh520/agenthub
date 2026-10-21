import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CI_SRC = readFileSync(resolve(__dirname, '../.github/workflows/ci.yml'), 'utf-8')

describe('CI coverage gate', () => {
  it('test job runs the package coverage command instead of bare vitest', () => {
    expect(CI_SRC).toContain('- run: npm test')
    expect(CI_SRC).not.toContain('- run: npx vitest run')
  })
})
