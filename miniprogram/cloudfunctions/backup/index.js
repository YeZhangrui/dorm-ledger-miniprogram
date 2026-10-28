/**
 * cloudfunctions/backup/index.js
 * 定时备份：把 5 个集合导出成 JSON 存到云存储 backups/<yyyyMMdd>/<collection>.json
 *
 * 约定：
 *  - 只有定时触发器（或控制台手动测试）能调：从客户端调进来一定能拿到 OPENID，一律拒绝；
 *  - 每批 100 条、单集合最多 5000 条 / 8MB，超出部分标记 truncated（宁可备份不完整，也不能把函数跑超时）；
 *  - 保留 14 天：第 15–60 天的目录按「已知文件名」拼出 fileID 后批量删除（云存储没有列目录 API）。
 *  - 云存储权限请设为「仅管理端可读写」，备份里是全体用户账目。
 */
var fs = require('fs');
var path = require('path');

/* 共享模块：仓库里在 ../_shared；上传云函数时若已复制成函数内 shared/，则走 ./shared（见 README「部署步骤」） */
var SHARED = fs.existsSync(path.join(__dirname, '..', '_shared', 'db.js')) ? '../_shared/' : './shared/';
var db = require(SHARED + 'db.js');

var COLLS = [db.COLL.ROOMS, db.COLL.MEMBERS, db.COLL.EXPENSES, db.COLL.SETTLE_LOGS, db.COLL.USAGE];
var BATCH = 100;                 // 分页大小：100 条/批
var MAX_DOCS = 5000;             // 单集合单次最多导出条数
var MAX_BYTES = 8 * 1024 * 1024; // 单文件最大 8MB
var MAX_BATCHES = 100;           // 兜底：最多翻 100 批（10000 条）
var KEEP_DAYS = 14;              // 保留 14 天
var CLEAN_DAYS = 60;             // 清理窗口：只尝试删第 15–60 天的目录
var DELETE_BATCH = 50;           // deleteFile 单次最多 50 个

/** 北京时间往前推 offsetDays 天，返回 'YYYYMMDD' */
function dayKeyOffset(offsetDays) {
  var shifted = new Date(Date.now() - offsetDays * 86400000 + 8 * 3600 * 1000);
  return db.bjDateStr(shifted).replace(/-/g, '');
}

/** 导出一个集合；返回纯 Buffer，不保留长字符串，控制内存 */
async function dumpCollection(coll) {
  var docs = [];
  var lastId = null;
  var truncated = false;
  var batches = 0;

  while (batches < MAX_BATCHES && docs.length < MAX_DOCS) {
    batches++;
    var query = lastId
      ? db.db.collection(coll).where({ _id: db._.gt(lastId) })
      : db.db.collection(coll);
    var res = await query.orderBy('_id', 'asc').limit(BATCH).get();
    var list = (res && res.data) || [];
    if (!list.length) break;
    for (var i = 0; i < list.length; i++) docs.push(list[i]);
    lastId = list[list.length - 1]._id;
    if (list.length < BATCH) break;
  }

  if (docs.length >= MAX_DOCS) truncated = true;

  var json = JSON.stringify(docs);
  var size = Buffer.byteLength(json, 'utf8');
  while (size > MAX_BYTES && docs.length > 100) {
    docs = docs.slice(0, Math.floor(docs.length * 0.8));
    truncated = true;
    json = JSON.stringify(docs);
    size = Buffer.byteLength(json, 'utf8');
  }

  return {
    count: docs.length,
    bytes: size,
    truncated: truncated,
    buffer: Buffer.from(json, 'utf8')
  };
}

/**
 * 清理过期备份：云存储没有「列目录」接口，所以用固定文件名反推 fileID。
 * bucketPrefix 从本次 uploadFile 返回的 fileID 里学到（形如 cloud://<env>.<bucket>）。
 */
async function cleanupOld(bucketPrefix) {
  var names = COLLS.concat(['_manifest.json']);
  var ids = [];
  for (var i = KEEP_DAYS + 1; i <= CLEAN_DAYS; i++) {
    var day = dayKeyOffset(i);
    for (var j = 0; j < names.length; j++) {
      ids.push(bucketPrefix + '/backups/' + day + '/' + names[j]);
    }
  }

  var deleted = 0;
  for (var s = 0; s < ids.length; s += DELETE_BATCH) {
    var chunk = ids.slice(s, s + DELETE_BATCH);
    try {
      var res = await db.cloud.deleteFile({ fileIDList: chunk });
      var list = (res && res.fileList) || [];
      for (var k = 0; k < list.length; k++) {
        if (list[k] && list[k].status === 0) deleted++;
      }
    } catch (e) {
      /* 目录本来就不存在时会整批报错，忽略即可 */
      console.warn('[backup] 清理失败：' + db.errString(e).slice(0, 160));
    }
  }
  return deleted;
}

exports.main = async function main(event, context) {
  var started = Date.now();
  try {
    /* 安全：客户端调用会带 OPENID，定时触发器没有 */
    var wx = db.getWXContext();
    if (wx.OPENID) {
      return db.fail(db.ERR.NO_AUTH, '这个函数只给定时触发器用');
    }

    var dayText = db.bjDateStr();          // 'YYYY-MM-DD'
    var dayKey = dayKeyOffset(0);          // 'YYYYMMDD'
    var dir = 'backups/' + dayKey + '/';

    var manifest = { date: dayText, createdAt: Date.now(), collections: {} };
    var bucketPrefix = '';
    var uploaded = 0;

    for (var i = 0; i < COLLS.length; i++) {
      var coll = COLLS[i];
      var dump;
      try {
        dump = await dumpCollection(coll);
      } catch (e) {
        if (db.isCollectionMissing(e)) {
          manifest.collections[coll] = { count: 0, bytes: 0, skipped: 'collection not exists' };
          continue;
        }
        throw e;
      }

      var cloudPath = dir + coll + '.json';
      var up = await db.cloud.uploadFile({ cloudPath: cloudPath, fileContent: dump.buffer });
      uploaded++;

      /* 第一次上传后学到 bucket 前缀，后面清理过期备份要用 */
      if (!bucketPrefix && up && up.fileID) {
        var suffix = '/' + cloudPath;
        var fid = String(up.fileID);
        if (fid.slice(-suffix.length) === suffix) {
          bucketPrefix = fid.slice(0, fid.length - suffix.length);
        }
      }

      manifest.collections[coll] = {
        count: dump.count,
        bytes: dump.bytes,
        truncated: dump.truncated,
        fileID: (up && up.fileID) || ''
      };
      if (dump.truncated) {
        console.warn('[backup] ' + coll + ' 超过单次导出上限（' + MAX_DOCS + ' 条 / ' + MAX_BYTES + ' 字节），本次只备份了一部分');
      }
    }

    /* 清单最后写：方便排查「这次备份到几号」 */
    manifest.deletedLater = 0;
    await db.cloud.uploadFile({
      cloudPath: dir + '_manifest.json',
      fileContent: Buffer.from(JSON.stringify(manifest), 'utf8')
    });

    var deleted = 0;
    if (bucketPrefix) {
      deleted = await cleanupOld(bucketPrefix);
      manifest.deletedLater = deleted;
    } else {
      console.warn('[backup] 没拿到 bucket 前缀，跳过过期清理');
    }

    return db.ok({
      date: dayText,
      uploaded: uploaded,
      deleted: deleted,
      ms: Date.now() - started,
      collections: manifest.collections
    });
  } catch (e) {
    console.error('[backup] ' + db.errString(e).slice(0, 300) + '\n' + (e && e.stack ? String(e.stack).slice(0, 800) : ''));
    return db.fail(db.ERR.INTERNAL, '备份失败，请到云函数日志里看原因');
  }
};
