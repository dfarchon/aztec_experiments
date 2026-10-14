export const AI_MODEL = 'Horizon-Labs/content-safety-guard-small';
export const AI_REVISION = '6152f768a82207aab4ae7305b9df235a4a5163d9';
export const AI_MODEL_VERSION = `${AI_MODEL}:${AI_REVISION}:q8:unsafe-0.5:v1`;
export const AI_CACHE_NAME = `df-signal-model-${AI_REVISION}-q8`;
export const AI_CATEGORY_THRESHOLDS = {
  hate: 0.2, harassment: 0.25, violence: 0.3, weapons: 0.2,
  sexual: 0.15, sexual_minors: 0.25, self_harm: 0.2, criminal_planning: 0.2,
  drugs: 0.35, privacy: 0.2, profanity: 0.25, fraud_manipulation: 0.15,
  misinformation: 0.15, unauthorized_advice: 0.2, other: 0.1,
};

export function safetyResult(predictions) {
  if (!Array.isArray(predictions)) throw new Error('模型返回格式不正确');
  const scores = Object.fromEntries(predictions.map(({ label, score }) => [label, score]));
  for (const label of ['unsafe', ...Object.keys(AI_CATEGORY_THRESHOLDS)]) {
    if (!Number.isFinite(scores[label]) || scores[label] < 0 || scores[label] > 1) throw new Error('模型分类分数不完整');
  }
  const flagged = scores.unsafe >= 0.5;
  const labels = flagged ? Object.entries(AI_CATEGORY_THRESHOLDS).filter(([label, threshold]) => scores[label] >= threshold).map(([label]) => label) : [];
  return { scores, labels: flagged && !labels.length ? ['unsafe'] : labels };
}
