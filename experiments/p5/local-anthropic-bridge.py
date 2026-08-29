"""P9-乙 T6：本地弱模型 Anthropic 协议桥（FastAPI）。

把 D:/huggingface_cache 里的 Qwen1.5-0.5B-Chat 挂成 Anthropic /v1/messages，
供 claude CLI 子进程（ANTHROPIC_BASE_URL 指向本服务）做决策层调用。

设计约束：
- 只读本地缓存（local_files_only=True），不联网拉模型；
- 支持 stream=true 的 SSE 响应（CLI 走 SDK 流式解析，事件格式对齐 Anthic messages API）；
- 不做采样修饰（temperature 透传），保持弱模型原始行为——探带要的就是真实形态；
- 仅供实验内网使用（127.0.0.1），无鉴权，别暴露端口。

启动：python local-anthropic-bridge.py  （默认 127.0.0.1:15799）
换模型：环境变量 BRIDGE_MODEL_PATH=<snapshot目录> BRIDGE_MODEL_NAME=<短名>
"""
import asyncio
import json
import os
import time
import uuid

# 彻底离线：transformers 4.57 tokenizer init 有 is_base_mistral 联网路径（local_files_only 也拦不住），
# 必须全局 offline + 直接 snapshot 路径加载
os.environ.setdefault('HF_HOME', 'D:/huggingface_cache')
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'

import torch
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL_ID = 'Qwen/Qwen1.5-0.5B-Chat'
MODEL_PATH = 'D:/huggingface_cache/hub/models--Qwen--Qwen1.5-0.5B-Chat/snapshots/4d14e384a4b037942bb3f3016665157c8bcb70ea'
SERVED_MODEL_NAME = 'qwen1.5-0.5b-chat'  # CLI 侧 GLM_MODEL 用这个短名
MODEL_ID = os.environ.get('BRIDGE_MODEL_ID', MODEL_ID)
MODEL_PATH = os.environ.get('BRIDGE_MODEL_PATH', MODEL_PATH)
SERVED_MODEL_NAME = os.environ.get('BRIDGE_MODEL_NAME', SERVED_MODEL_NAME)

app = FastAPI()
tok = AutoTokenizer.from_pretrained(MODEL_PATH, local_files_only=True)
model = AutoModelForCausalLM.from_pretrained(MODEL_PATH, torch_dtype=torch.float16, local_files_only=True).to('cuda').eval()


def _flatten(content) -> str:
    """Anthropic content 可能是 str 或 [{type:text,text:...}...]"""
    if isinstance(content, str):
        return content
    parts = []
    for block in content or []:
        if isinstance(block, dict) and block.get('type') == 'text':
            parts.append(block.get('text', ''))
    return '\n'.join(parts)


def _to_chatml(payload: dict):
    msgs = []
    sys_txt = _flatten(payload.get('system'))
    if sys_txt:
        msgs.append({'role': 'system', 'content': sys_txt})
    for m in payload.get('messages', []):
        role = m.get('role', 'user')
        if role not in ('user', 'assistant'):
            role = 'user'
        txt = _flatten(m.get('content'))
        if txt:
            msgs.append({'role': role, 'content': txt})
    return msgs


@torch.inference_mode()
def _generate(messages, temperature, max_tokens) -> str:
    text = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = tok(text, return_tensors='pt').to('cuda')
    # 防超长：模型窗 32k，留生成余量后截尾部保留 system+最近上下文
    if inputs['input_ids'].shape[1] > 28000:
        inputs = {k: v[:, -28000:] for k, v in inputs.items()}
    out = model.generate(
        **inputs,
        max_new_tokens=max_tokens,
        do_sample=(temperature or 1.0) > 0.01,
        temperature=max(temperature or 1.0, 0.01),
        top_p=0.95,
        pad_token_id=tok.eos_token_id,
    )
    return tok.decode(out[0][inputs['input_ids'].shape[1]:], skip_special_tokens=True)


def _anthropic_json(text, prompt_tok, comp_tok, mid=None):
    return {
        'id': mid or f'msg_{uuid.uuid4().hex[:24]}',
        'type': 'message', 'role': 'assistant',
        'content': [{'type': 'text', 'text': text}],
        'model': SERVED_MODEL_NAME,
        'stop_reason': 'end_turn', 'stop_sequence': None,
        'usage': {'input_tokens': prompt_tok, 'output_tokens': comp_tok},
    }


@app.post('/v1/messages')
async def messages(req: Request):
    payload = await req.json()
    messages_ = _to_chatml(payload)
    temperature = payload.get('temperature', 1.0)
    max_tokens = min(int(payload.get('max_tokens') or 512), 2048)
    prompt_tok = sum(len(tok(t['content'])['input_ids']) for t in messages_)
    text = await _run(messages_, temperature, max_tokens)
    comp_tok = max(len(text) // 3, 1)
    if payload.get('stream'):
        mid = f'msg_{uuid.uuid4().hex[:24]}'

        def sse():
            yield f'event: message_start\ndata: {json.dumps({"type":"message_start","message":_anthropic_json("", prompt_tok, 0, mid)})}\n\n'
            yield f'event: content_block_start\ndata: {json.dumps({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}})}\n\n'
            yield f'event: content_block_delta\ndata: {json.dumps({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":text}})}\n\n'
            yield f'event: content_block_stop\ndata: {json.dumps({"type":"content_block_stop","index":0})}\n\n'
            yield f'event: message_delta\ndata: {json.dumps({"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":None},"usage":{"output_tokens":comp_tok}})}\n\n'
            yield f'event: message_stop\ndata: {json.dumps({"type":"message_stop"})}\n\n'
        return StreamingResponse(sse(), media_type='text/event-stream')
    return JSONResponse(_anthropic_json(text, prompt_tok, comp_tok))


async def _run(messages_, temperature, max_tokens):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _generate, messages_, temperature, max_tokens)


@app.get('/v1/models')
async def models():
    return {'data': [{'id': SERVED_MODEL_NAME, 'display_name': MODEL_ID, 'type': 'model', 'created_at': '2026-08-30T00:00:00Z'}]}


@app.get('/health')
async def health():
    return {'ok': True, 'model': MODEL_ID, 'device': str(model.device), 't': time.time()}


if __name__ == '__main__':
    print(f'[bridge] loading {MODEL_ID} on {model.device} ... ready')
    uvicorn.run(app, host='127.0.0.1', port=15799, log_level='warning')
