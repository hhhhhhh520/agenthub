export const PROVIDER_CATEGORIES = {
  official:    { label: '官方',     color: 'bg-green-100 text-green-800' },
  cn_official: { label: '国内官方', color: 'bg-blue-100 text-blue-800' },
  aggregator:  { label: '聚合代理', color: 'bg-yellow-100 text-yellow-800' },
  third_party: { label: '第三方',   color: 'bg-orange-100 text-orange-800' },
  custom:      { label: '自定义',   color: 'bg-gray-100 text-gray-800' },
} as const

export type ProviderCategory = keyof typeof PROVIDER_CATEGORIES
