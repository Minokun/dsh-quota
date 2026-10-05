/**
 * 趋势 sparkline 的纯几何计算：把一组采样值（如某额度条目最近的已用
 * 百分比序列）归一化到给定的 SVG 视口内，输出 `<polyline points>` 字符串。
 * 无 React / DOM 依赖，可单测。
 * @module dsh-quota/client/sparkline
 */

/**
 * 计算归一化后的 polyline points。
 * 序列映射到 [0,width]×[0,height]，Y 按 min/max 缩放（max===min 的平坦序列
 * 居中画在中线，避免除零）；首尾点贴合视口两端。
 * @param values - 采样值序列（时间升序）。
 * @param width - 视口宽（SVG 用户单位）。
 * @param height - 视口高（SVG 用户单位）。
 * @returns points 属性字符串；少于 2 个点返回空串（画不出线）。
 */
export function sparklinePoints(values: readonly number[], width: number, height: number): string {
  if (values.length < 2 || width <= 0 || height <= 0) return ''
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min
  const pad = height * 0.1 // 上下各留 10%，避免贴边被裁
  const usable = height - pad * 2
  return values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width
      const y = span === 0
        ? height / 2 // 平坦序列居中
        : pad + usable * (1 - (value - min) / span) // 值越大越靠上
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

/**
 * 从 /status 的 history 行裁出某条目的趋势序列。
 * @param row - history 条目：`[epochMs, value][]`（原始 JSON 形状，宽容非数字）。
 * @param limit - 最多保留的采样点数（默认 30，约覆盖面板的常规历史长度）。
 * @returns 数值序列（时间升序）；没有有效采样返回空数组。
 */
export function trendValues(row: unknown, limit = 30): number[] {
  if (!Array.isArray(row)) return []
  const values: number[] = []
  for (const sample of row) {
    if (Array.isArray(sample) && sample.length >= 2 && typeof sample[1] === 'number' && Number.isFinite(sample[1])) {
      values.push(sample[1])
    }
  }
  return values.slice(-limit)
}
