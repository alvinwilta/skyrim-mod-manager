/** Golden-angle hue spread — visually distinct, stable per group id. */
export const groupHue = (bucket: number) => Math.round((bucket * 137.508) % 360)
