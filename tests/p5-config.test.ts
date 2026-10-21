import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildP5Paths, CONFIG, P5_DIR } from '../experiments/p5/config'

const CONFIG_SRC = readFileSync(resolve(__dirname, '../experiments/p5/config.ts'), 'utf-8')

describe('P5 config paths', () => {
  it('默认路径从仓库内 experiments/p5 派生，不再写死盘符', () => {
    expect(P5_DIR).toBe(resolve(__dirname, '../experiments/p5'))
    expect(CONFIG.workDir).toBe(resolve(P5_DIR, 'work'))
    expect(CONFIG.resultsDir).toBe(resolve(P5_DIR, 'results'))
    expect(CONFIG.dbPath).toBe(`file:${resolve(P5_DIR, 'p5.db').replace(/\\/g, '/')}`)
    expect(CONFIG_SRC).not.toMatch(/D:\/ai全栈挑战赛/)
  })

  it('P5_DB_PATH / P5_WORK_DIR / P5_RESULTS_DIR 覆盖默认值', () => {
    const paths = buildP5Paths(
      {
        P5_DB_PATH: resolve('tmp/p5-test.db'),
        P5_WORK_DIR: resolve('tmp/p5-work'),
        P5_RESULTS_DIR: resolve('tmp/p5-results'),
      },
      P5_DIR,
    )

    expect(paths.dbPath).toBe(`file:${resolve('tmp/p5-test.db').replace(/\\/g, '/')}`)
    expect(paths.workDir).toBe(resolve('tmp/p5-work'))
    expect(paths.resultsDir).toBe(resolve('tmp/p5-results'))
  })

  it('P5_DB_PATH 传入 file: URL 时保留 URL 语义', () => {
    const paths = buildP5Paths({ P5_DB_PATH: 'file:./tmp/custom.db' }, P5_DIR)
    expect(paths.dbPath).toBe(`file:${resolve('tmp/custom.db').replace(/\\/g, '/')}`)
  })
})
