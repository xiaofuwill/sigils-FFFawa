/**
 * Documentation-level grammar contract for SIGILS v4.3 filters.
 * This package intentionally does not normalize or rewrite user expressions.
 */
export const FILTER_SYNTAX = {
  expression: "OR groups separated by |; terms inside a group are ANDed by unquoted whitespace.",
  quoting: "Double quotes preserve whitespace and | inside a term. Backslash escapes the next character.",
  negation: "A leading ! negates a term. For package addresses, !# is the blacklist form.",
  packageAddress: "#<Create Glob pattern> matches a Create package address; # alone matches blank addresses.",
  legacyAddress: "addr:<text> retains legacy case-insensitive address substring matching.",
  glob: {
    star: "* matches zero or more characters.",
    question: "? matches exactly one Unicode code point.",
    characterSet: "[abc] matches one listed character; [a-z] matches a range; [!abc] negates a set.",
    alternatives: "{north,south} matches one alternative; nested brace groups are unsupported.",
    escape: "Backslash escapes Glob metacharacters.",
    limits: "Pattern limit: 256 UTF-8 bytes; 256 tokens; 64 expanded alternatives.",
  },
  matching: "Create address matching is case-sensitive and symmetric: the stored package address and filter address may each contain a Glob expression.",
  safety: "If an item is identified as a Create package but its address metadata is unavailable, address filters fail closed.",
} as const;

export const FILTER_EXAMPLES = [
  { expression: "#warehouse", meaning: "包裹地址匹配 warehouse。" },
  { expression: "!#warehouse", meaning: "包裹地址不是 warehouse。" },
  { expression: "#crate-?", meaning: "crate- 之后正好一个字符。" },
  { expression: "#north-*", meaning: "地址以 north- 开头。" },
  { expression: "#{north,south}-[0-9]", meaning: "north 或 south 后接一个数字。" },
  { expression: '"#Main Depot"', meaning: "地址含空格时用引号括起。" },
  { expression: "addr:warehouse", meaning: "旧式地址子串匹配，不是 Glob。" },
  { expression: "#warehouse @create", meaning: "地址匹配且来自 create 模组。" },
  { expression: "#warehouse|#factory", meaning: "满足任一地址条件即可。" },
] as const;
