/**
 * make-icon.mjs
 * 生成 multi-size 的 Windows .ico（32bpp BMP-in-ICO，兼容性最好）
 * 纯 Node 实现，不依赖 sharp / png-to-ico 等第三方库。
 *
 * 图形：蓝紫渐变圆角方块 + 白色终端提示符  >_
 *
 * 用法：node scripts/make-icon.mjs
 * 产物：build/icon.ico
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(__dirname, '../build/icon.ico')

const SIZES = [16, 24, 32, 48, 64, 128, 256]

/* ---------------------------------------------------------------- 几何工具 */

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** 到线段的最短距离 */
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const len2 = vx * vx + vy * vy
  let t = len2 === 0 ? 0 : (wx * vx + wy * vy) / len2
  t = clamp01(t)
  const cx = ax + t * vx
  const cy = ay + t * vy
  return Math.hypot(px - cx, py - cy)
}

/** 圆角矩形有符号距离（<0 在内部） */
function roundRectSDF(px, py, w, h, r) {
  const dx = Math.abs(px - w / 2) - (w / 2 - r)
  const dy = Math.abs(py - h / 2) - (h / 2 - r)
  const ox = Math.max(dx, 0)
  const oy = Math.max(dy, 0)
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(ox, oy) - r
}

/** 覆盖率（1px 抗锯齿带） */
function coverage(d) {
  return clamp01(0.5 - d)
}

/* ---------------------------------------------------------------- 像素绘制 */

function renderRGBA(size) {
  const w = size
  const h = size
  const buf = Buffer.alloc(w * h * 4) // RGBA
  const radius = w * 0.22

  // 渐变端点色：靛蓝 -> 紫
  const c1 = [79, 70, 229]
  const c2 = [147, 51, 234]

  const stroke = w * 0.085
  // 提示符 ">"
  const p1 = [0.28, 0.28]
  const p2 = [0.47, 0.50]
  const p3 = [0.28, 0.72]
  // 下划线 "_"
  const u1 = [0.56, 0.72]
  const u2 = [0.79, 0.72]

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cxp = x + 0.5
      const cyp = y + 0.5

      // 1) 圆角方块遮罩
      const bgD = roundRectSDF(cxp, cyp, w, h, radius)
      if (bgD > 1) continue
      const bgA = coverage(bgD)

      // 2) 对角渐变
      const t = clamp01((cxp / w) * 0.5 + (cyp / h) * 0.5)
      let r = c1[0] + (c2[0] - c1[0]) * t
      let g = c1[1] + (c2[1] - c1[1]) * t
      let b = c1[2] + (c2[2] - c1[2]) * t

      // 3) 白色前景（chevron + underscore）
      const dChev = Math.min(
        segDist(cxp, cyp, p1[0] * w, p1[1] * h, p2[0] * w, p2[1] * h),
        segDist(cxp, cyp, p2[0] * w, p2[1] * h, p3[0] * w, p3[1] * h)
      )
      const dUnder = segDist(cxp, cyp, u1[0] * w, u1[1] * h, u2[0] * w, u2[1] * h)

      // 圆头线段
      const half = stroke / 2
      const fg =
        coverage(dChev - half) + coverage(dUnder - half) > 0
          ? Math.max(coverage(dChev - half), coverage(dUnder - half))
          : 0

      if (fg > 0) {
        r = r * (1 - fg) + 255 * fg
        g = g * (1 - fg) + 255 * fg
        b = b * (1 - fg) + 255 * fg
      }

      const i = (y * w + x) * 4
      buf[i] = Math.round(r)
      buf[i + 1] = Math.round(g)
      buf[i + 2] = Math.round(b)
      buf[i + 3] = Math.round(bgA * 255)
    }
  }
  return buf
}

/* ---------------------------------------------------------------- ICO 编码 */

function encodeBmpImage(rgba, w, h) {
  const xorSize = w * h * 4
  const andRow = Math.ceil(w / 8)
  const andPadded = Math.ceil(andRow / 4) * 4
  const andSize = andPadded * h
  const header = Buffer.alloc(40)

  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(w, 4) // biWidth
  header.writeInt32LE(h * 2, 8) // biHeight = XOR + AND
  header.writeUInt16LE(1, 12) // biPlanes
  header.writeUInt16LE(32, 14) // biBitCount
  header.writeUInt32LE(0, 16) // biCompression = BI_RGB
  header.writeUInt32LE(xorSize + andSize, 20)
  header.writeInt32LE(0, 24)
  header.writeInt32LE(0, 28)
  header.writeUInt32LE(0, 32)
  header.writeUInt32LE(0, 36)

  // XOR：BGRA，自下而上
  const xor = Buffer.alloc(xorSize)
  for (let y = 0; y < h; y++) {
    const srcRow = (h - 1 - y) * w * 4
    const dstRow = y * w * 4
    for (let x = 0; x < w; x++) {
      const s = srcRow + x * 4
      const d = dstRow + x * 4
      xor[d] = rgba[s + 2] // B
      xor[d + 1] = rgba[s + 1] // G
      xor[d + 2] = rgba[s] // R
      // rgba[s+3] 已按直通 alpha 处理：这里把 A 置 0（全不透明由 AND 掩码表达）
      xor[d + 3] = 0
    }
  }

  // AND mask：全部 0 = 不透明
  const and = Buffer.alloc(andSize, 0)

  return Buffer.concat([header, xor, and])
}

function buildIco(images) {
  const count = images.length
  const dir = Buffer.alloc(6)
  dir.writeUInt16LE(0, 0)
  dir.writeUInt16LE(1, 2) // 1 = ICO
  dir.writeUInt16LE(count, 4)

  const entries = Buffer.alloc(16 * count)
  let offset = 6 + 16 * count
  const blobs = []

  images.forEach((img, idx) => {
    const e = idx * 16
    entries.writeUInt8(img.size >= 256 ? 0 : img.size, e + 0)
    entries.writeUInt8(img.size >= 256 ? 0 : img.size, e + 1)
    entries.writeUInt8(0, e + 2)
    entries.writeUInt8(0, e + 3)
    entries.writeUInt16LE(1, e + 4)
    entries.writeUInt16LE(32, e + 6)
    entries.writeUInt32LE(img.data.length, e + 8)
    entries.writeUInt32LE(offset, e + 12)
    offset += img.data.length
    blobs.push(img.data)
  })

  return Buffer.concat([dir, entries, ...blobs])
}

/* ---------------------------------------------------------------- main */

const images = SIZES.map((size) => ({
  size,
  data: encodeBmpImage(renderRGBA(size), size, size)
}))

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, buildIco(images))
console.log(`[icon] 已生成 ${OUT}  （尺寸: ${SIZES.join(', ')}）`)
