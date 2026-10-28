#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本机 AI 代理：让 demo 用多模态大模型识图，而 API Key 完全不进浏览器。

为什么需要它：直接在前端填 Key，任何打开网页的人都能从浏览器里把 Key 偷走。
这个脚本在本机转发请求 —— Key 只存在于本机环境变量，浏览器只跟 127.0.0.1 说话。

用法（PowerShell，Windows）：

    $env:UPSTREAM_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"   # 上游 OpenAI 兼容地址
    $env:UPSTREAM_KEY  = "sk-你的key"
    python ai_proxy.py
    # 默认监听 http://127.0.0.1:8765/v1

然后在 demo 的「🤖 AI 识图设置」里：
    服务商 = 本机代理（ai_proxy.py，Key 不落浏览器）
    接口   = http://127.0.0.1:8765/v1
    模型   = qwen-vl-max-latest（换成你上游支持的视觉模型名即可）
    API Key 留空

可选环境变量：PORT（默认 8765）。只监听 127.0.0.1，不对局域网开放。
"""
import json
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = os.environ.get("UPSTREAM_BASE", "https://dashscope.aliyuncs.com/compatible-mode/v1").rstrip("/")
KEY = os.environ.get("UPSTREAM_KEY", "")
PORT = int(os.environ.get("PORT", "8765"))


def candidate_paths(path):
    """上游路径兼容：DeepSeek 文档里 base_url 是 https://api.deepseek.com（无 /v1），
    但很多客户端习惯带 /v1。这里两种都试，404 时自动退到不带 /v1 的那种。"""
    cands = [path]
    if path.startswith("/v1/"):
        cands.append(path[3:])
    return cands


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")

    def do_OPTIONS(self):                     # 浏览器预检
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):                         # 方便用浏览器确认代理活着
        body = json.dumps({"ok": True, "upstream": UPSTREAM, "has_key": bool(KEY)},
                          ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        if not self.path.startswith("/"):
            self.send_response(404)
            self._cors()
            self.end_headers()
            return
        auth = "Bearer " + KEY if KEY else (self.headers.get("Authorization") or "")

        code, data = 502, json.dumps({"error": {"message": "上游没有可用路径"}}).encode("utf-8")
        for path in candidate_paths(self.path):
            req = urllib.request.Request(UPSTREAM + path, data=body, method="POST")
            req.add_header("Content-Type", "application/json")
            if auth:
                req.add_header("Authorization", auth)
            try:
                with urllib.request.urlopen(req, timeout=180) as resp:
                    code, data = resp.status, resp.read()
            except urllib.error.HTTPError as exc:        # 上游报错原样透传，方便前端看到原因
                code, data = exc.code, exc.read()
            except Exception as exc:                      # 网络/超时：把原因和排查方向一起说清
                reason = getattr(exc, "reason", None)
                msg = "无法连接上游 %s%s（%s%s）：请检查 UPSTREAM_BASE 与网络" % (
                    UPSTREAM, path, type(exc).__name__,
                    "/" + type(reason).__name__ if reason is not None and not isinstance(reason, str) else "")
                extra = (str(exc) or (reason if isinstance(reason, str) else "")).strip()
                if extra:
                    msg += " ｜ " + extra
                code = 502
                data = json.dumps({"error": {"message": msg, "type": type(exc).__name__}},
                                  ensure_ascii=False).encode("utf-8")
            if code != 404:                               # 只有 404 才说明路径猜错了，换下一个
                break

        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        sys.stderr.write("[ai_proxy] " + (fmt % args) + "\n")


if __name__ == "__main__":
    print("AI 代理已启动：http://127.0.0.1:%d/v1  →  上游 %s" % (PORT, UPSTREAM))
    print("浏览器里把「接口」填成 http://127.0.0.1:%d/v1，API Key 留空即可。" % PORT)
    if not KEY:
        print("提示：未设置 UPSTREAM_KEY，将使用前端传来的 Authorization（不推荐，Key 会经过浏览器）。")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
