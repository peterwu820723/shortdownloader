export function parseEpisodeRange(value: string, allowed: number[]): number[] {
  const result = new Set<number>()
  if (!value.trim()) return []
  for (const part of value.replace(/，/g, ',').split(',')) {
    const match = part.trim().match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/)
    if (!match) throw new Error('集数格式示例：1-5, 8, 12-15')
    const start = Number(match[1]), end = Number(match[2] || match[1])
    if (start > end || end - start > 500) throw new Error('集数范围无效。')
    for (let n = start; n <= end; n++) {
      if (!allowed.includes(n)) throw new Error(`目录中没有第 ${n} 集。`)
      result.add(n)
    }
  }
  return [...result].sort((a, b) => a - b)
}
