/** Render message text with ``` code fences folded into <details>, so long code does not bury the conversation. */
export function renderMessageBody(content: string, codeLabel: (lines: number) => string): Node[] {
  const out: Node[] = [];
  const re = /```([\w-]*)[ \t]*\n([\s\S]*?)```/g;
  let last = 0;
  for (const m of content.matchAll(re)) {
    const before = content.slice(last, m.index).replace(/\n+$/, '');
    if (before.trim()) out.push(document.createTextNode(before));
    const det = document.createElement('details');
    det.className = 'fence';
    const sum = document.createElement('summary');
    sum.textContent = codeLabel(m[2].replace(/\n$/, '').split('\n').length);
    const pre = document.createElement('pre');
    pre.textContent = m[2];
    det.append(sum, pre);
    out.push(det);
    last = (m.index ?? 0) + m[0].length;
  }
  const rest = content.slice(last).replace(/^\n+/, '');
  if (rest.trim()) out.push(document.createTextNode(rest));
  return out;
}
