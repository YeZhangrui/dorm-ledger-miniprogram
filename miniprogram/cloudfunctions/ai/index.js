/**
 * cloudfunctions/ai/index.js
 * 小票识图（DeepSeek 多模态）——Key 只存在云函数环境变量里，不下发到客户端。
 *
 * action：recognize { fileID, mime?, roomId? }
 * 流程：校验成员 → 当日配额（usage 原子自增）→ 下载图片 → base64 → 调模型 →
 *       finance.js 归一化 → 删除刚上传的临时图片 → 返回结构化小票
 *
 * 配额：usage 集合 _id = '<openid>_<yyyyMMdd>'（北京时间），默认 10 次/人/天。
 *      失败不扣次数：出错会回滚计数，避免用户白白损失额度。
 */
var fs = require('fs');
var path = require('path');
var https = require('https');
var urlmod = require('url');

/* 共享模块：仓库里在 ../_shared；上传云函数时若已复制成函数内 shared/，则走 ./shared（见 README「部署步骤」） */
var SHARED = fs.existsSync(path.join(__dirname, '..', '_shared', 'db.js')) ? '../_shared/' : './shared/';
var db = require(SHARED + 'db.js');
var V = require(SHARED + 'validate.js');
var F = require(SHARED + 'finance.js');

var AI_URL = 'https://api.deepseek.com/chat/completions';
var MODEL = String(process.env.DEEPSEEK_MODEL || 'deepseek-flash');
var KEY = String(process.env.DEEPSEEK_KEY || '');
var DAILY_LIMIT = Math.max(1, Number(process.env.AI_DAILY_LIMIT) || 10);
var TIMEOUT_MS = 25000;                 // 单次请求 25 秒（云函数超时请设到 60 秒）
var MAX_IMAGE_BYTES = 6 * 1024 * 1024;  // 6MB，超过先让用户压缩
var TEMP_PREFIX = 'ai-temp/';           // 客户端上传路径必须落在这里，函数只删这个目录下的文件

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/* ---------------- 配额 ---------------- */
/**
 * 原子占一次配额：先按「未达上限」条件自增；文档不存在则新建。
 * 两条路径都失败（冲突/已达上限）才返回 QUOTA。
 */
async function takeQuota(openid, dayKey) {
  var usageId = openid + '_' + dayKey;
  var now = Date.now();

  var upd = await db.db.collection(db.COLL.USAGE)
    .where({ _id: usageId, aiCalls: db._.lt(DAILY_LIMIT) })
    .update({ data: { aiCalls: db._.inc(1), updatedAt: now } });
  var updated = (upd && upd.stats && upd.stats.updated) || 0;

  if (updated) {
    var doc = await db.getDocOrNull(db.COLL.USAGE, usageId);
    return { usageId: usageId, used: Number(doc && doc.aiCalls) || 1, limit: DAILY_LIMIT };
  }

  /* 文档还不存在：本次就是今天第一次 */
  try {
    await db.db.collection(db.COLL.USAGE).add({
      data: { _id: usageId, aiCalls: 1, bytes: 0, updatedAt: now }
    });
    return { usageId: usageId, used: 1, limit: DAILY_LIMIT };
  } catch (e) {
    if (db.isDuplicateKey(e)) {
      throw new db.AppError(db.ERR.QUOTA, '今天的 AI 识图次数用完了（每天 ' + DAILY_LIMIT + ' 次），明天再来或手动记账');
    }
    throw e;
  }
}

/** 记一下当天识别了多少字节（只是用量统计，失败不影响主流程） */
function addBytes(usageId, bytes) {
  if (!usageId || !bytes) return Promise.resolve();
  return db.db.collection(db.COLL.USAGE).doc(usageId)
    .update({ data: { bytes: db._.inc(bytes) } })
    .catch(function (e) {
      console.warn('[ai] 用量统计失败：' + db.errString(e).slice(0, 160));
    });
}

/** 调用失败时把刚占的次数还回去（不扣费原则） */
function refundQuota(usageId) {
  if (!usageId) return Promise.resolve();
  return db.db.collection(db.COLL.USAGE).doc(usageId)
    .update({ data: { aiCalls: db._.inc(-1) } })
    .catch(function (e) {
      console.warn('[ai] 配额回滚失败：' + db.errString(e).slice(0, 160));
    });
}

/* ---------------- 图片 ---------------- */
function fileIDPath(fileID) {
  var s = String(fileID || '');
  var idx = s.indexOf('/', 'cloud://'.length);
  if (idx < 0) return '';
  return s.slice(idx + 1);
}

/** 从文件头判断真实类型，客户端传的 mime 只当兜底 */
function sniffMime(buf, hint) {
  if (!buf || buf.length < 4) return hint || 'image/jpeg';
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.length > 12 && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  var h = String(hint || '').toLowerCase();
  if (/^image\/(jpeg|jpg|png|webp|gif)$/.test(h)) return h === 'image/jpg' ? 'image/jpeg' : h;
  return 'image/jpeg';
}

/* ---------------- HTTP ---------------- */
function postWithFetch(urlStr, bodyObj, timeoutMs) {
  var ctl = new AbortController();
  var timer = setTimeout(function () { ctl.abort(); }, timeoutMs);
  return fetch(urlStr, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify(bodyObj),
    signal: ctl.signal
  }).then(function (res) {
    return res.text().then(function (text) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + String(text).slice(0, 180));
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error('AI 返回的不是 JSON');
      }
    });
  }).catch(function (e) {
    if (e && (e.name === 'AbortError' || /aborted/i.test(String(e.message)))) {
      throw new Error('请求超时（' + Math.round(timeoutMs / 1000) + ' 秒）');
    }
    throw e;
  }).then(function (v) {
    clearTimeout(timer);
    return v;
  }, function (e) {
    clearTimeout(timer);
    throw e;
  });
}

function postWithHttps(urlStr, bodyObj, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var payload = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    var u = new urlmod.URL(urlStr);
    var finished = false;

    var req = https.request({
      method: 'POST',
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        Authorization: 'Bearer ' + KEY
      },
      timeout: timeoutMs
    }, function (res) {
      var chunks = [];
      var size = 0;
      res.on('data', function (c) {
        size += c.length;
        if (size > 2 * 1024 * 1024) {
          if (!finished) { finished = true; req.destroy(); reject(new Error('AI 返回内容过大')); }
          return;
        }
        chunks.push(c);
      });
      res.on('end', function () {
        if (finished) return;
        finished = true;
        var text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('HTTP ' + res.statusCode + ' ' + text.slice(0, 180)));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (e) {
          reject(new Error('AI 返回的不是 JSON'));
        }
      });
    });

    req.on('timeout', function () {
      if (!finished) { finished = true; req.destroy(); reject(new Error('请求超时（' + Math.round(timeoutMs / 1000) + ' 秒）')); }
    });
    req.on('error', function (e) {
      if (!finished) { finished = true; reject(e); }
    });

    req.write(payload);
    req.end();
  });
}

/** Node 18+ 有全局 fetch 就用 fetch，Node 16 退回 https */
function postJson(urlStr, bodyObj, timeoutMs) {
  if (typeof fetch === 'function' && typeof AbortController === 'function') {
    return postWithFetch(urlStr, bodyObj, timeoutMs);
  }
  return postWithHttps(urlStr, bodyObj, timeoutMs);
}

function pickContent(data) {
  var choice = (data && data.choices && data.choices[0]) || {};
  var content = choice.message && choice.message.content;
  if (Array.isArray(content)) {
    content = content.map(function (x) { return (x && x.text) || ''; }).join('');
  }
  if (typeof content !== 'string' || !content.trim()) {
    var reason = choice.finish_reason ? '（' + choice.finish_reason + '）' : '';
    throw new db.AppError(db.ERR.INVALID, 'AI 没返回内容' + reason + '，请重试或改用粘贴票面文字');
  }
  return content;
}

/** 调模型，失败重试 1 次；错误信息只回中文提示，不把上游原文抛给客户端 */
async function callModel(dataUri) {
  var body = {
    model: MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: F.AI_PROMPT },
        { type: 'image_url', image_url: { url: dataUri } }
      ]
    }]
  };

  var lastErr = null;
  for (var attempt = 0; attempt < 2; attempt++) {
    try {
      return await postJson(AI_URL, body, TIMEOUT_MS);
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await sleep(600);
    }
  }

  var msg = String((lastErr && lastErr.message) || '');
  console.error('[ai][recognize] 模型调用失败：' + msg.slice(0, 200)); // 不含 Key、不含票面文字
  if (/HTTP 401|HTTP 403/.test(msg)) {
    throw new db.AppError(db.ERR.INVALID, 'AI 服务鉴权失败，请联系管理员检查 Key');
  }
  if (/HTTP 429/.test(msg)) {
    throw new db.AppError(db.ERR.QUOTA, 'AI 服务太忙了，请过一会儿再试');
  }
  throw new db.AppError(db.ERR.INTERNAL, 'AI 识图失败了，请重试，或改用粘贴票面文字');
}

/* ---------------- recognize ---------------- */
async function recognize(ctx) {
  var p = ctx.payload || {};

  /* 1) 成员校验：只有房间成员才能用，防止陌生人刷额度 */
  await db.resolveRoom(ctx.openid, p.roomId);

  var fid = V.fileID(p.fileID);
  var pathInBucket = fileIDPath(fid);

  /* 2) 没配 Key 直接说清楚，不占配额 */
  if (!KEY) {
    throw new db.AppError(db.ERR.INVALID, 'AI 未配置');
  }

  /* 3) 当日配额 */
  var quota = await takeQuota(ctx.openid, db.bjDayKey());
  var bytes = 0;

  try {
    /* 4) 下载图片 + 类型/体积校验 */
    var dl = await db.cloud.downloadFile({ fileID: fid });
    var buf = dl && dl.fileContent;
    if (!buf || !buf.length) throw new db.AppError(db.ERR.INVALID, '图片读取失败，请重新拍一张');
    bytes = buf.length;
    if (bytes > MAX_IMAGE_BYTES) {
      throw new db.AppError(db.ERR.INVALID, '图片太大了（超过 6MB），请压缩后再试');
    }

    var mime = sniffMime(buf, p.mime);
    var dataUri = 'data:' + mime + ';base64,' + buf.toString('base64');
    buf = null; // 尽早释放

    /* 5) 调模型 → 抽 JSON → 归一化（与客户端共用同一份 finance.js） */
    var answer = await callModel(dataUri);
    var content = pickContent(answer);
    var parsed = F.extractJsonFromText(content);
    var rec = F.normalizeAiReceipt(parsed, 'AI 识图 · ' + MODEL, content);

    addBytes(quota.usageId, bytes);

    return {
      merchant: rec.merchant,
      date: rec.date,
      total: rec.total,
      sum: rec.sum,
      lines: rec.lines,
      warnings: rec.warnings,
      raw: String(content || '').slice(0, 4000),
      quota: { used: quota.used, limit: quota.limit }
    };
  } catch (e) {
    /* 失败不扣次数 */
    await refundQuota(quota.usageId);
    throw e;
  } finally {
    /* 6) 不留存用户图片：只删 ai-temp/ 下我们自己上传的临时文件 */
    if (pathInBucket && pathInBucket.indexOf(TEMP_PREFIX) === 0) {
      try {
        await db.cloud.deleteFile({ fileIDList: [fid] });
      } catch (e2) {
        console.warn('[ai] 临时图片删除失败：' + db.errString(e2).slice(0, 160));
      }
    } else if (pathInBucket) {
      console.warn('[ai] fileID 不在 ' + TEMP_PREFIX + ' 下，跳过删除：' + pathInBucket.slice(0, 80));
    }
  }
}

exports.main = db.createHandler('ai', {
  recognize: recognize
});
