"use client"

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="flex h-screen items-center justify-center bg-white dark:bg-gray-950">
      <div className="text-center space-y-4 max-w-md">
        <h1 className="text-2xl font-bold text-red-600">出了点问题</h1>
        <p className="text-gray-500 dark:text-gray-400">
          {process.env.NODE_ENV === "development"
            ? error.message
            : "页面加载时发生了错误，请重试。"}
        </p>
        {process.env.NODE_ENV === "development" && error.digest && (
          <p className="text-xs text-gray-400 dark:text-gray-500">错误ID: {error.digest}</p>
        )}
        <button
          onClick={() => reset()}
          className="px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-md hover:bg-gray-700 dark:hover:bg-gray-300 transition-colors"
        >
          重试
        </button>
      </div>
    </div>
  )
}
