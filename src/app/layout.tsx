import type { Metadata } from "next"
import "./globals.css"
import { Toaster } from "@/components/ui/sonner"

export const metadata: Metadata = {
  title: "AgentHub",
  description: "多 Agent 协作平台",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full overflow-hidden antialiased">
      <body className="h-screen overflow-hidden flex flex-col">
        {children}
        <Toaster position="bottom-right" />
      </body>
    </html>
  )
}
