/** Formatea un conteo; únicamente 1 usa el singular. */
export const pluralize = (count: number, singular: string, plural = `${singular}s`) =>
  `${count} ${count === 1 ? singular : plural}`;
