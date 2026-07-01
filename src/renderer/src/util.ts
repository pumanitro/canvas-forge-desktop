export const uid = () =>
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

export const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v))
