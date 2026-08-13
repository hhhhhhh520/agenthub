import { CONFIG } from './config'

/** 暂停点罐头消息（Spec §6：固定句，落库为 user 消息后 LLM 才能看到） */
export function simulateUserReply(awaitingType: string): string {
  return CONFIG.cannedReplies[awaitingType] ?? CONFIG.cannedReplies.escalate
}
