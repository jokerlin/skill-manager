import { encode } from "gpt-tokenizer/encoding/o200k_base";

/**
 * Token estimate using the o200k_base BPE. Claude's tokenizer is not public;
 * o200k is close enough to rank skills and size budgets (label it as an estimate in UIs).
 */
export const estimateTokens = (text: string): number => (text.length === 0 ? 0 : encode(text).length);
