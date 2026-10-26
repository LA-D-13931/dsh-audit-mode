/**
 * 会话日志解码（共享模块）—— README 里叫“会话日志”。
 *
 * 文件：~/.dsh/sessions/<编码工作目录>/<session-id>/session.v4.jsonl.zstd
 * 格式：zstd 多帧拼接的 JSONL（每帧一批事件；首帧含 session header，version 4）。
 *
 * 为什么单独成模块：会话审计 / 巡检 / --dump-events 都要解它；不要再在 bash 里
 * 复制粘贴魔数扫描（本次会话内联了 15 次）。
 *
 * 边界：只读；不做任何写入。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export const MAGIC = 0x28b52ffd;
export const SUPPORTED_VERSION = 4;

export function findMagic(buf, from) {
  for (let i = from; i <= buf.length - 4; i++) if (buf.readUInt32BE(i) === MAGIC) return i;
  return -1;
}

/** 解 zstd 多帧；若不是 zstd（演练用明文 .jsonl），原样返回。 */
export function decodeZstd(buf) {
  if (buf.length < 4 || buf.readUInt32BE(0) !== MAGIC) return buf.toString("utf8");
  const starts = [];
  for (let i = 0; i <= buf.length - 4; i++) if (buf.readUInt32BE(i) === MAGIC) starts.push(i);
  const parts = [];
  let i = 0;
  while (i < starts.length) {
    let ok = false;
    for (let j = i; j < starts.length; j++) {
      const end = j + 1 < starts.length ? starts[j + 1] : buf.length;
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(starts[i], end)));
        i = j + 1;
        ok = true;
        break;
      } catch {
        /* 可能是帧内伪魔数：延长到下一帧再试 */
      }
    }
    if (!ok) throw new Error("zstd 帧解不开（日志损坏或版本变化）");
  }
  return Buffer.concat(parts).toString("utf8");
}

export function decodeFirstFrame(buf) {
  if (buf.length < 4 || buf.readUInt32BE(0) !== MAGIC) return buf.toString("utf8");
  const second = findMagic(buf, 4);
  const end = second >= 0 ? second : buf.length;
  try {
    return zlib.zstdDecompressSync(buf.subarray(0, end)).toString("utf8");
  } catch {
    return "";
  }
}

export function parseJsonl(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}

export function collectSessionFiles(root, depth = 0, acc = []) {
  let st;
  try {
    st = fs.statSync(root);
  } catch {
    return acc;
  }
  if (st.isFile()) {
    if (/\.jsonl(\.zstd)?$/.test(root)) acc.push(root);
    return acc;
  }
  if (!st.isDirectory() || depth > 4) return acc;
  for (const name of fs.readdirSync(root)) collectSessionFiles(path.join(root, name), depth + 1, acc);
  return acc;
}

/** 只读文件头（最多 1MB）——不能为了看 header 把几百 MB 日志全读进来。 */
export function readHeader(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return null;
    const cap = Math.min(size, 1024 * 1024);
    const buf = Buffer.alloc(cap);
    fs.readSync(fd, buf, 0, cap, 0);
    let end = cap;
    if (cap >= 4 && buf.readUInt32BE(0) === MAGIC) {
      const second = findMagic(buf, 4);
      if (second >= 0) end = second;
    }
    const first = decodeZstd(buf.subarray(0, end)).split("\n").find((l) => l.trim());
    if (!first) return null;
    try {
      return JSON.parse(first);
    } catch {
      return null;
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

/** 读整个会话 → 事件数组；版本不符时抛错（调用方按“没验成”处理）。 */
export function readSessionEvents(file) {
  const buf = fs.readFileSync(file);
  const events = parseJsonl(decodeZstd(buf));
  const header = events.find((e) => e.type === "session");
  if (!header || header.type !== "session") throw new Error("日志缺 session header");
  if (header.version !== SUPPORTED_VERSION) {
    throw new Error(`日志版本 ${header.version} 未支持（本工具只认 v${SUPPORTED_VERSION}）`);
  }
  return { header, events };
}
