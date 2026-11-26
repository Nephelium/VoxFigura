const samples: Record<string, { a: string; b: string }> = {
  swan: { a: 'suan_mandarin', b: 'swan_english' },
  khoomei: { a: 'overtone_khoomei', b: 'overtone_khoomei' },
  creaky: { a: 'phonation_a', b: 'phonation_a' },
  cantonese: { a: 'cantonese_checked', b: 'cantonese_checked' },
  voqs: { a: 'voqs_quality', b: 'voqs_quality' },
};

export function samplePair(caseId: string) {
  return samples[caseId] ?? samples.swan;
}
