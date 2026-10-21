import { describe, expect, it } from 'vitest'
import {
  appendPlaceholders,
  mergeUploaded,
  removePlaceholders,
  type AttachmentUploadState,
  type UploadedAttachment,
} from '@/lib/attachment-upload'

function placeholder(id: string, filename: string): AttachmentUploadState {
  return {
    id,
    filename,
    mimeType: 'text/plain',
    size: 4,
    uploading: true,
  }
}

function uploaded(id: string, filename: string): UploadedAttachment {
  return { id, filename, mimeType: 'text/plain', size: 4 }
}

describe('attachment-upload — P3 #23 并发上传状态合并', () => {
  it('两个并发上传交错 append/merge，互不覆盖', () => {
    const p1 = [placeholder('tmp-1', 'a.txt')]
    const p2 = [placeholder('tmp-2', 'b.txt')]

    let state: AttachmentUploadState[] = []
    state = appendPlaceholders(state, p1)
    state = appendPlaceholders(state, p2)
    state = mergeUploaded(state, p1, [uploaded('real-1', 'a.txt')])
    state = mergeUploaded(state, p2, [uploaded('real-2', 'b.txt')])

    expect(state.map(a => a.id)).toEqual(['real-1', 'real-2'])
    expect(state.every(a => !a.uploading)).toBe(true)
  })

  it('上传结果数量与占位不一致时显式抛错，不把半套结果写进列表', () => {
    const p = [placeholder('tmp-1', 'a.txt')]
    expect(() => mergeUploaded([...p], p, [])).toThrow(/数量/)
  })

  it('失败清理只移除本次占位，保留已有附件', () => {
    const existing = { ...placeholder('old-1', 'old.txt'), uploading: false }
    const p = [placeholder('tmp-1', 'a.txt')]

    const state = removePlaceholders(appendPlaceholders([existing], p), p)

    expect(state).toEqual([existing])
  })
})
