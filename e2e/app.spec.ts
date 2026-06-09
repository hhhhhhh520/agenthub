import { test, expect } from "@playwright/test"

test.describe("工作区首页", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await page.waitForSelector("h1")
  })

  test("页面标题和描述正确", async ({ page }) => {
    await expect(page).toHaveTitle("AgentHub")
    await expect(page.locator("h1")).toHaveText("工作区")
    await expect(page.locator("p.text-sm.text-muted-foreground").first()).toHaveText(
      "概览你的项目和智能体活动"
    )
  })

  test("统计卡片显示会话和智能体数量", async ({ page }) => {
    // 使用 grid 容器内的卡片（排除侧边栏）
    const grid = page.locator(".grid.grid-cols-2")
    await expect(grid).toBeVisible()

    // 会话卡片
    const sessionCard = grid.locator("a[href='/projects']").first()
    await expect(sessionCard).toBeVisible()
    await expect(sessionCard.locator("p.text-xs")).toHaveText("会话")

    // 智能体卡片
    const agentCard = grid.locator("a[href='/agents']").first()
    await expect(agentCard).toBeVisible()
    await expect(agentCard.locator("p.text-xs")).toHaveText("智能体")
  })

  test("创建群聊按钮可点击", async ({ page }) => {
    const btn = page.locator("button", { hasText: "创建群聊" }).first()
    await expect(btn).toBeVisible()
    await btn.click()
    // 自定义 Dialog 使用 backdrop div（bg-black/50）
    await expect(page.locator(".fixed.inset-0.z-50")).toBeVisible()
  })

  test("进入聊天按钮链接正确", async ({ page }) => {
    const link = page.locator("a[href='/chat']", { hasText: "进入聊天" })
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute("href", "/chat")
  })

  test("搜索会话功能", async ({ page }) => {
    const searchInput = page.locator("input[placeholder='搜索会话...']")
    await expect(searchInput).toBeVisible()
    await searchInput.fill("不存在的会话名称xyz")
    await page.waitForTimeout(300)
    // 应该显示无匹配提示
    await expect(page.locator("text=没有匹配的会话")).toBeVisible()
  })

  test("侧边栏导航存在", async ({ page }) => {
    // 侧边栏使用 data-sidebar="sidebar" 作为最外层容器
    const sidebar = page.locator("[data-sidebar='sidebar']")
    await expect(sidebar).toBeVisible()
    // 侧边栏内应有导航链接
    await expect(sidebar.getByRole("link", { name: "工作区" })).toBeVisible()
    await expect(sidebar.getByRole("link", { name: "项目" })).toBeVisible()
    await expect(sidebar.getByRole("link", { name: "智能体" })).toBeVisible()
  })
})

test.describe("聊天页面", () => {
  test("页面可访问", async ({ page }) => {
    await page.goto("/chat")
    await page.waitForSelector("body")
    await expect(page).toHaveURL(/\/chat/)
  })
})

test.describe("项目页面", () => {
  test("页面可访问", async ({ page }) => {
    await page.goto("/projects")
    await page.waitForSelector("body")
    await expect(page).toHaveURL(/\/projects/)
  })
})

test.describe("智能体页面", () => {
  test("页面可访问", async ({ page }) => {
    await page.goto("/agents")
    await page.waitForSelector("body")
    await expect(page).toHaveURL(/\/agents/)
  })
})

test.describe("API 端点", () => {
  test("GET /api/agents 返回数组", async ({ request }) => {
    const response = await request.get("/api/agents")
    expect(response.ok()).toBeTruthy()
    const data = await response.json()
    expect(Array.isArray(data)).toBeTruthy()
  })

  test("GET /api/sessions 返回数组", async ({ request }) => {
    const response = await request.get("/api/sessions")
    expect(response.ok()).toBeTruthy()
    const data = await response.json()
    expect(Array.isArray(data)).toBeTruthy()
  })

  test("GET /api/config 返回配置", async ({ request }) => {
    const response = await request.get("/api/config?key=setupCompleted")
    expect(response.ok()).toBeTruthy()
    const data = await response.json()
    expect(data).toHaveProperty("value")
  })
})

test.describe("创建群聊流程", () => {
  test("打开和关闭创建群聊弹窗", async ({ page }) => {
    await page.goto("/")
    await page.waitForSelector("h1")

    // 点击创建群聊
    await page.locator("button", { hasText: "创建群聊" }).first().click()
    const dialog = page.locator(".fixed.inset-0.z-50")
    await expect(dialog).toBeVisible()

    // 点击 backdrop 关闭
    await page.mouse.click(10, 10)
    await expect(dialog).not.toBeVisible()
  })
})
