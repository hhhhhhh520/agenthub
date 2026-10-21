/** 异步请求世代：只有最后一次 begin 的请求允许写状态。 */
export interface RequestEpoch {
  next(): number
  isCurrent(id: number): boolean
  invalidate(): void
}

export function createRequestEpoch(): RequestEpoch {
  let current = 0
  return {
    next: () => ++current,
    isCurrent: (id) => id === current,
    invalidate: () => { current++ },
  }
}
