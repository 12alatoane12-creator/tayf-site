export interface StrongAcidBaseInput { acidMoles: number; baseMoles: number; totalVolumeL: number; pKw?: number }
export interface StrongAcidBaseResult {
  pH: number; pOH: number; excessMoles: number; excessSpecies: 'H+' | 'OH-' | 'none';
  excessConcentration: number; reactedMoles: number; pKw: number; assumptions: string[];
}

/** Ideal strong acid/strong base stoichiometry. pKw defaults to 14 only as a declared 25 °C assumption. */
export function solveStrongAcidBase(input: StrongAcidBaseInput): StrongAcidBaseResult {
  const { acidMoles, baseMoles, totalVolumeL } = input;
  const pKw = input.pKw ?? 14;
  if (![acidMoles, baseMoles, totalVolumeL, pKw].every(Number.isFinite) || acidMoles < 0 || baseMoles < 0 || totalVolumeL <= 0 || pKw <= 0) {
    throw new Error('تحتاج موازنة الحمض والقاعدة إلى مولات غير سالبة وحجم كلي موجب وقيم محدودة.');
  }
  const difference = acidMoles - baseMoles;
  const excessMoles = Math.abs(difference);
  const excessConcentration = excessMoles / totalVolumeL;
  const excessSpecies = difference > 0 ? 'H+' : difference < 0 ? 'OH-' : 'none';
  const pH = difference === 0 ? pKw / 2 : difference > 0 ? -Math.log10(excessConcentration) : pKw + Math.log10(excessConcentration);
  const pOH = pKw - pH;
  return {
    pH, pOH, excessMoles, excessSpecies, excessConcentration,
    reactedMoles: Math.min(acidMoles, baseMoles), pKw,
    assumptions: ['حمض قوي وقاعدة قوية بنسبة مولية 1:1.', 'حجوم قابلة للجمع ومحلول مثالي؛ أُهمل النشاط الكيميائي.', 'استُخدم pKw = 14 كافتراض عند 25 °C.'],
  };
}

export interface DilutionResult { concentration: number; initialMoles: number; initialVolumeL: number; finalVolumeL: number }
export function solveDilution(concentration: number, initialVolumeMl: number, finalVolumeMl: number): DilutionResult {
  if (![concentration, initialVolumeMl, finalVolumeMl].every(Number.isFinite) || concentration < 0 || initialVolumeMl <= 0 || finalVolumeMl < initialVolumeMl) {
    throw new Error('يلزم تركيز غير سالب، وحجم عينة موجب، وحجم نهائي لا يقل عن حجم العينة.');
  }
  const initialVolumeL = initialVolumeMl / 1000;
  const finalVolumeL = finalVolumeMl / 1000;
  const initialMoles = concentration * initialVolumeL;
  return { concentration: initialMoles / finalVolumeL, initialMoles, initialVolumeL, finalVolumeL };
}

export interface AgClResult { moles: number; massGrams: number; limitingReactant: 'AgNO3' | 'NaCl' | 'equal' }
export function solveAgClStoichiometry(agno3Moles: number, naclMoles: number, molarMass = 143.32): AgClResult {
  if (![agno3Moles, naclMoles, molarMass].every(Number.isFinite) || agno3Moles < 0 || naclMoles < 0 || molarMass <= 0) {
    throw new Error('المولات والكتلة المولية يجب أن تكون قيماً صالحة وغير سالبة.');
  }
  const moles = Math.min(agno3Moles, naclMoles);
  return { moles, massGrams: moles * molarMass, limitingReactant: agno3Moles < naclMoles ? 'AgNO3' : naclMoles < agno3Moles ? 'NaCl' : 'equal' };
}


export interface SolutionQuantity { concentration: number; moles: number; volumeMl: number }
export function solutionQuantityFromConcentration(concentration: number, volumeMl: number): SolutionQuantity {
  if (![concentration, volumeMl].every(Number.isFinite) || concentration < 0 || volumeMl < 0) throw new Error('التركيز والحجم يجب أن يكونا قيمتين غير سالبتين ومحدودتين.');
  return { concentration, volumeMl, moles: concentration * volumeMl / 1000 };
}
export function combineStockAddition(existing: SolutionQuantity, stockConcentration: number, addedVolumeMl: number): SolutionQuantity {
  if (![existing.concentration, existing.moles, existing.volumeMl, stockConcentration, addedVolumeMl].every(Number.isFinite)
    || existing.concentration < 0 || existing.moles < 0 || existing.volumeMl < 0 || stockConcentration < 0 || addedVolumeMl <= 0) {
    throw new Error('تعذر دمج الإضافة بسبب تركيز أو حجم غير صالح.');
  }
  const volumeMl = existing.volumeMl + addedVolumeMl;
  const moles = existing.moles + stockConcentration * addedVolumeMl / 1000;
  return { volumeMl, moles, concentration: volumeMl > 0 ? moles / (volumeMl / 1000) : 0 };
}


export function solveConcentration(moles: number, volumeL: number): number {
  if (![moles, volumeL].every(Number.isFinite) || moles < 0 || volumeL <= 0) throw new Error('يلزم عدد مولات غير سالب وحجم موجب.');
  return moles / volumeL;
}
export function solveMoles(concentration: number, volumeL: number): number {
  if (![concentration, volumeL].every(Number.isFinite) || concentration < 0 || volumeL <= 0) throw new Error('يلزم تركيز غير سالب وحجم موجب.');
  return concentration * volumeL;
}
export function solveSolutionVolume(moles: number, concentration: number): number {
  if (![moles, concentration].every(Number.isFinite) || moles <= 0 || concentration <= 0) throw new Error('يلزم عدد مولات وتركيز موجبان لاستنتاج حجم موجب محدد.');
  return moles / concentration;
}
export function sumSolutionVolumesMl(volumesMl: number[]): number {
  if (!Array.isArray(volumesMl) || !volumesMl.every((volume) => Number.isFinite(volume) && volume >= 0)) throw new Error('أحجام المحاليل يجب أن تكون أرقامًا غير سالبة ومحدودة.');
  return volumesMl.reduce((sum, volume) => sum + volume, 0);
}
export type ChemicalQuantityKind = 'volume' | 'moles' | 'mass';
export function quantityToSolution(kind: ChemicalQuantityKind, quantity: number, concentration: number, molarMass: number, molarMassVerified = false): SolutionQuantity {
  if (!['volume', 'moles', 'mass'].includes(kind)) throw new Error('طريقة تحديد الكمية غير مدعومة.');
  if (![quantity, concentration].every(Number.isFinite) || quantity <= 0 || concentration < 0) throw new Error('أدخل كمية موجبة وتركيزًا غير سالب.');
  if (kind === 'volume') return solutionQuantityFromConcentration(concentration, quantity);
  if (concentration <= 0) throw new Error('يلزم تركيز موجب لتحويل المولات أو الكتلة إلى حجم محلول.');
  let moles: number;
  if (kind === 'moles') moles = quantity;
  else {
    if (!molarMassVerified || !Number.isFinite(molarMass) || molarMass <= 0) throw new Error('تحويل الكتلة إلى مولات غير متاح حتى توثيق الكتلة المولية بمصدر علمي.');
    moles = quantity / molarMass;
  }
  const volumeMl = moles / concentration * 1000;
  if (!Number.isFinite(volumeMl) || volumeMl <= 0 || !Number.isFinite(moles)) throw new Error('الكمية والتركيز ينتجان حجمًا خارج النطاق العددي.');
  return { concentration, moles, volumeMl };
}

export interface VisualEffectInput {
  gasModelSupported: boolean; gasMoles?: number; ionicProductQ?: number; solubilityProductKsp?: number; solutionColor?: string | null;
}
export interface VisualEffects { showBubbles: boolean; showPrecipitate: boolean; solutionColor: string | null }
/** Visuals are emitted only when the corresponding numerical model and required data are present. */
export function deriveVisualEffects(input: VisualEffectInput): VisualEffects {
  const showBubbles = input.gasModelSupported && Number.isFinite(input.gasMoles) && (input.gasMoles ?? 0) > 0;
  const showPrecipitate = Number.isFinite(input.ionicProductQ) && (input.ionicProductQ as number) >= 0
    && Number.isFinite(input.solubilityProductKsp) && (input.solubilityProductKsp as number) > 0
    && (input.ionicProductQ as number) > (input.solubilityProductKsp as number);
  return { showBubbles, showPrecipitate, solutionColor: typeof input.solutionColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.solutionColor) ? input.solutionColor : null };
}

export type ChemistryResultState = 'محسوب ضمن النموذج' | 'لا تحول مدعوم قابل للرصد' | 'خارج نطاق المحاكاة';
