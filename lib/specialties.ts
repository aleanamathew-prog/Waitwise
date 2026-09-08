/**
 * Plain-English hints for the specialty picker.
 *
 * A patient knows the body part, not the treatment function code. NHS England's
 * own names ("Trauma and Orthopaedic Service") are the terms a referral letter
 * uses, so they stay as the label, with the hint alongside.
 *
 * Codes absent from this map show their published name with no hint, rather
 * than a guess: a future release may add a code we have no wording for.
 */
export const SPECIALTY_HINTS: Record<string, string> = {
  C_100: 'hernias, gallbladder, appendix, bowel',
  C_101: 'bladder, kidneys, prostate, urinary problems',
  C_110: 'bones, joints, fractures, hips and knees',
  C_120: 'hearing, sinuses, tonsils, throat',
  C_130: 'eyes, cataracts, vision',
  C_140: 'jaw, mouth, wisdom teeth',
  C_150: 'surgery on the brain and spine',
  C_160: 'skin, burns, hand surgery, reconstruction',
  C_170: 'surgery on the heart, lungs and chest',
  C_300: 'general medical problems, often more than one',
  C_301: 'stomach, bowel, liver, digestion',
  C_320: 'heart, chest pain, palpitations',
  C_330: 'skin, moles, rashes',
  C_340: 'lungs, breathing, asthma',
  C_400: 'brain and nerves, headaches, epilepsy — not surgery',
  C_410: 'arthritis, joint and muscle pain',
  C_430: 'care for older people, frailty, falls',
  C_502: 'periods, menopause, pelvic and reproductive health',
  X02: 'medical specialties without a category of their own',
  X03: 'mental health services',
  X04: "children's services",
  X05: 'surgery without a category of its own',
  X06: 'services not covered by any other category',
};

/**
 * NHS England's residual buckets. A referral letter never says "Other - Other",
 * so these are grouped apart from the specialties a patient might be looking
 * for. They are not hidden: they hold 22% of everyone waiting, and X02 alone is
 * larger than most named specialties, so dropping them would quietly remove
 * those services from the comparison.
 */
export function isResidualCategory(code: string): boolean {
  return code.startsWith('X');
}
