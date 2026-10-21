"use client"

import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components-v2/app-sidebar"

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="overflow-y-auto">
        <div className="md:hidden sticky top-0 z-30 flex items-center gap-2 border-b bg-background px-3 py-2">
          <SidebarTrigger />
          <span className="text-sm font-medium">AgentHub</span>
        </div>
        {children}
      </SidebarInset>
    </SidebarProvider>
  )
}
