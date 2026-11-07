/** OpenAI-compatible reasoning_effort values. Empty means inherit / omit, not none. */
export const REASONING_OPTIONS = [
  { value: '', label: '默认 / 跟随上级（不额外指定）' },
  { value: 'none', label: '关闭推理 · none' },
  { value: 'minimal', label: '极低 · minimal' },
  { value: 'low', label: '低 · low' },
  { value: 'medium', label: '中 · medium' },
  { value: 'high', label: '高 · high' },
  { value: 'xhigh', label: '极高 · xhigh' },
];
const VALUES = new Set(REASONING_OPTIONS.map((option) => option.value));
export function validateReasoningEffort(value) {
  if (typeof value !== 'string' || !VALUES.has(value)) throw new Error('推理档位无效：请选择默认、none、minimal、low、medium、high 或 xhigh');
  return value;
}
export function validateReasoningConfig(llm) {
  if (Object.hasOwn(llm, 'reasoningEffort')) validateReasoningEffort(llm.reasoningEffort);
  if (Object.hasOwn(llm, 'reasoningEfforts')) {
    const efforts = llm.reasoningEfforts;
    if (!efforts || typeof efforts !== 'object' || Array.isArray(efforts)) throw new Error('分用途推理档位必须是对象');
    for (const [purpose, value] of Object.entries(efforts)) {
      if (!['chat', 'agent', 'background'].includes(purpose)) throw new Error(`未知推理用途：${purpose}`);
      validateReasoningEffort(value);
    }
  }
}
export function reasoningEffortFor(llm, purpose = 'chat') {
  const override = llm.reasoningEfforts?.[purpose];
  const value = override === undefined || override === '' ? (llm.reasoningEffort ?? '') : override;
  return validateReasoningEffort(value);
}
