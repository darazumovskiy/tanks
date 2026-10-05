// Текст интерфейса толпы, который видит игрок: без погашенных слоёв, элементов с hidden и закрытых подсказок
// (aria-hidden); куски — через пробел.
export function shownText(root: Element): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node instanceof Element) {
      const isHiddenLayer = node.classList.contains('ffa-layer') && !node.classList.contains('is-shown');
      const isAriaHidden = node.getAttribute('aria-hidden') === 'true';
      if (node.hasAttribute('hidden') || isHiddenLayer || isAriaHidden) {
        return;
      }
    }
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '');
      return;
    }
    node.childNodes.forEach(walk);
  };
  walk(root);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
