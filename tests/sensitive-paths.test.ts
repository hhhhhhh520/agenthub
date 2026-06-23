// contract v1 §1.2 b: 敏感路径检测单元测试
import { describe, it, expect } from 'vitest'
import { isSensitivePath, pickSensitive } from '@/lib/services/sensitive-paths'

describe('isSensitivePath', () => {
  describe('精确匹配的敏感文件', () => {
    it('package.json 是敏感的', () => {
      expect(isSensitivePath('package.json')).toBe(true)
    })

    it('package-lock.json 是敏感的', () => {
      expect(isSensitivePath('package-lock.json')).toBe(true)
    })

    it('prisma/schema.prisma 是敏感的', () => {
      expect(isSensitivePath('prisma/schema.prisma')).toBe(true)
    })

    it('.gitignore 是敏感的', () => {
      expect(isSensitivePath('.gitignore')).toBe(true)
    })

    it('tsconfig.json 是敏感的', () => {
      expect(isSensitivePath('tsconfig.json')).toBe(true)
    })
  })

  describe('前缀匹配:.env / node_modules / .git / .agenthub', () => {
    it('.env 是敏感的', () => {
      expect(isSensitivePath('.env')).toBe(true)
    })

    it('.env.local 是敏感的', () => {
      expect(isSensitivePath('.env.local')).toBe(true)
    })

    it('.env.production 是敏感的', () => {
      expect(isSensitivePath('.env.production')).toBe(true)
    })

    it('node_modules 下任何文件都敏感', () => {
      expect(isSensitivePath('node_modules/some-pkg/index.js')).toBe(true)
      expect(isSensitivePath('node_modules/.bin/foo')).toBe(true)
    })

    it('.git 下任何文件都敏感(用户自己的 git 元数据)', () => {
      expect(isSensitivePath('.git/HEAD')).toBe(true)
      expect(isSensitivePath('.git/refs/heads/main')).toBe(true)
    })

    it('.agenthub/ 是敏感的(影子 git 等)', () => {
      expect(isSensitivePath('.agenthub/shadow-git/abc/HEAD')).toBe(true)
    })

    it('.next/ 是敏感的(build artifacts)', () => {
      expect(isSensitivePath('.next/cache/foo')).toBe(true)
    })
  })

  describe('模式匹配:配置文件', () => {
    it('next.config.js / .mjs / .ts 都敏感', () => {
      expect(isSensitivePath('next.config.js')).toBe(true)
      expect(isSensitivePath('next.config.mjs')).toBe(true)
      expect(isSensitivePath('next.config.ts')).toBe(true)
    })

    it('vite.config.* 敏感', () => {
      expect(isSensitivePath('vite.config.ts')).toBe(true)
    })

    it('vitest.config.* 敏感', () => {
      expect(isSensitivePath('vitest.config.ts')).toBe(true)
    })

    it('tsconfig.build.json 等扩展 tsconfig 敏感', () => {
      expect(isSensitivePath('tsconfig.build.json')).toBe(true)
    })
  })

  describe('普通代码文件不敏感', () => {
    it('src/ 下普通文件不敏感', () => {
      expect(isSensitivePath('src/app/page.tsx')).toBe(false)
      expect(isSensitivePath('src/lib/utils.ts')).toBe(false)
    })

    it('普通 README / docs 不敏感', () => {
      expect(isSensitivePath('README.md')).toBe(false)
      expect(isSensitivePath('docs/architecture.md')).toBe(false)
    })

    it('其他 JSON 不敏感', () => {
      expect(isSensitivePath('src/config.json')).toBe(false)
      expect(isSensitivePath('public/data.json')).toBe(false)
    })

    it('test 文件不敏感', () => {
      expect(isSensitivePath('tests/foo.test.ts')).toBe(false)
    })
  })

  describe('路径标准化:Windows 反斜杠 + ./ 前缀', () => {
    it('Windows 反斜杠路径正确识别', () => {
      expect(isSensitivePath('node_modules\\foo\\index.js')).toBe(true)
    })

    it('./ 前缀正确识别', () => {
      expect(isSensitivePath('./package.json')).toBe(true)
      expect(isSensitivePath('./.env')).toBe(true)
    })
  })
})

describe('pickSensitive', () => {
  it('从越界列表中筛出敏感越界', () => {
    const undeclared = [
      'src/foo.ts',           // 普通
      'package.json',         // 敏感
      'src/bar.ts',           // 普通
      '.env',                 // 敏感
      'node_modules/x/i.js',  // 敏感
    ]
    expect(pickSensitive(undeclared)).toEqual([
      'package.json', '.env', 'node_modules/x/i.js',
    ])
  })

  it('全部非敏感返回空数组', () => {
    expect(pickSensitive(['src/a.ts', 'src/b.ts'])).toEqual([])
  })

  it('全部敏感返回原列表', () => {
    expect(pickSensitive(['package.json', '.env'])).toEqual(['package.json', '.env'])
  })

  it('空输入返回空数组', () => {
    expect(pickSensitive([])).toEqual([])
  })
})
