export interface LibraryItem { type: string; name: string; desc: string; symbol: string; unit: string; value: number }
export interface ChemicalDefinition {
  id: string; name: string; formula: string; cat: 'acid' | 'base' | 'salt' | 'indicator';
  color: string; conc: number; molar: number; phase: string; kind: string; safety: string;
  source: string; version: string; molarMassVerified: boolean;
}
export interface ElementDefinition { symbol: string; name: string; atomicNumber: number }

export const library: LibraryItem[] = [
  { type: 'source', name: 'بطارية / مصدر جهد', desc: 'مصدر جهد مثالي', symbol: '＋ −', unit: 'V', value: 12 },
  { type: 'resistor', name: 'مقاومة', desc: 'عنصر مقاومي', symbol: '▱', unit: 'Ω', value: 100 },
  { type: 'resistor', name: 'مقاومة', desc: 'عنصر مقاومي', symbol: '▱', unit: 'Ω', value: 200 },
  { type: 'switch', name: 'مفتاح', desc: 'غير مدعوم حسابيًا في هذه المرحلة', symbol: '／', unit: '', value: 1 },
  { type: 'capacitor', name: 'متسعة', desc: 'غير مدعومة في حل DC الحالي', symbol: 'Ⅱ', unit: 'µF', value: 100 },
  { type: 'inductor', name: 'ملف', desc: 'غير مدعوم في حل DC الحالي', symbol: '∿', unit: 'mH', value: 10 },
  { type: 'ammeter', name: 'أميتر', desc: 'غير مدعوم حسابيًا في هذه المرحلة', symbol: 'Ⓐ', unit: 'A', value: 0 },
  { type: 'voltmeter', name: 'فولتميتر', desc: 'غير مدعوم حسابيًا في هذه المرحلة', symbol: 'Ⓥ', unit: 'V', value: 0 },
  { type: 'diode', name: 'دايود', desc: 'غير مدعوم في حل DC الحالي', symbol: '▷', unit: '', value: 0 },
];

/** Card colors are identifying UI tokens, not computed solution colors. */
import chemicalData from './chemicals.json';
export const chemicals: ChemicalDefinition[] = chemicalData.chemicals as ChemicalDefinition[];

const elementRows: [string, string, number][] = [
  ['H', 'هيدروجين', 1], ['He', 'هيليوم', 2], ['Li', 'ليثيوم', 3], ['Be', 'بيريليوم', 4], ['B', 'بورون', 5], ['C', 'كربون', 6], ['N', 'نيتروجين', 7], ['O', 'أكسجين', 8], ['F', 'فلور', 9], ['Ne', 'نيون', 10], ['Na', 'صوديوم', 11], ['Mg', 'مغنيسيوم', 12], ['Al', 'ألومنيوم', 13], ['Si', 'سيليكون', 14], ['P', 'فوسفور', 15], ['S', 'كبريت', 16], ['Cl', 'كلور', 17], ['Ar', 'أرغون', 18], ['K', 'بوتاسيوم', 19], ['Ca', 'كالسيوم', 20], ['Fe', 'حديد', 26], ['Cu', 'نحاس', 29], ['Zn', 'زنك', 30], ['Ag', 'فضة', 47], ['I', 'يود', 53], ['Au', 'ذهب', 79], ['Hg', 'زئبق', 80], ['Pb', 'رصاص', 82], ['U', 'يورانيوم', 92],
];
export const elements: ElementDefinition[] = elementRows.map(([symbol, name, atomicNumber]) => ({ symbol, name, atomicNumber }));
