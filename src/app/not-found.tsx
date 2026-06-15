import Link from "next/link"

export default function NotFound() {
  return (
    <div className="flex h-screen items-center justify-center bg-white dark:bg-gray-950">
      <div className="text-center space-y-4">
        <h1 className="text-6xl font-bold text-gray-300 dark:text-gray-700">404</h1>
        <p className="text-gray-500 dark:text-gray-400">页面不存在</p>
        <Link
          href="/"
          className="inline-block px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-md hover:bg-gray-700 dark:hover:bg-gray-300 transition-colors"
        >
          返回首页
        </Link>
      </div>
    </div>
  )
}
