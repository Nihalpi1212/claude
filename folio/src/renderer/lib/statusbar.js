// Status bar: small keyed slots, left and right aligned.
export class Statusbar {
  constructor() {
    this.root = document.getElementById('statusbar');
    this.left = document.createElement('div');
    this.left.className = 'status-left';
    this.left.style.display = 'flex';
    this.left.style.gap = '16px';
    this.right = document.createElement('div');
    this.right.className = 'status-right';
    this.root.append(this.left, this.right);
    this.items = new Map();
  }

  set(key, content, { right = false } = {}) {
    let el = this.items.get(key);
    if (!el) {
      el = document.createElement('span');
      el.className = 'status-item';
      el.dataset.key = key;
      this.items.set(key, el);
      (right ? this.right : this.left).appendChild(el);
    }
    if (content instanceof Node) el.replaceChildren(content);
    else el.textContent = content ?? '';
    el.hidden = content === null || content === undefined || content === '';
    return el;
  }

  clear(key) {
    const el = this.items.get(key);
    if (!el) return;
    el.replaceChildren();
    el.hidden = true;
  }
}
