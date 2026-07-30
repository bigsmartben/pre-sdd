import type { ProductObservation, ReviewDriver } from './review-host.js';

export class DomObservationAdapter implements ReviewDriver {
  locate(itemId: string): Element | null {
    for (const element of document.querySelectorAll('[data-visual-item-id]')) {
      if (element.getAttribute('data-visual-item-id') === itemId) return element;
    }
    return null;
  }

  observe(itemId: string): ProductObservation | null {
    const element = this.locate(itemId);
    if (!element) return null;
    return { itemId, state: Object.freeze({ text: element.textContent ?? '', hidden: element.hasAttribute('hidden') }) };
  }

  dispatch(itemId: string, event: Event): boolean {
    return this.locate(itemId)?.dispatchEvent(event) ?? false;
  }
}
