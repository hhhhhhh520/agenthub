"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useTheme } from "next-themes"
import { useMounted } from "@/lib/hooks/use-mounted"
import {
  Home,
  FolderKanban,
  Bot,
  Sun,
  Moon,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar"

const navItems = [
  { title: "工作区", href: "/", icon: Home },
  { title: "项目", href: "/projects", icon: FolderKanban },
  { title: "智能体", href: "/agents", icon: Bot },

]

export function AppSidebar() {
  const pathname = usePathname()
  const { theme, setTheme } = useTheme()
  const mounted = useMounted()

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b px-4 py-3">
        <div className="flex items-center gap-2 group-data-[collapsible=icon]:justify-center">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground text-sm font-bold">
            A
          </div>
          <span className="font-semibold text-sm group-data-[collapsible=icon]:hidden">
            AgentHub
          </span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => {
                const isActive =
                  pathname === item.href ||
                  (item.href !== "/" && pathname.startsWith(item.href))
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton isActive={isActive} tooltip={item.title} render={<Link href={item.href} />}>
                        <item.icon className="h-4 w-4" />
                        <span>{item.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t p-2">
        <SidebarMenu>
          {mounted && (
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => {
                  if (theme === 'system') setTheme('light')
                  else if (theme === 'light') setTheme('dark')
                  else setTheme('system')
                }}
                tooltip={
                  theme === 'system' ? '跟随系统（点击切换亮色）' :
                  theme === 'light' ? '亮色模式（点击切换暗色）' :
                  '暗色模式（点击跟随系统）'
                }
                className="w-full"
              >
                {theme === 'system' ? (
                  <Sun className="h-4 w-4 opacity-50" />
                ) : theme === 'dark' ? (
                  <Moon className="h-4 w-4" />
                ) : (
                  <Sun className="h-4 w-4" />
                )}
                <span>{theme === 'system' ? '系统' : theme === 'dark' ? '暗色' : '亮色'}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <SidebarMenuItem>
            <SidebarTrigger className="w-full" />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}
