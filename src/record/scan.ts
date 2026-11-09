// Same checks as tools/build_session.py: stop the build if text looks like a secret or an e-mail address.
const SECRET_PATTERNS: [string, RegExp][] = [
  ['API key (sk-)', /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Bearer token', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/],
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function scanText(text: string, where: string, allowEmails: string[] = []): string[] {
  const problems: string[] = [];
  for (const [label, re] of SECRET_PATTERNS) if (re.test(text)) problems.push(`${where}: looks like a ${label}`);
  const allow = new Set(allowEmails.map((e) => e.toLowerCase()));
  for (const m of text.matchAll(EMAIL)) {
    const a = m[0].toLowerCase();
    if (allow.has(a) || a.startsWith('noreply@')) continue;
    problems.push(`${where}: e-mail address ${m[0]}`);
  }
  return problems;
}
